/** Operational history is retained separately from the permanent audit chain. */
export const ACTIVITY_SCHEMA_SQL = `
CREATE TABLE activity_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  activity_id TEXT NOT NULL,
  request_id TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  first_occurred_at INTEGER CHECK (first_occurred_at IS NULL OR (first_occurred_at >= 0 AND first_occurred_at <= occurred_at)),
  last_occurred_at INTEGER NOT NULL CHECK (last_occurred_at >= occurred_at),
  source_type TEXT NOT NULL CHECK (source_type IN ('HTTP', 'BACKGROUND', 'MAINTENANCE', 'INTERNAL')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'ANONYMOUS', 'ADMIN', 'API_CLIENT')),
  actor_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  subject_type TEXT,
  subject_id TEXT,
  site_id TEXT,
  site_name TEXT,
  source_address TEXT,
  user_agent TEXT,
  http_method TEXT,
  route TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  event_count INTEGER NOT NULL DEFAULT 1 CHECK (event_count >= 1),
  is_aggregate INTEGER NOT NULL DEFAULT 0 CHECK (is_aggregate IN (0, 1)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  core_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(core_event_ids_json)),
  external_event_id TEXT UNIQUE,
  aggregation_key TEXT UNIQUE
);
CREATE INDEX activity_events_time_idx ON activity_events(occurred_at DESC, sequence DESC);
CREATE INDEX activity_events_action_time_idx ON activity_events(action, occurred_at DESC, sequence DESC);
CREATE INDEX activity_events_site_time_idx ON activity_events(site_id, occurred_at DESC, sequence DESC);
CREATE INDEX activity_events_activity_idx ON activity_events(activity_id, sequence);
CREATE INDEX activity_events_source_time_idx ON activity_events(source_address, occurred_at DESC, sequence DESC);
CREATE TABLE activity_capture_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
CREATE TABLE activity_external_receipts (
  event_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  imported_at INTEGER NOT NULL CHECK (imported_at >= 0),
  core_event_id TEXT,
  UNIQUE(source_id, source_sequence)
);
CREATE INDEX activity_external_receipts_retention_idx ON activity_external_receipts(occurred_at) WHERE core_event_id IS NULL;
CREATE TABLE activity_import_sources (
  source_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  first_observed_at INTEGER NOT NULL CHECK (first_observed_at >= 0),
  last_import_at INTEGER,
  last_error_code TEXT,
  gap_count INTEGER NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);
`;
