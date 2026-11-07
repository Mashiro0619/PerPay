export const INGEST_RETENTION_SCHEMA_SQL = `
  CREATE TABLE ledger_retention_state (
    singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
    deleted_observations INTEGER NOT NULL DEFAULT 0 CHECK (deleted_observations >= 0),
    pruning INTEGER NOT NULL DEFAULT 0 CHECK (pruning IN (0, 1)),
    last_completed_at INTEGER CHECK (last_completed_at >= 0),
    scan_after_started_at INTEGER CHECK (scan_after_started_at >= 0),
    scan_after_run_id TEXT,
    CHECK ((scan_after_started_at IS NULL) = (scan_after_run_id IS NULL))
  ) STRICT;
  INSERT INTO ledger_retention_state(singleton_key) VALUES (1);

  CREATE TABLE ledger_request_checkpoints (
    provider_account_key TEXT NOT NULL REFERENCES provider_account_bindings(provider_account_key),
    request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
    response_fingerprint BLOB NOT NULL CHECK (length(response_fingerprint) = 32),
    observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
    PRIMARY KEY (provider_account_key, request_fingerprint)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER ledger_request_checkpoints_retirement_insert
  BEFORE INSERT ON ledger_request_checkpoints
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
  BEGIN
    SELECT RAISE(ABORT, 'request checkpoints originate from retired observations');
  END;

  CREATE TRIGGER ledger_request_checkpoints_identity_immutable
  BEFORE UPDATE OF provider_account_key, request_fingerprint ON ledger_request_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'retired request identity is immutable');
  END;

  CREATE TRIGGER ledger_request_checkpoints_time_monotonic
  BEFORE UPDATE ON ledger_request_checkpoints WHEN NEW.observed_at < OLD.observed_at
  BEGIN
    SELECT RAISE(ABORT, 'retired request observation time cannot move backwards');
  END;

  CREATE TRIGGER ledger_request_checkpoints_no_delete
  BEFORE DELETE ON ledger_request_checkpoints
  BEGIN
    SELECT RAISE(ABORT, 'retired request stability checkpoints cannot be deleted');
  END;

  CREATE TRIGGER ledger_retention_state_no_delete
  BEFORE DELETE ON ledger_retention_state
  BEGIN
    SELECT RAISE(ABORT, 'ledger retention state cannot be deleted');
  END;

  CREATE TRIGGER ledger_retention_state_monotonic
  BEFORE UPDATE ON ledger_retention_state
  WHEN NEW.singleton_key != OLD.singleton_key
    OR NEW.deleted_observations < OLD.deleted_observations
    OR NEW.deleted_observations > OLD.deleted_observations + 1
    OR (NEW.deleted_observations != OLD.deleted_observations AND (NEW.pruning != 1 OR OLD.pruning != 1))
    OR (OLD.last_completed_at IS NOT NULL AND (NEW.last_completed_at IS NULL OR NEW.last_completed_at < OLD.last_completed_at))
  BEGIN
    SELECT RAISE(ABORT, 'ledger retention progress is invalid');
  END;

  CREATE INDEX ingest_runs_retention_idx
    ON ingest_runs(started_at, ingest_run_id, completed_at)
    WHERE status = 'COMPLETED' AND pages_received = 1;
  CREATE INDEX ingest_segments_accepted_page_idx
    ON ingest_segments(accepted_raw_page_id) WHERE accepted_raw_page_id IS NOT NULL;
  CREATE INDEX ledger_conflicts_raw_event_idx
    ON ledger_conflicts(raw_event_id) WHERE raw_event_id IS NOT NULL;

  DROP TRIGGER ingest_runs_no_delete;
  CREATE TRIGGER ingest_runs_no_delete
  BEFORE DELETE ON ingest_runs
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    OR OLD.status != 'COMPLETED' OR OLD.pages_received != 1
    OR EXISTS (SELECT 1 FROM ingest_errors WHERE ingest_run_id = OLD.ingest_run_id)
  BEGIN
    SELECT RAISE(ABORT, 'only successful ingest runs can be retired');
  END;

  DROP TRIGGER ingest_segments_no_delete;
  CREATE TRIGGER ingest_segments_no_delete
  BEFORE DELETE ON ingest_segments
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    OR OLD.parent_segment_id IS NOT NULL OR OLD.state != 'COMPLETE'
    OR NOT EXISTS (SELECT 1 FROM ingest_runs WHERE ingest_run_id = OLD.ingest_run_id
      AND status = 'COMPLETED' AND pages_received = 1)
  BEGIN
    SELECT RAISE(ABORT, 'only completed ingest segments can be retired');
  END;

  DROP TRIGGER provider_raw_pages_no_delete;
  CREATE TRIGGER provider_raw_pages_no_delete
  BEFORE DELETE ON provider_raw_pages
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    OR OLD.has_more != 0
    OR EXISTS (SELECT 1 FROM provider_raw_events WHERE raw_page_id = OLD.raw_page_id)
    OR EXISTS (SELECT 1 FROM ledger_conflicts AS conflict
      WHERE conflict.provider_account_key = OLD.provider_account_key AND (
        conflict.raw_page_id = OLD.raw_page_id
        OR json_extract(conflict.details_json, '$.existing_raw_page_id') = OLD.raw_page_id
        OR json_extract(conflict.details_json, '$.incoming_raw_page_id') = OLD.raw_page_id
        OR json_extract(conflict.details_json, '$.request_fingerprint') = OLD.request_fingerprint
      ))
  BEGIN
    SELECT RAISE(ABORT, 'provider pages containing ledger evidence cannot be retired');
  END;

  DROP TRIGGER ingest_run_page_observations_no_delete;
  CREATE TRIGGER ingest_run_page_observations_no_delete
  BEFORE DELETE ON ingest_run_page_observations
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    OR OLD.disposition != 'PROCESSED' OR OLD.observation_kind != 'ACCEPTED_LEAF'
    OR NOT EXISTS (SELECT 1 FROM ingest_runs WHERE ingest_run_id = OLD.ingest_run_id
      AND status = 'COMPLETED' AND pages_received = 1)
    OR NOT EXISTS (SELECT 1 FROM provider_raw_pages WHERE raw_page_id = OLD.raw_page_id
      AND has_more = 0)
  BEGIN
    SELECT RAISE(ABORT, 'only successful page observations can be retired');
  END;

  CREATE TRIGGER ingest_run_page_observations_retired
  AFTER DELETE ON ingest_run_page_observations
  BEGIN
    UPDATE ledger_retention_state SET deleted_observations = deleted_observations + 1
      WHERE singleton_key = 1;
  END;

  DROP TRIGGER provider_raw_events_no_delete;
  CREATE TRIGGER provider_raw_events_no_delete
  BEFORE DELETE ON provider_raw_events
  WHEN NOT EXISTS (SELECT 1 FROM ledger_retention_state WHERE singleton_key = 1 AND pruning = 1)
    OR EXISTS (SELECT 1 FROM ledger_entries WHERE raw_event_id = OLD.raw_event_id)
    OR EXISTS (SELECT 1 FROM ledger_conflicts WHERE raw_event_id = OLD.raw_event_id)
    OR EXISTS (SELECT 1 FROM ingest_run_page_observations WHERE raw_page_id = OLD.raw_page_id)
  BEGIN
    SELECT RAISE(ABORT, 'referenced provider events cannot be retired');
  END;
`;
