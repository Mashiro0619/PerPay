import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
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
import { inspectAuditChain } from "./audit-chain.ts";
import {
  conflictFingerprint,
  ledgerConflictOperationEvidence,
  ledgerConflictOperationFingerprint,
  ledgerConflictOperationRequest,
  legacySemanticFingerprintV1,
  normalizeProviderIdentity,
  pageVariantConflictFingerprint,
  parseOccurredAtWithPrecision,
  requestFingerprint,
  semanticFingerprint,
} from "../ledger/model.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../orders/checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "../orders/collection-profile.ts";
import {
  MAX_ORDER_CLOCK_AHEAD_MILLISECONDS,
  orderEventDetailsFingerprint,
} from "../orders/model.ts";
import {
  assertDatabaseMaintenanceIdle,
  hasDatabaseMaintenanceLock,
  syncDirectory,
} from "./maintenance-lock.ts";
import {
  prepareWebhookTarget,
  webhookDeliveryRequestFingerprint,
} from "../notifications/model.ts";
import {
  candidateEvidence,
  candidateFingerprint,
  RECONCILIATION_RULE_VERSION,
  financialExceptionDetailsFingerprint,
  financialExceptionFingerprint,
  financialExceptionResolutionFingerprint,
  financialOperationEvidence,
  financialOperationFingerprint,
  manualSettlementEvidence,
  outboxPayloadFingerprint,
  refundRecordEvidence,
  type FinancialExceptionType,
  type FinancialOperationFingerprintInput,
  type FinancialOperationType,
} from "../reconciliation/model.ts";
import { APP_VERSION, DATABASE_COMPATIBILITY } from "../version.ts";
import {
  ensurePrivateDirectory,
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
  hardenSqliteArtifacts,
} from "../infrastructure/storage/permissions.ts";
import {
  assertBackupStorageHeadroom,
  inspectDatabaseStorageHeadroom,
} from "../infrastructure/storage/capacity.ts";
import { StartupLeaseHeartbeat } from "./startup-lease-heartbeat.ts";

const SQLITE_TIMEOUT_MS = 5_000;
const LEASE_TTL_MS = 30_000;
const LEASE_HEARTBEAT_MS = 10_000;
const LEASE_KEY = 1;
const PROVIDER_CONFLICT_STATE_FIX_VERSION = 10;

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
    hardenProcessFileCreation();
    const resolvedPath = resolve(databasePath);
    ensurePrivateDirectory(dirname(resolvedPath));
    hardenSqliteArtifacts(resolvedPath);
    assertDatabaseMaintenanceIdle(resolvedPath);
    const existed = existsSync(resolvedPath) && statSync(resolvedPath).size > 0;
    const connection = new DatabaseSync(resolvedPath, {
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MS,
      readBigInts: true,
      defensive: true,
    });
    const leaseToken = randomUUID();
    let startupLeaseHeartbeat: StartupLeaseHeartbeat | null = null;

    try {
      hardenExistingPrivateFile(resolvedPath);
      assertDatabaseMaintenanceIdle(resolvedPath);
      configurePragmas(connection);
      hardenSqliteArtifacts(resolvedPath);
      ensureLeaseTable(connection);
      acquireLease(connection, leaseToken);
      startupLeaseHeartbeat = await StartupLeaseHeartbeat.start({
        databasePath: resolvedPath,
        leaseKey: LEASE_KEY,
        leaseToken,
        leaseTtlMilliseconds: LEASE_TTL_MS,
        intervalMilliseconds: LEASE_HEARTBEAT_MS,
        sqliteTimeoutMilliseconds: SQLITE_TIMEOUT_MS,
      });
      assertDatabaseMaintenanceIdle(resolvedPath);
      await migrate(
        connection,
        resolvedPath,
        existed,
        () => renewLease(connection, leaseToken),
      );
      startupLeaseHeartbeat.assertHealthy();
      if (!validateSchema(connection)) {
        throw new Error("database schema integrity check failed: schema=invalid");
      }
      startupLeaseHeartbeat.assertHealthy();
      initializeRuntimeSecrets(connection);
      const integrity = inspectDatabaseIntegrity(connection);
      if (!integrity.ok) {
        throw new Error(
          `database integrity check failed: quick_check=${integrity.quickCheck}, ` +
          `foreign_key_violations=${integrity.foreignKeyViolations}, ` +
          `domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`,
        );
      }
      recordApplicationVersion(connection);
      startupLeaseHeartbeat.assertHealthy();
      await startupLeaseHeartbeat.stop(true);
      startupLeaseHeartbeat = null;
      return new AppDatabase(connection, resolvedPath, leaseToken);
    } catch (error) {
      if (startupLeaseHeartbeat !== null) {
        try {
          await startupLeaseHeartbeat.stop(false);
        } catch {
          // Keep the startup error as the cause of failure.
        }
      }
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
    // A maintenance operation creates its lock before it claims the persisted
    // maintenance lease.  Keep readiness fail-closed during that entire
    // interval, including the potentially expensive source/target checks
    // performed before the lease claim.
    try {
      if (hasDatabaseMaintenanceLock(this.#databasePath)) {
        return { ok: false, result: "database_maintenance_in_progress" };
      }
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
      // Recheck after the probe and lease read so a lock acquired while this
      // health check was running cannot produce a transient ready response.
      if (hasDatabaseMaintenanceLock(this.#databasePath)) {
        return { ok: false, result: "database_maintenance_in_progress" };
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
      if (!inspectDatabaseStorageHeadroom(this.#databasePath).sufficient) {
        return { ok: false, result: "database_storage_low" };
      }
      return { ok: true, result: "ok" };
    } catch {
      return { ok: false, result: "database_probe_failed" };
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
      // Recheck after taking the write lock so an expired lease cannot be stolen
      // between the preflight check and the first mutation.
      this.assertAvailable();
      const result = operation(this.#connection);
      if (isPromiseLike(result)) {
        throw new Error("database write callbacks must be synchronous");
      }
      // A synchronous callback can still hold the write lock long enough for
      // the persisted lease to approach expiry. Renew while that lock is held
      // so no completed transaction is published with an expired lease.
      renewLease(this.#connection, this.#leaseToken);
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
    return inspectDatabaseIntegrity(this.#connection);
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
    return createVerifiedDatabaseBackup(this.#connection, this.#databasePath, targetPath);
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

  private assertAvailable(): void {
    if (this.#closed || this.#leaseLost) {
      throw new Error(this.#leaseLost ? "database lease lost" : "database is closed");
    }
    assertDatabaseMaintenanceIdle(this.#databasePath);
    try {
      const lease = this.#connection
        .prepare("SELECT owner_token, expires_at FROM app_lease WHERE lease_key = ?")
        .get(LEASE_KEY) as LeaseRow | undefined;
      if (
        lease === undefined ||
        lease.owner_token !== this.#leaseToken ||
        Number(lease.expires_at) <= Date.now()
      ) {
        this.#leaseLost = true;
        throw new Error("database lease lost");
      }
    } catch (error) {
      this.#leaseLost = true;
      if (error instanceof Error && error.message === "database lease lost") throw error;
      throw new Error("database lease could not be verified", { cause: error });
    }
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

function renewLease(connection: DatabaseSync, token: string): void {
  const result = connection
    .prepare("UPDATE app_lease SET expires_at = ? WHERE lease_key = ? AND owner_token = ?")
    .run(Date.now() + LEASE_TTL_MS, LEASE_KEY, token);
  if (Number(result.changes) !== 1) {
    throw new Error("database lease ownership changed before commit");
  }
}

async function migrate(
  connection: DatabaseSync,
  databasePath: string,
  existed: boolean,
  renewStartupLease: () => void,
): Promise<void> {
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
      if (migration.postApply === "upgrade_ledger_semantic_fingerprints_v2") {
        upgradeLedgerSemanticFingerprints(connection);
      } else if (migration.postApply === "backfill_evidence_fingerprints_v1") {
        backfillEvidenceFingerprints(connection);
      }
      insert.run(migration.version, migration.name, migrationChecksum(migration));
      // A long migration owns SQLite's write lock, so renew in that same
      // transaction immediately before publishing the migrated schema.
      renewStartupLease();
      connection.exec("COMMIT");
    } catch (error) {
      if (connection.isTransaction) connection.exec("ROLLBACK");
      throw new Error(`database migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}

/**
 * v4 rows were identified without timestamp precision. Once v5 persists that
 * precision, rewrite historical identities while the migration transaction is
 * still open so a crash cannot leave a mixture of fingerprint versions.
 */
function upgradeLedgerSemanticFingerprints(connection: DatabaseSync): void {
  if (!columnExists(connection, "ledger_entries", "occurred_at_precision_ms")) {
    throw new Error("v5 migration did not create ledger occurrence precision");
  }
  const rows = connection.prepare(
    `SELECT entry.ledger_entry_id, entry.external_event_id,
            entry.semantic_fingerprint, entry.occurred_at,
            entry.occurred_at_precision_ms, entry.amount_cents,
            entry.direction, entry.currency, entry.alipay_order_no,
            entry.merchant_order_no, entry.trans_memo, entry.other_account,
            raw.occurred_at_text
       FROM ledger_entries AS entry
       LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = entry.raw_event_id
      ORDER BY entry.ledger_entry_id`,
  ).all() as Array<{
    ledger_entry_id: string;
    external_event_id: string;
    semantic_fingerprint: string;
    occurred_at: bigint | number;
    occurred_at_precision_ms: bigint | number;
    amount_cents: bigint | number;
    direction: "CREDIT" | "DEBIT";
    currency: "CNY";
    alipay_order_no: string | null;
    merchant_order_no: string | null;
    trans_memo: string | null;
    other_account: string | null;
    occurred_at_text: string | null;
  }>;
  if (rows.length === 0) return;

  const updates: Array<{ ledgerEntryId: string; fingerprint: string }> = [];
  for (const row of rows) {
    const occurredAt = Number(row.occurred_at);
    const precision = Number(row.occurred_at_precision_ms);
    const amountCents = Number(row.amount_cents);
    if (
      !Number.isSafeInteger(occurredAt) || occurredAt < 0 ||
      ![1, 10, 100, 1_000].includes(precision) ||
      !Number.isSafeInteger(amountCents) || amountCents < 1
    ) {
      throw new Error(`v5 migration found invalid ledger facts ${row.ledger_entry_id}`);
    }
    let parsed: ReturnType<typeof parseOccurredAtWithPrecision>;
    try {
      parsed = parseOccurredAtWithPrecision(row.occurred_at_text);
    } catch (error) {
      throw new Error(`v5 migration found an invalid retained timestamp ${row.ledger_entry_id}`, {
        cause: error,
      });
    }
    if (
      parsed.milliseconds !== occurredAt ||
      parsed.precisionMilliseconds !== precision
    ) {
      throw new Error(`v5 migration found timestamp facts that do not match raw evidence ${row.ledger_entry_id}`);
    }
    const legacy = legacySemanticFingerprintV1({
      externalEventId: row.external_event_id,
      occurredAt,
      amountCents,
      direction: row.direction,
      currency: row.currency,
      alipayOrderNo: row.alipay_order_no,
      merchantOrderNo: row.merchant_order_no,
      transMemo: row.trans_memo,
      otherAccount: row.other_account,
    });
    if (legacy !== row.semantic_fingerprint) {
      throw new Error(`v4 ledger fingerprint mismatch during v5 migration ${row.ledger_entry_id}`);
    }
    const fingerprint = semanticFingerprint({
      externalEventId: row.external_event_id,
      occurredAt,
      occurredAtPrecisionMilliseconds: precision as 1 | 10 | 100 | 1_000,
      amountCents,
      direction: row.direction,
      currency: row.currency,
      alipayOrderNo: row.alipay_order_no,
      merchantOrderNo: row.merchant_order_no,
      transMemo: row.trans_memo,
      otherAccount: row.other_account,
    });
    updates.push({ ledgerEntryId: row.ledger_entry_id, fingerprint });
  }

  const trigger = connection.prepare(
    `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'ledger_entries_facts_immutable'`,
  ).get() as { sql: string } | undefined;
  if (!trigger?.sql) throw new Error("v5 migration cannot find ledger immutability trigger");
  connection.exec("DROP TRIGGER ledger_entries_facts_immutable");
  try {
    const update = connection.prepare(
      "UPDATE ledger_entries SET semantic_fingerprint = ? WHERE ledger_entry_id = ?",
    );
    for (const row of updates) {
      const result = update.run(row.fingerprint, row.ledgerEntryId);
      if (Number(result.changes) !== 1) {
        throw new Error(`v5 migration could not update ledger fingerprint ${row.ledgerEntryId}`);
      }
    }
  } finally {
    connection.exec(trigger.sql);
  }
}

function backfillEvidenceFingerprints(connection: DatabaseSync): void {
  for (const [tableName, columnName] of [
    ["order_events", "details_fingerprint"],
    ["financial_exceptions", "details_fingerprint"],
    ["financial_exceptions", "resolution_fingerprint"],
  ] as const) {
    if (!columnExists(connection, tableName, columnName)) {
      throw new Error(`v9 migration did not create ${tableName}.${columnName}`);
    }
  }

  const triggerNames = [
    "order_events_no_update",
    "financial_exceptions_evidence_immutable",
    "financial_exceptions_resolution_once",
  ] as const;
  const triggers = connection.prepare(
    `SELECT name, sql
       FROM sqlite_schema
      WHERE type = 'trigger' AND name IN (?, ?, ?)
      ORDER BY name`,
  ).all(...triggerNames) as Array<{ name: string; sql: string | null }>;
  if (
    triggers.length !== triggerNames.length ||
    triggers.some((trigger) => trigger.sql === null)
  ) {
    throw new Error("v9 migration cannot find evidence immutability triggers");
  }

  for (const trigger of triggers) connection.exec(`DROP TRIGGER ${trigger.name}`);
  try {
    const backfillBatchSize = 256;
    const updateOrderEvent = connection.prepare(
      "UPDATE order_events SET details_fingerprint = ? WHERE event_id = ?",
    );
    const selectOrderEvents = connection.prepare(
      `SELECT rowid, event_id, details_json
         FROM order_events
        WHERE rowid > ?
        ORDER BY rowid
        LIMIT ?`,
    );
    let lastOrderEventRowId: bigint | number = 0;
    while (true) {
      const rows = selectOrderEvents.all(lastOrderEventRowId, backfillBatchSize) as Array<{
        rowid: bigint | number;
        event_id: string;
        details_json: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const result = updateOrderEvent.run(
          orderEventDetailsFingerprint(row.details_json),
          row.event_id,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`v9 migration could not bind order event ${row.event_id}`);
        }
      }
      lastOrderEventRowId = rows.at(-1)!.rowid;
    }

    const updateException = connection.prepare(
      `UPDATE financial_exceptions
          SET details_fingerprint = ?, resolution_fingerprint = ?
        WHERE exception_id = ?`,
    );
    const selectExceptions = connection.prepare(
      `SELECT rowid, exception_id, details_json, resolution_json
         FROM financial_exceptions
        WHERE rowid > ?
        ORDER BY rowid
        LIMIT ?`,
    );
    let lastExceptionRowId: bigint | number = 0;
    while (true) {
      const rows = selectExceptions.all(lastExceptionRowId, backfillBatchSize) as Array<{
        rowid: bigint | number;
        exception_id: string;
        details_json: string;
        resolution_json: string | null;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const result = updateException.run(
          financialExceptionDetailsFingerprint(row.details_json),
          row.resolution_json === null
            ? null
            : financialExceptionResolutionFingerprint(row.resolution_json),
          row.exception_id,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`v9 migration could not bind financial exception ${row.exception_id}`);
        }
      }
      lastExceptionRowId = rows.at(-1)!.rowid;
    }
  } finally {
    for (const trigger of triggers) connection.exec(trigger.sql!);
  }

  const missing = connection.prepare(
    `SELECT
       (SELECT COUNT(*) FROM order_events WHERE details_fingerprint IS NULL) +
       (SELECT COUNT(*) FROM financial_exceptions WHERE details_fingerprint IS NULL) +
       (SELECT COUNT(*) FROM financial_exceptions
         WHERE (resolution_json IS NULL) != (resolution_fingerprint IS NULL)) AS count`,
  ).get() as { count: bigint | number };
  if (Number(missing.count) !== 0) {
    throw new Error("v9 migration left unbound evidence rows");
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
    await createVerifiedDatabaseBackup(connection, databasePath, staging);
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

function columnExists(connection: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(connection, tableName)) return false;
  return (connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .some((column) => column.name === columnName);
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
  if (!tableExists(connection, "checkout_token_keys")) return;
  let keys = readCheckoutTokenKeys(connection);
  if (keys.length > 0) {
    assertCheckoutTokenKeySet(keys);
    assertCheckoutTokenKeysMatchSessions(connection, keys);
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
    const result = connection.prepare(
      `INSERT INTO checkout_token_keys(key_version, key_material, activated_at, retired_at)
       VALUES (1, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL)`,
    ).run(randomBytes(32));
    if (Number(result.changes) !== 1) {
      throw new Error("checkout token key was not initialized");
    }
    connection.exec("COMMIT");
  } catch (error) {
    if (connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  }
  keys = readCheckoutTokenKeys(connection);
  assertCheckoutTokenKeySet(keys);
  assertCheckoutTokenKeysMatchSessions(connection, keys);
}

export function inspectDatabaseIntegrity(connection: DatabaseSync): DatabaseIntegrity {
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
  return countIdentityDomainViolations(connection) +
    countOrderDomainViolations(connection) +
    countLedgerDomainViolations(connection) +
    countReconciliationDomainViolations(connection) +
    countWebhookDomainViolations(connection);
}

function countIdentityDomainViolations(connection: DatabaseSync): number {
  if (!tableExists(connection, "api_client_keys")) return 0;
  return readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT config.key_version
           FROM api_client_config AS config
           LEFT JOIN api_client_keys AS active
             ON active.client_id = config.client_id
            AND active.key_version = config.key_version
            AND active.secret_fingerprint = config.secret_fingerprint
            AND active.retired_at IS NULL
          WHERE active.key_version IS NULL

         UNION ALL

         SELECT key_version
           FROM (
             SELECT key_version,
                    MIN(key_version) OVER (PARTITION BY client_id) +
                      ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY key_version) - 1
                      AS expected_version
               FROM api_client_keys
           )
          WHERE key_version != expected_version

         UNION ALL

         SELECT active.key_version
           FROM api_client_keys AS active
          WHERE active.retired_at IS NULL
            AND active.key_version != (
              SELECT MAX(latest.key_version)
                FROM api_client_keys AS latest
               WHERE latest.client_id = active.client_id
            )

         UNION ALL

         SELECT current.key_version
           FROM api_client_keys AS current
           JOIN api_client_keys AS next
             ON next.client_id = current.client_id
            AND next.key_version = current.key_version + 1
          WHERE current.retired_at IS NULL
             OR current.retired_at > next.activated_at
       )`,
    "API client key",
  );
}

function countOrderDomainViolations(connection: DatabaseSync): number {
  if (!tableExists(connection, "payment_orders")) return 0;
  const checkoutTokenKeyPredicate = tableExists(connection, "checkout_token_keys")
    ? "(SELECT COUNT(*) FROM checkout_token_keys WHERE retired_at IS NULL) != 1"
    : tableExists(connection, "checkout_token_key")
      ? "(SELECT COUNT(*) FROM checkout_token_key WHERE singleton_key = 1) != 1"
      : "1";
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
            WHERE ${checkoutTokenKeyPredicate}

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

function countLedgerDomainViolations(connection: DatabaseSync): number {
  if (
    !tableExists(connection, "ingest_runs") ||
    !tableExists(connection, "ingest_segments") ||
    !tableExists(connection, "ingest_run_page_observations") ||
    !tableExists(connection, "provider_raw_pages") ||
    !tableExists(connection, "provider_raw_events") ||
    !tableExists(connection, "ledger_entries") ||
    !tableExists(connection, "ledger_conflicts") ||
    !tableExists(connection, "ingest_errors") ||
    !tableExists(connection, "ledger_cursors")
  ) {
    return 0;
  }
  // The v7 stability columns are intentionally optional here: this function
  // also verifies the pre-migration backup while a v6 database is still open.
  // Keep the v6 predicates until the migration transaction has committed.
  const hasPageDisposition = columnExists(
    connection,
    "ingest_run_page_observations",
    "disposition",
  );
  const hasPageObservationSequence = columnExists(
    connection,
    "ingest_run_page_observations",
    "observation_sequence",
  );
  const hasPageTransitionEnforcement = columnExists(
    connection,
    "ingest_run_page_observations",
    "transition_enforced",
  );
  const hasPageStability = hasPageDisposition &&
    hasPageObservationSequence &&
    hasPageTransitionEnforcement;
  const pageStabilityColumnCount = Number(hasPageDisposition) +
    Number(hasPageObservationSequence) +
    Number(hasPageTransitionEnforcement);
  const pageStabilitySchemaViolations =
    pageStabilityColumnCount === 0 || pageStabilityColumnCount === 3 ? 0 : 1;
  const observationIntegrity = hasPageStability
    ? `
               OR observation.disposition IS NULL
               OR observation.disposition NOT IN ('PROCESSED', 'REJECTED_VARIANT')
               OR observation.observation_sequence < 1
               OR observation.transition_enforced NOT IN (0, 1)
               OR (observation.disposition = 'REJECTED_VARIANT' AND (
                     run.status != 'FAILED' OR
                     run.failure_code != 'pagination_variant' OR
                     segment.state != 'PENDING' OR
                     NOT EXISTS (
                       SELECT 1
                         FROM ledger_conflicts AS variant_conflict
                         JOIN provider_raw_pages AS previous_page
                           ON previous_page.raw_page_id =
                              json_extract(
                                variant_conflict.details_json,
                                '$.existing_raw_page_id'
                              )
                         JOIN ingest_run_page_observations AS previous_observation
                           ON previous_observation.raw_page_id = previous_page.raw_page_id
                          AND previous_observation.observation_sequence =
                              json_extract(
                                variant_conflict.details_json,
                                '$.previous_observation_sequence'
                              )
                        WHERE variant_conflict.provider_account_key = run.provider_account_key
                          AND variant_conflict.raw_page_id = page.raw_page_id
                          AND variant_conflict.conflict_type = 'RAW_PAGE_VARIANT'
                          AND variant_conflict.incoming_semantic_fingerprint = page.response_fingerprint
                          AND variant_conflict.existing_semantic_fingerprint =
                              previous_page.response_fingerprint
                          AND previous_page.provider_account_key = page.provider_account_key
                          AND previous_page.request_fingerprint = page.request_fingerprint
                          AND previous_observation.observation_sequence = (
                            SELECT MAX(earlier_observation.observation_sequence)
                              FROM ingest_run_page_observations AS earlier_observation
                              JOIN provider_raw_pages AS earlier_page
                                ON earlier_page.raw_page_id = earlier_observation.raw_page_id
                             WHERE earlier_page.provider_account_key = page.provider_account_key
                               AND earlier_page.request_fingerprint = page.request_fingerprint
                               AND earlier_observation.observation_sequence <
                                   observation.observation_sequence
                          )
                          AND (SELECT COUNT(*)
                                 FROM json_each(variant_conflict.details_json)) = 5
                          AND json_type(
                                variant_conflict.details_json,
                                '$.request_fingerprint'
                              ) = 'text'
                          AND json_extract(
                                variant_conflict.details_json,
                                '$.request_fingerprint'
                              ) = page.request_fingerprint
                          AND json_type(
                                variant_conflict.details_json,
                                '$.ingest_segment_id'
                              ) = 'text'
                          AND json_extract(
                                variant_conflict.details_json,
                                '$.ingest_segment_id'
                              ) = segment.ingest_segment_id
                          AND json_type(
                                variant_conflict.details_json,
                                '$.previous_observation_sequence'
                              ) = 'integer'
                          AND json_type(
                                variant_conflict.details_json,
                                '$.existing_raw_page_id'
                              ) = 'text'
                          AND json_type(
                                variant_conflict.details_json,
                                '$.incoming_raw_page_id'
                              ) = 'text'
                          AND json_extract(
                                variant_conflict.details_json,
                                '$.incoming_raw_page_id'
                              ) = page.raw_page_id
                     ) OR
                     NOT EXISTS (
                       SELECT 1
                         FROM ingest_errors AS variant_error
                        WHERE variant_error.ingest_run_id = run.ingest_run_id
                          AND variant_error.error_code = 'pagination_variant'
                          AND variant_error.retryable = 1
                     ) OR
                     ((observation.observation_kind = 'OVERSIZED_PROBE' AND page.has_more != 1) OR
                      (observation.observation_kind = 'ACCEPTED_LEAF' AND page.has_more != 0))
                   ))
               OR (observation.disposition = 'PROCESSED' AND
                   observation.observation_kind = 'OVERSIZED_PROBE' AND (
                     page.has_more != 1 OR EXISTS (
                       SELECT 1 FROM provider_raw_events AS probe_raw
                        WHERE probe_raw.raw_page_id = page.raw_page_id
                     )
                   ))
               OR (observation.disposition = 'PROCESSED' AND
                   observation.observation_kind = 'ACCEPTED_LEAF' AND (
                     page.has_more != 0 OR page.total_size != (
                       SELECT COUNT(*) FROM provider_raw_events AS accepted_raw
                        WHERE accepted_raw.raw_page_id = page.raw_page_id
                     )
                   ))`
    : `
               OR (observation.observation_kind = 'OVERSIZED_PROBE' AND (
                     page.has_more != 1 OR EXISTS (
                       SELECT 1 FROM provider_raw_events AS probe_raw
                        WHERE probe_raw.raw_page_id = page.raw_page_id
                     )
                   ))
               OR (observation.observation_kind = 'ACCEPTED_LEAF' AND (
                     page.has_more != 0 OR page.total_size != (
                       SELECT COUNT(*) FROM provider_raw_events AS accepted_raw
                        WHERE accepted_raw.raw_page_id = page.raw_page_id
                     )
                   ))`;
  const acceptedDisposition = hasPageStability
    ? " AND accepted_observation.disposition = 'PROCESSED'"
    : "";
  const progressDisposition = hasPageStability
    ? "WHERE observation.disposition = 'PROCESSED'"
    : "";
  const rawEventDisposition = hasPageStability
    ? " AND accepted_observation.disposition = 'PROCESSED'"
    : "";
  const observationSequenceIntegrity = hasPageStability
    ? `
         UNION ALL

         SELECT 'ingest_page_observation_sequence' AS subject
          WHERE (SELECT COUNT(*) FROM ingest_run_page_observations) !=
                (SELECT COALESCE(MAX(observation_sequence), 0)
                   FROM ingest_run_page_observations)`
    : "";
  const observationTransitionIntegrity = hasPageStability
    ? `
         UNION ALL

         SELECT 'ingest_page_observation_transition:' || ordered.observation_sequence AS subject
           FROM (
             SELECT observation.observation_sequence,
                    observation.disposition,
                    observation.transition_enforced,
                    page.response_fingerprint,
                    LAG(page.response_fingerprint) OVER (
                      PARTITION BY page.provider_account_key, page.request_fingerprint
                      ORDER BY observation.observation_sequence
                    ) AS previous_response_fingerprint
               FROM ingest_run_page_observations AS observation
               JOIN provider_raw_pages AS page ON page.raw_page_id = observation.raw_page_id
           ) AS ordered
          WHERE ordered.transition_enforced NOT IN (0, 1)
             OR (ordered.transition_enforced = 0 AND ordered.disposition != 'PROCESSED')
             OR (ordered.transition_enforced = 0 AND EXISTS (
                   SELECT 1
                     FROM ingest_run_page_observations AS earlier
                    WHERE earlier.transition_enforced = 1
                      AND earlier.observation_sequence < ordered.observation_sequence
                ))
             OR (ordered.transition_enforced = 1 AND (
                   (ordered.previous_response_fingerprint IS NULL AND
                    ordered.disposition != 'PROCESSED') OR
                   (ordered.previous_response_fingerprint = ordered.response_fingerprint AND
                    ordered.disposition != 'PROCESSED') OR
                   (ordered.previous_response_fingerprint != ordered.response_fingerprint AND
                    ordered.disposition != 'REJECTED_VARIANT')
                ))`
    : "";
  const row = connection.prepare(
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT page.raw_page_id AS subject
           FROM provider_raw_pages AS page
           LEFT JOIN ingest_runs AS run ON run.ingest_run_id = page.ingest_run_id
          WHERE run.ingest_run_id IS NULL
             OR run.provider_account_key != page.provider_account_key
             OR run.page_size != page.page_size
             OR page.page_no != 1
             OR NOT EXISTS (
               SELECT 1
                 FROM ingest_run_page_observations AS page_observation
                 JOIN ingest_segments AS page_segment
                   ON page_segment.ingest_segment_id = page_observation.ingest_segment_id
                WHERE page_observation.raw_page_id = page.raw_page_id
                  AND page_segment.window_start = page.window_start
                  AND page_segment.window_end = page.window_end
             )

         UNION ALL

         SELECT observation.ingest_segment_id || ':' || observation.raw_page_id AS subject
           FROM ingest_run_page_observations AS observation
            LEFT JOIN ingest_runs AS run ON run.ingest_run_id = observation.ingest_run_id
            LEFT JOIN ingest_segments AS segment
              ON segment.ingest_segment_id = observation.ingest_segment_id
            LEFT JOIN provider_raw_pages AS page ON page.raw_page_id = observation.raw_page_id
           WHERE run.ingest_run_id IS NULL
              OR segment.ingest_segment_id IS NULL
              OR page.raw_page_id IS NULL
              OR segment.ingest_run_id != run.ingest_run_id
              OR run.provider_account_key != page.provider_account_key
              OR segment.window_start != page.window_start
              OR segment.window_end != page.window_end
              OR run.page_size != page.page_size
               OR page.page_no != 1
               OR observation.http_status != page.http_status
               OR observation.signature_verified != 1
${observationIntegrity}

${observationSequenceIntegrity}

${observationTransitionIntegrity}

         UNION ALL

         SELECT segment.ingest_segment_id AS subject
           FROM ingest_segments AS segment
           LEFT JOIN ingest_runs AS run ON run.ingest_run_id = segment.ingest_run_id
           LEFT JOIN ingest_segments AS parent
             ON parent.ingest_segment_id = segment.parent_segment_id
           LEFT JOIN provider_raw_pages AS accepted
             ON accepted.raw_page_id = segment.accepted_raw_page_id
          WHERE run.ingest_run_id IS NULL
             OR (segment.parent_segment_id IS NULL AND (
                   segment.depth != 0 OR
                   segment.window_start != run.window_start OR
                   segment.window_end != run.window_end
                ))
             OR (segment.parent_segment_id IS NOT NULL AND (
                   parent.ingest_segment_id IS NULL OR
                   parent.ingest_run_id != segment.ingest_run_id OR
                   parent.state != 'SPLIT' OR
                   segment.depth != parent.depth + 1 OR
                   segment.window_start < parent.window_start OR
                   segment.window_end > parent.window_end
                ))
             OR (segment.state = 'COMPLETE' AND (
                   accepted.raw_page_id IS NULL OR
                   accepted.provider_account_key != run.provider_account_key OR
                   accepted.window_start != segment.window_start OR
                   accepted.window_end != segment.window_end OR
                   accepted.page_no != 1 OR
                   accepted.has_more != 0 OR
                   NOT EXISTS (
                     SELECT 1
                       FROM ingest_run_page_observations AS accepted_observation
                      WHERE accepted_observation.ingest_run_id = segment.ingest_run_id
                        AND accepted_observation.ingest_segment_id = segment.ingest_segment_id
                        AND accepted_observation.raw_page_id = segment.accepted_raw_page_id
                        AND accepted_observation.observation_kind = 'ACCEPTED_LEAF'${acceptedDisposition}
                   )
                 ))
             OR (segment.state = 'SPLIT' AND (
                   (SELECT COUNT(*) FROM ingest_segments AS child
                     WHERE child.parent_segment_id = segment.ingest_segment_id) != 2 OR
                   NOT EXISTS (
                     SELECT 1 FROM ingest_segments AS left_child
                      WHERE left_child.parent_segment_id = segment.ingest_segment_id
                        AND left_child.window_start = segment.window_start
                        AND left_child.window_end = segment.split_at
                   ) OR
                   NOT EXISTS (
                     SELECT 1 FROM ingest_segments AS right_child
                      WHERE right_child.parent_segment_id = segment.ingest_segment_id
                        AND right_child.window_start = segment.split_at
                        AND right_child.window_end = segment.window_end
                   )
                ))
             OR (segment.state = 'PENDING' AND run.status = 'RUNNING' AND EXISTS (
                   SELECT 1
                     FROM ingest_run_page_observations AS pending_observation
                    WHERE pending_observation.ingest_segment_id = segment.ingest_segment_id
                ))

         UNION ALL

         SELECT raw.raw_event_id AS subject
           FROM provider_raw_events AS raw
           LEFT JOIN provider_raw_pages AS page ON page.raw_page_id = raw.raw_page_id
          WHERE page.raw_page_id IS NULL
             OR raw.provider_account_key != page.provider_account_key
             OR NOT EXISTS (
                  SELECT 1
                    FROM ingest_run_page_observations AS accepted_observation
                   WHERE accepted_observation.raw_page_id = raw.raw_page_id
                     AND accepted_observation.observation_kind = 'ACCEPTED_LEAF'${rawEventDisposition}
                )

         UNION ALL

         SELECT entry.ledger_entry_id AS subject
           FROM ledger_entries AS entry
           LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = entry.raw_event_id
          WHERE raw.raw_event_id IS NULL
             OR entry.provider_account_key != raw.provider_account_key
             OR entry.external_event_id != raw.external_event_id

         UNION ALL

         SELECT conflict.conflict_id AS subject
           FROM ledger_conflicts AS conflict
           LEFT JOIN provider_raw_pages AS page ON page.raw_page_id = conflict.raw_page_id
           LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = conflict.raw_event_id
           LEFT JOIN ledger_entries AS entry
             ON entry.ledger_entry_id = conflict.existing_ledger_entry_id
          WHERE (conflict.raw_page_id IS NOT NULL AND (
                   page.raw_page_id IS NULL OR
                   page.provider_account_key != conflict.provider_account_key
                ))
             OR (conflict.raw_event_id IS NOT NULL AND (
                   raw.raw_event_id IS NULL OR
                   raw.provider_account_key != conflict.provider_account_key
                ))
             OR (conflict.existing_ledger_entry_id IS NOT NULL AND (
                   entry.ledger_entry_id IS NULL OR
                   entry.provider_account_key != conflict.provider_account_key
                ))
             OR (conflict.raw_page_id IS NOT NULL AND conflict.raw_event_id IS NOT NULL AND
                 raw.raw_page_id != conflict.raw_page_id)

         UNION ALL

         SELECT error.ingest_error_id AS subject
           FROM ingest_errors AS error
           LEFT JOIN ingest_runs AS run ON run.ingest_run_id = error.ingest_run_id
          WHERE run.ingest_run_id IS NULL
             OR run.provider_account_key != error.provider_account_key

         UNION ALL

         SELECT run.ingest_run_id AS subject
           FROM ingest_runs AS run
           LEFT JOIN ledger_cursors AS cursor
             ON cursor.provider_account_key = run.provider_account_key
          WHERE run.status = 'RUNNING'
            AND (
              cursor.provider_account_key IS NULL OR
              cursor.window_start != run.window_start OR
              cursor.window_end != run.window_end OR
              cursor.page_size != run.page_size OR
              cursor.complete != 0 OR
              cursor.next_page_no != 1 OR
              NOT EXISTS (
                SELECT 1 FROM ingest_segments AS pending
                 WHERE pending.ingest_run_id = run.ingest_run_id
                   AND pending.state = 'PENDING'
              )
            )

         UNION ALL

         SELECT run.ingest_run_id AS subject
           FROM ingest_runs AS run
          WHERE run.status = 'COMPLETED'
            AND EXISTS (
              SELECT 1 FROM ingest_segments AS pending
               WHERE pending.ingest_run_id = run.ingest_run_id
                 AND pending.state = 'PENDING'
            )

         UNION ALL

         SELECT run.ingest_run_id AS subject
           FROM ingest_runs AS run
           LEFT JOIN (
             SELECT
                observation.ingest_run_id,
                COUNT(*) AS page_count,
                 COALESCE(SUM((
                   SELECT COUNT(*)
                     FROM provider_raw_events AS raw
                    WHERE raw.raw_page_id = observation.raw_page_id
                     AND observation.observation_kind = 'ACCEPTED_LEAF'
                 )), 0) AS detail_count
              FROM ingest_run_page_observations AS observation
             ${progressDisposition}
              GROUP BY observation.ingest_run_id
           ) AS progress ON progress.ingest_run_id = run.ingest_run_id
          WHERE run.pages_received != COALESCE(progress.page_count, 0)
             OR run.details_received != COALESCE(progress.detail_count, 0)
       )`,
  ).get() as { violations: bigint | number };
  const violations = Number(row.violations);
  if (!Number.isSafeInteger(violations) || violations < 0) {
    throw new Error("ledger domain integrity violation count is invalid");
  }
  return violations + pageStabilitySchemaViolations;
}

function countReconciliationDomainViolations(connection: DatabaseSync): number {
  const requiredTables = [
    "financial_operations",
    "match_candidates",
    "payment_matches",
    "ledger_transactions",
    "ledger_postings",
    "refund_records",
    "financial_exceptions",
    "outbox_events",
  ] as const;
  if (requiredTables.some((table) => !tableExists(connection, table))) return 0;
  const appliedSchemaVersion = tableExists(connection, "schema_migrations")
    ? Number((connection.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get() as { version: bigint | number }).version)
    : 0;
  const supportsLegacyProviderConflictState =
    Number.isSafeInteger(appliedSchemaVersion) &&
    appliedSchemaVersion > 0 &&
    appliedSchemaVersion < PROVIDER_CONFLICT_STATE_FIX_VERSION;
  const legacyProviderConflictState = supportsLegacyProviderConflictState
    ? `(
           entry.state = 'CONFLICT' AND
           EXISTS (
             SELECT 1
               FROM ledger_conflicts AS provider_conflict
              WHERE provider_conflict.existing_ledger_entry_id = entry.ledger_entry_id
                AND provider_conflict.conflict_type = 'DUPLICATE_EXTERNAL_ID'
           )
         )`
    : "0";

  const candidateViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM match_candidates AS candidate
       LEFT JOIN ledger_entries AS entry
         ON entry.ledger_entry_id = candidate.ledger_entry_id
       LEFT JOIN payment_orders AS orders
         ON orders.order_id = candidate.order_id
       LEFT JOIN collection_profiles AS profile
         ON profile.profile_id = orders.collection_profile_id
       LEFT JOIN amount_slots AS slot
         ON slot.slot_id = candidate.slot_id
       LEFT JOIN financial_operations AS decision
         ON decision.financial_operation_id = candidate.decided_by_operation_id
      WHERE entry.ledger_entry_id IS NULL
         OR orders.order_id IS NULL
         OR profile.profile_id IS NULL
         OR slot.slot_id IS NULL
         OR entry.provider_account_key != profile.provider_account_key
         OR entry.direction != 'CREDIT'
         OR entry.currency != orders.currency
         OR entry.amount_cents != orders.payable_amount_cents
         OR entry.occurred_at + entry.occurred_at_precision_ms <= orders.eligible_from
         OR entry.occurred_at + entry.occurred_at_precision_ms <= slot.occupied_from
         OR entry.occurred_at >= orders.expires_at
         OR (slot.released_at IS NOT NULL AND entry.occurred_at >= slot.released_at)
         OR slot.order_id != orders.order_id
         OR slot.collection_profile_id != orders.collection_profile_id
         OR slot.payable_amount_cents != orders.payable_amount_cents
         OR (
           (candidate.status = 'ELIGIBLE' AND
            (candidate.decided_by_operation_id IS NOT NULL OR candidate.decided_at IS NOT NULL)) OR
           (candidate.status IN ('SELECTED', 'SUPERSEDED') AND
            (candidate.decided_by_operation_id IS NULL OR candidate.decided_at IS NULL)) OR
           (candidate.decided_by_operation_id IS NOT NULL AND (
             decision.financial_operation_id IS NULL OR
             decision.order_id != candidate.order_id OR
             decision.ledger_entry_id != candidate.ledger_entry_id OR
             (candidate.status = 'SELECTED' AND decision.operation_type != 'AUTO_SETTLEMENT') OR
             (candidate.status = 'SUPERSEDED' AND decision.operation_type != 'SUPERSEDE_CANDIDATE')
           ))
         )`,
    "reconciliation candidate",
  );

  const matchViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM payment_matches AS payment_match
       LEFT JOIN ledger_entries AS entry
         ON entry.ledger_entry_id = payment_match.ledger_entry_id
       LEFT JOIN payment_orders AS orders
         ON orders.order_id = payment_match.order_id
       LEFT JOIN match_candidates AS candidate
         ON candidate.candidate_id = payment_match.candidate_id
       LEFT JOIN financial_operations AS creation
         ON creation.financial_operation_id = payment_match.created_by_operation_id
       LEFT JOIN financial_operations AS resolution
         ON resolution.financial_operation_id = payment_match.resolved_by_operation_id
      WHERE entry.ledger_entry_id IS NULL
         OR orders.order_id IS NULL
         OR entry.currency != orders.currency
         OR creation.financial_operation_id IS NULL
         OR creation.order_id != payment_match.order_id
         OR creation.ledger_entry_id != payment_match.ledger_entry_id
         OR (
           payment_match.evidence_type = 'AMOUNT_INFERRED' AND (
             candidate.candidate_id IS NULL OR
             candidate.ledger_entry_id != payment_match.ledger_entry_id OR
             candidate.order_id != payment_match.order_id OR
             candidate.evidence_json != payment_match.evidence_json OR
             creation.operation_type != 'AUTO_SETTLEMENT'
           )
         )
         OR (
           payment_match.evidence_type = 'MANUAL' AND (
             payment_match.candidate_id IS NOT NULL OR
             creation.operation_type != 'MANUAL_SETTLEMENT'
           )
         )
         OR (
           payment_match.status = 'SETTLED' AND (
             (entry.state != 'ALLOCATED' AND NOT ${legacyProviderConflictState}) OR
             orders.payment_status != 'CONFIRMED' OR
             orders.payment_basis NOT IN ('INFERRED', 'MANUAL') OR
             orders.received_amount_cents != entry.amount_cents OR
             resolution.operation_type NOT IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT') OR
             (candidate.candidate_id IS NOT NULL AND candidate.status != 'SELECTED')
           )
         )
         OR (
           payment_match.status = 'REVERSED' AND (
             resolution.operation_type != 'REVERSE_SETTLEMENT' OR
             (
               entry.state != 'CONFLICT' AND
               NOT EXISTS (
                 SELECT 1 FROM payment_matches AS replacement
                  WHERE replacement.ledger_entry_id = payment_match.ledger_entry_id
                    AND replacement.status = 'SETTLED'
               )
             ) OR
             orders.payment_status != 'DISPUTED'
           )
         )`,
    "reconciliation match",
  );

  const paymentMatchEventViolations = tableExists(connection, "payment_match_events")
    ? readViolationCount(
        connection,
        `SELECT COUNT(*) AS violations
           FROM (
             SELECT match_event.event_sequence AS subject
               FROM payment_match_events AS match_event
               LEFT JOIN payment_matches AS payment_match
                 ON payment_match.payment_match_id = match_event.payment_match_id
              WHERE payment_match.payment_match_id IS NULL
                 OR match_event.status NOT IN ('SETTLED', 'REVERSED')
                 OR (match_event.status = payment_match.status AND
                     match_event.occurred_at != payment_match.updated_at)
                 OR (match_event.status = 'SETTLED' AND
                     match_event.occurred_at != payment_match.created_at)
                 OR (match_event.status = 'REVERSED' AND payment_match.status != 'REVERSED')

             UNION ALL

             SELECT payment_match.payment_match_id AS subject
               FROM payment_matches AS payment_match
              WHERE (SELECT COUNT(*) FROM payment_match_events AS match_event
                      WHERE match_event.payment_match_id = payment_match.payment_match_id) !=
                    CASE WHEN payment_match.status = 'SETTLED' THEN 1 ELSE 2 END

             UNION ALL

             SELECT 'payment_match_event_sequence' AS subject
              WHERE (SELECT COUNT(*) FROM payment_match_events) !=
                    (SELECT COALESCE(MAX(event_sequence), 0) FROM payment_match_events)
           )`,
        "payment match event",
      )
    : 0;

  const effectiveStateViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT entry.ledger_entry_id AS subject
           FROM ledger_entries AS entry
          WHERE (
                  entry.state = 'ALLOCATED' AND
                  (
                    (SELECT COUNT(*) FROM payment_matches AS active
                      WHERE active.ledger_entry_id = entry.ledger_entry_id
                        AND active.status = 'SETTLED') +
                    (SELECT COUNT(*) FROM refund_records AS refund
                      WHERE refund.ledger_entry_id = entry.ledger_entry_id)
                  ) != 1
                )
             OR (
                  entry.state IN ('UNALLOCATED', 'CONFLICT', 'ISOLATED', 'IGNORED') AND
                  EXISTS (SELECT 1 FROM payment_matches AS active
                           WHERE active.ledger_entry_id = entry.ledger_entry_id
                             AND active.status = 'SETTLED') AND
                  NOT ${legacyProviderConflictState}
                )
             OR (
                  entry.state = 'CANDIDATE' AND
                  NOT EXISTS (SELECT 1 FROM payment_matches AS active
                               WHERE active.ledger_entry_id = entry.ledger_entry_id
                                 AND active.status = 'SETTLED') AND
                  (SELECT COUNT(*) FROM match_candidates AS possible
                    WHERE possible.ledger_entry_id = entry.ledger_entry_id
                      AND possible.status = 'ELIGIBLE') < 2
                )

         UNION ALL

         SELECT orders.order_id AS subject
           FROM payment_orders AS orders
          WHERE (
                  orders.payment_status = 'CONFIRMED' AND
                  (SELECT COUNT(*) FROM payment_matches AS active
                    WHERE active.order_id = orders.order_id
                      AND active.status = 'SETTLED') != 1
                )
             OR (
                  orders.payment_status IN ('UNPAID', 'DISPUTED') AND
                  EXISTS (SELECT 1 FROM payment_matches AS active
                           WHERE active.order_id = orders.order_id
                             AND active.status = 'SETTLED')
                )
       )`,
    "reconciliation effective state",
  );

  const accountingViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT ledger_transaction.ledger_transaction_id AS subject
            FROM ledger_transactions AS ledger_transaction
            LEFT JOIN financial_operations AS operation
              ON operation.financial_operation_id = ledger_transaction.financial_operation_id
            LEFT JOIN ledger_entries AS entry
              ON entry.ledger_entry_id = ledger_transaction.ledger_entry_id
          WHERE ledger_transaction.status != 'POSTED'
             OR operation.financial_operation_id IS NULL
             OR operation.order_id IS NOT ledger_transaction.order_id
             OR operation.ledger_entry_id IS NOT ledger_transaction.ledger_entry_id
             OR (ledger_transaction.transaction_type = 'SETTLEMENT' AND operation.operation_type NOT IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT'))
             OR (ledger_transaction.transaction_type = 'REVERSAL' AND operation.operation_type != 'REVERSE_SETTLEMENT')
             OR (ledger_transaction.transaction_type = 'REFUND' AND operation.operation_type != 'RECORD_REFUND')
             OR (SELECT COUNT(*) FROM ledger_postings AS posting
                  WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id) < 2
             OR COALESCE((SELECT SUM(posting.amount_cents) FROM ledger_postings AS posting
                           WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                             AND posting.side = 'DEBIT'), 0)
                 != COALESCE((SELECT SUM(posting.amount_cents) FROM ledger_postings AS posting
                               WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                                 AND posting.side = 'CREDIT'), 0)
             OR (
                  ledger_transaction.transaction_type IN ('SETTLEMENT', 'REVERSAL', 'REFUND') AND
                  (
                    entry.ledger_entry_id IS NULL OR
                    (SELECT COUNT(*) FROM ledger_postings AS posting
                      WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id) != 2 OR
                    (
                      ledger_transaction.transaction_type = 'SETTLEMENT' AND
                      (
                        entry.direction != 'CREDIT' OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'PROVIDER_CASH'
                            AND posting.side = 'DEBIT'
                            AND posting.amount_cents = entry.amount_cents) != 1 OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'ORDER_SETTLEMENT'
                            AND posting.side = 'CREDIT'
                            AND posting.amount_cents = entry.amount_cents) != 1
                      )
                    ) OR
                    (
                      ledger_transaction.transaction_type = 'REVERSAL' AND
                      (
                        entry.direction != 'CREDIT' OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'ORDER_SETTLEMENT'
                            AND posting.side = 'DEBIT'
                            AND posting.amount_cents = entry.amount_cents) != 1 OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'PROVIDER_CASH'
                            AND posting.side = 'CREDIT'
                            AND posting.amount_cents = entry.amount_cents) != 1
                      )
                    ) OR
                    (
                      ledger_transaction.transaction_type = 'REFUND' AND
                      (
                        entry.direction != 'DEBIT' OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'REFUND_CLEARING'
                            AND posting.side = 'DEBIT'
                            AND posting.amount_cents = entry.amount_cents) != 1 OR
                        (SELECT COUNT(*) FROM ledger_postings AS posting
                          WHERE posting.ledger_transaction_id = ledger_transaction.ledger_transaction_id
                            AND posting.account_code = 'PROVIDER_CASH'
                            AND posting.side = 'CREDIT'
                            AND posting.amount_cents = entry.amount_cents) != 1
                      )
                    )
                  )
                )

         UNION ALL

         SELECT posting.posting_id AS subject
           FROM ledger_postings AS posting
           LEFT JOIN ledger_transactions AS ledger_transaction
             ON ledger_transaction.ledger_transaction_id = posting.ledger_transaction_id
          WHERE ledger_transaction.ledger_transaction_id IS NULL
             OR posting.currency != ledger_transaction.currency
             OR posting.order_id IS NOT ledger_transaction.order_id
             OR posting.ledger_entry_id IS NOT ledger_transaction.ledger_entry_id
       )`,
    "financial ledger",
  );

  const operationViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM financial_operations AS operation
      WHERE (operation.operation_type = 'AUTO_SETTLEMENT' AND (
               (SELECT COUNT(*) FROM match_candidates AS candidate
                 WHERE candidate.decided_by_operation_id = operation.financial_operation_id
                   AND candidate.status = 'SELECTED') != 1 OR
               (SELECT COUNT(*) FROM payment_matches AS payment_match
                 WHERE payment_match.created_by_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM ledger_transactions AS ledger_transaction
                 WHERE ledger_transaction.financial_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM outbox_events AS outbox
                 WHERE outbox.financial_operation_id = operation.financial_operation_id) != 1
             ))
         OR (operation.operation_type = 'SUPERSEDE_CANDIDATE' AND
               (SELECT COUNT(*) FROM match_candidates AS candidate
                 WHERE candidate.decided_by_operation_id = operation.financial_operation_id) != 1)
         OR (operation.operation_type = 'MANUAL_SETTLEMENT' AND (
               (SELECT COUNT(*) FROM payment_matches AS payment_match
                 WHERE payment_match.created_by_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM ledger_transactions AS ledger_transaction
                 WHERE ledger_transaction.financial_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM outbox_events AS outbox
                 WHERE outbox.financial_operation_id = operation.financial_operation_id) != 1
             ))
         OR (operation.operation_type = 'REVERSE_SETTLEMENT' AND (
               (SELECT COUNT(*) FROM payment_matches AS payment_match
                 WHERE payment_match.resolved_by_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM ledger_transactions AS ledger_transaction
                 WHERE ledger_transaction.financial_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM outbox_events AS outbox
                 WHERE outbox.financial_operation_id = operation.financial_operation_id) != 1
             ))
         OR (operation.operation_type = 'RECORD_REFUND' AND (
               (SELECT COUNT(*) FROM refund_records AS refund
                 WHERE refund.financial_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM ledger_transactions AS ledger_transaction
                 WHERE ledger_transaction.financial_operation_id = operation.financial_operation_id) != 1 OR
               (SELECT COUNT(*) FROM outbox_events AS outbox
                 WHERE outbox.financial_operation_id = operation.financial_operation_id) != 1
             ))`,
    "financial operation",
  );

  const orderEventOperationViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT event.event_id AS subject
           FROM order_events AS event
           LEFT JOIN financial_operations AS operation
             ON operation.financial_operation_id =
                json_extract(event.details_json, '$.financial_operation_id')
          WHERE event.event_type IN (
                  'PAYMENT_CONFIRMED', 'PAYMENT_DISPUTED', 'REFUND_UPDATED'
                )
            AND (
              json_type(event.details_json, '$.financial_operation_id') IS NOT 'text' OR
              operation.financial_operation_id IS NULL OR
              operation.order_id IS NOT event.order_id OR
              operation.created_at != event.occurred_at OR
              NOT (
                (event.event_type = 'PAYMENT_CONFIRMED' AND
                 operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')) OR
                (event.event_type = 'PAYMENT_DISPUTED' AND
                 operation.operation_type = 'REVERSE_SETTLEMENT') OR
                (event.event_type = 'REFUND_UPDATED' AND
                 operation.operation_type = 'RECORD_REFUND')
              ) OR
              (
                event.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_DISPUTED', 'REFUND_UPDATED') AND
                (SELECT COUNT(*)
                   FROM outbox_events AS outbox
                  WHERE outbox.financial_operation_id = operation.financial_operation_id
                    AND outbox.aggregate_type = 'PAYMENT_ORDER'
                    AND outbox.aggregate_id = event.order_id
                    AND outbox.aggregate_version = event.sequence
                    AND outbox.event_type = event.event_type
                    AND outbox.created_at = event.occurred_at) != 1
              )
            )

         UNION ALL

         SELECT operation.financial_operation_id AS subject
           FROM financial_operations AS operation
          WHERE operation.operation_type IN (
                  'AUTO_SETTLEMENT',
                  'MANUAL_SETTLEMENT', 'REVERSE_SETTLEMENT', 'RECORD_REFUND'
                )
            AND (
              operation.order_id IS NULL OR
              (SELECT COUNT(*)
                 FROM order_events AS event
                WHERE json_type(event.details_json, '$.financial_operation_id') = 'text'
                  AND json_extract(event.details_json, '$.financial_operation_id') =
                      operation.financial_operation_id
                  AND event.order_id = operation.order_id
                  AND event.occurred_at = operation.created_at
                  AND (
                    (event.event_type = 'PAYMENT_CONFIRMED' AND
                     operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')) OR
                    (event.event_type = 'PAYMENT_DISPUTED' AND
                     operation.operation_type = 'REVERSE_SETTLEMENT') OR
                    (event.event_type = 'REFUND_UPDATED' AND
                     operation.operation_type = 'RECORD_REFUND')
                  )) != 1
            )
       )`,
    "order event financial operation",
  );

  const exceptionAndOutboxViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT exception.exception_id AS subject
           FROM financial_exceptions AS exception
           LEFT JOIN ledger_entries AS entry
             ON entry.ledger_entry_id = exception.ledger_entry_id
           LEFT JOIN match_candidates AS candidate
             ON candidate.candidate_id = exception.candidate_id
           LEFT JOIN financial_operations AS resolution
             ON resolution.financial_operation_id = exception.resolution_operation_id
          WHERE (exception.ledger_entry_id IS NOT NULL AND (
                   entry.ledger_entry_id IS NULL OR
                   entry.provider_account_key != exception.provider_account_key
                 ))
             OR (exception.candidate_id IS NOT NULL AND (
                   candidate.candidate_id IS NULL OR
                   candidate.ledger_entry_id IS NOT exception.ledger_entry_id OR
                   candidate.order_id IS NOT exception.order_id
                 ))
              OR (exception.status != 'OPEN' AND (
                    resolution.financial_operation_id IS NULL OR
                    resolution.operation_type NOT IN (
                      'AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT', 'RECORD_REFUND'
                    ) OR
                    (exception.ledger_entry_id IS NOT NULL AND resolution.ledger_entry_id IS NOT exception.ledger_entry_id) OR
                    (exception.order_id IS NOT NULL AND resolution.order_id IS NOT exception.order_id) OR
                    resolution.created_at != exception.resolved_at
                  ))

         UNION ALL

         SELECT outbox.outbox_event_id AS subject
           FROM outbox_events AS outbox
           LEFT JOIN payment_orders AS orders
             ON orders.order_id = outbox.aggregate_id
           LEFT JOIN financial_operations AS operation
             ON operation.financial_operation_id = outbox.financial_operation_id
          WHERE orders.order_id IS NULL
             OR operation.financial_operation_id IS NULL
             OR operation.order_id != outbox.aggregate_id
             OR json_extract(outbox.payload_json, '$.event_id') != outbox.outbox_event_id
             OR json_extract(outbox.payload_json, '$.event_type') != outbox.event_type
             OR json_extract(outbox.payload_json, '$.financial_operation_id') != outbox.financial_operation_id
             OR json_extract(outbox.payload_json, '$.order_id') != outbox.aggregate_id
             OR json_extract(outbox.payload_json, '$.order_version') != outbox.aggregate_version
             OR json_extract(outbox.payload_json, '$.occurred_at') != outbox.created_at
       )`,
    "financial exception or outbox",
  );

  const refundViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM refund_records AS refund
       LEFT JOIN financial_operations AS operation
         ON operation.financial_operation_id = refund.financial_operation_id
       LEFT JOIN ledger_entries AS entry
         ON entry.ledger_entry_id = refund.ledger_entry_id
       LEFT JOIN payment_orders AS orders
         ON orders.order_id = refund.order_id
       LEFT JOIN ledger_transactions AS ledger_transaction
         ON ledger_transaction.financial_operation_id = refund.financial_operation_id
       LEFT JOIN outbox_events AS outbox
         ON outbox.financial_operation_id = refund.financial_operation_id
      WHERE operation.operation_type != 'RECORD_REFUND'
         OR operation.order_id != refund.order_id
         OR operation.ledger_entry_id != refund.ledger_entry_id
         OR entry.direction != 'DEBIT'
         OR entry.currency != orders.currency
         OR entry.amount_cents != refund.amount_cents
         OR entry.state != 'ALLOCATED'
         OR orders.payment_status NOT IN ('CONFIRMED', 'DISPUTED')
         OR orders.refund_status NOT IN ('PARTIAL', 'FULL')
         OR ledger_transaction.transaction_type != 'REFUND'
         OR outbox.event_type != 'REFUND_UPDATED'`,
    "refund record",
  );

  const refundAggregateViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT orders.order_id
           FROM payment_orders AS orders
           LEFT JOIN refund_records AS refund
             ON refund.order_id = orders.order_id
          GROUP BY orders.order_id, orders.received_amount_cents, orders.refund_status
         HAVING
           (COALESCE(SUM(refund.amount_cents), 0) = 0 AND orders.refund_status != 'NONE') OR
           (
             COALESCE(SUM(refund.amount_cents), 0) > 0 AND
             COALESCE(SUM(refund.amount_cents), 0) < orders.received_amount_cents AND
             orders.refund_status != 'PARTIAL'
           ) OR
           (
             COALESCE(SUM(refund.amount_cents), 0) = orders.received_amount_cents AND
             orders.refund_status != 'FULL'
           ) OR
           COALESCE(SUM(refund.amount_cents), 0) > orders.received_amount_cents
       )`,
    "refund aggregate",
  );

  return candidateViolations + matchViolations + paymentMatchEventViolations + effectiveStateViolations +
    accountingViolations + operationViolations + orderEventOperationViolations +
    exceptionAndOutboxViolations + refundViolations + refundAggregateViolations;
}

function countWebhookDomainViolations(connection: DatabaseSync): number {
  const requiredTables = [
    "webhook_targets",
    "webhook_signing_keys",
    "webhook_deliveries",
    "webhook_attempts",
  ] as const;
  if (requiredTables.some((table) => !tableExists(connection, table))) return 0;

  const targetViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM webhook_targets AS target
       LEFT JOIN payment_orders AS orders ON orders.order_id = target.order_id
      WHERE orders.order_id IS NULL
         OR orders.api_client_id != target.api_client_id
         OR orders.created_at != target.created_at
         OR orders.webhook_target_request_fingerprint IS NULL
         OR orders.webhook_target_request_fingerprint != target.request_fingerprint`,
    "webhook target",
  );
  const targetCommitmentViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM payment_orders AS orders
       LEFT JOIN webhook_targets AS target ON target.order_id = orders.order_id
      WHERE orders.webhook_target_request_fingerprint IS NOT NULL
        AND target.target_id IS NULL`,
    "webhook target commitment",
  );
  const signingKeyViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM (
         SELECT key_version
           FROM (
             SELECT key_version,
                    ROW_NUMBER() OVER (ORDER BY key_version) AS expected_version
               FROM webhook_signing_keys
           )
          WHERE key_version != expected_version

         UNION ALL

         SELECT 0
          WHERE (SELECT COUNT(*) FROM webhook_signing_keys WHERE retired_at IS NULL) > 1

         UNION ALL

         SELECT active.key_version
           FROM webhook_signing_keys AS active
          WHERE active.retired_at IS NULL
            AND active.key_version != (SELECT MAX(key_version) FROM webhook_signing_keys)

         UNION ALL

         SELECT current.key_version
           FROM webhook_signing_keys AS current
           JOIN webhook_signing_keys AS next
             ON next.key_version = current.key_version + 1
          WHERE current.retired_at IS NULL
             OR current.retired_at > next.activated_at
       )`,
    "webhook signing key",
  );
  const deliveryViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM webhook_deliveries AS delivery
       LEFT JOIN outbox_events AS outbox
         ON outbox.outbox_event_id = delivery.outbox_event_id
       LEFT JOIN webhook_targets AS target
         ON target.target_id = delivery.target_id
       LEFT JOIN webhook_deliveries AS predecessor
         ON predecessor.delivery_id = delivery.predecessor_delivery_id
      WHERE outbox.outbox_event_id IS NULL
         OR target.target_id IS NULL
         OR outbox.aggregate_id != target.order_id
         OR (
           delivery.generation = 1 AND (
             delivery.requested_by_type != 'SYSTEM' OR
             delivery.request_key != delivery.outbox_event_id OR
             delivery.predecessor_delivery_id IS NOT NULL
           )
         )
         OR (
           delivery.generation > 1 AND (
             delivery.requested_by_type != 'ADMIN' OR
             predecessor.delivery_id IS NULL OR
             predecessor.outbox_event_id != delivery.outbox_event_id OR
             predecessor.target_id != delivery.target_id OR
             predecessor.generation != delivery.generation - 1 OR
             predecessor.status NOT IN ('ACKNOWLEDGED', 'DEAD_LETTER')
           )
         )
         OR delivery.attempt_count != (
           SELECT COUNT(*) FROM webhook_attempts AS attempt
            WHERE attempt.delivery_id = delivery.delivery_id
         )
         OR (
           delivery.status = 'PENDING' AND delivery.attempt_count != 0
         )
         OR (
           delivery.status = 'LEASED' AND NOT EXISTS (
             SELECT 1 FROM webhook_attempts AS attempt
              WHERE attempt.delivery_id = delivery.delivery_id
                AND attempt.attempt_number = delivery.attempt_count
                AND attempt.lease_token = delivery.lease_token
                AND attempt.outcome = 'STARTED'
           )
         )
         OR (
           delivery.status = 'RETRY_WAIT' AND NOT EXISTS (
             SELECT 1 FROM webhook_attempts AS attempt
              WHERE attempt.delivery_id = delivery.delivery_id
                AND attempt.attempt_number = delivery.attempt_count
                AND attempt.outcome IN ('RETRYABLE_FAILURE', 'OUTCOME_UNKNOWN')
           )
         )
         OR (
           delivery.status = 'ACKNOWLEDGED' AND NOT EXISTS (
             SELECT 1 FROM webhook_attempts AS attempt
              WHERE attempt.delivery_id = delivery.delivery_id
                AND attempt.attempt_number = delivery.attempt_count
                AND attempt.outcome = 'ACKNOWLEDGED'
           )
         )
         OR (
           delivery.status = 'DEAD_LETTER' AND NOT EXISTS (
             SELECT 1 FROM webhook_attempts AS attempt
              WHERE attempt.delivery_id = delivery.delivery_id
                AND attempt.attempt_number = delivery.attempt_count
                AND attempt.outcome IN ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'OUTCOME_UNKNOWN')
           )
         )`,
    "webhook delivery",
  );
  const attemptViolations = readViolationCount(
    connection,
    `SELECT COUNT(*) AS violations
       FROM webhook_attempts AS attempt
       LEFT JOIN webhook_deliveries AS delivery
         ON delivery.delivery_id = attempt.delivery_id
       LEFT JOIN webhook_signing_keys AS signing_key
         ON signing_key.key_version = attempt.key_version
       LEFT JOIN outbox_events AS outbox
         ON outbox.outbox_event_id = delivery.outbox_event_id
      WHERE delivery.delivery_id IS NULL
         OR signing_key.key_version IS NULL
         OR outbox.outbox_event_id IS NULL
         OR attempt.request_body_fingerprint != outbox.payload_fingerprint
         OR attempt.attempt_number > delivery.attempt_count
         OR (
           attempt.outcome = 'STARTED' AND (
             delivery.status != 'LEASED' OR
             delivery.attempt_count != attempt.attempt_number OR
             delivery.lease_token != attempt.lease_token
           )
         )`,
    "webhook attempt",
  );
  return targetViolations + targetCommitmentViolations + signingKeyViolations +
    deliveryViolations + attemptViolations;
}

function readViolationCount(connection: DatabaseSync, sql: string, label: string): number {
  const row = connection.prepare(sql).get() as { violations: bigint | number };
  const violations = Number(row.violations);
  if (!Number.isSafeInteger(violations) || violations < 0) {
    throw new Error(`${label} domain integrity violation count is invalid`);
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
  return inspectAuditChain(connection).violations +
    countOrderCryptographicDomainViolations(connection) +
    countLedgerCryptographicDomainViolations(connection) +
    countReconciliationCryptographicDomainViolations(connection) +
    countWebhookCryptographicDomainViolations(connection);
}

function countOrderCryptographicDomainViolations(connection: DatabaseSync): number {
  if (
    !tableExists(connection, "collection_profiles") ||
    !tableExists(connection, "checkout_sessions") ||
    (!tableExists(connection, "checkout_token_keys") &&
      !tableExists(connection, "checkout_token_key"))
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

  if (columnExists(connection, "order_events", "details_fingerprint")) {
    for (const row of connection
      .prepare("SELECT details_json, details_fingerprint FROM order_events")
      .iterate() as Iterable<{ details_json: string; details_fingerprint: string | null }>) {
      if (
        row.details_fingerprint === null ||
        row.details_fingerprint !== orderEventDetailsFingerprint(row.details_json)
      ) {
        violations += 1;
      }
    }
  }

  if (tableExists(connection, "checkout_token_keys")) {
    try {
      const keys = readCheckoutTokenKeys(connection);
      assertCheckoutTokenKeySet(keys);
      assertCheckoutTokenKeysMatchSessions(connection, keys);
    } catch {
      violations += 1;
    }
    return violations;
  }

  const keyRow = connection.prepare(
    "SELECT key_material FROM checkout_token_key WHERE singleton_key = 1",
  ).get() as { key_material: Uint8Array } | undefined;
  if (!keyRow || !(keyRow.key_material instanceof Uint8Array) || keyRow.key_material.byteLength !== 32) {
    return violations;
  }
  for (const row of connection.prepare(
    "SELECT checkout_id, token_digest FROM checkout_sessions",
  ).iterate() as Iterable<{ checkout_id: string; token_digest: string }>) {
    try {
      const token = deriveCheckoutToken(keyRow.key_material, row.checkout_id);
      if (digestCheckoutToken(token) !== row.token_digest) violations += 1;
    } catch {
      violations += 1;
    }
  }
  return violations;
}

function countLedgerCryptographicDomainViolations(connection: DatabaseSync): number {
  let violations = 0;
  if (tableExists(connection, "provider_account_bindings")) {
    for (const row of connection
      .prepare(
        `SELECT provider_account_key, provider_kind, provider_endpoint,
                external_account_id, identity_fingerprint_version,
                identity_fingerprint
           FROM provider_account_bindings`,
      )
      .iterate() as Iterable<{
        provider_account_key: string;
        provider_kind: "alipay";
        provider_endpoint: string;
        external_account_id: string;
        identity_fingerprint_version: bigint | number;
        identity_fingerprint: string;
      }>) {
      try {
        const expected = normalizeProviderIdentity({
          providerAccountKey: row.provider_account_key,
          providerKind: row.provider_kind,
          endpoint: row.provider_endpoint,
          externalAccountId: row.external_account_id,
        });
        if (
          Number(row.identity_fingerprint_version) !== expected.identityFingerprintVersion ||
          row.identity_fingerprint !== expected.identityFingerprint
        ) {
          violations += 1;
        }
      } catch {
        violations += 1;
      }
    }
  }
  if (
    !tableExists(connection, "provider_raw_pages") ||
    !tableExists(connection, "provider_raw_events") ||
    !tableExists(connection, "ledger_entries") ||
    !tableExists(connection, "ledger_conflicts") ||
    !tableExists(connection, "ingest_errors")
  ) {
    return violations;
  }
  for (const row of connection
    .prepare(
      `SELECT provider_account_key, window_start, window_end, page_no, page_size,
              request_fingerprint, raw_body, response_fingerprint
         FROM provider_raw_pages`,
    )
    .iterate() as Iterable<{
      provider_account_key: string;
      window_start: string;
      window_end: string;
      page_no: bigint | number;
      page_size: bigint | number;
      request_fingerprint: string;
      raw_body: Uint8Array;
      response_fingerprint: string;
    }>) {
    const pageNo = Number(row.page_no);
    const pageSize = Number(row.page_size);
    if (!Number.isSafeInteger(pageNo) || pageNo < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1) {
      violations += 1;
    } else if (requestFingerprint(
      row.provider_account_key,
      row.window_start,
      row.window_end,
      pageNo,
      pageSize,
    ) !== row.request_fingerprint) {
      violations += 1;
    }
    if (!fingerprintMatches(row.raw_body, row.response_fingerprint)) violations += 1;
  }
  for (const row of connection
    .prepare("SELECT raw_payload, payload_fingerprint FROM provider_raw_events")
    .iterate() as Iterable<{ raw_payload: Uint8Array; payload_fingerprint: string }>) {
    if (!fingerprintMatches(row.raw_payload, row.payload_fingerprint)) violations += 1;
  }
  const hasPageObservationStability =
    columnExists(connection, "ingest_run_page_observations", "disposition") &&
    columnExists(connection, "ingest_run_page_observations", "observation_sequence") &&
    columnExists(connection, "ingest_run_page_observations", "transition_enforced");
  const variantObservationProjection = hasPageObservationStability
    ? `,
              previous_observation.raw_page_id AS previous_observation_raw_page_id,
              incoming_observation.raw_page_id AS incoming_observation_raw_page_id,
              incoming_observation.ingest_run_id AS incoming_observation_run_id,
              incoming_observation.observation_sequence AS incoming_observation_sequence,
              incoming_observation.disposition AS incoming_observation_disposition,
              incoming_observation.transition_enforced AS incoming_transition_enforced,
              (
                SELECT MAX(earlier_observation.observation_sequence)
                  FROM ingest_run_page_observations AS earlier_observation
                  JOIN provider_raw_pages AS earlier_page
                    ON earlier_page.raw_page_id = earlier_observation.raw_page_id
                 WHERE earlier_page.provider_account_key = page.provider_account_key
                   AND earlier_page.request_fingerprint = page.request_fingerprint
                   AND earlier_observation.observation_sequence <
                       incoming_observation.observation_sequence
              ) AS expected_previous_observation_sequence`
    : `,
              NULL AS previous_observation_raw_page_id,
              incoming_observation.raw_page_id AS incoming_observation_raw_page_id,
              incoming_observation.ingest_run_id AS incoming_observation_run_id,
              NULL AS incoming_observation_sequence,
              'PROCESSED' AS incoming_observation_disposition,
              0 AS incoming_transition_enforced,
              NULL AS expected_previous_observation_sequence`;
  const variantObservationJoins = hasPageObservationStability
    ? `
         LEFT JOIN ingest_run_page_observations AS previous_observation
           ON previous_observation.observation_sequence =
              json_extract(conflict.details_json, '$.previous_observation_sequence')`
    : "";
  for (const row of connection
    .prepare(
      `SELECT conflict.conflict_type, conflict.provider_account_key,
              conflict.raw_page_id, conflict.raw_event_id,
              conflict.external_event_id, conflict.existing_semantic_fingerprint,
              conflict.incoming_semantic_fingerprint, conflict.conflict_fingerprint,
              page.request_fingerprint AS incoming_request_fingerprint,
              page.response_fingerprint AS incoming_response_fingerprint,
              page.provider_account_key AS incoming_provider_account_key,
              page.ingest_run_id AS incoming_ingest_run_id,
              raw.payload_fingerprint, raw.ordinal,
              (SELECT COUNT(*) FROM json_each(conflict.details_json)) AS details_count,
              json_type(conflict.details_json, '$.request_fingerprint')
                AS detail_request_fingerprint_type,
              json_extract(conflict.details_json, '$.request_fingerprint')
                AS detail_request_fingerprint,
              json_type(conflict.details_json, '$.ingest_segment_id')
                AS detail_ingest_segment_id_type,
              json_extract(conflict.details_json, '$.ingest_segment_id')
                AS detail_ingest_segment_id,
              json_type(
                conflict.details_json,
                '$.previous_observation_sequence'
              ) AS detail_previous_observation_sequence_type,
              json_extract(
                conflict.details_json,
                '$.previous_observation_sequence'
              ) AS detail_previous_observation_sequence,
              json_type(conflict.details_json, '$.existing_raw_page_id')
                AS detail_existing_raw_page_id_type,
              json_extract(conflict.details_json, '$.existing_raw_page_id')
                AS detail_existing_raw_page_id,
              json_type(conflict.details_json, '$.incoming_raw_page_id')
                AS detail_incoming_raw_page_id_type,
              json_extract(conflict.details_json, '$.incoming_raw_page_id')
                AS detail_incoming_raw_page_id,
              json_type(
                conflict.details_json,
                '$.existing_occurred_at_precision_milliseconds'
              ) AS detail_existing_precision_type,
              json_extract(
                conflict.details_json,
                '$.existing_occurred_at_precision_milliseconds'
              ) AS detail_existing_precision,
              json_type(
                conflict.details_json,
                '$.incoming_occurred_at_precision_milliseconds'
              ) AS detail_incoming_precision_type,
              json_extract(
                conflict.details_json,
                '$.incoming_occurred_at_precision_milliseconds'
              ) AS detail_incoming_precision,
              detail_segment.ingest_run_id AS detail_segment_run_id,
              existing_page.provider_account_key AS existing_provider_account_key,
              existing_page.request_fingerprint AS existing_request_fingerprint,
              existing_page.response_fingerprint AS existing_response_fingerprint
              ${variantObservationProjection}
         FROM ledger_conflicts AS conflict
         LEFT JOIN provider_raw_pages AS page ON page.raw_page_id = conflict.raw_page_id
         LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = conflict.raw_event_id
         LEFT JOIN ingest_segments AS detail_segment
           ON detail_segment.ingest_segment_id =
              json_extract(conflict.details_json, '$.ingest_segment_id')
         LEFT JOIN provider_raw_pages AS existing_page
           ON existing_page.raw_page_id =
              json_extract(conflict.details_json, '$.existing_raw_page_id')
         LEFT JOIN ingest_run_page_observations AS incoming_observation
           ON incoming_observation.raw_page_id = page.raw_page_id
          AND incoming_observation.ingest_segment_id = detail_segment.ingest_segment_id
         ${variantObservationJoins}`,
    )
    .iterate() as Iterable<{
      conflict_type:
        | "RAW_PAGE_VARIANT"
        | "DUPLICATE_EXTERNAL_ID"
        | "MISSING_EXTERNAL_ID"
        | "INVALID_AMOUNT"
        | "INVALID_TIMESTAMP"
        | "INVALID_DIRECTION"
        | "INVALID_SHAPE";
      provider_account_key: string;
      raw_page_id: string | null;
      raw_event_id: string | null;
      external_event_id: string | null;
      existing_semantic_fingerprint: string | null;
      incoming_semantic_fingerprint: string | null;
      conflict_fingerprint: string;
      incoming_request_fingerprint: string | null;
      incoming_response_fingerprint: string | null;
      incoming_provider_account_key: string | null;
      incoming_ingest_run_id: string | null;
      payload_fingerprint: string | null;
      ordinal: bigint | number | null;
      details_count: bigint | number;
      detail_request_fingerprint_type: string | null;
      detail_request_fingerprint: string | null;
      detail_ingest_segment_id_type: string | null;
      detail_ingest_segment_id: string | null;
      detail_previous_observation_sequence_type: string | null;
      detail_previous_observation_sequence: bigint | number | null;
      detail_existing_raw_page_id_type: string | null;
      detail_existing_raw_page_id: string | null;
      detail_incoming_raw_page_id_type: string | null;
      detail_incoming_raw_page_id: string | null;
      detail_existing_precision_type: string | null;
      detail_existing_precision: bigint | number | null;
      detail_incoming_precision_type: string | null;
      detail_incoming_precision: bigint | number | null;
      detail_segment_run_id: string | null;
      existing_provider_account_key: string | null;
      existing_request_fingerprint: string | null;
      existing_response_fingerprint: string | null;
      previous_observation_raw_page_id: string | null;
      incoming_observation_raw_page_id: string | null;
      incoming_observation_run_id: string | null;
      incoming_observation_sequence: bigint | number | null;
      incoming_observation_disposition: string | null;
      incoming_transition_enforced: bigint | number | null;
      expected_previous_observation_sequence: bigint | number | null;
    }>) {
      try {
        let parts: readonly unknown[];
        if (row.conflict_type === "RAW_PAGE_VARIANT") {
          const detailsCount = Number(row.details_count);
          if (
            !Number.isSafeInteger(detailsCount) ||
            row.raw_page_id === null ||
            row.incoming_observation_raw_page_id === null ||
            row.detail_request_fingerprint_type !== "text" ||
            row.detail_ingest_segment_id_type !== "text" ||
            row.detail_existing_raw_page_id_type !== "text" ||
            row.detail_incoming_raw_page_id_type !== "text" ||
            row.detail_request_fingerprint === null ||
            row.detail_ingest_segment_id === null ||
            row.detail_existing_raw_page_id === null ||
            row.detail_incoming_raw_page_id === null ||
            row.detail_existing_raw_page_id === row.detail_incoming_raw_page_id ||
            row.detail_incoming_raw_page_id !== row.raw_page_id ||
            row.incoming_request_fingerprint !== row.detail_request_fingerprint ||
            row.existing_request_fingerprint !== row.detail_request_fingerprint ||
            row.incoming_provider_account_key !== row.provider_account_key ||
            row.existing_provider_account_key !== row.provider_account_key ||
            row.existing_semantic_fingerprint === null ||
            row.incoming_semantic_fingerprint === null ||
            row.existing_response_fingerprint !== row.existing_semantic_fingerprint ||
            row.incoming_response_fingerprint !== row.incoming_semantic_fingerprint ||
            row.existing_semantic_fingerprint === row.incoming_semantic_fingerprint
          ) {
            throw new Error("raw page variant conflict evidence is incomplete");
          }
          if (row.detail_previous_observation_sequence_type === null) {
            if (
              detailsCount !== 4 ||
              row.detail_segment_run_id !== row.incoming_ingest_run_id ||
              row.incoming_observation_run_id !== row.detail_segment_run_id ||
              row.incoming_observation_disposition !== "PROCESSED" ||
              Number(row.incoming_transition_enforced) !== 0
            ) {
              throw new Error("legacy raw page variant evidence is invalid");
            }
            parts = [
              row.conflict_type,
              row.detail_request_fingerprint,
              row.existing_semantic_fingerprint,
              row.incoming_semantic_fingerprint,
            ];
          } else {
            const previousObservationSequence = Number(
              row.detail_previous_observation_sequence,
            );
            const incomingObservationSequence = Number(row.incoming_observation_sequence);
            if (
              detailsCount !== 5 ||
              row.detail_previous_observation_sequence_type !== "integer" ||
              !Number.isSafeInteger(previousObservationSequence) ||
              previousObservationSequence < 1 ||
              !Number.isSafeInteger(incomingObservationSequence) ||
              incomingObservationSequence <= previousObservationSequence ||
              Number(row.expected_previous_observation_sequence) !==
                previousObservationSequence ||
              row.incoming_observation_run_id !== row.detail_segment_run_id ||
              row.previous_observation_raw_page_id !== row.detail_existing_raw_page_id ||
              row.incoming_observation_disposition !== "REJECTED_VARIANT" ||
              Number(row.incoming_transition_enforced) !== 1
            ) {
              throw new Error("raw page variant sequence evidence is invalid");
            }
            if (pageVariantConflictFingerprint({
              requestFingerprint: row.detail_request_fingerprint,
              ingestSegmentId: row.detail_ingest_segment_id,
              previousObservationSequence,
              existingRawPageId: row.detail_existing_raw_page_id,
              existingResponseFingerprint: row.existing_semantic_fingerprint,
              incomingRawPageId: row.detail_incoming_raw_page_id,
              incomingResponseFingerprint: row.incoming_semantic_fingerprint,
            }) !== row.conflict_fingerprint) {
              violations += 1;
            }
            continue;
          }
        } else if (row.conflict_type === "DUPLICATE_EXTERNAL_ID") {
          if (
            row.external_event_id === null ||
            row.existing_semantic_fingerprint === null ||
            row.incoming_semantic_fingerprint === null
          ) {
            throw new Error("duplicate external ID conflict evidence is incomplete");
          }
          if (
            row.detail_existing_precision_type === null &&
            row.detail_incoming_precision_type === null
          ) {
            parts = [
              row.conflict_type,
              row.external_event_id,
              row.existing_semantic_fingerprint,
              row.incoming_semantic_fingerprint,
            ];
          } else {
            const existingPrecision = Number(row.detail_existing_precision);
            const incomingPrecision = Number(row.detail_incoming_precision);
            if (
              row.detail_existing_precision_type !== "integer" ||
              row.detail_incoming_precision_type !== "integer" ||
              ![1, 10, 100, 1_000].includes(existingPrecision) ||
              ![1, 10, 100, 1_000].includes(incomingPrecision)
            ) {
              throw new Error("duplicate external ID precision evidence is invalid");
            }
            parts = [
              row.conflict_type,
              row.external_event_id,
              row.existing_semantic_fingerprint,
              row.incoming_semantic_fingerprint,
              existingPrecision,
              incomingPrecision,
            ];
          }
        } else {
          const ordinal = Number(row.ordinal);
          if (
            row.raw_page_id === null ||
            row.raw_event_id === null ||
            row.payload_fingerprint === null ||
            !Number.isSafeInteger(ordinal) ||
            ordinal < 0
          ) {
            throw new Error("normalization conflict evidence is incomplete");
          }
          parts = [
            row.conflict_type,
            row.payload_fingerprint,
            row.raw_page_id,
            ordinal,
          ];
        }
        if (conflictFingerprint(parts) !== row.conflict_fingerprint) violations += 1;
    } catch {
      violations += 1;
    }
  }
  if (
    tableExists(connection, "ledger_conflict_operations") &&
    columnExists(connection, "ledger_conflicts", "resolution_operation_id") &&
    columnExists(connection, "ledger_conflicts", "resolution_fingerprint")
  ) {
    for (const row of connection.prepare(
      `SELECT operation.conflict_operation_id, operation.operation_key,
              operation.conflict_id, operation.request_fingerprint,
              operation.request_json, operation.action, operation.actor_type,
              operation.actor_id, operation.reason, operation.created_at,
              conflict.conflict_type, conflict.status,
              conflict.resolution_json, conflict.resolution_operation_id,
              conflict.resolution_fingerprint, conflict.resolved_at
         FROM ledger_conflict_operations AS operation
         LEFT JOIN ledger_conflicts AS conflict
           ON conflict.conflict_id = operation.conflict_id`,
    ).iterate() as Iterable<{
      conflict_operation_id: string;
      operation_key: string;
      conflict_id: string;
      request_fingerprint: string;
      request_json: string;
      action: "CONFIRM_VARIANT" | "KEEP_EXISTING" | "ACKNOWLEDGE_ISOLATED";
      actor_type: "SYSTEM" | "ADMIN";
      actor_id: string | null;
      reason: string;
      created_at: bigint | number;
      conflict_type:
        | "RAW_PAGE_VARIANT"
        | "DUPLICATE_EXTERNAL_ID"
        | "MISSING_EXTERNAL_ID"
        | "INVALID_AMOUNT"
        | "INVALID_TIMESTAMP"
        | "INVALID_DIRECTION"
        | "INVALID_SHAPE"
        | null;
      status: "OPEN" | "RESOLVED" | "IGNORED" | null;
      resolution_json: string | null;
      resolution_operation_id: string | null;
      resolution_fingerprint: string | null;
      resolved_at: bigint | number | null;
    }>) {
      try {
        const request = ledgerConflictOperationRequest({
          conflictId: row.conflict_id,
          action: row.action,
          actorType: row.actor_type,
          actorId: row.actor_id,
          reason: row.reason,
        });
        const requestJson = JSON.stringify(ledgerConflictOperationEvidence(request));
        JSON.parse(row.request_json);
        const fingerprint = ledgerConflictOperationFingerprint(request);
        const operationKey = row.actor_type === "SYSTEM"
          ? `system:confirm_variant:${row.conflict_id}`
          : `admin:${row.conflict_operation_id}`;
        const actionMatchesConflict =
          (row.conflict_type === "RAW_PAGE_VARIANT" &&
            row.action === "CONFIRM_VARIANT" && row.actor_type === "SYSTEM" &&
            row.actor_id === null && row.status === "RESOLVED") ||
          (row.conflict_type === "DUPLICATE_EXTERNAL_ID" &&
            row.action === "KEEP_EXISTING" && row.actor_type === "ADMIN" &&
            row.actor_id !== null && row.status === "RESOLVED") ||
          (row.conflict_type !== null &&
            row.conflict_type !== "RAW_PAGE_VARIANT" &&
            row.conflict_type !== "DUPLICATE_EXTERNAL_ID" &&
            row.action === "ACKNOWLEDGE_ISOLATED" && row.actor_type === "ADMIN" &&
            row.actor_id !== null && row.status === "IGNORED");
        if (
          row.request_json !== requestJson ||
          row.request_fingerprint !== fingerprint ||
          row.operation_key !== operationKey ||
          !actionMatchesConflict ||
          row.resolution_json !== requestJson ||
          row.resolution_operation_id !== row.conflict_operation_id ||
          row.resolution_fingerprint !== fingerprint ||
          row.resolved_at === null ||
          Number(row.resolved_at) !== Number(row.created_at)
        ) {
          violations += 1;
        }
      } catch {
        violations += 1;
      }
    }
    violations += readViolationCount(
      connection,
      `SELECT COUNT(*) AS violations
         FROM ledger_conflicts AS conflict
         LEFT JOIN ledger_conflict_operations AS operation
           ON operation.conflict_id = conflict.conflict_id
        WHERE (conflict.status = 'OPEN' AND (
                 operation.conflict_operation_id IS NOT NULL OR
                 conflict.resolution_json IS NOT NULL OR
                 conflict.resolution_operation_id IS NOT NULL OR
                 conflict.resolution_fingerprint IS NOT NULL OR
                 conflict.resolved_at IS NOT NULL
              ))
           OR (conflict.status IN ('RESOLVED', 'IGNORED') AND (
                 operation.conflict_operation_id IS NULL OR
                 conflict.resolution_json IS NULL OR
                 conflict.resolution_operation_id IS NULL OR
                 conflict.resolution_fingerprint IS NULL OR
                 conflict.resolved_at IS NULL
       ))`,
      "ledger conflict terminal state",
    );
  }
  const hasLedgerOccurrencePrecision = columnExists(
    connection,
    "ledger_entries",
    "occurred_at_precision_ms",
  );
  const ledgerRowsSql = hasLedgerOccurrencePrecision
    ? `SELECT entry.external_event_id, entry.semantic_fingerprint, entry.occurred_at,
              entry.occurred_at_precision_ms, entry.amount_cents,
              entry.direction, entry.currency, entry.alipay_order_no, entry.merchant_order_no,
              entry.trans_memo, entry.other_account, raw.occurred_at_text
         FROM ledger_entries AS entry
         LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = entry.raw_event_id`
    : `SELECT entry.external_event_id, entry.semantic_fingerprint, entry.occurred_at,
              1000 AS occurred_at_precision_ms, entry.amount_cents,
              entry.direction, entry.currency, entry.alipay_order_no, entry.merchant_order_no,
              entry.trans_memo, entry.other_account, raw.occurred_at_text
         FROM ledger_entries AS entry
         LEFT JOIN provider_raw_events AS raw ON raw.raw_event_id = entry.raw_event_id`;
  for (const row of connection
    .prepare(ledgerRowsSql)
    .iterate() as Iterable<{
      external_event_id: string;
      semantic_fingerprint: string;
      occurred_at: bigint | number;
      occurred_at_precision_ms: bigint | number;
      amount_cents: bigint | number;
      direction: "CREDIT" | "DEBIT";
      currency: "CNY";
      alipay_order_no: string | null;
      merchant_order_no: string | null;
      trans_memo: string | null;
      other_account: string | null;
      occurred_at_text: string | null;
    }>) {
    const occurredAt = Number(row.occurred_at);
    const occurredAtPrecisionMilliseconds = Number(row.occurred_at_precision_ms);
    const amountCents = Number(row.amount_cents);
    let rawOccurrence: ReturnType<typeof parseOccurredAtWithPrecision> | null = null;
    try {
      rawOccurrence = parseOccurredAtWithPrecision(row.occurred_at_text);
    } catch {
      violations += 1;
    }
    if (
      !Number.isSafeInteger(occurredAt) ||
      occurredAt < 0 ||
      ![1, 10, 100, 1_000].includes(occurredAtPrecisionMilliseconds) ||
      !Number.isSafeInteger(occurredAt + occurredAtPrecisionMilliseconds) ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 1
    ) {
      violations += 1;
      continue;
    }
    if (
      rawOccurrence !== null &&
      (rawOccurrence.milliseconds !== occurredAt ||
        (hasLedgerOccurrencePrecision &&
          rawOccurrence.precisionMilliseconds !== occurredAtPrecisionMilliseconds))
    ) {
      violations += 1;
    }
    const expected = hasLedgerOccurrencePrecision
      ? semanticFingerprint({
          externalEventId: row.external_event_id,
          occurredAt,
          occurredAtPrecisionMilliseconds: occurredAtPrecisionMilliseconds as 1 | 10 | 100 | 1_000,
          amountCents,
          direction: row.direction,
          currency: row.currency,
          alipayOrderNo: row.alipay_order_no,
          merchantOrderNo: row.merchant_order_no,
          transMemo: row.trans_memo,
          otherAccount: row.other_account,
        })
      : legacySemanticFingerprintV1({
          externalEventId: row.external_event_id,
          occurredAt,
          amountCents,
          direction: row.direction,
          currency: row.currency,
          alipayOrderNo: row.alipay_order_no,
          merchantOrderNo: row.merchant_order_no,
          transMemo: row.trans_memo,
          otherAccount: row.other_account,
        });
    if (expected !== row.semantic_fingerprint) violations += 1;
  }
  for (const row of connection
    .prepare(
      `SELECT raw_body, response_fingerprint
         FROM ingest_errors
        WHERE raw_body IS NOT NULL`,
    )
    .iterate() as Iterable<{
      raw_body: Uint8Array;
      response_fingerprint: string | null;
    }>) {
    if (!fingerprintMatches(row.raw_body, row.response_fingerprint)) violations += 1;
  }
  return violations;
}

function countReconciliationCryptographicDomainViolations(connection: DatabaseSync): number {
  if (
    !tableExists(connection, "financial_operations") ||
    !tableExists(connection, "match_candidates") ||
    !tableExists(connection, "financial_exceptions") ||
    !tableExists(connection, "refund_records") ||
    !tableExists(connection, "outbox_events")
  ) {
    return 0;
  }

  let violations = 0;
  for (const row of connection
    .prepare(
      `SELECT candidate.candidate_id, candidate.ledger_entry_id,
              candidate.order_id, candidate.slot_id, candidate.rule_version,
              candidate.evidence_json, candidate.candidate_fingerprint,
              entry.provider_account_key, entry.semantic_fingerprint,
              entry.occurred_at, entry.occurred_at_precision_ms, entry.amount_cents,
              orders.collection_profile_id,
              slot.generation, slot.occupied_from, slot.released_at
         FROM match_candidates AS candidate
         LEFT JOIN ledger_entries AS entry
           ON entry.ledger_entry_id = candidate.ledger_entry_id
         LEFT JOIN payment_orders AS orders
           ON orders.order_id = candidate.order_id
         LEFT JOIN amount_slots AS slot ON slot.slot_id = candidate.slot_id`,
    )
    .iterate() as Iterable<{
      candidate_id: string;
      ledger_entry_id: string;
      order_id: string;
      slot_id: string;
      rule_version: bigint | number;
      evidence_json: string;
      candidate_fingerprint: string;
      provider_account_key: string | null;
      semantic_fingerprint: string | null;
      occurred_at: bigint | number | null;
      occurred_at_precision_ms: bigint | number | null;
      amount_cents: bigint | number | null;
      collection_profile_id: string | null;
      generation: bigint | number | null;
      occupied_from: bigint | number | null;
      released_at: bigint | number | null;
    }>) {
    try {
      const evidence = parseIntegrityJsonObject(row.evidence_json);
      const evidenceReleasedAt = nullableIntegritySafeInteger(
        evidence.slot_released_at,
        "candidate evidence release time",
      );
      const currentReleasedAt = nullableIntegritySafeInteger(
        row.released_at,
        "candidate slot release time",
      );
      if (
        (currentReleasedAt === null && evidenceReleasedAt !== null) ||
        (currentReleasedAt !== null && evidenceReleasedAt !== null && evidenceReleasedAt !== currentReleasedAt)
      ) {
        throw new Error("candidate release snapshot is invalid");
      }
      const input = {
        providerAccountKey: requireIntegrityString(row.provider_account_key, "candidate provider account"),
        ledgerEntryId: row.ledger_entry_id,
        ledgerSemanticFingerprint: requireIntegrityString(
          row.semantic_fingerprint,
          "candidate ledger fingerprint",
        ),
        occurredAt: integritySafeInteger(row.occurred_at, "candidate occurrence"),
        occurredAtPrecisionMilliseconds: integrityTimestampPrecision(
          row.occurred_at_precision_ms,
          "candidate occurrence precision",
        ),
        amountCents: integritySafeInteger(row.amount_cents, "candidate amount"),
        orderId: row.order_id,
        collectionProfileId: requireIntegrityString(
          row.collection_profile_id,
          "candidate collection profile",
        ),
        slotId: row.slot_id,
        slotGeneration: integritySafeInteger(row.generation, "candidate slot generation"),
        slotOccupiedFrom: integritySafeInteger(row.occupied_from, "candidate slot occupation"),
        slotReleasedAt: evidenceReleasedAt,
      };
      const expectedJson = JSON.stringify(candidateEvidence(input));
      if (
        Number(row.rule_version) !== RECONCILIATION_RULE_VERSION ||
        row.evidence_json !== expectedJson ||
        row.candidate_fingerprint !== candidateFingerprint(input)
      ) {
        violations += 1;
      }
    } catch {
      violations += 1;
    }
  }

  if (
    columnExists(connection, "financial_exceptions", "details_fingerprint") &&
    columnExists(connection, "financial_exceptions", "resolution_fingerprint")
  ) {
    for (const row of connection
      .prepare(
        `SELECT details_json, details_fingerprint,
                resolution_json, resolution_fingerprint
           FROM financial_exceptions`,
      )
      .iterate() as Iterable<{
        details_json: string;
        details_fingerprint: string | null;
        resolution_json: string | null;
        resolution_fingerprint: string | null;
      }>) {
      if (
        row.details_fingerprint === null ||
        row.details_fingerprint !== financialExceptionDetailsFingerprint(row.details_json)
      ) violations += 1;
      if (
        (row.resolution_json === null) !== (row.resolution_fingerprint === null) ||
        (
          row.resolution_json !== null &&
          row.resolution_fingerprint !==
            financialExceptionResolutionFingerprint(row.resolution_json)
        )
      ) violations += 1;
    }
  }

  for (const row of connection
    .prepare(
      `SELECT payment_match.evidence_json, operation.financial_operation_id,
              operation.actor_id, operation.reason
         FROM payment_matches AS payment_match
         LEFT JOIN financial_operations AS operation
           ON operation.financial_operation_id = payment_match.created_by_operation_id
        WHERE payment_match.evidence_type = 'MANUAL'`,
    )
    .iterate() as Iterable<{
      evidence_json: string;
      financial_operation_id: string | null;
      actor_id: string | null;
      reason: string | null;
    }>) {
    try {
      const expected = JSON.stringify(manualSettlementEvidence({
        financialOperationId: requireIntegrityString(
          row.financial_operation_id,
          "manual settlement operation",
        ),
        actorId: requireIntegrityString(row.actor_id, "manual settlement actor"),
        reason: requireIntegrityString(row.reason, "manual settlement reason"),
      }));
      if (row.evidence_json !== expected) violations += 1;
    } catch {
      violations += 1;
    }
  }

  for (const row of connection
    .prepare(
      `SELECT refund.evidence_json, operation.financial_operation_id,
              operation.actor_id, operation.reason
         FROM refund_records AS refund
         LEFT JOIN financial_operations AS operation
           ON operation.financial_operation_id = refund.financial_operation_id`,
    )
    .iterate() as Iterable<{
      evidence_json: string;
      financial_operation_id: string | null;
      actor_id: string | null;
      reason: string | null;
    }>) {
    try {
      const expected = JSON.stringify(refundRecordEvidence({
        financialOperationId: requireIntegrityString(row.financial_operation_id, "refund operation"),
        actorId: requireIntegrityString(row.actor_id, "refund actor"),
        reason: requireIntegrityString(row.reason, "refund reason"),
      }));
      if (row.evidence_json !== expected) violations += 1;
    } catch {
      violations += 1;
    }
  }

  for (const row of connection
    .prepare(
      `SELECT financial_operation_id, request_fingerprint, request_json,
              operation_type, actor_type, actor_id, order_id, ledger_entry_id,
              reverses_operation_id, reason
         FROM financial_operations`,
    )
    .iterate() as Iterable<{
      financial_operation_id: string;
      request_fingerprint: string;
      request_json: string;
      operation_type: FinancialOperationType;
      actor_type: "SYSTEM" | "ADMIN";
      actor_id: string | null;
      order_id: string | null;
      ledger_entry_id: string | null;
      reverses_operation_id: string | null;
      reason: string | null;
    }>) {
    try {
      const evidence = parseIntegrityJsonObject(row.request_json);
      const candidateId = nullableIntegrityString(evidence.candidate_id, "operation candidate ID");
      const paymentMatchId = nullableIntegrityString(
        evidence.payment_match_id,
        "operation payment match ID",
      );
      const input: FinancialOperationFingerprintInput = {
        operationType: row.operation_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        orderId: row.order_id,
        ledgerEntryId: row.ledger_entry_id,
        candidateId,
        paymentMatchId,
        reversesOperationId: row.reverses_operation_id,
        reason: row.reason,
      };
      if (
        row.request_json !== JSON.stringify(financialOperationEvidence(input)) ||
        row.request_fingerprint !== financialOperationFingerprint(input)
      ) {
        violations += 1;
      }
    } catch {
      violations += 1;
    }
  }

  for (const row of connection
    .prepare(
      `SELECT provider_account_key, exception_type, ledger_entry_id,
              order_id, candidate_id, context_key, exception_fingerprint
         FROM financial_exceptions`,
    )
    .iterate() as Iterable<{
      provider_account_key: string;
      exception_type: FinancialExceptionType;
      ledger_entry_id: string | null;
      order_id: string | null;
      candidate_id: string | null;
      context_key: string;
      exception_fingerprint: string;
    }>) {
    if (row.exception_fingerprint !== financialExceptionFingerprint({
      providerAccountKey: row.provider_account_key,
      exceptionType: row.exception_type,
      ledgerEntryId: row.ledger_entry_id,
      orderId: row.order_id,
      candidateId: row.candidate_id,
      contextKey: row.context_key,
    })) {
      violations += 1;
    }
  }

  for (const row of connection
    .prepare("SELECT payload_json, payload_fingerprint FROM outbox_events")
    .iterate() as Iterable<{ payload_json: string; payload_fingerprint: string }>) {
    if (row.payload_fingerprint !== outboxPayloadFingerprint(row.payload_json)) violations += 1;
  }
  return violations;
}

function countWebhookCryptographicDomainViolations(connection: DatabaseSync): number {
  if (
    !tableExists(connection, "webhook_targets") ||
    !tableExists(connection, "webhook_deliveries")
  ) {
    return 0;
  }
  let violations = 0;
  for (const row of connection
    .prepare(
      `SELECT target_url, allowed_origin, target_format, url_fingerprint,
              request_fingerprint, request_fingerprint_version
         FROM webhook_targets`,
    )
    .iterate() as Iterable<{
      target_url: string;
      allowed_origin: string;
      target_format: string;
      url_fingerprint: string;
      request_fingerprint: string;
      request_fingerprint_version: bigint | number;
    }>) {
    try {
      const expected = prepareWebhookTarget(row.target_url, row.allowed_origin);
      if (
        row.target_format !== expected.format ||
        row.url_fingerprint !== expected.urlFingerprint ||
        row.request_fingerprint !== expected.requestFingerprint ||
        Number(row.request_fingerprint_version) !== expected.requestFingerprintVersion
      ) {
        violations += 1;
      }
    } catch {
      violations += 1;
    }
  }
  for (const row of connection
    .prepare(
      `SELECT outbox_event_id, target_id, generation, predecessor_delivery_id,
              requested_by_type,
              requested_by_actor_id, reason, request_fingerprint,
              request_fingerprint_version
         FROM webhook_deliveries`,
    )
    .iterate() as Iterable<{
      outbox_event_id: string;
      target_id: string;
      generation: bigint | number;
      predecessor_delivery_id: string | null;
      requested_by_type: "SYSTEM" | "ADMIN";
      requested_by_actor_id: string | null;
      reason: string | null;
      request_fingerprint: string;
      request_fingerprint_version: bigint | number;
    }>) {
    const generation = Number(row.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      violations += 1;
      continue;
    }
    const expected = webhookDeliveryRequestFingerprint({
      eventId: row.outbox_event_id,
      targetId: row.target_id,
      generation,
      predecessorDeliveryId: row.predecessor_delivery_id,
      requestedByType: row.requested_by_type,
      requestedByActorId: row.requested_by_actor_id,
      reason: row.reason,
    });
    if (
      row.request_fingerprint !== expected ||
      Number(row.request_fingerprint_version) !== 1
    ) {
      violations += 1;
    }
  }
  return violations;
}

function parseIntegrityJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("integrity evidence is not an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function integritySafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${label} is not an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function nullableIntegritySafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : integritySafeInteger(value, label);
}

function integrityTimestampPrecision(
  value: unknown,
  label: string,
): 1 | 10 | 100 | 1_000 {
  const precision = integritySafeInteger(value, label);
  if (precision !== 1 && precision !== 10 && precision !== 100 && precision !== 1_000) {
    throw new Error(`${label} is invalid`);
  }
  return precision;
}

function requireIntegrityString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function nullableIntegrityString(value: unknown, label: string): string | null {
  return value === null ? null : requireIntegrityString(value, label);
}

function fingerprintMatches(value: Uint8Array, expected: string | null): boolean {
  return value instanceof Uint8Array &&
    expected !== null &&
    createHash("sha256").update(value).digest("hex") === expected;
}

interface CheckoutTokenKeyRow {
  readonly key_version: bigint | number;
  readonly key_material: Uint8Array;
  readonly activated_at: bigint | number;
  readonly retired_at: bigint | number | null;
}

function readCheckoutTokenKeys(connection: DatabaseSync): CheckoutTokenKeyRow[] {
  return connection.prepare(
    `SELECT key_version, key_material, activated_at, retired_at
       FROM checkout_token_keys
      ORDER BY key_version`,
  ).all() as unknown as CheckoutTokenKeyRow[];
}

function assertCheckoutTokenKeySet(keys: readonly CheckoutTokenKeyRow[]): void {
  let activeKeys = 0;
  for (const [index, key] of keys.entries()) {
    const version = Number(key.key_version);
    const activatedAt = Number(key.activated_at);
    const retiredAt = key.retired_at === null ? null : Number(key.retired_at);
    if (
      version !== index + 1 ||
      !(key.key_material instanceof Uint8Array) ||
      key.key_material.byteLength !== 32 ||
      !Number.isSafeInteger(activatedAt) ||
      activatedAt < 0 ||
      (retiredAt !== null &&
        (!Number.isSafeInteger(retiredAt) || retiredAt < activatedAt))
    ) {
      throw new Error("checkout token key history is invalid");
    }
    if (retiredAt === null) activeKeys += 1;
    const previous = keys[index - 1];
    if (previous !== undefined) {
      const previousRetiredAt = previous.retired_at === null ? null : Number(previous.retired_at);
      if (previousRetiredAt === null || previousRetiredAt > activatedAt) {
        throw new Error("checkout token key history is invalid");
      }
    }
  }
  if (activeKeys !== 1 || keys.at(-1)?.retired_at !== null) {
    throw new Error("checkout token key history has no unique active key");
  }
}

function assertCheckoutTokenKeysMatchSessions(
  connection: DatabaseSync,
  keys: readonly CheckoutTokenKeyRow[],
): void {
  if (!tableExists(connection, "checkout_sessions")) return;
  const keyByVersion = new Map(
    keys.map((key) => [Number(key.key_version), key.key_material] as const),
  );
  for (const row of connection
    .prepare("SELECT checkout_id, token_digest, token_key_version FROM checkout_sessions")
    .iterate() as Iterable<{
      checkout_id: string;
      token_digest: string;
      token_key_version: bigint | number;
    }>) {
    let digest: string;
    try {
      const key = keyByVersion.get(Number(row.token_key_version));
      if (key === undefined) throw new Error("checkout token key version is missing");
      digest = digestCheckoutToken(deriveCheckoutToken(key, row.checkout_id));
    } catch {
      throw new Error("checkout token key history does not match persisted checkout sessions");
    }
    if (digest !== row.token_digest) {
      throw new Error("checkout token key history does not match persisted checkout sessions");
    }
  }
}

export async function createVerifiedDatabaseBackup(sourceConnection: DatabaseSync, sourcePath: string, targetPath: string): Promise<DatabaseBackup> {
  hardenProcessFileCreation();
  const source = resolve(sourcePath); const target = resolve(targetPath);
  if (source === target) throw new Error("backup target must differ from the source database");
  const directory = ensurePrivateDirectory(dirname(target));
  assertBackupStorageHeadroom(source, directory);
  const name = target.split(/[\\/]/).pop() ?? "backup.sqlite3";
  const tempPath = resolve(directory, `.${name}.${randomUUID()}.tmp`);
  const reservation = openSync(tempPath, "wx", 0o600); closeSync(reservation);
  try {
    const pages = await sqliteBackup(sourceConnection, tempPath, { rate: 100 });
    hardenExistingPrivateFile(tempPath);
    const verification = new DatabaseSync(tempPath, { readOnly: true, enableForeignKeyConstraints: true, timeout: SQLITE_TIMEOUT_MS, readBigInts: true, defensive: true });
    try {
      const integrity = inspectDatabaseIntegrity(verification);
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
      const integrity = inspectDatabaseIntegrity(finalVerification);
      if (!integrity.ok) throw new Error(`final backup verification failed: quick_check=${integrity.quickCheck}, foreign_key_violations=${integrity.foreignKeyViolations}, domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`);
    } finally { finalVerification.close(); }
    removeSqliteSidecars(tempPath);
    const hash = await sha256File(tempPath);
    const file = openSync(tempPath, "r+"); try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(tempPath, target);
    hardenExistingPrivateFile(target);
    syncDirectory(directory);
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
  syncDirectory(dirname(target));
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
