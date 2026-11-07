import type { DatabaseSync } from "node:sqlite";

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

/** Returns the previous hash when another matching signed response is required. */
export function reconsiderRetiredResponse(
  connection: DatabaseSync,
  providerAccountKey: string,
  requestFingerprint: string,
  responseFingerprint: string,
  observedAt: number,
): string | null {
  // Upgrade fixtures can ingest using a released schema before migration 43.
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_request_checkpoints'").get()) return null;
  const request = Buffer.from(requestFingerprint, "hex");
  const response = Buffer.from(responseFingerprint, "hex");
  const checkpoint = connection.prepare(`SELECT response_fingerprint FROM ledger_request_checkpoints
    WHERE provider_account_key = ? AND request_fingerprint = ?`).get(providerAccountKey, request) as
    { response_fingerprint: Uint8Array } | undefined;
  if (!checkpoint || response.equals(checkpoint.response_fingerprint)) return null;
  connection.prepare(`UPDATE ledger_request_checkpoints SET response_fingerprint = ?, observed_at = MAX(observed_at, ?)
    WHERE provider_account_key = ? AND request_fingerprint = ?`).run(response, observedAt, providerAccountKey, request);
  return Buffer.from(checkpoint.response_fingerprint).toString("hex");
}
