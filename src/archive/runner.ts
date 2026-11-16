import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { openIntegrityDatabase } from "../database/connection.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { syncDirectory } from "../database/maintenance-lock.ts";
import { ensurePrivateDirectory, hardenExistingPrivateFile } from "../infrastructure/storage/permissions.ts";
import { iterateArchiveRequestCheckpoints, retireArchiveRequestCheckpoints } from "../ledger/request-checkpoints.ts";
import { archiveRecordKey, decodeArchiveRecord, encodeArchiveRecord, hashArchiveFile } from "./codec.ts";
import { archiveIdentityDigest } from "./keys.ts";
import { HistoryArchiveError, type HistoryArchiveSummary } from "./model.ts";
import { buildHistoryArchivePlan, dropHistoryArchivePlan, quoted, selectedTable, type HistoryArchivePlan } from "./planner.ts";
import { historyArchiveFilePath, readHistoryArchive } from "./store.ts";
import { ARCHIVE_BUSINESS_TABLES } from "./schema.ts";

export interface CreateHistoryArchiveOptions {
  readonly connection: DatabaseSync;
  readonly dataDirectory: string;
  readonly before: number;
  readonly now: number;
  readonly instanceId: string;
  readonly validateDatabase: (connection: DatabaseSync) => void;
}

export interface CreateHistoryArchiveResult {
  readonly archive: HistoryArchiveSummary;
  readonly counts: Readonly<Record<string, number>>;
  readonly skippedOrders: number;
}

const ARCHIVE_FILE_SCHEMA = `
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  CREATE TABLE archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE archive_records (
    record_id INTEGER PRIMARY KEY, table_name TEXT NOT NULL, record_key TEXT NOT NULL, payload BLOB NOT NULL,
    sha256 TEXT NOT NULL, raw_bytes INTEGER NOT NULL, UNIQUE(table_name, record_key)
  ) STRICT;
  CREATE TABLE archive_record_links (
    record_id INTEGER NOT NULL REFERENCES archive_records(record_id),
    parent_record_id INTEGER NOT NULL REFERENCES archive_records(record_id),
    PRIMARY KEY(record_id, parent_record_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX archive_record_links_parent ON archive_record_links(parent_record_id);
  CREATE TABLE archive_evidence_payloads (
    fingerprint TEXT PRIMARY KEY, encoding TEXT NOT NULL, raw_bytes INTEGER NOT NULL, body BLOB NOT NULL
  ) STRICT;
  CREATE TABLE archive_orders (
    order_id TEXT PRIMARY KEY, merchant_order_no TEXT NOT NULL, site_id TEXT NOT NULL, site_name TEXT NOT NULL,
    product_name TEXT NOT NULL, requested_amount_cents INTEGER NOT NULL, payable_amount_cents INTEGER NOT NULL,
    received_amount_cents INTEGER, payment_status TEXT NOT NULL, refund_status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
`;

/** The caller owns the stopped-service maintenance lock and exclusive writer lease. */
export function createHistoryArchive(options: CreateHistoryArchiveOptions): CreateHistoryArchiveResult {
  const { connection, before, now } = options;
  if (!Number.isSafeInteger(before) || before <= 0 || before > now) throw new RangeError("归档截止时间必须早于当前时间。");
  const directory = ensurePrivateDirectory(join(options.dataDirectory, "archives"));
  recoverStagedHistoryArchives(connection, options.dataDirectory, options.instanceId);
  const archiveId = randomUUID();
  const path = historyArchiveFilePath(options.dataDirectory, archiveId);
  const staging = `${path}.partial`;
  let plan: HistoryArchivePlan | undefined;
  let committed = false;
  connection.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON");
  try {
    options.validateDatabase(connection);
    plan = buildHistoryArchivePlan(connection, before);
    const schemaVersion = Number(connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version);
    const counts: Record<string, number> = { ...plan.counts };
    const checkpointRows = iterateArchiveRequestCheckpoints(connection, before);
    const archive = openIntegrityDatabase(staging, { enableForeignKeyConstraints: true, defensive: true, readBigInts: true });
    try {
      archive.exec(ARCHIVE_FILE_SCHEMA);
      archive.exec("BEGIN IMMEDIATE");
      const saveRecord = archive.prepare("INSERT INTO archive_records(table_name, record_key, payload, sha256, raw_bytes) VALUES (?, ?, ?, ?, ?)");
      const saveEvidence = archive.prepare("INSERT OR IGNORE INTO archive_evidence_payloads(fingerprint, encoding, raw_bytes, body) VALUES (?, ?, ?, ?)");
      const evidence = connection.prepare("SELECT fingerprint, encoding, raw_bytes, body FROM ledger_evidence_payloads WHERE fingerprint = ?");
      for (const table of plan.tables) {
        const rows = connection.prepare(`SELECT source.* FROM ${quoted(table.name)} AS source JOIN ${selectedTable(table.name)} AS selected ON source.rowid = selected.source_rowid`).iterate();
        for (const row of rows) {
          const encoded = encodeArchiveRecord(row);
          saveRecord.run(table.name, archiveRecordKey(row, table.primaryKey), encoded.payload, encoded.sha256, encoded.rawBytes);
          for (const column of ["raw_body_reference", "raw_payload_reference"]) {
            if (typeof row[column] !== "string") continue;
            const payload = evidence.get(row[column])!;
            saveEvidence.run(payload.fingerprint!, payload.encoding!, payload.raw_bytes!, payload.body!);
          }
        }
      }
      let checkpointCount = 0;
      for (const row of checkpointRows) {
        const encoded = encodeArchiveRecord(row);
        saveRecord.run("ledger_request_checkpoints", archiveRecordKey(row, ["provider_account_key", "request_fingerprint"]), encoded.payload, encoded.sha256, encoded.rawBytes);
        checkpointCount += 1;
      }
      counts.ledger_request_checkpoints = checkpointCount;
      const recordCount = Object.values(counts).reduce((total, count) => total + count, 0);
      if (recordCount === 0) throw new HistoryArchiveError("archive_empty", "所选日期之前没有可归档的完整历史记录。");
      writeArchiveRelations(connection, archive, plan);
      writeArchiveOrders(connection, archive);
      const metadata = { format: "perpay-history", format_version: 1, archive_id: archiveId, instance_id: options.instanceId,
        created_at: now, before, schema_version: schemaVersion, record_count: recordCount, counts };
      const saveMetadata = archive.prepare("INSERT INTO archive_metadata(key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries(metadata)) saveMetadata.run(key, JSON.stringify(value));
      archive.exec("COMMIT");
      verifyArchiveContents(archive, counts);
    } finally { archive.close(); }
    hardenExistingPrivateFile(staging);
    const handle = openSync(staging, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    const sha256 = hashArchiveFile(staging);
    const sizeBytes = statSync(staging).size;
    syncDirectory(directory);

    const recordCount = Object.values(counts).reduce((total, count) => total + count, 0);
    connection.prepare(`INSERT INTO history_archives(archive_id, created_at, before_timestamp, schema_version, size_bytes, sha256,
      order_count, ledger_count, record_count, payment_match_event_count, status, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', NULL)`)
      .run(archiveId, now, before, schemaVersion, sizeBytes, sha256, counts.payment_orders!, counts.ledger_entries!, recordCount, counts.payment_match_events!);
    saveArchiveIdentities(connection, archiveId);
    deleteArchivedRecords(connection, plan, before);
    appendAuditEvent(connection, { occurredAt: now, actorType: "SYSTEM", action: "history.archive.created", outcome: "SUCCESS",
      subjectType: "history_archive", subjectId: archiveId, details: { before, sha256, size_bytes: sizeBytes, counts } });
    options.validateDatabase(connection);
    connection.exec("COMMIT");
    committed = true;
    renameSync(staging, path);
    syncDirectory(directory);
    return { archive: readHistoryArchive(connection, archiveId), counts, skippedOrders: plan.eligibleOrders - counts.payment_orders! };
  } catch (error) {
    if (!committed && connection.isTransaction) connection.exec("ROLLBACK");
    throw error;
  } finally {
    if (plan) dropHistoryArchivePlan(connection, plan);
    connection.exec("DROP TABLE IF EXISTS temp.archive_request_checkpoints; DROP TABLE IF EXISTS temp.archive_request_checkpoint_providers");
    if (!committed && existsSync(staging)) unlinkSync(staging);
  }
}

/** Finishes a committed publication or removes a candidate whose source is intact. */
export function recoverStagedHistoryArchives(connection: DatabaseSync, dataDirectory: string, instanceId: string): void {
  const directory = join(dataDirectory, "archives");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const match = /^history-([0-9a-f-]{36})\.sqlite3\.partial$/.exec(name);
    if (!match) continue;
    const archiveId = match[1]!;
    const path = historyArchiveFilePath(dataDirectory, archiveId);
    const stagedPath = `${path}.partial`;
    const registered = connection.prepare("SELECT sha256, size_bytes, status FROM history_archives WHERE archive_id = ?").get(archiveId) as
      { sha256: string; size_bytes: number | bigint; status: string } | undefined;
    if (registered) {
      if (registered.status === "DELETED") continue;
      if (statSync(stagedPath).size !== Number(registered.size_bytes) || hashArchiveFile(stagedPath) !== registered.sha256) {
        throw new Error(`待完成归档校验失败：${stagedPath}`);
      }
      if (!existsSync(path)) renameSync(stagedPath, path);
      else if (hashArchiveFile(path) === registered.sha256) unlinkSync(stagedPath);
      else throw new Error(`归档发布位置已被其他文件占用：${path}`);
      syncDirectory(directory);
      continue;
    }
    const staged = openIntegrityDatabase(stagedPath, { readOnly: true, defensive: true, readBigInts: true });
    try {
      const hasMetadata = staged.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'archive_metadata'").get();
      const metadata = hasMetadata ? staged.prepare("SELECT value FROM archive_metadata WHERE key = 'instance_id'").get() : undefined;
      // Metadata is committed last in the archive file, before the source can
      // be changed. A file without it was interrupted during its first write.
      if (metadata && JSON.parse(String(metadata.value)) !== instanceId) throw new Error(`待完成归档属于其他实例：${stagedPath}`);
      if (metadata && !archiveSourceStillPresent(connection, staged)) {
        throw new Error(`发现未登记归档，源记录已变化；文件已保留：${stagedPath}`);
      }
    } finally { staged.close(); }
    unlinkSync(stagedPath);
    syncDirectory(directory);
  }
}

function archiveSourceStillPresent(connection: DatabaseSync, staged: DatabaseSync): boolean {
  const allowed = new Set<string>([...ARCHIVE_BUSINESS_TABLES, "ledger_request_checkpoints"]);
  const lookups = new Map<string, { statement: ReturnType<DatabaseSync["prepare"]>; primaryKey: string[] }>();
  for (const record of staged.prepare("SELECT table_name, payload, sha256, raw_bytes FROM archive_records").iterate()) {
    const table = String(record.table_name);
    if (!allowed.has(table)) return false;
    let lookup = lookups.get(table);
    if (!lookup) {
      const columns = connection.prepare(`PRAGMA table_info(${quoted(table)})`).all() as {name: string; pk: number | bigint}[];
      const primaryKey = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => column.name);
      lookup = { primaryKey, statement: connection.prepare(`SELECT * FROM ${quoted(table)} WHERE ${primaryKey.map(column => `${quoted(column)} IS ?`).join(" AND ")}`) };
      lookups.set(table, lookup);
    }
    const archived = decodeArchiveRecord(record.payload as Uint8Array, String(record.sha256), Number(record.raw_bytes));
    const original = lookup.statement.get(...lookup.primaryKey.map(column => archived[column]!));
    if (!original || encodeArchiveRecord(original).sha256 !== record.sha256) return false;
  }
  return true;
}

function writeArchiveOrders(source: DatabaseSync, archive: DatabaseSync): void {
  const rows = source.prepare(`SELECT orders.order_id, orders.merchant_order_no, orders.api_client_id AS site_id,
    COALESCE(json_extract(site.configuration, '$.name'), orders.api_client_id) AS site_name,
    orders.product_name, orders.requested_amount_cents, orders.payable_amount_cents, orders.received_amount_cents,
    orders.payment_status, orders.refund_status, orders.created_at, orders.updated_at
    FROM payment_orders AS orders JOIN ${selectedTable("payment_orders")} AS selected ON selected.source_rowid = orders.rowid
      LEFT JOIN sites AS site ON site.client_id = orders.api_client_id`).iterate();
  const save = archive.prepare("INSERT INTO archive_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows) save.run(row.order_id!, row.merchant_order_no!, row.site_id!, row.site_name!, row.product_name!, row.requested_amount_cents!,
    row.payable_amount_cents!, row.received_amount_cents!, row.payment_status!, row.refund_status!, row.created_at!, row.updated_at!);
}

function writeArchiveRelations(source: DatabaseSync, archive: DatabaseSync, plan: HistoryArchivePlan): void {
  const save = archive.prepare(`INSERT OR IGNORE INTO archive_record_links(record_id, parent_record_id)
    SELECT child.record_id, parent.record_id FROM archive_records AS child, archive_records AS parent
    WHERE child.table_name = ? AND child.record_key = ? AND parent.table_name = ? AND parent.record_key = ?`);
  const tableMap = new Map(plan.tables.map(table => [table.name, table]));
  for (const relation of plan.relations) {
    const child = tableMap.get(relation.child)!;
    const parent = tableMap.get(relation.parent)!;
    const columns = [...child.primaryKey.map((key, i) => `child.${quoted(key)} AS child_${i}`), ...parent.primaryKey.map((key, i) => `parent.${quoted(key)} AS parent_${i}`)];
    const join = relation.joinSql ?? relation.pairs.map(pair => `child.${quoted(pair.from)} = parent.${quoted(pair.to)}`).join(" AND ");
    for (const row of source.prepare(`SELECT ${columns.join(", ")} FROM ${quoted(child.name)} AS child
      JOIN ${selectedTable(child.name)} AS selected ON selected.source_rowid = child.rowid
      JOIN ${quoted(parent.name)} AS parent ON ${join}`).iterate()) {
      save.run(child.name, archiveRecordKey(row, child.primaryKey.map((_, i) => `child_${i}`)), parent.name,
        archiveRecordKey(row, parent.primaryKey.map((_, i) => `parent_${i}`)));
    }
  }
}

function verifyArchiveContents(archive: DatabaseSync, counts: Readonly<Record<string, number>>): void {
  if (archive.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok" || archive.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("归档文件完整性校验失败。");
  }
  for (const [table, expected] of Object.entries(counts)) {
    if (Number(archive.prepare("SELECT COUNT(*) AS count FROM archive_records WHERE table_name = ?").get(table)!.count) !== expected) {
      throw new Error(`归档记录数量不一致：${table}`);
    }
  }
  for (const row of archive.prepare("SELECT payload, sha256, raw_bytes FROM archive_records").iterate()) {
    decodeArchiveRecord(row.payload as Uint8Array, String(row.sha256), Number(row.raw_bytes));
  }
  for (const row of archive.prepare("SELECT fingerprint, encoding, raw_bytes, body FROM archive_evidence_payloads").iterate()) {
    const bytes = row.encoding === "gzip" ? gunzipSync(row.body as Uint8Array, {maxOutputLength: Number(row.raw_bytes)}) : Buffer.from(row.body as Uint8Array);
    if (bytes.length !== Number(row.raw_bytes) || createHash("sha256").update(bytes).digest("hex") !== row.fingerprint) {
      throw new Error("归档采集正文校验失败。");
    }
  }
}

function saveArchiveIdentities(connection: DatabaseSync, archiveId: string): void {
  const saveOperation = connection.prepare(`INSERT INTO archived_operation_keys(operation_kind, operation_id, operation_key_digest, archive_id)
    VALUES (?, ?, ?, ?)`);
  for (const [kind, table, id] of [["FINANCIAL", "financial_operations", "financial_operation_id"],
    ["LEDGER_CONFLICT", "ledger_conflict_operations", "conflict_operation_id"]] as const) {
    for (const row of connection.prepare(`SELECT operation.${quoted(id)} AS operation_id, operation.operation_key FROM ${quoted(table)} AS operation
      JOIN ${selectedTable(table)} AS selected ON selected.source_rowid = operation.rowid`).iterate()) {
      saveOperation.run(kind, row.operation_id!, archiveIdentityDigest(String(row.operation_key)), archiveId);
    }
  }
  connection.prepare(`INSERT INTO archived_admin_operation_keys(operation_id, archive_id, audit_event_id)
    SELECT operation.operation_id, ?, audit.event_id FROM admin_operation_log AS operation
    JOIN ${selectedTable("admin_operation_log")} AS selected ON selected.source_rowid = operation.rowid
    JOIN audit_events AS audit ON audit.actor_type = 'ADMIN' AND audit.subject_type = 'admin_operation' AND audit.outcome = 'SUCCESS'
      AND json_extract(audit.details_json, '$.operation_id') = operation.operation_id`).run(archiveId);
  const saveOrder = connection.prepare(`INSERT INTO archived_order_keys(order_id, archive_id, api_client_id, merchant_order_digest, idempotency_key_digest)
    VALUES (?, ?, ?, ?, ?)`);
  for (const row of connection.prepare(`SELECT orders.* FROM payment_orders AS orders JOIN ${selectedTable("payment_orders")} AS selected ON orders.rowid = selected.source_rowid`).iterate()) {
    saveOrder.run(row.order_id!, archiveId, row.api_client_id!, archiveIdentityDigest(String(row.merchant_order_no)), row.idempotency_key_digest!);
  }
  const saveLedger = connection.prepare(`INSERT INTO archived_ledger_keys(ledger_entry_id, archive_id, provider_account_key, external_event_digest, semantic_fingerprint, payment_settled)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of connection.prepare(`SELECT entry.*, EXISTS (
      SELECT 1 FROM payment_matches AS payment_match WHERE payment_match.ledger_entry_id = entry.ledger_entry_id AND payment_match.status = 'SETTLED'
    ) AS payment_settled FROM ledger_entries AS entry JOIN ${selectedTable("ledger_entries")} AS selected ON entry.rowid = selected.source_rowid`).iterate()) {
    saveLedger.run(row.ledger_entry_id!, archiveId, row.provider_account_key!, archiveIdentityDigest(String(row.external_event_id)), row.semantic_fingerprint!, row.payment_settled!);
  }
  connection.exec(`INSERT INTO archived_amount_slot_anchors(alipay_account_id, payable_amount_cents, generation, released_at, available_at)
    SELECT slot.alipay_account_id, slot.payable_amount_cents, slot.generation, slot.released_at,
      MAX(slot.released_at, (CASE WHEN orders.checkout_status = 'EXPIRED' THEN orders.expires_at ELSE orders.closed_at END) + orders.amount_reuse_cooldown_seconds * 1000)
    FROM amount_slots AS slot JOIN ${selectedTable("amount_slots")} AS selected ON selected.source_rowid = slot.rowid
      JOIN payment_orders AS orders ON orders.order_id = slot.order_id
    WHERE NOT EXISTS (SELECT 1 FROM amount_slots AS later JOIN ${selectedTable("amount_slots")} AS selected_later ON selected_later.source_rowid = later.rowid
      WHERE later.alipay_account_id = slot.alipay_account_id AND later.payable_amount_cents = slot.payable_amount_cents AND later.generation > slot.generation)
    ON CONFLICT(alipay_account_id, payable_amount_cents) DO UPDATE SET generation = excluded.generation,
      released_at = excluded.released_at, available_at = excluded.available_at;`);
}

function deleteArchivedRecords(connection: DatabaseSync, plan: HistoryArchivePlan, before: number): void {
  const tables = new Set(plan.tables.map(table => table.name));
  const guards = (connection.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as {name: string; tbl_name: string; sql: string}[])
    .filter(trigger => tables.has(trigger.tbl_name) && /\bBEFORE\s+DELETE\b/i.test(trigger.sql));
  for (const guard of guards) connection.exec(`DROP TRIGGER ${quoted(guard.name)}`);
  connection.exec("UPDATE ledger_retention_state SET pruning = 1 WHERE singleton_key = 1");
  for (const table of plan.tables) connection.exec(`DELETE FROM ${quoted(table.name)} WHERE rowid IN (SELECT source_rowid FROM ${selectedTable(table.name)})`);
  retireArchiveRequestCheckpoints(connection, before);
  connection.exec(`DELETE FROM ledger_evidence_payloads WHERE
    NOT EXISTS (SELECT 1 FROM provider_raw_pages WHERE raw_body_reference = fingerprint)
    AND NOT EXISTS (SELECT 1 FROM provider_raw_events WHERE raw_payload_reference = fingerprint)
    AND NOT EXISTS (SELECT 1 FROM ingest_errors WHERE raw_body_reference = fingerprint)`);
  connection.exec("UPDATE ledger_retention_state SET pruning = 0 WHERE singleton_key = 1");
  for (const guard of guards) connection.exec(guard.sql);
}
