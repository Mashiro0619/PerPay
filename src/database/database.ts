import { createHash, randomUUID } from "node:crypto";
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
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import { migrations, migrationChecksum, type Migration } from "./migrations.ts";
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
  readonly schema: string;
}

export interface DatabaseBackup {
  readonly pages: number;
  readonly targetPath: string;
  readonly sha256: string;
}

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
  #closed = false;
  #leaseLost = false;

  private constructor(connection: DatabaseSync, databasePath: string, leaseToken: string) {
    this.#connection = connection;
    this.#databasePath = databasePath;
    this.#leaseToken = leaseToken;
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
      return { ok: true, result: "ok" };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : "unknown_database_error" };
    }
  }

  /** Expensive integrity checks are explicit, rather than part of /readyz. */
  integrityCheck(): DatabaseIntegrity {
    if (this.#closed) {
      return { ok: false, quickCheck: "database_closed", foreignKeyViolations: -1, schema: "error" };
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
  if (existed && pending && !hasTable) {
    throw new Error("existing SQLite database has no migration metadata; refusing unverified migration");
  }
  if (existed && pending) {
    await createVerifiedBackup(connection, databasePath, `${databasePath}.pre-migration-${Date.now()}-${randomUUID()}.sqlite3`);
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
  const newestKnown = Math.max(0, ...migrations.map((migration) => migration.version));
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
  for (const row of rows) {
    if (!Number.isSafeInteger(row.version) || row.version < 1 || versions.has(row.version) || names.has(row.name)) throw new Error("invalid schema migration metadata");
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

function inspectIntegrity(connection: DatabaseSync): DatabaseIntegrity {
  try {
    const quick = connection.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    const quickCheck = quick?.quick_check ?? "missing_result";
    const foreignKeys = connection.prepare("PRAGMA foreign_key_check").all();
    const schema = validateSchema(connection) ? "ok" : "invalid";
    return { ok: quickCheck === "ok" && foreignKeys.length === 0 && schema === "ok", quickCheck, foreignKeyViolations: foreignKeys.length, schema };
  } catch (error) {
    return { ok: false, quickCheck: error instanceof Error ? error.message : "integrity_check_failed", foreignKeyViolations: -1, schema: "error" };
  }
}

function validateSchema(connection: DatabaseSync): boolean {
  if (!tableExists(connection, "schema_migrations") || !tableExists(connection, "system_metadata") || !tableExists(connection, "app_lease")) return false;
  try {
    const migrationColumns = connection.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
    const hasChecksum = migrationColumns.some((column) => column.name === "checksum");
    for (const row of readAppliedMigrations(connection, hasChecksum)) {
      const migration = migrations.find((candidate) => candidate.version === row.version) as Migration | undefined;
      if (!migration || (row.checksum !== null && row.checksum !== migrationChecksum(migration))) return false;
    }
    return true;
  } catch { return false; }
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
      if (!integrity.ok) throw new Error(`backup verification failed: quick_check=${integrity.quickCheck}, foreign_key_violations=${integrity.foreignKeyViolations}, schema=${integrity.schema}`);
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
    } finally {
      writable.close();
    }
    const finalVerification = new DatabaseSync(tempPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MS,
      readBigInts: true,
      defensive: true,
    });
    try {
      const integrity = inspectIntegrity(finalVerification);
      if (!integrity.ok) throw new Error(`final backup verification failed: quick_check=${integrity.quickCheck}, foreign_key_violations=${integrity.foreignKeyViolations}, schema=${integrity.schema}`);
    } finally { finalVerification.close(); }
    const hash = await sha256File(tempPath);
    const file = openSync(tempPath, "r+"); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tempPath, target);
    try { const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Unsupported by some filesystems. */ }
    return { pages, targetPath: target, sha256: hash };
  } catch (error) { rmSync(tempPath, { force: true }); throw error; }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256FileSync(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
