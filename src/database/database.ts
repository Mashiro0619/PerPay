import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import { migrations, migrationChecksum, type Migration } from "./migrations.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../orders/checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "../orders/collection-profile.ts";
import { MAX_ORDER_CLOCK_AHEAD_MILLISECONDS } from "../orders/model.ts";
import { APP_VERSION, DATABASE_COMPATIBILITY } from "../version.ts";

const SQLITE_TIMEOUT_MS = 5_000;
const LEASE_TTL_MS = 30_000;
const LEASE_HEARTBEAT_MS = 10_000;
const LEASE_KEY = 1;

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly result: string;
}

export interface DatabaseIntegrity {
  readonly ok: boolean;
  readonly quickCheck: string;
  readonly foreignKeyViolations: number;
  readonly domainViolations: number;
  readonly schema: string;
}

export interface DatabaseBackup {
  readonly pages: number;
  readonly targetPath: string;
  readonly sha256: string;
}

export type DatabaseReadOperation<T> = (connection: DatabaseSync) => T;
export type DatabaseWriteOperation<T> = (connection: DatabaseSync) => T;

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string | null;
}

interface LeaseRow {
  readonly owner_token: string;
  readonly expires_at: bigint | number;
}

export class AppDatabase {
  readonly #connection: DatabaseSync;
  readonly #databasePath: string;
  readonly #leaseToken: string;
  readonly #leaseHeartbeat: NodeJS.Timeout;
  readonly #wallClockAnchorMs: number;
  readonly #monotonicAnchorMs: number;
  #closed = false;
  #leaseLost = false;

  private constructor(connection: DatabaseSync, databasePath: string, leaseToken: string) {
    this.#connection = connection;
    this.#databasePath = databasePath;
    this.#leaseToken = leaseToken;
    this.#wallClockAnchorMs = Date.now();
    this.#monotonicAnchorMs = performance.now();
    this.#leaseHeartbeat = setInterval(() => this.#renewLease(), LEASE_HEARTBEAT_MS);
    this.#leaseHeartbeat.unref();
  }

  /** Opens the database, taking its lease and applying verified migrations. */
  static async open(databasePath: string): Promise<AppDatabase> {
    const resolvedPath = resolve(databasePath);
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const existed = existsSync(resolvedPath) && statSync(resolvedPath).size > 0;
    const connection = new DatabaseSync(resolvedPath, {
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MS,
      readBigInts: true,
      defensive: true,
    });
    const leaseToken = randomUUID();

    try {
      configurePragmas(connection);
      ensureLeaseTable(connection);
      acquireLease(connection, leaseToken);
      await migrate(connection, resolvedPath, existed);
      if (!validateSchema(connection)) {
        throw new Error("database schema integrity check failed: schema=invalid");
      }
      initializeRuntimeSecrets(connection);
      const integrity = inspectIntegrity(connection);
      if (!integrity.ok) {
        throw new Error(
          `database integrity check failed: quick_check=${integrity.quickCheck}, ` +
          `foreign_key_violations=${integrity.foreignKeyViolations}, ` +
          `domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`,
        );
      }
      recordApplicationVersion(connection);
      return new AppDatabase(connection, resolvedPath, leaseToken);
    } catch (error) {
      try {
        releaseLease(connection, leaseToken);
      } catch {
        // Keep the startup error as the cause of failure.
      }
      connection.close();
      throw error;
    }
  }

  health(): DatabaseHealth {
    if (this.#closed || this.#leaseLost) {
      return { ok: false, result: this.#leaseLost ? "database_lease_lost" : "database_closed" };
    }
    try {
      const row = this.#connection.prepare("SELECT 1 AS probe").get() as
        | { probe: number }
        | undefined;
      if (row === undefined || Number(row.probe) !== 1) {
        return { ok: false, result: "probe_failed" };
      }
      const lease = this.#connection
        .prepare("SELECT owner_token, expires_at FROM app_lease WHERE lease_key = ?")
        .get(LEASE_KEY) as LeaseRow | undefined;
      if (!lease || lease.owner_token !== this.#leaseToken || Number(lease.expires_at) <= Date.now()) {
        return { ok: false, result: "database_lease_lost" };
      }
      if (tableExists(this.#connection, "order_clock")) {
        const row = this.#connection
          .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
          .get() as { last_now_ms: bigint | number } | undefined;
        const logicalNow = row ? Number(row.last_now_ms) : Number.NaN;
        if (
          !Number.isSafeInteger(logicalNow) ||
          logicalNow - databaseTimeMilliseconds(this.#connection) >
            MAX_ORDER_CLOCK_AHEAD_MILLISECONDS
        ) {
          return { ok: false, result: "order_clock_ahead" };
        }
        const currentPhysical = databaseTimeMilliseconds(this.#connection);
        const expectedPhysical =
          this.#wallClockAnchorMs + (performance.now() - this.#monotonicAnchorMs);
        if (Math.abs(currentPhysical - expectedPhysical) > MAX_ORDER_CLOCK_AHEAD_MILLISECONDS) {
          return { ok: false, result: "system_clock_changed" };
        }
      }
      return { ok: true, result: "ok" };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : "unknown_database_error" };
    }
  }

  /** Runs a synchronous read through the single application connection. */
  read<T>(operation: DatabaseReadOperation<T>): T {
    this.assertAvailable();
    return operation(this.#connection);
  }

  /** Runs a short synchronous write transaction. Async callbacks are forbidden. */
  write<T>(operation: DatabaseWriteOperation<T>): T {
    this.assertAvailable();
    if (this.#connection.isTransaction) {
      throw new Error("nested database transactions are not supported");
    }

    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(this.#connection);
      if (isPromiseLike(result)) {
        throw new Error("database write callbacks must be synchronous");
      }
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#connection.isTransaction) this.#connection.exec("ROLLBACK");
      throw error;
    }
  }

  /** Expensive integrity checks are explicit, rather than part of /readyz. */
  integrityCheck(): DatabaseIntegrity {
    if (this.#closed) {
      return {
        ok: false,
        quickCheck: "database_closed",
        foreignKeyViolations: -1,
        domainViolations: -1,
        schema: "error",
      };
    }
    return inspectIntegrity(this.#connection);
  }

  instanceId(): string {
    const row = this.#connection
      .prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'")
      .get() as { value: string } | undefined;
    if (!row) {
      throw new Error("database is missing instance_id");
    }
    return row.value;
  }

  async backup(targetPath: string): Promise<number> {
    const result = await this.backupDetailed(targetPath);
    return result.pages;
  }

  async backupDetailed(targetPath: string): Promise<DatabaseBackup> {
    if (this.#closed || this.#leaseLost) {
      throw new Error("database is not available for backup");
    }
    return createVerifiedBackup(this.#connection, this.#databasePath, targetPath);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#leaseHeartbeat);
    try {
      releaseLease(this.#connection, this.#leaseToken);
    } finally {
      this.#connection.close();
    }
  }

  #renewLease(): void {
    if (this.#closed || this.#leaseLost) {
      return;
    }
    try {
      const result = this.#connection
        .prepare("UPDATE app_lease SET expires_at = ? WHERE lease_key = ? AND owner_token = ?")
        .run(Date.now() + LEASE_TTL_MS, LEASE_KEY, this.#leaseToken);
      if (Number(result.changes) !== 1) {
        this.#leaseLost = true;
      }
    } catch {
      this.#leaseLost = true;
    }
  }

  #assertAvailable(): void {
    if (this.#closed || this.#leaseLost) {
      throw new Error(this.#leaseLost ? "database lease lost" : "database is closed");
    }
  }

  private assertAvailable(): void {
    this.#assertAvailable();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function configurePragmas(connection: DatabaseSync): void {
  const journal = connection.prepare("PRAGMA journal_mode = WAL").get() as
    | { journal_mode: string }
    | undefined;
  if (journal?.journal_mode.toLowerCase() !== "wal") {
    throw new Error(`SQLite journal_mode assertion failed: ${String(journal?.journal_mode)}`);
  }
  connection.exec("PRAGMA synchronous = FULL;");
  assertPragmaNumber(connection, "synchronous", 2);
  connection.exec("PRAGMA busy_timeout = 5000;");
  assertPragmaNumber(connection, "busy_timeout", SQLITE_TIMEOUT_MS);
  connection.exec("PRAGMA wal_autocheckpoint = 1000;");
  assertPragmaNumber(connection, "wal_autocheckpoint", 1000);
  connection.exec("PRAGMA trusted_schema = OFF;");
  assertPragmaNumber(connection, "trusted_schema", 0);
  connection.exec("PRAGMA temp_store = MEMORY;");
  assertPragmaNumber(connection, "temp_store", 2);
  assertPragmaNumber(connection, "foreign_keys", 1);
}

function assertPragmaNumber(connection: DatabaseSync, name: string, expected: number): void {
  const row = connection.prepare(`PRAGMA ${name}`).get() as
    | Record<string, bigint | number>
    | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (value === undefined || Number(value) !== expected) {
    throw new Error(`SQLite ${name} assertion failed: expected ${expected}, got ${String(value)}`);
  }
}

function databaseTimeMilliseconds(connection: DatabaseSync): number {
  const row = connection
    .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
    .get() as { now_ms: bigint | number };
  const value = Number(row.now_ms);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("database clock is outside the safe integer range");
  }
  return value;
}

function ensureLeaseTable(connection: DatabaseSync): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS app_lease (
      lease_key INTEGER PRIMARY KEY CHECK (lease_key = 1),
      owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_host TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
  `);
}

function acquireLease(connection: DatabaseSync, token: string): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT owner_token, expires_at FROM app_lease WHERE lease_key = ?").get(LEASE_KEY) as
      | LeaseRow
      | undefined;
    const now = Date.now();
    if (row && row.owner_token !== token && Number(row.expires_at) > now) {
      throw new Error("another process already owns the database lease");
    }
    const values = [token, process.pid, process.platform, now, now + LEASE_TTL_MS, LEASE_KEY] as const;
    if (row) {
      connection
        .prepare("UPDATE app_lease SET owner_token = ?, owner_pid = ?, owner_host = ?, acquired_at = ?, expires_at = ? WHERE lease_key = ?")
        .run(...values);
    } else {
      connection
        .prepare("INSERT INTO app_lease(lease_key, owner_token, owner_pid, owner_host, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(LEASE_KEY, ...values.slice(0, 5));
    }
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

function releaseLease(connection: DatabaseSync, token: string): void {
  if (!connection.isOpen) return;
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare("DELETE FROM app_lease WHERE lease_key = ? AND owner_token = ?").run(LEASE_KEY, token);
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

async function migrate(connection: DatabaseSync, databasePath: string, existed: boolean): Promise<void> {
  const hasTable = tableExists(connection, "schema_migrations");
  const before = hasTable ? readAppliedMigrations(connection, false) : [];
  validateAppliedMigrationNames(before);
  const pending = migrations.some((migration) => !before.some((row) => row.version === migration.version));
  const newestAppliedBeforeMigration = Math.max(0, ...before.map((row) => row.version));
  const newestKnown = Math.max(0, ...migrations.map((migration) => migration.version));
  if (existed && pending && !hasTable) {
    throw new Error("existing SQLite database has no migration metadata; refusing unverified migration");
  }
  if (existed && pending) {
    await createPreMigrationBackup(
      connection,
      databasePath,
      newestAppliedBeforeMigration,
      newestKnown,
    );
  }
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const columns = connection.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "checksum")) connection.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  const rows = readAppliedMigrations(connection, true);
  validateAppliedMigrationNames(rows);
  const expectedByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of rows) {
    const migration = expectedByVersion.get(row.version);
    if (!migration) throw new Error(`database contains unknown migration ${row.version} ${row.name}`);
    const expected = migrationChecksum(migration);
    if (row.checksum && row.checksum !== expected) throw new Error(`migration checksum mismatch for ${row.version} (${row.name})`);
    if (!row.checksum) connection.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(expected, row.version);
  }
  const newestApplied = Math.max(0, ...rows.map((row) => row.version));
  if (newestApplied > newestKnown) throw new Error("database schema is newer than this application; refusing startup");
  const insert = connection.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
  const versions = new Set(rows.map((row) => row.version));
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(migration.sql);
      insert.run(migration.version, migration.name, migrationChecksum(migration));
      connection.exec("COMMIT");
    } catch (error) {
      if (connection.isTransaction) connection.exec("ROLLBACK");
      throw new Error(`database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}

async function createPreMigrationBackup(
  connection: DatabaseSync,
  databasePath: string,
  fromVersion: number,
  toVersion: number,
): Promise<void> {
  const target = `${databasePath}.pre-migration-v${fromVersion}-to-v${toVersion}.sqlite3`;
  const staging = `${target}.staging-${randomUUID()}`;
  try {
    await createVerifiedBackup(connection, databasePath, staging);
    replaceFileAtomically(staging, target);
  } catch (error) {
    removeSqliteArtifacts(staging);
    throw error;
  }
}

function tableExists(connection: DatabaseSync, tableName: string): boolean {
  const row = connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { present: number } | undefined;
  return row !== undefined && Number(row.present) === 1;
}

function readAppliedMigrations(connection: DatabaseSync, includeChecksum: boolean): AppliedMigration[] {
  const sql = includeChecksum
    ? "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    : "SELECT version, name FROM schema_migrations ORDER BY version";
  const rows = connection.prepare(sql).all() as Array<{ version: bigint; name: string; checksum?: string | null }>;
  return rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    checksum: includeChecksum ? row.checksum ?? null : null,
  }));
}

function validateAppliedMigrationNames(rows: readonly AppliedMigration[]): void {
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!Number.isSafeInteger(row.version) || row.version < 1 || versions.has(row.version) || names.has(row.name)) throw new Error("invalid schema migration metadata");
    if (row.version !== index + 1) throw new Error("schema migrations must form a contiguous prefix");
    versions.add(row.version); names.add(row.name);
    const migration = migrations.find((candidate) => candidate.version === row.version);
    if (!migration || migration.name !== row.name) throw new Error(`database contains unknown or renamed migration ${row.version} ${row.name}`);
  }
}

function recordApplicationVersion(connection: DatabaseSync): void {
  const applied = connection.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: bigint | null };
  const schemaVersion = Number(applied.version ?? 0n);
  if (schemaVersion < DATABASE_COMPATIBILITY.minimum || schemaVersion > DATABASE_COMPATIBILITY.maximum) throw new Error(`database schema ${schemaVersion} is outside application ${APP_VERSION} compatibility ${DATABASE_COMPATIBILITY.minimum}-${DATABASE_COMPATIBILITY.maximum}`);
  connection.prepare("INSERT INTO system_metadata(key, value, updated_at) VALUES ('last_started_version', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(APP_VERSION);
}

function initializeRuntimeSecrets(connection: DatabaseSync): void {
  if (!tableExists(connection, "checkout_token_key")) return;
  const existing = connection
    .prepare("SELECT key_material FROM checkout_token_key WHERE singleton_key = 1")
    .get() as { key_material: Uint8Array } | undefined;
  if (existing) {
    if (!(existing.key_material instanceof Uint8Array) || existing.key_material.byteLength !== 32) {
      throw new Error("checkout token key is invalid");
    }
    assertCheckoutTokenKeyMatchesSessions(connection, existing.key_material);
    return;
  }

  if (!tableExists(connection, "payment_orders") || !tableExists(connection, "checkout_sessions")) {
    return;
  }
  const state = connection
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM payment_orders) AS has_orders,
         EXISTS(SELECT 1 FROM checkout_sessions) AS has_checkouts`,
    )
    .get() as { has_orders: bigint | number; has_checkouts: bigint | number };
  if (Number(state.has_orders) !== 0 || Number(state.has_checkouts) !== 0) {
    throw new Error("checkout token key is missing from a database that already contains orders");
  }

  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = connection
      .prepare(
        `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
         VALUES (1, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      )
      .run(randomBytes(32));
    if (Number(result.changes) !== 1) {
      throw new Error("checkout token key was not initialized");
    }
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  }
}

function inspectIntegrity(connection: DatabaseSync): DatabaseIntegrity {
  try {
    const quick = connection.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    const quickCheck = quick?.quick_check ?? "missing_result";
    const foreignKeys = connection.prepare("PRAGMA foreign_key_check").all();
    const domainViolations =
      countDomainViolations(connection) + countCryptographicDomainViolations(connection);
    const schema = validateSchema(connection) ? "ok" : "invalid";
    return {
      ok:
        quickCheck === "ok" &&
        foreignKeys.length === 0 &&
        domainViolations === 0 &&
        schema === "ok",
      quickCheck,
      foreignKeyViolations: foreignKeys.length,
      domainViolations,
      schema,
    };
  } catch (error) {
    return {
      ok: false,
      quickCheck: error instanceof Error ? error.message : "integrity_check_failed",
      foreignKeyViolations: -1,
      domainViolations: -1,
      schema: "error",
    };
  }
}

function countDomainViolations(connection: DatabaseSync): number {
  if (!tableExists(connection, "payment_orders")) return 0;
  const row = connection
    .prepare(
      `SELECT COUNT(*) AS violations
         FROM (
           SELECT orders.order_id AS subject
             FROM payment_orders AS orders
             LEFT JOIN checkout_sessions AS checkout ON checkout.order_id = orders.order_id
             LEFT JOIN amount_slots AS slot ON slot.order_id = orders.order_id
            WHERE checkout.order_id IS NULL
               OR slot.order_id IS NULL
               OR slot.collection_profile_id != orders.collection_profile_id
               OR slot.payable_amount_cents != orders.payable_amount_cents
               OR slot.occupied_from != orders.eligible_from
               OR (
                 orders.checkout_status = 'OPEN' AND
                 (slot.released_at IS NOT NULL OR slot.release_reason IS NOT NULL)
               )
               OR (
                 orders.checkout_status IN ('CLOSED', 'EXPIRED') AND
                 (
                   slot.released_at IS NOT orders.closed_at OR
                   slot.release_reason != orders.checkout_status
                 )
               )

           UNION ALL

           SELECT orders.order_id AS subject
             FROM payment_orders AS orders
             LEFT JOIN order_events AS event ON event.order_id = orders.order_id
            GROUP BY orders.order_id, orders.version
           HAVING COUNT(event.event_id) != orders.version
               OR MIN(event.sequence) != 1
               OR MAX(event.sequence) != orders.version

           UNION ALL

           SELECT ordered.slot_id AS subject
             FROM (
               SELECT
                 slot_id,
                 generation,
                 occupied_from,
                 ROW_NUMBER() OVER (
                   PARTITION BY payable_amount_cents ORDER BY generation
                 ) AS position,
                 LAG(generation) OVER (
                   PARTITION BY payable_amount_cents ORDER BY generation
                 ) AS previous_generation,
                 LAG(released_at) OVER (
                   PARTITION BY payable_amount_cents ORDER BY generation
                 ) AS previous_released_at
               FROM amount_slots
             ) AS ordered
            WHERE
              (ordered.position = 1 AND ordered.generation != 1) OR
              (
                ordered.position > 1 AND
                (
                  ordered.generation != ordered.previous_generation + 1 OR
                  ordered.previous_released_at IS NULL OR
                  ordered.previous_released_at > ordered.occupied_from
                )
              )

           UNION ALL

           SELECT 'active_profile' AS subject
            WHERE EXISTS (SELECT 1 FROM collection_profiles)
              AND NOT EXISTS (SELECT 1 FROM active_collection_profile WHERE singleton_key = 1)

           UNION ALL

           SELECT 'activation_head' AS subject
             FROM active_collection_profile AS active
            WHERE NOT EXISTS (
              SELECT 1
                FROM collection_profile_activations AS activation
               WHERE activation.sequence = (
                 SELECT MAX(sequence) FROM collection_profile_activations
               )
                 AND activation.profile_id = active.profile_id
                 AND activation.activated_at = active.activated_at
            )

           UNION ALL

           SELECT 'checkout_token_key' AS subject
            WHERE (SELECT COUNT(*) FROM checkout_token_key WHERE singleton_key = 1) != 1

           UNION ALL

           SELECT 'order_clock' AS subject
            WHERE (SELECT COUNT(*) FROM order_clock WHERE singleton_key = 1) != 1
         )`,
    )
    .get() as { violations: bigint | number };
  const violations = Number(row.violations);
  if (!Number.isSafeInteger(violations) || violations < 0) {
    throw new Error("domain integrity violation count is invalid");
  }
  return violations;
}

function validateSchema(connection: DatabaseSync): boolean {
  if (!tableExists(connection, "schema_migrations") || !tableExists(connection, "system_metadata") || !tableExists(connection, "app_lease")) return false;
  try {
    const migrationColumns = connection.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
    const hasChecksum = migrationColumns.some((column) => column.name === "checksum");
    const applied = readAppliedMigrations(connection, hasChecksum);
    validateAppliedMigrationNames(applied);
    for (const row of applied) {
      const migration = migrations.find((candidate) => candidate.version === row.version) as Migration | undefined;
      if (!migration || (row.checksum !== null && row.checksum !== migrationChecksum(migration))) return false;
    }
    return migrationSchemaCatalog(connection) === expectedMigrationSchemaCatalog(applied.length);
  } catch { return false; }
}

interface SchemaCatalogRow {
  readonly type: string;
  readonly name: string;
  readonly table_name: string;
  readonly sql: string;
}

const expectedMigrationSchemaCatalogs = new Map<number, string>();

function expectedMigrationSchemaCatalog(appliedCount: number): string {
  const cached = expectedMigrationSchemaCatalogs.get(appliedCount);
  if (cached !== undefined) return cached;
  const expected = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    readBigInts: true,
    defensive: true,
  });
  try {
    ensureLeaseTable(expected);
    for (const migration of migrations.slice(0, appliedCount)) expected.exec(migration.sql);
    const catalog = migrationSchemaCatalog(expected);
    expectedMigrationSchemaCatalogs.set(appliedCount, catalog);
    return catalog;
  } finally {
    expected.close();
  }
}

function migrationSchemaCatalog(connection: DatabaseSync): string {
  const rows = connection
    .prepare(
      `SELECT type, name, tbl_name AS table_name, sql
         FROM sqlite_schema
        WHERE sql IS NOT NULL
          AND name NOT GLOB 'sqlite_*'
          AND name != 'schema_migrations'
        ORDER BY type, name`,
    )
    .all() as unknown as SchemaCatalogRow[];
  return JSON.stringify(rows);
}

function countCryptographicDomainViolations(connection: DatabaseSync): number {
  if (
    !tableExists(connection, "collection_profiles") ||
    !tableExists(connection, "checkout_sessions") ||
    !tableExists(connection, "checkout_token_key")
  ) {
    return 0;
  }

  let violations = 0;
  for (const row of connection
    .prepare(
      `SELECT code_payload, payload_fingerprint, profile_fingerprint
         FROM collection_profiles`,
    )
    .iterate() as Iterable<{
      code_payload: string;
      payload_fingerprint: string;
      profile_fingerprint: string;
    }>) {
    const expected = fingerprintCollectionCodeProfile(row.code_payload);
    if (
      row.payload_fingerprint !== expected.payloadFingerprint ||
      row.profile_fingerprint !== expected.profileFingerprint
    ) {
      violations += 1;
    }
  }

  const keyRow = connection
    .prepare("SELECT key_material FROM checkout_token_key WHERE singleton_key = 1")
    .get() as { key_material: Uint8Array } | undefined;
  if (!keyRow || !(keyRow.key_material instanceof Uint8Array) || keyRow.key_material.byteLength !== 32) {
    return violations;
  }
  for (const row of connection
    .prepare("SELECT checkout_id, token_digest FROM checkout_sessions")
    .iterate() as Iterable<{ checkout_id: string; token_digest: string }>) {
    try {
      const token = deriveCheckoutToken(keyRow.key_material, row.checkout_id);
      if (digestCheckoutToken(token) !== row.token_digest) violations += 1;
    } catch {
      violations += 1;
    }
  }
  return violations;
}

function assertCheckoutTokenKeyMatchesSessions(
  connection: DatabaseSync,
  key: Uint8Array,
): void {
  if (!tableExists(connection, "checkout_sessions")) return;
  for (const row of connection
    .prepare("SELECT checkout_id, token_digest FROM checkout_sessions")
    .iterate() as Iterable<{ checkout_id: string; token_digest: string }>) {
    let digest: string;
    try {
      digest = digestCheckoutToken(deriveCheckoutToken(key, row.checkout_id));
    } catch {
      throw new Error("checkout token key does not match persisted checkout sessions");
    }
    if (digest !== row.token_digest) {
      throw new Error("checkout token key does not match persisted checkout sessions");
    }
  }
}

async function createVerifiedBackup(sourceConnection: DatabaseSync, sourcePath: string, targetPath: string): Promise<DatabaseBackup> {
  const source = resolve(sourcePath); const target = resolve(targetPath);
  if (source === target) throw new Error("backup target must differ from the source database");
  const directory = dirname(target); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = target.split(/[\\/]/).pop() ?? "backup.sqlite3";
  const tempPath = resolve(directory, `.${name}.${randomUUID()}.tmp`);
  const reservation = openSync(tempPath, "wx", 0o600); closeSync(reservation);
  try {
    const pages = await sqliteBackup(sourceConnection, tempPath, { rate: 100 });
    chmodSync(tempPath, 0o600);
    const verification = new DatabaseSync(tempPath, { readOnly: true, enableForeignKeyConstraints: true, timeout: SQLITE_TIMEOUT_MS, readBigInts: true, defensive: true });
    try {
      const integrity = inspectIntegrity(verification);
      if (!integrity.ok) throw new Error(`backup verification failed: quick_check=${integrity.quickCheck}, foreign_key_violations=${integrity.foreignKeyViolations}, domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`);
    } finally { verification.close(); }
    // The lease is process identity, not application data. A copied live lease
    // would make a restored database reject its first legitimate owner, so
    // clear it before publishing the artifact and verify the final bytes too.
    const writable = new DatabaseSync(tempPath, {
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MS,
      readBigInts: true,
      defensive: true,
    });
    try {
      writable.exec("DELETE FROM app_lease");
      const checkpoint = writable.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: bigint | number; log: bigint | number; checkpointed: bigint | number }
        | undefined;
      if (!checkpoint || Number(checkpoint.busy) !== 0) {
        throw new Error("backup WAL checkpoint did not complete");
      }
      const journal = writable.prepare("PRAGMA journal_mode = DELETE").get() as
        | { journal_mode: string }
        | undefined;
      if (journal?.journal_mode.toLowerCase() !== "delete") {
        throw new Error("backup could not switch to a self-contained journal mode");
      }
    } finally {
      writable.close();
    }
    removeSqliteSidecars(tempPath);
    const finalVerification = new DatabaseSync(tempPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MS,
      readBigInts: true,
      defensive: true,
    });
    try {
      const integrity = inspectIntegrity(finalVerification);
      if (!integrity.ok) throw new Error(`final backup verification failed: quick_check=${integrity.quickCheck}, foreign_key_violations=${integrity.foreignKeyViolations}, domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`);
    } finally { finalVerification.close(); }
    removeSqliteSidecars(tempPath);
    const hash = await sha256File(tempPath);
    const file = openSync(tempPath, "r+"); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tempPath, target);
    try { const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Unsupported by some filesystems. */ }
    return { pages, targetPath: target, sha256: hash };
  } catch (error) { removeSqliteArtifacts(tempPath); throw error; }
}

function replaceFileAtomically(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if (!existsSync(target)) throw error;
    const displaced = `${target}.replaced-${randomUUID()}`;
    renameSync(target, displaced);
    try {
      renameSync(source, target);
      removeSqliteArtifacts(displaced);
    } catch (replacementError) {
      if (!existsSync(target) && existsSync(displaced)) renameSync(displaced, target);
      throw replacementError;
    }
  }
  try {
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch {
    // Directory fsync is not supported on every platform.
  }
}

function removeSqliteSidecars(path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function removeSqliteArtifacts(path: string): void {
  rmSync(path, { force: true });
  removeSqliteSidecars(path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256FileSync(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
