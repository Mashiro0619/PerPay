import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const BATCH_RECORDS = 200;
const BATCH_BYTES = 8 * 1024 * 1024;
const supportedConnections = new WeakSet<DatabaseSync>();

export function hasEvidencePayloads(connection: DatabaseSync): boolean {
  if (supportedConnections.has(connection)) return true;
  const available = connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_evidence_payloads'").get() !== undefined;
  if (available) supportedConnections.add(connection);
  return available;
}

export function storeEvidencePayload(connection: DatabaseSync, body: Uint8Array): { body: Uint8Array; reference: string | null } {
  if (!hasEvidencePayloads(connection)) return { body, reference: null };
  const fingerprint = createHash("sha256").update(body).digest("hex");
  if (!connection.prepare("SELECT 1 FROM ledger_evidence_payloads WHERE fingerprint = ?").get(fingerprint)) {
    const compressed = gzipSync(body);
    const useGzip = compressed.byteLength < body.byteLength;
    connection.prepare("INSERT INTO ledger_evidence_payloads(fingerprint, encoding, raw_bytes, body) VALUES (?, ?, ?, ?)")
      .run(fingerprint, useGzip ? "gzip" : "identity", body.byteLength, useGzip ? compressed : body);
  }
  return { body: new Uint8Array(), reference: fingerprint };
}

export function readEvidencePayload(
  connection: DatabaseSync,
  inline: Uint8Array,
  reference: string | null | undefined,
  maximumBytes = MAX_PAYLOAD_BYTES,
): Uint8Array {
  if (reference == null) return new Uint8Array(inline);
  const row = connection.prepare("SELECT encoding, raw_bytes, body FROM ledger_evidence_payloads WHERE fingerprint = ?").get(reference) as
    { encoding: "identity" | "gzip"; raw_bytes: number | bigint; body: Uint8Array } | undefined;
  if (!row) throw new Error("ledger evidence payload is missing");
  const bytes = decodePayload(row, maximumBytes);
  if (createHash("sha256").update(bytes).digest("hex") !== reference) throw new Error("ledger evidence payload fingerprint does not match");
  return bytes;
}

function decodePayload(row: { encoding: string; raw_bytes: number | bigint; body: Uint8Array }, maximumBytes: number): Uint8Array {
  const size = Number(row.raw_bytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error("ledger evidence payload size is invalid");
  const bytes = row.encoding === "gzip" ? gunzipSync(row.body, { maxOutputLength: maximumBytes }) : new Uint8Array(row.body);
  if (row.encoding !== "gzip" && row.encoding !== "identity") throw new Error("ledger evidence payload encoding is invalid");
  if (bytes.byteLength !== size) throw new Error("ledger evidence payload size does not match");
  return bytes;
}

export function countEvidencePayloadViolations(connection: DatabaseSync): number {
  if (!hasEvidencePayloads(connection)) return 0;
  let violations = 0;
  for (const row of connection.prepare("SELECT fingerprint, encoding, raw_bytes, body FROM ledger_evidence_payloads").iterate() as Iterable<{
    fingerprint: string; encoding: string; raw_bytes: number | bigint; body: Uint8Array;
  }>) {
    try {
      if (createHash("sha256").update(decodePayload(row, MAX_PAYLOAD_BYTES)).digest("hex") !== row.fingerprint) violations++;
    } catch { violations++; }
  }
  const oversizedEvents = connection.prepare(`SELECT count(*) AS count FROM provider_raw_events AS event
    JOIN ledger_evidence_payloads AS payload ON payload.fingerprint = event.raw_payload_reference
    WHERE payload.raw_bytes > 524288`).get() as { count: number | bigint };
  return violations + Number(oversizedEvents.count);
}

const sources = [
  { table: "provider_raw_pages", key: "raw_page_id", body: "raw_body", reference: "raw_body_reference", fingerprint: "response_fingerprint", time: "received_at" },
  { table: "provider_raw_events", key: "raw_event_id", body: "raw_payload", reference: "raw_payload_reference", fingerprint: "payload_fingerprint", time: "observed_at" },
  { table: "ingest_errors", key: "ingest_error_id", body: "raw_body", reference: "raw_body_reference", fingerprint: "response_fingerprint", time: "occurred_at" },
] as const;

/** Converts existing evidence without changing its original bytes or record identity. */
export function compactEvidencePayloads(database: Pick<AppDatabase, "read" | "write">): { compactedRecords: number; removedPayloads: number; hasMore: boolean } {
  if (!database.read(hasEvidencePayloads)) return { compactedRecords: 0, removedPayloads: 0, hasMore: false };
  return database.write(connection => {
    let compactedRecords = 0, bytes = 0, hasMore = false;
    for (const source of sources) {
      const rows = connection.prepare(`SELECT ${source.key} AS id, length(${source.body}) AS raw_bytes, ${source.fingerprint} AS fingerprint
        FROM ${source.table} WHERE ${source.reference} IS NULL AND ${source.body} IS NOT NULL
        ORDER BY ${source.time}, ${source.key} LIMIT ?`).all(BATCH_RECORDS - compactedRecords + 1) as unknown as
        { id: string; raw_bytes: number | bigint; fingerprint: string }[];
      const readBody = connection.prepare(`SELECT ${source.body} AS body FROM ${source.table} WHERE ${source.key} = ?`);
      for (const row of rows) {
        const rawBytes = Number(row.raw_bytes);
        if (compactedRecords >= BATCH_RECORDS || (compactedRecords > 0 && bytes + rawBytes > BATCH_BYTES)) { hasMore = true; break; }
        const { body } = readBody.get(row.id) as { body: Uint8Array };
        if (createHash("sha256").update(body).digest("hex") !== row.fingerprint) throw new Error("existing ledger evidence fingerprint does not match");
        const stored = storeEvidencePayload(connection, body);
        connection.prepare(`UPDATE ${source.table} SET ${source.body} = ?, ${source.reference} = ? WHERE ${source.key} = ?`)
          .run(stored.body, stored.reference, row.id);
        compactedRecords++;
        bytes += rawBytes;
      }
      if (hasMore) break;
    }
    const cleanup = connection.prepare("SELECT scan_after_fingerprint FROM ledger_evidence_cleanup_state WHERE singleton_key = 1")
      .get() as { scan_after_fingerprint: string | null };
    const payloads = connection.prepare(`SELECT fingerprint FROM ledger_evidence_payloads
      WHERE fingerprint > ? ORDER BY fingerprint LIMIT ?`)
      .all(cleanup.scan_after_fingerprint ?? "", BATCH_RECORDS + 1) as { fingerprint: string }[];
    const remove = connection.prepare(`DELETE FROM ledger_evidence_payloads AS payload
      WHERE fingerprint = ?
        AND NOT EXISTS (SELECT 1 FROM provider_raw_pages WHERE raw_body_reference = payload.fingerprint)
        AND NOT EXISTS (SELECT 1 FROM provider_raw_events WHERE raw_payload_reference = payload.fingerprint)
        AND NOT EXISTS (SELECT 1 FROM ingest_errors WHERE raw_body_reference = payload.fingerprint)`);
    const batch = payloads.slice(0, BATCH_RECORDS);
    let removedPayloads = 0;
    for (const row of batch) removedPayloads += Number(remove.run(row.fingerprint).changes);
    const cleanupHasMore = payloads.length > BATCH_RECORDS;
    // A completed pass yields to the scheduler. The next pass revisits references
    // released behind the cursor, while unfinished passes resume after restart.
    connection.prepare("UPDATE ledger_evidence_cleanup_state SET scan_after_fingerprint = ? WHERE singleton_key = 1")
      .run(cleanupHasMore ? batch.at(-1)!.fingerprint : null);
    return { compactedRecords, removedPayloads, hasMore: hasMore || cleanupHasMore };
  });
}
