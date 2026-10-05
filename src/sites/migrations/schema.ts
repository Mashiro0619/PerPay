/** Schema 34 definition. Registered together with its runtime readers. */
export const MULTI_SITE_SCHEMA_SQL = String.raw`
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE perpay_v34_configuration AS SELECT * FROM runtime_configuration;
CREATE TEMP TABLE perpay_v34_clients AS SELECT * FROM api_client_config;
CREATE TEMP TABLE perpay_v34_keys AS SELECT * FROM webhook_signing_keys;
CREATE TEMP TABLE perpay_v34_secrets AS SELECT * FROM runtime_secrets;

DROP TABLE api_client_config;
CREATE TABLE api_client_config (

        client_id TEXT PRIMARY KEY NOT NULL CHECK (
          length(client_id) BETWEEN 3 AND 64 AND
          client_id GLOB '[A-Za-z0-9]*' AND
          client_id NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        secret_fingerprint TEXT CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        key_version INTEGER CHECK (key_version >= 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (created_at >= 0 AND created_at <= updated_at),
        CHECK (
          (secret_fingerprint IS NULL AND key_version IS NULL AND enabled = 0) OR
          (secret_fingerprint IS NOT NULL AND key_version IS NOT NULL)
        )
      ) STRICT;
INSERT INTO api_client_config(client_id, secret_fingerprint, key_version, enabled, created_at, updated_at)
SELECT client_id, secret_fingerprint, key_version, enabled, created_at, updated_at FROM perpay_v34_clients;
-- An initialized old instance may never have issued an API key. Preserve its website
-- without manufacturing credentials. A fresh migration chain has none of this state.
INSERT INTO api_client_config(client_id, secret_fingerprint, key_version, enabled, created_at, updated_at)
SELECT 'default', NULL, NULL, 0, created_at, updated_at FROM perpay_v34_configuration
WHERE NOT EXISTS (SELECT 1 FROM api_client_config WHERE client_id = 'default')
  AND (revision > 0 OR EXISTS (SELECT 1 FROM admin_identity) OR EXISTS (SELECT 1 FROM perpay_v34_secrets));
CREATE TRIGGER api_client_config_key_transition
      BEFORE UPDATE OF client_id, secret_fingerprint, key_version ON api_client_config
      WHEN NEW.client_id != OLD.client_id OR NOT EXISTS (
        SELECT 1 FROM api_client_keys AS key
        WHERE key.client_id = NEW.client_id
          AND key.key_version = NEW.key_version
          AND key.secret_fingerprint = NEW.secret_fingerprint
          AND key.retired_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'API client config must reference the active key');
      END;

CREATE TABLE site_defaults (
 singleton_key INTEGER PRIMARY KEY CHECK(singleton_key = 1),
 revision INTEGER NOT NULL CHECK(revision >= 0),
 policy TEXT NOT NULL CHECK(json_valid(policy) AND json_type(policy) = 'object'),
 updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
INSERT INTO site_defaults SELECT 1, 0, json_object('orders', json_object('order_ttl_seconds', order_ttl_seconds, 'amount_offset_maximum_cents', amount_offset_maximum_cents, 'amount_reuse_cooldown_seconds', amount_reuse_cooldown_seconds, 'pending_order_limit', NULL), 'display', json_object('checkout_name', system_name, 'checkout_help_url', checkout_help_url, 'checkout_show_product_name', json(CASE checkout_show_product_name WHEN 1 THEN 'true' ELSE 'false' END)), 'notification_delivery', json_object('timeout_milliseconds', webhook_timeout_milliseconds, 'maximum_attempts', webhook_maximum_attempts, 'retry_base_seconds', webhook_retry_base_milliseconds / 1000, 'retry_maximum_seconds', webhook_retry_maximum_milliseconds / 1000)), updated_at FROM perpay_v34_configuration;
CREATE TRIGGER site_defaults_revision_guard BEFORE UPDATE ON site_defaults
WHEN NEW.singleton_key != OLD.singleton_key OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'site defaults revision is invalid'); END;
CREATE TRIGGER site_defaults_no_delete BEFORE DELETE ON site_defaults
BEGIN SELECT RAISE(ABORT, 'site defaults cannot be deleted'); END;

CREATE TABLE sites (
 client_id TEXT PRIMARY KEY REFERENCES api_client_config(client_id),
 revision INTEGER NOT NULL CHECK(revision >= 0),
 configuration TEXT NOT NULL CHECK(json_valid(configuration) AND json_type(configuration) = 'object'),
 created_at INTEGER NOT NULL CHECK(created_at >= 0),
 updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
 deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at = updated_at)
) STRICT;
INSERT INTO sites
SELECT client.client_id, 0,
 json_object('name', '原业务网站', 'accepting_orders', json('true'),
 'notifications_enabled', json(CASE config.webhook_enabled WHEN 1 THEN 'true' ELSE 'false' END),
 'notification_origin', config.webhook_allowed_origin, 'return_origin', config.webhook_allowed_origin,
 'policy', json(defaults.policy)), client.created_at, max(client.created_at, config.updated_at), NULL
FROM api_client_config AS client CROSS JOIN perpay_v34_configuration AS config CROSS JOIN site_defaults AS defaults;
CREATE TRIGGER sites_revision_guard BEFORE UPDATE ON sites
WHEN NEW.client_id != OLD.client_id OR NEW.created_at != OLD.created_at OR
 NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at OR OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'site revision or lifecycle is invalid'); END;
CREATE TRIGGER sites_no_delete BEFORE DELETE ON sites
BEGIN SELECT RAISE(ABORT, 'site identity must be retained'); END;
CREATE TRIGGER sites_empty_before_delete BEFORE UPDATE OF deleted_at ON sites
WHEN NEW.deleted_at IS NOT NULL AND (
 EXISTS(SELECT 1 FROM payment_orders WHERE api_client_id = OLD.client_id) OR
 EXISTS(SELECT 1 FROM webhook_targets WHERE api_client_id = OLD.client_id) OR
 EXISTS(SELECT 1 FROM outbox_events AS event JOIN payment_orders AS orders ON orders.order_id = event.aggregate_id WHERE orders.api_client_id = OLD.client_id))
BEGIN SELECT RAISE(ABORT, 'site has historical business data'); END;
CREATE TRIGGER api_client_identity_no_delete BEFORE DELETE ON api_client_config
BEGIN SELECT RAISE(ABORT, 'website identity cannot be reused'); END;

CREATE TABLE site_secrets (
client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        secret_name TEXT NOT NULL CHECK (
          secret_name IN (
            'api_secret', 'webhook_secret'
          )
        ),
        secret_version INTEGER NOT NULL CHECK (secret_version >= 1),
        cipher_version INTEGER NOT NULL CHECK (cipher_version = 1),
        nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
        ciphertext BLOB NOT NULL CHECK (
          typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND 32768
        ),
        authentication_tag BLOB NOT NULL CHECK (
          typeof(authentication_tag) = 'blob' AND length(authentication_tag) = 16
        ),
        secret_fingerprint TEXT NOT NULL CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
PRIMARY KEY(client_id, secret_name), UNIQUE(secret_name, secret_fingerprint)
      ) STRICT;
CREATE TRIGGER site_secrets_version_guard BEFORE UPDATE ON site_secrets
WHEN NEW.client_id != OLD.client_id OR NEW.secret_name != OLD.secret_name OR
 NEW.secret_version != OLD.secret_version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'website secret version is invalid'); END;
CREATE TRIGGER site_secrets_no_delete BEFORE DELETE ON site_secrets
BEGIN SELECT RAISE(ABORT, 'website secret history cannot be deleted'); END;

CREATE TABLE site_creation_requests (
 operation_id TEXT PRIMARY KEY,
 request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
 client_id TEXT NOT NULL UNIQUE REFERENCES sites(client_id),
 created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER site_creation_requests_no_update BEFORE UPDATE ON site_creation_requests
BEGIN SELECT RAISE(ABORT, 'site creation identity is immutable'); END;
CREATE TRIGGER site_creation_requests_no_delete BEFORE DELETE ON site_creation_requests
BEGIN SELECT RAISE(ABORT, 'site creation identity must be retained'); END;

DROP TABLE webhook_signing_keys;
CREATE TABLE webhook_signing_keys (
        client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
site_key_version INTEGER NOT NULL CHECK (site_key_version >= 1),
key_version INTEGER PRIMARY KEY CHECK (key_version >= 1),
        key_id TEXT NOT NULL UNIQUE CHECK (length(key_id) = 36),
        secret_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= activated_at),
UNIQUE(client_id, site_key_version), UNIQUE(client_id, key_version)
      ) STRICT;
INSERT INTO webhook_signing_keys(client_id, site_key_version, key_version, key_id, secret_fingerprint, activated_at, retired_at)
SELECT 'default', key_version, key_version, key_id, secret_fingerprint, activated_at, retired_at FROM perpay_v34_keys;
CREATE UNIQUE INDEX webhook_signing_keys_one_active
      ON webhook_signing_keys(client_id) WHERE retired_at IS NULL;
CREATE TRIGGER webhook_signing_keys_valid_update
      BEFORE UPDATE ON webhook_signing_keys
      WHEN
        NEW.client_id != OLD.client_id OR NEW.site_key_version != OLD.site_key_version OR
        NEW.key_version != OLD.key_version OR
        NEW.key_id != OLD.key_id OR
        NEW.secret_fingerprint != OLD.secret_fingerprint OR
        NEW.activated_at != OLD.activated_at OR
        OLD.retired_at IS NOT NULL OR
        NEW.retired_at IS NULL OR
        NEW.retired_at < OLD.activated_at
      BEGIN
        SELECT RAISE(ABORT, 'webhook signing key transition is invalid');
      END;
CREATE TRIGGER webhook_signing_keys_no_delete
      BEFORE DELETE ON webhook_signing_keys
      BEGIN
        SELECT RAISE(ABORT, 'webhook signing keys cannot be deleted');
      END;
CREATE TRIGGER webhook_attempts_site_key_guard BEFORE INSERT ON webhook_attempts
WHEN NOT EXISTS(
 SELECT 1 FROM webhook_signing_keys AS key JOIN webhook_deliveries AS delivery ON delivery.delivery_id = NEW.delivery_id
 JOIN webhook_targets AS target ON target.target_id = delivery.target_id
 WHERE key.key_version = NEW.key_version AND key.client_id = target.api_client_id)
BEGIN SELECT RAISE(ABORT, 'notification signing key belongs to another website'); END;

DROP TABLE runtime_configuration;
CREATE TABLE runtime_configuration (
singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
revision INTEGER NOT NULL CHECK (revision >= 0),
payment_revision INTEGER NOT NULL CHECK (
          payment_revision >= 0 AND payment_revision <= revision
        ),
collection_code_payload TEXT CHECK (
          collection_code_payload IS NULL OR (
            length(collection_code_payload) >= 8 AND
            length(CAST(collection_code_payload AS BLOB)) <= 2331
          )
        ),
provider_environment TEXT CHECK (
          provider_environment IS NULL OR
          provider_environment IN ('PRODUCTION', 'SANDBOX')
        ),
provider_app_id TEXT CHECK (
          provider_app_id IS NULL OR (
            length(provider_app_id) BETWEEN 1 AND 64 AND
            provider_app_id GLOB '[A-Za-z0-9]*' AND
            provider_app_id NOT GLOB '*[^A-Za-z0-9._-]*'
          )
        ),
provider_account_key TEXT REFERENCES provider_account_bindings(provider_account_key),
provider_timeout_milliseconds INTEGER NOT NULL CHECK (
          provider_timeout_milliseconds BETWEEN 1000 AND 120000
        ),
provider_scan_interval_milliseconds INTEGER NOT NULL CHECK (
          provider_scan_interval_milliseconds BETWEEN 5000 AND 3600000
        ),
provider_maximum_success_age_milliseconds INTEGER NOT NULL CHECK (
          provider_maximum_success_age_milliseconds BETWEEN 10000 AND 86400000 AND
          provider_maximum_success_age_milliseconds >= provider_scan_interval_milliseconds * 2
        ),
checkout_key_rotation_days INTEGER NOT NULL CHECK (
          checkout_key_rotation_days BETWEEN 1 AND 3650
        ),
checkout_terminal_observation_seconds INTEGER NOT NULL CHECK (
          checkout_terminal_observation_seconds BETWEEN 60 AND 604800
        ),
created_at INTEGER NOT NULL CHECK (created_at >= 0),
updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
provider_safety_lag_milliseconds INTEGER NOT NULL
        DEFAULT 10000
        CHECK (provider_safety_lag_milliseconds BETWEEN 5000 AND 300000),
backup_interval_seconds INTEGER NOT NULL
        DEFAULT 86400
        CHECK (backup_interval_seconds BETWEEN 3600 AND 604800),
backup_keep_count INTEGER NOT NULL
        DEFAULT 7
        CHECK (backup_keep_count BETWEEN 1 AND 365),
provider_active_scan_interval_milliseconds INTEGER NOT NULL
        DEFAULT 5000
        CHECK (
          provider_active_scan_interval_milliseconds BETWEEN 5000 AND 3600000 AND
          provider_active_scan_interval_milliseconds <= provider_scan_interval_milliseconds
        ),
dashboard_chart_type TEXT NOT NULL DEFAULT 'AREA'
        CHECK (dashboard_chart_type IN ('AREA', 'BAR', 'LINE')),
system_name TEXT NOT NULL DEFAULT 'PerPay'
        CHECK (length(trim(system_name)) BETWEEN 1 AND 40),
admin_access TEXT NOT NULL DEFAULT '{"enabled":false,"cidrs":[]}'
      CHECK (json_valid(admin_access)),
provider_minimum_scan_interval_milliseconds INTEGER NOT NULL DEFAULT 5000
        CHECK (provider_minimum_scan_interval_milliseconds BETWEEN 5000 AND 3600000 AND provider_minimum_scan_interval_milliseconds <= provider_active_scan_interval_milliseconds),
CHECK ((provider_environment IS NULL) = (provider_app_id IS NULL)),
CHECK ((provider_environment IS NULL) = (provider_account_key IS NULL))
) STRICT;
INSERT INTO runtime_configuration(singleton_key, revision, payment_revision, collection_code_payload, provider_environment, provider_app_id, provider_account_key, provider_timeout_milliseconds, provider_scan_interval_milliseconds, provider_maximum_success_age_milliseconds, checkout_key_rotation_days, checkout_terminal_observation_seconds, created_at, updated_at, provider_safety_lag_milliseconds, backup_interval_seconds, backup_keep_count, provider_active_scan_interval_milliseconds, dashboard_chart_type, system_name, admin_access, provider_minimum_scan_interval_milliseconds) SELECT singleton_key, revision, payment_revision, collection_code_payload, provider_environment, provider_app_id, provider_account_key, provider_timeout_milliseconds, provider_scan_interval_milliseconds, provider_maximum_success_age_milliseconds, checkout_key_rotation_days, checkout_terminal_observation_seconds, created_at, updated_at, provider_safety_lag_milliseconds, backup_interval_seconds, backup_keep_count, provider_active_scan_interval_milliseconds, dashboard_chart_type, system_name, admin_access, provider_minimum_scan_interval_milliseconds FROM perpay_v34_configuration;
CREATE TRIGGER runtime_configuration_no_delete
      BEFORE DELETE ON runtime_configuration
      BEGIN
        SELECT RAISE(ABORT, 'runtime configuration cannot be deleted');
      END;
CREATE TRIGGER runtime_configuration_provider_timing_guard
      BEFORE UPDATE ON runtime_configuration
      WHEN NEW.provider_safety_lag_milliseconds > NEW.provider_maximum_success_age_milliseconds
      BEGIN
        SELECT RAISE(ABORT, 'provider safety lag exceeds maximum success age');
      END;
CREATE TRIGGER runtime_configuration_revision_guard
      BEFORE UPDATE ON runtime_configuration
      WHEN
        NEW.singleton_key != OLD.singleton_key OR
        NEW.revision != OLD.revision + 1 OR
        NEW.payment_revision NOT IN (OLD.payment_revision, OLD.payment_revision + 1) OR
        NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'runtime configuration revision is invalid');
      END;
DROP TABLE runtime_secrets;
CREATE TABLE runtime_secrets (
        secret_name TEXT PRIMARY KEY CHECK (
          secret_name IN (
            'provider_private_key', 'provider_public_key'
          )
        ),
        secret_version INTEGER NOT NULL CHECK (secret_version >= 1),
        cipher_version INTEGER NOT NULL CHECK (cipher_version = 1),
        nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
        ciphertext BLOB NOT NULL CHECK (
          typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND 32768
        ),
        authentication_tag BLOB NOT NULL CHECK (
          typeof(authentication_tag) = 'blob' AND length(authentication_tag) = 16
        ),
        secret_fingerprint TEXT NOT NULL CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;
INSERT INTO runtime_secrets SELECT * FROM perpay_v34_secrets WHERE secret_name IN ('provider_private_key', 'provider_public_key');
CREATE TRIGGER runtime_secrets_version_guard
      BEFORE UPDATE ON runtime_secrets
      WHEN
        NEW.secret_name != OLD.secret_name OR
        NEW.secret_version != OLD.secret_version + 1 OR
        NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'runtime secret version is invalid');
      END;
CREATE TRIGGER runtime_secrets_no_delete
      BEFORE DELETE ON runtime_secrets
      BEGIN
        SELECT RAISE(ABORT, 'runtime secrets cannot be deleted');
      END;
DROP TABLE perpay_v34_clients;
DROP TABLE perpay_v34_keys;
DROP TABLE perpay_v34_configuration;
CREATE INDEX payment_orders_site_pending ON payment_orders(api_client_id, expires_at)
WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID';
CREATE TRIGGER payment_orders_site_admission BEFORE INSERT ON payment_orders
WHEN NOT EXISTS (SELECT 1 FROM sites WHERE client_id = NEW.api_client_id AND deleted_at IS NULL
 AND json_extract(configuration, '$.accepting_orders') = 1)
BEGIN SELECT RAISE(ABORT, 'website does not accept new orders'); END;
CREATE TRIGGER payment_orders_site_capacity BEFORE INSERT ON payment_orders
WHEN EXISTS (SELECT 1 FROM sites WHERE client_id = NEW.api_client_id
 AND json_extract(configuration, '$.policy.orders.pending_order_limit') IS NOT NULL
 AND (SELECT count(*) FROM payment_orders WHERE api_client_id = NEW.api_client_id
  AND checkout_status = 'OPEN' AND payment_status = 'UNPAID' AND expires_at > NEW.created_at)
 >= json_extract(configuration, '$.policy.orders.pending_order_limit'))
BEGIN SELECT RAISE(ABORT, 'website pending order limit exceeded'); END;
-- perpay_v34_secrets is connection-local and consumed by the encrypted data migration.
`;
