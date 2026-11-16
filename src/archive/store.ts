import { existsSync, lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { type DatabaseSync } from "node:sqlite";
import { currentAuditContext } from "../audit/context.ts";
import { openIntegrityDatabase } from "../database/connection.ts";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { syncDirectory } from "../database/maintenance-lock.ts";
import { decodeArchiveRecord, hashArchiveFile, type ArchiveSourceRow } from "./codec.ts";
import { HistoryArchiveError, type ArchiveOrderSummary, type HistoryArchiveRecord, type HistoryArchiveSummary } from "./model.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;
const SUMMARY_COLUMNS = `archive_id, created_at, before_timestamp AS before, schema_version, size_bytes,
  sha256, order_count, ledger_count, status, deleted_at`;
const VERIFIED_ARCHIVE_LIMIT = 32;
const PARTIAL_ARCHIVE_NAME = /^history-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.sqlite3\.partial$/;
const verifiedArchives = new Map<string, { identity: string; sha256: string }>();

export function listHistoryArchives(connection: DatabaseSync, dataDirectory?: string): HistoryArchiveSummary[] {
  return (connection.prepare(`SELECT ${SUMMARY_COLUMNS} FROM history_archives ORDER BY created_at DESC, archive_id DESC`).all() as unknown as HistoryArchiveSummary[])
    .map(row => ({ ...mapSummary(row), ...(dataDirectory === undefined ? {} : {
      deletion_pending: row.status === "DELETED" && existsSync(`${historyArchiveFilePath(dataDirectory, row.archive_id)}.deleting`),
    }) }));
}

export function readHistoryArchive(connection: DatabaseSync, archiveId: string): HistoryArchiveSummary {
  const row = connection.prepare(`SELECT ${SUMMARY_COLUMNS} FROM history_archives WHERE archive_id = ?`).get(archiveId) as unknown as HistoryArchiveSummary | undefined;
  if (!row) throw new HistoryArchiveError("archive_not_found", "归档不存在。");
  return mapSummary(row);
}

function mapSummary(row: HistoryArchiveSummary): HistoryArchiveSummary {
  return { ...row, created_at: Number(row.created_at), before: Number(row.before), schema_version: Number(row.schema_version),
    size_bytes: Number(row.size_bytes), order_count: Number(row.order_count), ledger_count: Number(row.ledger_count),
    deleted_at: row.deleted_at === null ? null : Number(row.deleted_at) };
}

export function historyArchiveFilePath(dataDirectory: string, archiveId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(archiveId)) throw new HistoryArchiveError("archive_not_found", "归档不存在。");
  return join(dataDirectory, "archives", `history-${archiveId}.sqlite3`);
}

export function getHistoryArchiveDownload(connection: DatabaseSync, dataDirectory: string, archiveId: string): { archive: HistoryArchiveSummary; path: string; fileName: string } {
  const archive = readHistoryArchive(connection, archiveId);
  if (archive.status === "DELETED") throw new HistoryArchiveError("archive_deleted", "此归档已永久删除。");
  const path = availableArchivePath(dataDirectory, archiveId);
  assertArchiveFile(path, archive);
  return { archive, path, fileName: `history-${archiveId}.sqlite3` };
}

function assertArchiveFile(path: string, archive: HistoryArchiveSummary): void {
  if (!existsSync(path)) throw new HistoryArchiveError("archive_changed", "归档文件缺失，请检查数据目录中的 archives 文件夹。");
  const stat = lstatSync(path, { bigint: true });
  const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== archive.size_bytes) {
    verifiedArchives.delete(path);
    throw new HistoryArchiveError("archive_changed", "归档文件与登记信息不一致。");
  }
  const verified = verifiedArchives.get(path);
  verifiedArchives.delete(path);
  if (verified?.identity !== identity || verified.sha256 !== archive.sha256) {
    if (hashArchiveFile(path) !== archive.sha256) throw new HistoryArchiveError("archive_changed", "归档文件与登记信息不一致。");
  }
  verifiedArchives.set(path, { identity, sha256: archive.sha256 });
  if (verifiedArchives.size > VERIFIED_ARCHIVE_LIMIT) verifiedArchives.delete(verifiedArchives.keys().next().value!);
}

function availableArchivePath(dataDirectory: string, archiveId: string): string {
  const path = historyArchiveFilePath(dataDirectory, archiveId);
  // A committed archive remains usable if final publication was interrupted.
  if (existsSync(path)) return path;
  if (existsSync(`${path}.partial`)) return `${path}.partial`;
  return existsSync(`${path}.deleting`) ? `${path}.deleting` : path;
}

export function readHistoryArchiveOrders(connection: DatabaseSync, dataDirectory: string, archiveId: string, options: { cursor?: string; limit?: number } = {}): {
  archive: HistoryArchiveSummary; orders: ArchiveOrderSummary[]; next_cursor: string | null;
} {
  const { archive, path } = getHistoryArchiveDownload(connection, dataDirectory, archiveId);
  const source = openIntegrityDatabase(path, { readOnly: true, defensive: true });
  try {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const rows = source.prepare(`SELECT * FROM archive_orders ${options.cursor ? "WHERE order_id > ?" : ""} ORDER BY order_id LIMIT ?`)
      .all(...(options.cursor ? [options.cursor] : []), limit + 1) as unknown as ArchiveOrderSummary[];
    return { archive, orders: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1]!.order_id : null };
  } finally { source.close(); }
}

export function readHistoryArchiveOrder(connection: DatabaseSync, dataDirectory: string, archiveId: string, orderId: string): {
  order: ArchiveOrderSummary; records: HistoryArchiveRecord[];
} {
  const { path } = getHistoryArchiveDownload(connection, dataDirectory, archiveId);
  const source = openIntegrityDatabase(path, { readOnly: true, defensive: true });
  try {
    const order = source.prepare("SELECT * FROM archive_orders WHERE order_id = ?").get(orderId) as unknown as ArchiveOrderSummary | undefined;
    if (!order) throw new HistoryArchiveError("archive_order_not_found", "归档中不存在此订单。");
    const rows = source.prepare(`WITH RECURSIVE related(record_id) AS (
        SELECT record_id FROM archive_records WHERE table_name = 'payment_orders' AND record_key = ?
        UNION SELECT link.parent_record_id FROM archive_record_links AS link JOIN related ON link.record_id = related.record_id
        UNION SELECT link.record_id FROM archive_record_links AS link JOIN related ON link.parent_record_id = related.record_id
          JOIN archive_records AS parent ON parent.record_id = related.record_id
          WHERE parent.table_name NOT IN ('ingest_runs', 'provider_raw_pages', 'provider_raw_events', 'ledger_entries', 'amount_slots')
      ) SELECT record.* FROM archive_records AS record JOIN related USING(record_id)
        ORDER BY record.table_name, record.record_key`).all(JSON.stringify([orderId])) as {
          table_name: string; record_key: string; payload: Uint8Array; sha256: string; raw_bytes: number;
        }[];
    return { order, records: rows.map(row => ({ table: row.table_name, key: row.record_key,
      data: displayRecord(source, decodeArchiveRecord(row.payload, row.sha256, row.raw_bytes)),
    })) };
  } finally { source.close(); }
}

export function readHistoryArchiveRecords(connection: DatabaseSync, dataDirectory: string, archiveId: string,
  options: { table?: string; cursor?: string; limit?: number } = {}): {
    archive: HistoryArchiveSummary; tables: { table: string; count: number }[]; records: HistoryArchiveRecord[]; next_cursor: string | null;
  } {
  const { archive, path } = getHistoryArchiveDownload(connection, dataDirectory, archiveId);
  const source = openIntegrityDatabase(path, { readOnly: true, defensive: true });
  try {
    const tables = source.prepare("SELECT table_name AS 'table', COUNT(*) AS count FROM archive_records GROUP BY table_name ORDER BY table_name").all() as
      {table: string; count: number}[];
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)));
    const cursor = Number(options.cursor ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("归档记录页码无效。");
    const rows = source.prepare(`SELECT record_id, table_name, record_key, payload, sha256, raw_bytes FROM archive_records
      WHERE record_id > ? ${options.table ? "AND table_name = ?" : ""} ORDER BY record_id LIMIT ?`)
      .all(cursor, ...(options.table ? [options.table] : []), limit + 1) as {
        record_id: number; table_name: string; record_key: string; payload: Uint8Array; sha256: string; raw_bytes: number;
      }[];
    return { archive, tables, records: rows.slice(0, limit).map(row => ({ table: row.table_name, key: row.record_key,
      data: displayRecord(source, decodeArchiveRecord(row.payload, row.sha256, row.raw_bytes)) })),
      next_cursor: rows.length > limit ? String(rows[limit - 1]!.record_id) : null };
  } finally { source.close(); }
}

function displayRecord(source: DatabaseSync, row: ArchiveSourceRow): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_reference")) continue;
    const reference = row[`${key}_reference`];
    if ((key === "raw_body" || key === "raw_payload") && typeof reference === "string") {
      const payload = source.prepare("SELECT encoding, body, raw_bytes FROM archive_evidence_payloads WHERE fingerprint = ?").get(reference) as
        {encoding: string; body: Uint8Array; raw_bytes: number} | undefined;
      if (!payload) throw new Error("归档缺少采集正文。");
      const bytes = payload.encoding === "gzip" ? gunzipSync(payload.body, { maxOutputLength: payload.raw_bytes }) : Buffer.from(payload.body);
      result[key] = bytes.toString("utf8");
    } else {
      result[key] = value instanceof Uint8Array ? Buffer.from(value).toString(key.endsWith("fingerprint") ? "hex" : "utf8") : typeof value === "bigint" ? Number(value) : value;
    }
  }
  return result;
}

export function deleteHistoryArchive(database: DatabaseOwner, dataDirectory: string, archiveId: string, expectedSha256: string, now = Date.now()): HistoryArchiveSummary {
  const path = historyArchiveFilePath(dataDirectory, archiveId);
  const pendingPath = `${path}.deleting`;
  const availablePath = availableArchivePath(dataDirectory, archiveId);
  const rollbackPath = availablePath === pendingPath ? path : availablePath;
  let renamed = false;
  let result: HistoryArchiveSummary;
  try {
    result = database.write(connection => {
      const archive = readHistoryArchive(connection, archiveId);
      if (archive.sha256 !== expectedSha256) throw new HistoryArchiveError("archive_changed", "归档校验值已变化，请刷新后重试。");
      if (archive.status === "DELETED") return archive;
      if (existsSync(availablePath)) {
        assertArchiveFile(availablePath, archive);
        if (availablePath !== pendingPath) renameSync(availablePath, pendingPath);
        verifiedArchives.delete(availablePath);
        renamed = true;
        syncDirectory(join(dataDirectory, "archives"));
      } else {
        assertArchiveFile(pendingPath, archive);
        renamed = true;
      }
      connection.prepare("UPDATE history_archives SET status = 'DELETED', deleted_at = ? WHERE archive_id = ?").run(now, archiveId);
      appendAuditEvent(connection, { occurredAt: now, actorType: "ADMIN", actorId: currentAuditContext()?.actorId ?? undefined, action: "history.archive.deleted", outcome: "SUCCESS",
        subjectType: "history_archive", subjectId: archiveId, details: { sha256: archive.sha256, order_count: archive.order_count, ledger_count: archive.ledger_count } });
      return readHistoryArchive(connection, archiveId);
    });
  } catch (error) {
    if (renamed && existsSync(pendingPath) && !existsSync(rollbackPath)) {
      renameSync(pendingPath, rollbackPath);
      syncDirectory(join(dataDirectory, "archives"));
    }
    throw error;
  }
  try { finishArchiveDeletion(dataDirectory, archiveId); }
  catch {
    throw new HistoryArchiveError("archive_delete_pending", "归档删除已确认，但文件仍未清理，请在列表中重试删除。");
  }
  return { ...result, deletion_pending: false };
}

export function recoverDeletedHistoryArchives(database: Pick<AppDatabase, "read">, dataDirectory: string): {
  deleted: number; restored: number; failed: Array<{ archiveId: string; error: string }>;
} {
  const result = { deleted: 0, restored: 0, failed: [] as Array<{ archiveId: string; error: string }> };
  const directory = resolve(dataDirectory, "archives");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("归档目录必须是普通目录。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed.push({ archiveId: "archives", error: error instanceof Error ? error.message : String(error) });
    return result;
  }
  const archives = database.read(connection => listHistoryArchives(connection));
  for (const archive of archives) {
    try {
      if (archive.status === "DELETED") {
        if (finishArchiveDeletion(dataDirectory, archive.archive_id)) result.deleted++;
      } else {
        const path = historyArchiveFilePath(dataDirectory, archive.archive_id), pendingPath = `${path}.deleting`;
        if (!existsSync(path) && existsSync(pendingPath)) {
          assertArchiveFile(pendingPath, archive);
          renameSync(pendingPath, path);
          verifiedArchives.delete(pendingPath);
          syncDirectory(join(dataDirectory, "archives"));
          result.restored++;
        }
      }
    }
    catch (error) { result.failed.push({ archiveId: archive.archive_id, error: error instanceof Error ? error.message : String(error) }); }
  }
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) {
    result.failed.push({ archiveId: "archives", error: error instanceof Error ? error.message : String(error) });
    return result;
  }
  for (const name of files) {
    const match = PARTIAL_ARCHIVE_NAME.exec(name);
    if (!match) continue;
    const archiveId = match[1]!, stagedPath = resolve(directory, name);
    try {
      const stat = lstatSync(stagedPath);
      if (dirname(stagedPath) !== directory || !stat.isFile() || stat.isSymbolicLink()) throw new Error("待完成归档必须是归档目录中的普通文件。");
      const registered = database.read(connection => connection.prepare(`SELECT ${SUMMARY_COLUMNS} FROM history_archives WHERE archive_id = ?`).get(archiveId)) as unknown as HistoryArchiveSummary | undefined;
      if (registered) {
        if (registered.status !== "AVAILABLE") continue;
        const archive = mapSummary(registered), path = historyArchiveFilePath(dataDirectory, archiveId);
        assertArchiveFile(stagedPath, archive);
        if (existsSync(path)) {
          assertArchiveFile(path, archive);
          unlinkSync(stagedPath);
          result.deleted++;
        } else {
          renameSync(stagedPath, path);
          result.restored++;
        }
      } else {
        const staged = openIntegrityDatabase(stagedPath, { readOnly: true, defensive: true });
        let complete: boolean;
        try {
          complete = !!staged.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'archive_metadata'").get() &&
            !!staged.prepare("SELECT 1 FROM archive_metadata LIMIT 1").get();
        } finally { staged.close(); }
        // Complete unregistered files may belong to history newer than a
        // restored database. Offline recovery verifies their source records.
        if (complete) {
          result.failed.push({ archiveId, error: "发现完整但未登记的归档，请停服后运行归档命令核对原始记录。" });
          continue;
        }
        if (database.read(connection => connection.prepare("SELECT 1 FROM history_archives WHERE archive_id = ?").get(archiveId))) continue;
        unlinkSync(stagedPath);
        result.deleted++;
      }
      verifiedArchives.delete(stagedPath);
      syncDirectory(directory);
    } catch (error) { result.failed.push({ archiveId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}

function finishArchiveDeletion(dataDirectory: string, archiveId: string): boolean {
  const pendingPath = `${historyArchiveFilePath(dataDirectory, archiveId)}.deleting`;
  try { unlinkSync(pendingPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  verifiedArchives.delete(pendingPath);
  syncDirectory(join(dataDirectory, "archives"));
  return true;
}
