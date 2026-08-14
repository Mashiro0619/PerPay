import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Stable catalog checksum used to detect edited migration SQL at startup. */
export function migrationChecksum(migration: Pick<Migration, "version" | "name" | "sql">): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`, "utf8")
    .digest("hex");
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_system_schema",
    sql: `
      CREATE TABLE system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO system_metadata (key, value, updated_at)
      VALUES ('instance_id', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 2,
    name: "identity_and_audit_schema",
    sql: `
      CREATE TABLE admin_identity (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        username TEXT NOT NULL CHECK (
          length(username) BETWEEN 1 AND 64 AND
          username GLOB '[A-Za-z0-9]*' AND
          username NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        password_hash TEXT NOT NULL CHECK (
          length(password_hash) BETWEEN 64 AND 256 AND
          password_hash LIKE '$perpay$scrypt$%'
        ),
        session_generation INTEGER NOT NULL DEFAULT 1 CHECK (session_generation >= 1),
        password_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (password_changed_at >= 0),
        CHECK (created_at >= 0),
        CHECK (updated_at >= 0)
      ) STRICT;

      CREATE TABLE admin_sessions (
        session_id TEXT PRIMARY KEY CHECK (length(session_id) = 36),
        admin_key INTEGER NOT NULL DEFAULT 1 REFERENCES admin_identity(singleton_key)
          CHECK (admin_key = 1),
        token_digest TEXT NOT NULL UNIQUE CHECK (
          length(token_digest) = 64 AND
          token_digest = lower(token_digest) AND
          token_digest NOT GLOB '*[^0-9a-f]*'
        ),
        csrf_digest TEXT NOT NULL UNIQUE CHECK (
          length(csrf_digest) = 64 AND
          csrf_digest = lower(csrf_digest) AND
          csrf_digest NOT GLOB '*[^0-9a-f]*'
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        step_up_expires_at INTEGER,
        revoked_at INTEGER,
        revoke_reason TEXT,
        CHECK (created_at >= 0),
        CHECK (created_at <= last_seen_at),
        CHECK (last_seen_at <= idle_expires_at),
        CHECK (idle_expires_at <= absolute_expires_at),
        CHECK (
          step_up_expires_at IS NULL OR
          step_up_expires_at BETWEEN created_at AND absolute_expires_at
        ),
        CHECK (revoked_at IS NULL OR revoked_at >= created_at),
        CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 64),
        CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
      ) STRICT;

      CREATE INDEX admin_sessions_expiry_idx
      ON admin_sessions(revoked_at, idle_expires_at, absolute_expires_at);

      CREATE TABLE admin_auth_limits (
        source_hash TEXT PRIMARY KEY CHECK (
          length(source_hash) = 64 AND
          source_hash = lower(source_hash) AND
          source_hash NOT GLOB '*[^0-9a-f]*'
        ),
        window_started_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 0 AND 1000000),
        blocked_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (window_started_at >= 0),
        CHECK (blocked_until >= 0),
        CHECK (updated_at >= 0),
        CHECK (window_started_at <= updated_at),
        CHECK (blocked_until >= window_started_at)
      ) STRICT;

      CREATE INDEX admin_auth_limits_updated_idx
      ON admin_auth_limits(updated_at);

      CREATE TABLE api_client_config (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        client_id TEXT NOT NULL UNIQUE CHECK (
          length(client_id) BETWEEN 3 AND 64 AND
          client_id GLOB '[A-Za-z0-9]*' AND
          client_id NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        secret_fingerprint TEXT NOT NULL CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        key_version INTEGER NOT NULL CHECK (key_version >= 1),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (created_at >= 0 AND created_at <= updated_at)
      ) STRICT;

      CREATE TABLE api_nonces (
        client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        nonce TEXT NOT NULL CHECK (
          length(nonce) = 43 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        request_timestamp_seconds INTEGER NOT NULL CHECK (
          request_timestamp_seconds BETWEEN 1 AND 999999999999
        ),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, nonce),
        CHECK (created_at >= 0 AND created_at < expires_at),
        CHECK (expires_at > 0),
        CHECK (expires_at = (request_timestamp_seconds * 1000) + 301000)
      ) STRICT;

      CREATE INDEX api_nonces_expiry_idx ON api_nonces(expires_at);

      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 36),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        actor_type TEXT NOT NULL CHECK (
          actor_type IN ('SYSTEM', 'ANONYMOUS', 'ADMIN', 'API_CLIENT')
        ),
        actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
        action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
        outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
        subject_type TEXT CHECK (subject_type IS NULL OR length(subject_type) BETWEEN 1 AND 128),
        subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 128),
        request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
        remote_address_hash TEXT CHECK (
          remote_address_hash IS NULL OR
          (
            length(remote_address_hash) = 64 AND
            remote_address_hash = lower(remote_address_hash) AND
            remote_address_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND length(details_json) <= 8192
        ),
        previous_hash TEXT CHECK (
          previous_hash IS NULL OR
          (
            length(previous_hash) = 64 AND
            previous_hash = lower(previous_hash) AND
            previous_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        event_hash TEXT NOT NULL UNIQUE CHECK (
          length(event_hash) = 64 AND
          event_hash = lower(event_hash) AND
          event_hash NOT GLOB '*[^0-9a-f]*'
        )
      ) STRICT;

      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;

      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit events are append-only');
      END;

      CREATE UNIQUE INDEX audit_events_previous_hash_unique
      ON audit_events(previous_hash)
      WHERE previous_hash IS NOT NULL;

      CREATE TRIGGER audit_events_linear_chain
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM audit_events)
               AND NEW.previous_hash IS NOT NULL
            THEN RAISE(ABORT, 'first audit event must be the chain root')
          WHEN EXISTS (SELECT 1 FROM audit_events)
               AND NEW.previous_hash IS NULL
            THEN RAISE(ABORT, 'audit chain already has a root')
          WHEN EXISTS (SELECT 1 FROM audit_events)
               AND NEW.previous_hash != (
                 SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1
               )
            THEN RAISE(ABORT, 'audit event must extend the current chain head')
        END;
      END;
    `,
  },
] as const;
