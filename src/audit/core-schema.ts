// SPDX-License-Identifier: MIT
export const CORE_AUDIT_SCHEMA_SQL = `
  CREATE TABLE audit_event_context (
    event_id TEXT PRIMARY KEY REFERENCES audit_events(event_id),
    activity_id TEXT,
    source_address TEXT CHECK (source_address IS NULL OR length(source_address) BETWEEN 1 AND 45),
    user_agent TEXT CHECK (user_agent IS NULL OR length(CAST(user_agent AS BLOB)) BETWEEN 1 AND 1024),
    site_id TEXT,
    site_name TEXT,
    context_json TEXT NOT NULL CHECK (json_valid(context_json) AND length(CAST(context_json AS BLOB)) <= 65536),
    context_fingerprint TEXT NOT NULL CHECK (length(context_fingerprint) = 64),
    CHECK (activity_id IS json_extract(context_json, '$.activity_id')),
    CHECK (source_address IS json_extract(context_json, '$.source_address')),
    CHECK (user_agent IS json_extract(context_json, '$.user_agent')),
    CHECK (site_id IS json_extract(context_json, '$.site_id')),
    CHECK (site_name IS json_extract(context_json, '$.site_name'))
  ) STRICT;
  CREATE TRIGGER audit_event_context_no_update BEFORE UPDATE ON audit_event_context
    BEGIN SELECT RAISE(ABORT, 'audit context is append-only'); END;
  CREATE TRIGGER audit_event_context_no_delete BEFORE DELETE ON audit_event_context
    BEGIN SELECT RAISE(ABORT, 'audit context is append-only'); END;
  CREATE INDEX audit_event_context_activity_idx ON audit_event_context(activity_id);
  CREATE INDEX audit_event_context_source_idx ON audit_event_context(source_address, event_id);
  CREATE INDEX audit_event_context_site_idx ON audit_event_context(site_id, event_id);
  CREATE INDEX audit_events_time_idx ON audit_events(occurred_at, sequence);
  CREATE INDEX audit_events_action_time_idx ON audit_events(action, occurred_at, sequence);
  CREATE INDEX audit_events_outcome_time_idx ON audit_events(outcome, occurred_at, sequence);
  CREATE INDEX audit_events_actor_time_idx ON audit_events(actor_type, actor_id, occurred_at, sequence);
  CREATE INDEX audit_events_request_idx ON audit_events(request_id, sequence);
`;
