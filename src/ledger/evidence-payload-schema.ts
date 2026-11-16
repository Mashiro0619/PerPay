function referenceSchema(table: string, key: string, body: string, reference: string, fingerprint: string, time: string, columns: readonly string[]): string {
  return `
    ALTER TABLE ${table} ADD COLUMN ${reference} TEXT REFERENCES ledger_evidence_payloads(fingerprint)
      CHECK (${reference} IS NULL OR (${reference} = ${fingerprint} AND length(${body}) = 0) IS TRUE);
    CREATE INDEX ${table}_payload_reference_idx ON ${table}(${reference}) WHERE ${reference} IS NOT NULL;
    CREATE INDEX ${table}_inline_payload_idx ON ${table}(${time}, ${key}) WHERE ${reference} IS NULL AND ${body} IS NOT NULL;
    DROP TRIGGER ${table}_no_update;
    CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
    WHEN (
      OLD.${reference} IS NULL AND NEW.${reference} = OLD.${fingerprint} AND length(NEW.${body}) = 0
      AND ${columns.map(column => `NEW.${column} IS OLD.${column}`).join(" AND ")}
    ) IS NOT TRUE
    BEGIN SELECT RAISE(ABORT, 'ledger evidence may only move unchanged bytes to shared storage'); END;
  `;
}

export const EVIDENCE_PAYLOAD_SCHEMA_SQL = `
  CREATE TABLE ledger_evidence_payloads (
    fingerprint TEXT PRIMARY KEY CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'gzip')),
    raw_bytes INTEGER NOT NULL CHECK (raw_bytes BETWEEN 0 AND 2097152),
    body BLOB NOT NULL CHECK (typeof(body) = 'blob' AND length(body) <= 2097152),
    CHECK (encoding != 'identity' OR length(body) = raw_bytes)
  ) STRICT, WITHOUT ROWID;
  CREATE TRIGGER ledger_evidence_payloads_no_update BEFORE UPDATE ON ledger_evidence_payloads
  BEGIN SELECT RAISE(ABORT, 'shared ledger evidence is immutable'); END;

  CREATE TABLE ledger_evidence_cleanup_state (
    singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
    scan_after_fingerprint TEXT
  ) STRICT;
  INSERT INTO ledger_evidence_cleanup_state(singleton_key) VALUES (1);
` + referenceSchema("provider_raw_pages", "raw_page_id", "raw_body", "raw_body_reference", "response_fingerprint", "received_at", [
  "raw_page_id", "ingest_run_id", "provider_account_key", "window_start", "window_end", "page_no", "page_size", "total_size", "has_more",
  "request_fingerprint", "response_fingerprint", "http_status", "headers_json", "trace_id", "signature_verified", "received_at",
]) + referenceSchema("provider_raw_events", "raw_event_id", "raw_payload", "raw_payload_reference", "payload_fingerprint", "observed_at", [
  "raw_event_id", "raw_page_id", "provider_account_key", "ordinal", "external_event_id", "occurred_at_text", "amount_text", "direction_text",
  "alipay_order_no", "merchant_order_no", "trans_memo", "other_account", "payload_fingerprint", "observed_at",
]) + referenceSchema("ingest_errors", "ingest_error_id", "raw_body", "raw_body_reference", "response_fingerprint", "occurred_at", [
  "ingest_error_id", "ingest_run_id", "provider_account_key", "page_no", "error_kind", "error_code", "retryable", "http_status", "headers_json",
  "response_fingerprint", "trace_id", "signature_verified", "details_json", "occurred_at",
]);
