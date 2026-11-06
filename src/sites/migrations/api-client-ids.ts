/** Public API identities are reserved permanently while website ownership stays stable. */
export const SITE_API_CLIENT_IDS_SCHEMA_SQL = String.raw`
CREATE TABLE site_api_client_ids (
 api_client_id TEXT PRIMARY KEY NOT NULL CHECK (
   length(api_client_id) BETWEEN 1 AND 128 AND api_client_id = trim(api_client_id) AND instr(api_client_id, char(0)) = 0
 ),
 client_id TEXT NOT NULL REFERENCES sites(client_id),
 is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
 created_at INTEGER NOT NULL CHECK (created_at >= 0),
 retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= created_at),
 CHECK (retired_at IS NOT NULL OR is_current = 1),
 CHECK (is_current = 0 OR (
   length(api_client_id) BETWEEN 3 AND 64 AND api_client_id GLOB '[A-Za-z0-9]*' AND api_client_id NOT GLOB '*[^A-Za-z0-9._-]*'
 ))
) STRICT;
CREATE UNIQUE INDEX site_api_client_ids_current ON site_api_client_ids(client_id) WHERE is_current = 1;
INSERT INTO site_api_client_ids(api_client_id, client_id, is_current, created_at, retired_at)
SELECT client_id, client_id, 1, created_at, deleted_at FROM sites;
INSERT INTO site_api_client_ids(api_client_id, client_id, is_current, created_at, retired_at)
SELECT namespace.namespace_id, namespace.client_id, 0, namespace.recorded_at, namespace.recorded_at
FROM api_client_idempotency_namespaces AS namespace
WHERE NOT EXISTS (SELECT 1 FROM site_api_client_ids AS existing
  WHERE existing.api_client_id = namespace.namespace_id AND existing.client_id = namespace.client_id);
CREATE TRIGGER site_api_client_ids_retirement_guard BEFORE UPDATE ON site_api_client_ids
WHEN NEW.api_client_id != OLD.api_client_id OR NEW.client_id != OLD.client_id OR NEW.created_at != OLD.created_at
 OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
BEGIN SELECT RAISE(ABORT, 'public API client identities can only be retired once'); END;
CREATE TRIGGER site_api_client_ids_no_delete BEFORE DELETE ON site_api_client_ids
BEGIN SELECT RAISE(ABORT, 'public API client identities are permanently reserved'); END;

CREATE TABLE site_client_id_changes (
 operation_id TEXT PRIMARY KEY NOT NULL,
 client_id TEXT NOT NULL REFERENCES sites(client_id),
 request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
 previous_api_client_id TEXT NOT NULL REFERENCES site_api_client_ids(api_client_id),
 next_api_client_id TEXT NOT NULL REFERENCES site_api_client_ids(api_client_id),
 revision INTEGER NOT NULL CHECK (revision >= 0),
 changed INTEGER NOT NULL CHECK (changed IN (0, 1) AND changed = (previous_api_client_id != next_api_client_id)),
 created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
CREATE INDEX site_client_id_changes_client_time ON site_client_id_changes(client_id, created_at);
CREATE UNIQUE INDEX site_client_id_changes_introduced ON site_client_id_changes(next_api_client_id) WHERE changed = 1;
CREATE UNIQUE INDEX site_client_id_changes_retired ON site_client_id_changes(previous_api_client_id) WHERE changed = 1;
CREATE TRIGGER site_client_id_changes_no_update BEFORE UPDATE ON site_client_id_changes
BEGIN SELECT RAISE(ABORT, 'public API client identity changes are immutable'); END;
CREATE TRIGGER site_client_id_changes_no_delete BEFORE DELETE ON site_client_id_changes
BEGIN SELECT RAISE(ABORT, 'public API client identity changes are immutable'); END;
`;
