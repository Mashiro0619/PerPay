// SPDX-License-Identifier: MIT
/** Schema 42 retains historical native evidence and adds EasyPay GET delivery. */
export const EPAY_WEBHOOK_SCHEMA_SQL = String.raw`
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE perpay_v42_targets AS SELECT * FROM webhook_targets;
CREATE TEMP TABLE perpay_v42_attempts AS SELECT * FROM webhook_attempts;
DROP TABLE webhook_attempts;
DROP TABLE webhook_targets;
      CREATE TABLE webhook_targets (
        target_id TEXT PRIMARY KEY CHECK (length(target_id) = 36),
        order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
        api_client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        target_format TEXT NOT NULL CHECK (target_format IN ('NATIVE_JSON_V1', 'EPAY_V1', 'EPAY_V2')),
        target_url TEXT NOT NULL CHECK (
          length(CAST(target_url AS BLOB)) BETWEEN 10 AND 4096 AND
          target_url LIKE 'https://%'
        ),
        allowed_origin TEXT NOT NULL CHECK (
          length(CAST(allowed_origin AS BLOB)) BETWEEN 9 AND 2048 AND
          allowed_origin LIKE 'https://%'
        ),
        url_fingerprint TEXT NOT NULL CHECK (
          length(url_fingerprint) = 64 AND
          url_fingerprint = lower(url_fingerprint) AND
          url_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_fingerprint_version INTEGER NOT NULL CHECK (request_fingerprint_version = 1),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      INSERT INTO webhook_targets SELECT * FROM perpay_v42_targets;

      CREATE INDEX webhook_targets_client_idx
      ON webhook_targets(api_client_id, created_at, target_id);

      CREATE TRIGGER webhook_targets_valid_insert
      BEFORE INSERT ON webhook_targets
      WHEN
        NOT EXISTS (
          SELECT 1
            FROM payment_orders AS orders
           WHERE orders.order_id = NEW.order_id
             AND orders.api_client_id = NEW.api_client_id
             AND orders.created_at = NEW.created_at
             AND orders.webhook_target_request_fingerprint = NEW.request_fingerprint
        ) OR
        EXISTS (
          SELECT 1 FROM order_events AS event
           WHERE event.order_id = NEW.order_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'webhook target must match an uncommitted order target');
      END;

      CREATE TRIGGER webhook_targets_no_update
      BEFORE UPDATE ON webhook_targets
      BEGIN
        SELECT RAISE(ABORT, 'webhook targets are immutable');
      END;

      CREATE TRIGGER webhook_targets_no_delete
      BEFORE DELETE ON webhook_targets
      BEGIN
        SELECT RAISE(ABORT, 'webhook targets are immutable');
      END;

      CREATE TABLE webhook_attempts (
        attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
        delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        lease_token TEXT NOT NULL UNIQUE CHECK (length(lease_token) = 36),
        key_version INTEGER REFERENCES webhook_signing_keys(key_version),
        protocol TEXT NOT NULL DEFAULT 'native' CHECK (protocol IN ('native', 'epay_v1', 'epay_v2')),
        epay_key_id TEXT REFERENCES epay_credentials(credential_id),
        request_method TEXT NOT NULL DEFAULT 'POST' CHECK (request_method IN ('GET', 'POST')),
        request_url TEXT CHECK (request_url IS NULL OR length(CAST(request_url AS BLOB)) BETWEEN 10 AND 16384),
        request_fingerprint TEXT CHECK (request_fingerprint IS NULL OR
          (length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*')),
        request_timestamp INTEGER NOT NULL CHECK (request_timestamp >= 0),
        request_body_fingerprint TEXT NOT NULL CHECK (
          length(request_body_fingerprint) = 64 AND
          request_body_fingerprint = lower(request_body_fingerprint) AND
          request_body_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        resolved_addresses_fingerprint TEXT CHECK (
          resolved_addresses_fingerprint IS NULL OR (
            length(resolved_addresses_fingerprint) = 64 AND
            resolved_addresses_fingerprint = lower(resolved_addresses_fingerprint) AND
            resolved_addresses_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        ),
        connected_address TEXT CHECK (
          connected_address IS NULL OR length(connected_address) BETWEEN 2 AND 64
        ),
        outcome TEXT NOT NULL CHECK (
          outcome IN ('STARTED', 'ACKNOWLEDGED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'OUTCOME_UNKNOWN')
        ),
        http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
        response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes BETWEEN 0 AND 16384),
        response_fingerprint TEXT CHECK (
          response_fingerprint IS NULL OR (
            length(response_fingerprint) = 64 AND
            response_fingerprint = lower(response_fingerprint) AND
            response_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        ),
        ack_code TEXT CHECK (
          ack_code IS NULL OR
          (length(ack_code) BETWEEN 1 AND 100 AND
           ack_code GLOB '[a-z]*' AND ack_code NOT GLOB '*[^a-z0-9_]*')
        ),
        error_code TEXT CHECK (
          error_code IS NULL OR
          (length(error_code) BETWEEN 1 AND 100 AND
           error_code GLOB '[a-z]*' AND error_code NOT GLOB '*[^a-z0-9_]*')
        ),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= started_at),
        UNIQUE (delivery_id, attempt_number),
        CHECK ((protocol = 'native' AND key_version IS NOT NULL AND epay_key_id IS NULL AND
                request_method = 'POST' AND request_url IS NULL AND request_fingerprint IS NULL) OR
               (protocol != 'native' AND key_version IS NULL AND epay_key_id IS NOT NULL AND
                request_method = 'GET' AND request_url IS NOT NULL AND request_fingerprint IS NOT NULL)),
        CHECK (
          (outcome = 'STARTED' AND resolved_addresses_fingerprint IS NULL AND
           connected_address IS NULL AND http_status IS NULL AND response_bytes IS NULL AND
           response_fingerprint IS NULL AND ack_code IS NULL AND error_code IS NULL AND
           finished_at IS NULL) OR
          (outcome = 'ACKNOWLEDGED' AND ((protocol = 'native' AND http_status = 200) OR (protocol != 'native' AND http_status BETWEEN 200 AND 299)) AND response_bytes IS NOT NULL AND
           response_fingerprint IS NOT NULL AND ack_code = 'acknowledged' AND
           error_code IS NULL AND finished_at IS NOT NULL) OR
          (outcome IN ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'OUTCOME_UNKNOWN') AND
           error_code IS NOT NULL AND finished_at IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO webhook_attempts (
        attempt_id, delivery_id, attempt_number, lease_token, key_version,
        request_timestamp, request_body_fingerprint, resolved_addresses_fingerprint,
        connected_address, outcome, http_status, response_bytes, response_fingerprint,
        ack_code, error_code, started_at, finished_at
      ) SELECT attempt_id, delivery_id, attempt_number, lease_token, key_version,
        request_timestamp, request_body_fingerprint, resolved_addresses_fingerprint,
        connected_address, outcome, http_status, response_bytes, response_fingerprint,
        ack_code, error_code, started_at, finished_at FROM perpay_v42_attempts;

      CREATE INDEX webhook_attempts_delivery_idx
      ON webhook_attempts(delivery_id, attempt_number DESC);

      CREATE TRIGGER webhook_attempts_valid_insert
      BEFORE INSERT ON webhook_attempts
      WHEN NOT EXISTS (
        SELECT 1 FROM webhook_deliveries AS delivery
        JOIN webhook_targets AS target ON target.target_id = delivery.target_id
        WHERE delivery.delivery_id = NEW.delivery_id AND delivery.status = 'LEASED'
          AND delivery.attempt_count = NEW.attempt_number AND delivery.lease_token = NEW.lease_token
          AND ((NEW.protocol = 'native' AND target.target_format = 'NATIVE_JSON_V1' AND EXISTS (
            SELECT 1 FROM webhook_signing_keys AS signing_key
            WHERE signing_key.key_version = NEW.key_version AND signing_key.retired_at IS NULL
              AND signing_key.client_id = target.api_client_id)) OR
          (NEW.protocol != 'native' AND target.target_format = upper(NEW.protocol) AND EXISTS (
            SELECT 1 FROM epay_credentials AS credential
            WHERE credential.credential_id = NEW.epay_key_id AND credential.retired_at IS NULL
              AND credential.site_id = target.api_client_id
              AND credential.purpose = CASE NEW.protocol WHEN 'epay_v1' THEN 'v1_key' ELSE 'v2_platform' END)))
      )
      BEGIN
        SELECT RAISE(ABORT, 'webhook attempt must match its lease, protocol and website key');
      END;

      CREATE TRIGGER webhook_attempts_valid_update
      BEFORE UPDATE ON webhook_attempts
      WHEN
        NEW.attempt_id != OLD.attempt_id OR
        NEW.delivery_id != OLD.delivery_id OR
        NEW.attempt_number != OLD.attempt_number OR
        NEW.lease_token != OLD.lease_token OR
        NEW.key_version IS NOT OLD.key_version OR
        NEW.protocol != OLD.protocol OR NEW.epay_key_id IS NOT OLD.epay_key_id OR
        NEW.request_method != OLD.request_method OR NEW.request_url IS NOT OLD.request_url OR
        NEW.request_fingerprint IS NOT OLD.request_fingerprint OR
        NEW.request_timestamp != OLD.request_timestamp OR
        NEW.request_body_fingerprint != OLD.request_body_fingerprint OR
        NEW.started_at != OLD.started_at OR
        OLD.outcome != 'STARTED' OR
        NEW.outcome = 'STARTED'
      BEGIN
        SELECT RAISE(ABORT, 'webhook attempt transition is invalid');
      END;

      CREATE TRIGGER webhook_attempts_no_delete
      BEFORE DELETE ON webhook_attempts
      BEGIN
        SELECT RAISE(ABORT, 'webhook attempts cannot be deleted');
      END;

CREATE TRIGGER webhook_attempts_site_key_guard BEFORE INSERT ON webhook_attempts
WHEN NEW.protocol = 'native' AND NOT EXISTS (
  SELECT 1 FROM webhook_signing_keys AS signing_key
  JOIN webhook_deliveries AS delivery ON delivery.delivery_id = NEW.delivery_id
  JOIN webhook_targets AS target ON target.target_id = delivery.target_id
  WHERE signing_key.key_version = NEW.key_version AND signing_key.client_id = target.api_client_id
)
BEGIN SELECT RAISE(ABORT, 'notification signing key belongs to another website'); END;

CREATE TRIGGER webhook_deliveries_epay_event_guard BEFORE INSERT ON webhook_deliveries
WHEN EXISTS (
  SELECT 1 FROM webhook_targets AS target
  JOIN outbox_events AS event ON event.outbox_event_id = NEW.outbox_event_id
  WHERE target.target_id = NEW.target_id AND target.target_format IN ('EPAY_V1', 'EPAY_V2')
    AND event.event_type != 'PAYMENT_CONFIRMED'
)
BEGIN SELECT RAISE(ABORT, 'EasyPay notifications require a payment confirmation event'); END;

DROP TABLE perpay_v42_targets;
DROP TABLE perpay_v42_attempts;
`;
