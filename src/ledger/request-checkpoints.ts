import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { parseOccurredAt } from "./model.ts";

/** Keeps request stability after the bulky response and observation history retires. */
export function retainRequestCheckpoints(connection: DatabaseSync): void {
  const rows = connection.prepare(`WITH retiring AS (
    SELECT page.provider_account_key, page.request_fingerprint, page.response_fingerprint,
           observation.observed_at,
           ROW_NUMBER() OVER (
             PARTITION BY page.provider_account_key, page.request_fingerprint
             ORDER BY observation.observation_sequence DESC
           ) AS latest
      FROM ingest_retention_batch AS batch
        CROSS JOIN provider_raw_pages AS page
        CROSS JOIN ingest_run_page_observations AS observation
     WHERE page.ingest_run_id = batch.ingest_run_id AND observation.raw_page_id = page.raw_page_id
       AND NOT EXISTS (
         SELECT 1 FROM provider_raw_pages AS retained
          WHERE retained.provider_account_key = page.provider_account_key
            AND retained.request_fingerprint = page.request_fingerprint
            AND NOT EXISTS (SELECT 1 FROM ingest_retention_batch WHERE ingest_run_id = retained.ingest_run_id)
       )
  ) SELECT provider_account_key, request_fingerprint, response_fingerprint, observed_at
      FROM retiring WHERE latest = 1`).all() as unknown as {
        provider_account_key: string; request_fingerprint: string; response_fingerprint: string; observed_at: bigint | number;
      }[];
  const save = connection.prepare(`INSERT INTO ledger_request_checkpoints
    (provider_account_key, request_fingerprint, response_fingerprint, observed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_account_key, request_fingerprint) DO UPDATE SET
      response_fingerprint = excluded.response_fingerprint,
      observed_at = MAX(ledger_request_checkpoints.observed_at, excluded.observed_at)`);
  for (const row of rows) save.run(row.provider_account_key, Buffer.from(row.request_fingerprint, "hex"),
    Buffer.from(row.response_fingerprint, "hex"), row.observed_at);
}

/** Returns the comparison baseline when another matching signed response is required. */
export function reconsiderRetiredResponse(
  connection: DatabaseSync,
  providerAccountKey: string,
  requestFingerprint: string,
  responseFingerprint: string,
  observedAt: number,
  windowEnd: string,
): string | null {
  // Upgrade fixtures can ingest using a released schema before migration 43.
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_request_checkpoints'").get()) return null;
  const request = Buffer.from(requestFingerprint, "hex");
  const response = Buffer.from(responseFingerprint, "hex");
  const checkpoint = connection.prepare(`SELECT response_fingerprint FROM ledger_request_checkpoints
    WHERE provider_account_key = ? AND request_fingerprint = ?`).get(providerAccountKey, request) as
    { response_fingerprint: Uint8Array } | undefined;
  if (!checkpoint) {
    // Unknown current windows still accept their first signed response. Only a
    // window older than archived history needs to establish a new baseline.
    if (!hasRequestCheckpointArchive(connection)) return null;
    const archived = connection.prepare(`SELECT before_timestamp FROM ledger_request_archive_watermarks
      WHERE provider_account_key = ?`).get(providerAccountKey) as { before_timestamp: number | bigint } | undefined;
    if (!archived || parseOccurredAt(windowEnd) >= Number(archived.before_timestamp)) return null;
    connection.prepare(`INSERT INTO ledger_request_checkpoints
      (provider_account_key, request_fingerprint, response_fingerprint, observed_at) VALUES (?, ?, ?, ?)`)
      .run(providerAccountKey, request, response, observedAt);
    return responseFingerprint;
  }
  if (response.equals(checkpoint.response_fingerprint)) return null;
  connection.prepare(`UPDATE ledger_request_checkpoints SET response_fingerprint = ?, observed_at = MAX(observed_at, ?)
    WHERE provider_account_key = ? AND request_fingerprint = ?`).run(response, observedAt, providerAccountKey, request);
  return Buffer.from(checkpoint.response_fingerprint).toString("hex");
}

/** Fixes the checkpoint snapshot before the archive file is written. */
export function iterateArchiveRequestCheckpoints(
  connection: DatabaseSync,
  before: number,
): Iterable<Record<string, SQLOutputValue>> {
  if (!hasRequestCheckpointArchive(connection)) return [];
  const hasSelectedPages = !!connection.prepare(`SELECT 1 FROM sqlite_temp_schema
    WHERE type = 'table' AND name = 'archive_selected_provider_raw_pages'`).get();
  connection.exec(`DROP TABLE IF EXISTS temp.archive_request_checkpoints;
    DROP TABLE IF EXISTS temp.archive_request_checkpoint_providers;
    CREATE TEMP TABLE archive_request_checkpoints (
      provider_account_key TEXT NOT NULL, request_fingerprint BLOB NOT NULL,
      response_fingerprint BLOB NOT NULL, observed_at INTEGER NOT NULL,
      PRIMARY KEY (provider_account_key, request_fingerprint)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE archive_request_checkpoint_providers (provider_account_key TEXT PRIMARY KEY) WITHOUT ROWID;`);
  connection.prepare(`INSERT INTO archive_request_checkpoints
    SELECT checkpoint.provider_account_key, checkpoint.request_fingerprint, checkpoint.response_fingerprint, checkpoint.observed_at
      FROM ledger_request_checkpoints AS checkpoint
     WHERE checkpoint.observed_at < ? AND NOT EXISTS (
       SELECT 1 FROM provider_raw_pages AS page
        WHERE page.provider_account_key = checkpoint.provider_account_key
          AND page.request_fingerprint = lower(hex(checkpoint.request_fingerprint))
          ${hasSelectedPages ? "AND NOT EXISTS (SELECT 1 FROM archive_selected_provider_raw_pages WHERE source_rowid = page.rowid)" : ""}
     )`).run(before);
  connection.exec(`INSERT INTO archive_request_checkpoint_providers
    SELECT DISTINCT provider_account_key FROM archive_request_checkpoints;`);
  if (hasSelectedPages) connection.exec(`INSERT OR IGNORE INTO archive_request_checkpoint_providers
    SELECT page.provider_account_key FROM provider_raw_pages AS page
      JOIN archive_selected_provider_raw_pages AS selected ON selected.source_rowid = page.rowid;`);
  return connection.prepare(`SELECT provider_account_key, request_fingerprint, response_fingerprint, observed_at
    FROM archive_request_checkpoints ORDER BY provider_account_key, request_fingerprint`).iterate();
}

/** Called after the archive is durable and its selected online pages have been removed. */
export function retireArchiveRequestCheckpoints(connection: DatabaseSync, before: number): number {
  if (!hasRequestCheckpointArchive(connection)) return 0;
  connection.prepare(`INSERT INTO ledger_request_archive_watermarks(provider_account_key, before_timestamp)
    SELECT provider_account_key, ? FROM archive_request_checkpoint_providers WHERE true
    ON CONFLICT(provider_account_key) DO UPDATE SET
      before_timestamp = MAX(ledger_request_archive_watermarks.before_timestamp, excluded.before_timestamp)`).run(before);
  const deleted = connection.prepare(`DELETE FROM ledger_request_checkpoints
    WHERE (provider_account_key, request_fingerprint) IN (
      SELECT provider_account_key, request_fingerprint FROM archive_request_checkpoints)`).run();
  connection.exec(`DROP TABLE temp.archive_request_checkpoints;
    DROP TABLE temp.archive_request_checkpoint_providers;`);
  return Number(deleted.changes);
}

function hasRequestCheckpointArchive(connection: DatabaseSync): boolean {
  return !!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_request_archive_watermarks'").get();
}
