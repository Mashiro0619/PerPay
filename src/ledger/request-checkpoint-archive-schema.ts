export const REQUEST_CHECKPOINT_ARCHIVE_SCHEMA_SQL = `
  CREATE TRIGGER sites_archived_history_guard
  BEFORE UPDATE OF deleted_at ON sites
  WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM archived_order_keys WHERE api_client_id = OLD.client_id)
  BEGIN SELECT RAISE(ABORT, 'sites with archived history cannot be deleted'); END;

  CREATE TABLE ledger_request_archive_watermarks (
    provider_account_key TEXT PRIMARY KEY REFERENCES provider_account_bindings(provider_account_key),
    before_timestamp INTEGER NOT NULL CHECK (before_timestamp >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER ledger_request_archive_watermarks_monotonic
  BEFORE UPDATE ON ledger_request_archive_watermarks
  WHEN NEW.provider_account_key != OLD.provider_account_key OR NEW.before_timestamp < OLD.before_timestamp
  BEGIN SELECT RAISE(ABORT, 'request archive boundary cannot move backwards'); END;
  CREATE TRIGGER ledger_request_archive_watermarks_no_delete
  BEFORE DELETE ON ledger_request_archive_watermarks
  BEGIN SELECT RAISE(ABORT, 'request archive boundary must be retained'); END;

  CREATE INDEX ledger_request_checkpoints_archive_idx ON ledger_request_checkpoints(observed_at);

  DROP TRIGGER ledger_request_checkpoints_retirement_insert;
  CREATE TRIGGER ledger_request_checkpoints_retirement_insert
  BEFORE INSERT ON ledger_request_checkpoints
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    AND NOT EXISTS (SELECT 1 FROM ledger_request_archive_watermarks WHERE provider_account_key = NEW.provider_account_key)
  BEGIN SELECT RAISE(ABORT, 'request checkpoints require retired or archived history'); END;

  DROP TRIGGER ledger_request_checkpoints_no_delete;
  CREATE TRIGGER ledger_request_checkpoints_no_delete
  BEFORE DELETE ON ledger_request_checkpoints
  WHEN NOT EXISTS (SELECT 1 FROM ledger_request_archive_watermarks
    WHERE provider_account_key = OLD.provider_account_key AND before_timestamp > OLD.observed_at)
    OR EXISTS (SELECT 1 FROM provider_raw_pages
      WHERE provider_account_key = OLD.provider_account_key
        AND request_fingerprint = lower(hex(OLD.request_fingerprint)))
  BEGIN SELECT RAISE(ABORT, 'only archived request checkpoints without online pages can be removed'); END;
`;
