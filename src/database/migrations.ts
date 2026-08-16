import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly postApply?:
    | "upgrade_ledger_semantic_fingerprints_v2"
    | "backfill_evidence_fingerprints_v1";
}

/** Stable catalog checksum used to detect edited migration definitions at startup. */
export function migrationChecksum(migration: Migration): string {
  const postApply = migration.postApply ? `\0${migration.postApply}` : "";
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}${postApply}`, "utf8")
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
  {
    version: 3,
    name: "collection_and_order_schema",
    sql: `
      CREATE TABLE collection_profiles (
        profile_id TEXT PRIMARY KEY CHECK (length(profile_id) = 36),
        version INTEGER NOT NULL UNIQUE CHECK (version >= 1),
        provider_account_key TEXT NOT NULL CHECK (provider_account_key = 'primary'),
        code_payload TEXT NOT NULL CHECK (
          length(code_payload) >= 8 AND
          length(CAST(code_payload AS BLOB)) <= 4096
        ),
        payload_fingerprint TEXT NOT NULL CHECK (
          length(payload_fingerprint) = 64 AND
          payload_fingerprint = lower(payload_fingerprint) AND
          payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        profile_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(profile_fingerprint) = 64 AND
          profile_fingerprint = lower(profile_fingerprint) AND
          profile_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        evidence_policy TEXT NOT NULL CHECK (evidence_policy = 'UNIQUE_AMOUNT_AUTO'),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE INDEX collection_profiles_payload_fingerprint_idx
      ON collection_profiles(payload_fingerprint);

      CREATE TRIGGER collection_profiles_no_update
      BEFORE UPDATE ON collection_profiles
      BEGIN
        SELECT RAISE(ABORT, 'collection profiles are immutable');
      END;

      CREATE TRIGGER collection_profiles_no_delete
      BEFORE DELETE ON collection_profiles
      BEGIN
        SELECT RAISE(ABORT, 'collection profiles are immutable');
      END;

      CREATE TABLE active_collection_profile (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        profile_id TEXT NOT NULL UNIQUE REFERENCES collection_profiles(profile_id),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0)
      ) STRICT;

      CREATE TRIGGER active_collection_profile_valid_time_insert
      BEFORE INSERT ON active_collection_profile
      WHEN NEW.activated_at < (
        SELECT created_at FROM collection_profiles WHERE profile_id = NEW.profile_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'profile activation cannot predate the profile');
      END;

      CREATE TRIGGER active_collection_profile_valid_time_update
      BEFORE UPDATE ON active_collection_profile
      WHEN NEW.activated_at < OLD.activated_at OR NEW.activated_at < (
        SELECT created_at FROM collection_profiles WHERE profile_id = NEW.profile_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'profile activation time must advance');
      END;

      CREATE TRIGGER active_collection_profile_no_delete
      BEFORE DELETE ON active_collection_profile
      BEGIN
        SELECT RAISE(ABORT, 'active collection profile cannot be deleted');
      END;

      CREATE TABLE collection_profile_activations (
        activation_id TEXT PRIMARY KEY CHECK (length(activation_id) = 36),
        sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
        profile_id TEXT NOT NULL REFERENCES collection_profiles(profile_id),
        previous_profile_id TEXT REFERENCES collection_profiles(profile_id),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        reason TEXT NOT NULL CHECK (reason = 'CONFIG_SYNC'),
        CHECK (profile_id IS NOT previous_profile_id)
      ) STRICT;

      CREATE TRIGGER collection_profile_activations_sequence
      BEFORE INSERT ON collection_profile_activations
      WHEN NEW.sequence != COALESCE(
        (SELECT MAX(sequence) + 1 FROM collection_profile_activations),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'profile activation sequence must advance exactly once');
      END;

      CREATE TRIGGER collection_profile_activations_no_update
      BEFORE UPDATE ON collection_profile_activations
      BEGIN
        SELECT RAISE(ABORT, 'profile activations are append-only');
      END;

      CREATE TRIGGER collection_profile_activations_no_delete
      BEFORE DELETE ON collection_profile_activations
      BEGIN
        SELECT RAISE(ABORT, 'profile activations are append-only');
      END;

      CREATE TABLE checkout_token_key (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        key_material BLOB NOT NULL CHECK (
          typeof(key_material) = 'blob' AND length(key_material) = 32
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE TRIGGER checkout_token_key_no_update
      BEFORE UPDATE ON checkout_token_key
      BEGIN
        SELECT RAISE(ABORT, 'checkout token key is immutable');
      END;

      CREATE TRIGGER checkout_token_key_no_delete
      BEFORE DELETE ON checkout_token_key
      BEGIN
        SELECT RAISE(ABORT, 'checkout token key cannot be deleted');
      END;

      CREATE TABLE order_clock (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        last_now_ms INTEGER NOT NULL CHECK (last_now_ms >= 0)
      ) STRICT;

      INSERT INTO order_clock(singleton_key, last_now_ms)
      VALUES (1, CAST(unixepoch('subsec') * 1000 AS INTEGER));

      CREATE TRIGGER order_clock_no_decrease
      BEFORE UPDATE ON order_clock
      WHEN NEW.last_now_ms < OLD.last_now_ms
      BEGIN
        SELECT RAISE(ABORT, 'order clock cannot move backwards');
      END;

      CREATE TRIGGER order_clock_no_delete
      BEFORE DELETE ON order_clock
      BEGIN
        SELECT RAISE(ABORT, 'order clock cannot be deleted');
      END;

      CREATE TABLE payment_orders (
        order_id TEXT PRIMARY KEY CHECK (length(order_id) = 36),
        api_client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        merchant_order_no TEXT NOT NULL CHECK (
          length(merchant_order_no) BETWEEN 1 AND 64 AND
          merchant_order_no GLOB '[A-Za-z0-9]*' AND
          merchant_order_no NOT GLOB '*[^A-Za-z0-9._-]*'
        ),
        idempotency_key_digest TEXT NOT NULL CHECK (
          length(idempotency_key_digest) = 64 AND
          idempotency_key_digest = lower(idempotency_key_digest) AND
          idempotency_key_digest NOT GLOB '*[^0-9a-f]*'
        ),
        idempotency_key_digest_version INTEGER NOT NULL CHECK (
          idempotency_key_digest_version = 1
        ),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_fingerprint_version INTEGER NOT NULL CHECK (
          request_fingerprint_version = 1
        ),
        requested_amount_cents INTEGER NOT NULL CHECK (
          requested_amount_cents BETWEEN 1 AND 9999999998
        ),
        payable_amount_cents INTEGER NOT NULL CHECK (
          payable_amount_cents BETWEEN 2 AND 9999999999 AND
          payable_amount_cents > requested_amount_cents
        ),
        allocation_offset_max_cents INTEGER NOT NULL CHECK (
          allocation_offset_max_cents BETWEEN 1 AND 99
        ),
        received_amount_cents INTEGER CHECK (
          received_amount_cents IS NULL OR
          received_amount_cents BETWEEN 1 AND 9999999999
        ),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 200),
        collection_profile_id TEXT NOT NULL REFERENCES collection_profiles(profile_id),
        checkout_status TEXT NOT NULL CHECK (
          checkout_status IN ('OPEN', 'EXPIRED', 'CLOSED')
        ),
        payment_status TEXT NOT NULL CHECK (
          payment_status IN ('UNPAID', 'CONFIRMED', 'DISPUTED')
        ),
        refund_status TEXT NOT NULL CHECK (
          refund_status IN ('NONE', 'PARTIAL', 'FULL')
        ),
        payment_basis TEXT NOT NULL CHECK (
          payment_basis IN ('NONE', 'INFERRED', 'MANUAL')
        ),
        eligible_from INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        UNIQUE (api_client_id, merchant_order_no),
        UNIQUE (api_client_id, idempotency_key_digest),
        CHECK (
          payable_amount_cents - requested_amount_cents
          BETWEEN 1 AND allocation_offset_max_cents
        ),
        CHECK (eligible_from >= 0 AND eligible_from = created_at),
        CHECK (created_at >= 0 AND created_at < expires_at),
        CHECK (updated_at >= created_at),
        CHECK (
          (checkout_status = 'OPEN' AND closed_at IS NULL) OR
          (
            checkout_status = 'CLOSED' AND
            closed_at >= created_at AND closed_at < expires_at
          ) OR
          (checkout_status = 'EXPIRED' AND closed_at >= expires_at)
        ),
        CHECK (
          (
            payment_status = 'UNPAID' AND
            payment_basis = 'NONE' AND
            received_amount_cents IS NULL
          ) OR
          (
            payment_status = 'CONFIRMED' AND
            payment_basis IN ('INFERRED', 'MANUAL') AND
            received_amount_cents IS NOT NULL
          ) OR
          (
            payment_status = 'DISPUTED' AND
            payment_basis != 'NONE' AND
            received_amount_cents IS NOT NULL
          )
        ),
        CHECK (refund_status = 'NONE' OR payment_status IN ('CONFIRMED', 'DISPUTED'))
      ) STRICT;

      CREATE UNIQUE INDEX payment_orders_one_open_amount
      ON payment_orders(payable_amount_cents)
      WHERE checkout_status = 'OPEN';

      CREATE INDEX payment_orders_checkout_expiry_idx
      ON payment_orders(checkout_status, expires_at);

      CREATE INDEX payment_orders_created_idx
      ON payment_orders(created_at DESC, order_id);

      CREATE TRIGGER payment_orders_snapshot_immutable
      BEFORE UPDATE OF
        order_id, api_client_id, merchant_order_no, idempotency_key_digest,
        idempotency_key_digest_version,
        request_fingerprint, request_fingerprint_version, requested_amount_cents,
        payable_amount_cents, allocation_offset_max_cents, currency, description,
        collection_profile_id, eligible_from, created_at, expires_at
      ON payment_orders
      BEGIN
        SELECT RAISE(ABORT, 'order request and collection snapshot are immutable');
      END;

      CREATE TRIGGER payment_orders_initial_state
      BEFORE INSERT ON payment_orders
      WHEN
        NEW.checkout_status != 'OPEN' OR
        NEW.payment_status != 'UNPAID' OR
        NEW.refund_status != 'NONE' OR
        NEW.payment_basis != 'NONE' OR
        NEW.received_amount_cents IS NOT NULL OR
        NEW.closed_at IS NOT NULL OR
        NEW.updated_at != NEW.created_at OR
        NEW.version != 1
      BEGIN
        SELECT RAISE(ABORT, 'new orders must use the initial state');
      END;

      CREATE TRIGGER payment_orders_version_step
      BEFORE UPDATE ON payment_orders
      WHEN NEW.version != OLD.version + 1
      BEGIN
        SELECT RAISE(ABORT, 'order version must advance exactly once');
      END;

      CREATE TRIGGER payment_orders_updated_at_monotonic
      BEFORE UPDATE ON payment_orders
      WHEN NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'order updated_at cannot move backwards');
      END;

      CREATE TRIGGER payment_orders_end_time_once
      BEFORE UPDATE OF closed_at ON payment_orders
      WHEN
        OLD.closed_at IS NOT NULL OR
        NEW.closed_at IS NULL OR
        NEW.closed_at != NEW.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'order end time can only be set once');
      END;

      CREATE TRIGGER payment_orders_checkout_transition
      BEFORE UPDATE ON payment_orders
      WHEN NOT (
        OLD.checkout_status = 'OPEN' AND
        NEW.checkout_status IN ('EXPIRED', 'CLOSED')
      )
      BEGIN
        SELECT RAISE(ABORT, 'this schema version only permits ending an open checkout');
      END;

      CREATE TRIGGER payment_orders_payment_state_locked
      BEFORE UPDATE OF received_amount_cents, payment_status, refund_status, payment_basis
      ON payment_orders
      BEGIN
        SELECT RAISE(ABORT, 'payment state is not enabled by this schema version');
      END;

      CREATE TRIGGER payment_orders_no_delete
      BEFORE DELETE ON payment_orders
      BEGIN
        SELECT RAISE(ABORT, 'payment orders cannot be deleted');
      END;

      CREATE TABLE checkout_sessions (
        checkout_id TEXT PRIMARY KEY CHECK (length(checkout_id) = 36),
        order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
        token_digest TEXT NOT NULL UNIQUE CHECK (
          length(token_digest) = 64 AND
          token_digest = lower(token_digest) AND
          token_digest NOT GLOB '*[^0-9a-f]*'
        )
      ) STRICT;

      CREATE TRIGGER checkout_sessions_no_update
      BEFORE UPDATE ON checkout_sessions
      BEGIN
        SELECT RAISE(ABORT, 'checkout sessions are immutable');
      END;

      CREATE TRIGGER checkout_sessions_no_delete
      BEFORE DELETE ON checkout_sessions
      BEGIN
        SELECT RAISE(ABORT, 'checkout sessions cannot be deleted');
      END;

      CREATE TABLE amount_slots (
        slot_id TEXT PRIMARY KEY CHECK (length(slot_id) = 36),
        order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
        collection_profile_id TEXT NOT NULL REFERENCES collection_profiles(profile_id),
        payable_amount_cents INTEGER NOT NULL CHECK (
          payable_amount_cents BETWEEN 2 AND 9999999999
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        occupied_from INTEGER NOT NULL CHECK (occupied_from >= 0),
        released_at INTEGER,
        release_reason TEXT CHECK (release_reason IN ('CLOSED', 'EXPIRED')),
        UNIQUE (payable_amount_cents, generation),
        CHECK (released_at IS NULL OR released_at >= occupied_from),
        CHECK ((released_at IS NULL) = (release_reason IS NULL))
      ) STRICT;

      CREATE UNIQUE INDEX amount_slots_one_active_amount
      ON amount_slots(payable_amount_cents)
      WHERE released_at IS NULL;

      CREATE INDEX amount_slots_order_interval_idx
      ON amount_slots(order_id, occupied_from, released_at);

      CREATE INDEX amount_slots_matching_interval_idx
      ON amount_slots(
        collection_profile_id,
        payable_amount_cents,
        occupied_from,
        released_at,
        generation
      );

      CREATE TRIGGER amount_slots_valid_insert
      BEFORE INSERT ON amount_slots
      WHEN
        NEW.released_at IS NOT NULL OR
        NEW.release_reason IS NOT NULL OR
        NOT EXISTS (
          SELECT 1
            FROM payment_orders AS orders
           WHERE orders.order_id = NEW.order_id
             AND orders.collection_profile_id = NEW.collection_profile_id
             AND orders.payable_amount_cents = NEW.payable_amount_cents
             AND orders.eligible_from = NEW.occupied_from
             AND orders.checkout_status = 'OPEN'
        )
      BEGIN
        SELECT RAISE(ABORT, 'new amount slot must match an open order');
      END;

      CREATE TRIGGER amount_slots_generation_step
      BEFORE INSERT ON amount_slots
      WHEN NEW.generation != COALESCE(
        (
          SELECT MAX(previous.generation) + 1
            FROM amount_slots AS previous
           WHERE previous.payable_amount_cents = NEW.payable_amount_cents
        ),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'amount slot generation must advance exactly once');
      END;

      CREATE TRIGGER amount_slots_no_overlap
      BEFORE INSERT ON amount_slots
      WHEN EXISTS (
        SELECT 1
          FROM amount_slots AS previous
         WHERE previous.payable_amount_cents = NEW.payable_amount_cents
           AND previous.generation = (
             SELECT MAX(latest.generation)
               FROM amount_slots AS latest
              WHERE latest.payable_amount_cents = NEW.payable_amount_cents
           )
           AND (
             previous.released_at IS NULL OR
             previous.released_at > NEW.occupied_from
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'amount slot intervals cannot overlap');
      END;

      CREATE TRIGGER amount_slots_release_only
      BEFORE UPDATE ON amount_slots
      WHEN
        OLD.slot_id IS NOT NEW.slot_id OR
        OLD.order_id IS NOT NEW.order_id OR
        OLD.collection_profile_id IS NOT NEW.collection_profile_id OR
        OLD.payable_amount_cents IS NOT NEW.payable_amount_cents OR
        OLD.generation IS NOT NEW.generation OR
        OLD.occupied_from IS NOT NEW.occupied_from OR
        OLD.released_at IS NOT NULL OR
        NEW.released_at IS NULL OR
        NEW.release_reason IS NULL OR
        NOT EXISTS (
          SELECT 1
            FROM payment_orders AS orders
           WHERE orders.order_id = NEW.order_id
             AND orders.checkout_status = NEW.release_reason
             AND orders.closed_at = NEW.released_at
        )
      BEGIN
        SELECT RAISE(ABORT, 'amount slots can only be released once');
      END;

      CREATE TRIGGER payment_orders_release_amount_slot
      AFTER UPDATE OF checkout_status ON payment_orders
      WHEN OLD.checkout_status = 'OPEN' AND NEW.checkout_status IN ('CLOSED', 'EXPIRED')
      BEGIN
        UPDATE amount_slots
           SET released_at = NEW.closed_at,
               release_reason = NEW.checkout_status
         WHERE order_id = NEW.order_id
           AND released_at IS NULL;
        SELECT CASE
          WHEN changes() != 1
            THEN RAISE(ABORT, 'terminal order must release exactly one amount slot')
        END;
      END;

      CREATE TRIGGER amount_slots_no_delete
      BEFORE DELETE ON amount_slots
      BEGIN
        SELECT RAISE(ABORT, 'amount slot history cannot be deleted');
      END;

      CREATE TABLE order_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        order_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL CHECK (
          event_type IN ('CREATED', 'CHECKOUT_CLOSED', 'CHECKOUT_EXPIRED')
        ),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND
          json_type(details_json) = 'object' AND
          length(CAST(details_json AS BLOB)) <= 8192
        ),
        UNIQUE (order_id, sequence)
      ) STRICT;

      CREATE INDEX order_events_occurred_idx
      ON order_events(occurred_at, event_id);

      CREATE TRIGGER order_events_valid_insert
      BEFORE INSERT ON order_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM payment_orders AS orders
         WHERE orders.order_id = NEW.order_id
           AND orders.version = NEW.sequence
           AND orders.updated_at = NEW.occurred_at
           AND (
             (
               NEW.event_type = 'CREATED' AND
               orders.version = 1 AND
               orders.checkout_status = 'OPEN'
             ) OR
             (
               NEW.event_type = 'CHECKOUT_CLOSED' AND
               orders.checkout_status = 'CLOSED'
             ) OR
             (
               NEW.event_type = 'CHECKOUT_EXPIRED' AND
               orders.checkout_status = 'EXPIRED'
             )
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'order event must match the current order version');
      END;

      CREATE TRIGGER order_events_no_update
      BEFORE UPDATE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are append-only');
      END;

      CREATE TRIGGER order_events_no_delete
      BEFORE DELETE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are append-only');
      END;
    `,
  },
  {
    version: 4,
    name: "ledger_ingestion_schema",
    sql: `
      /*
       * Ingestion deliberately keeps provider evidence separate from the
       * normalized ledger.  A provider can return the same page more than
       * once, or return a different body for the same request while a
       * statement is changing.  Both observations remain durable; only the
       * normalized row with the first semantic fingerprint is eligible for
       * matching.
       */
      CREATE TABLE provider_account_bindings (
        provider_account_key TEXT PRIMARY KEY CHECK (provider_account_key = 'primary'),
        provider_kind TEXT NOT NULL CHECK (provider_kind = 'alipay'),
        provider_endpoint TEXT NOT NULL CHECK (
          length(provider_endpoint) BETWEEN 1 AND 2048 AND
          provider_endpoint = trim(provider_endpoint) AND
          provider_endpoint GLOB 'https://*' AND
          instr(provider_endpoint, char(0)) = 0
        ),
        external_account_id TEXT NOT NULL CHECK (
          length(external_account_id) BETWEEN 1 AND 128 AND
          external_account_id = trim(external_account_id) AND
          instr(external_account_id, char(0)) = 0
        ),
        identity_fingerprint_version INTEGER NOT NULL CHECK (
          identity_fingerprint_version = 1
        ),
        identity_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(identity_fingerprint) = 64 AND
          identity_fingerprint = lower(identity_fingerprint) AND
          identity_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        bound_at INTEGER NOT NULL CHECK (bound_at >= 0)
      ) STRICT;

      CREATE TRIGGER provider_account_bindings_no_update
      BEFORE UPDATE ON provider_account_bindings
      BEGIN
        SELECT RAISE(ABORT, 'provider account bindings are immutable');
      END;

      CREATE TRIGGER provider_account_bindings_no_delete
      BEFORE DELETE ON provider_account_bindings
      BEGIN
        SELECT RAISE(ABORT, 'provider account bindings cannot be deleted');
      END;

      CREATE TABLE ingest_runs (
        ingest_run_id TEXT PRIMARY KEY CHECK (length(ingest_run_id) = 36),
        provider_account_key TEXT NOT NULL CHECK (
          length(provider_account_key) BETWEEN 1 AND 128 AND
          instr(provider_account_key, char(0)) = 0
        ),
        window_start TEXT NOT NULL CHECK (
          length(window_start) BETWEEN 1 AND 64 AND instr(window_start, char(0)) = 0
        ),
        window_end TEXT NOT NULL CHECK (
          length(window_end) BETWEEN 1 AND 64 AND instr(window_end, char(0)) = 0
        ),
        page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 2000),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        completed_at INTEGER,
        pages_received INTEGER NOT NULL DEFAULT 0 CHECK (pages_received >= 0),
        details_received INTEGER NOT NULL DEFAULT 0 CHECK (details_received >= 0),
        failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
        CHECK (completed_at IS NULL OR completed_at >= started_at),
        CHECK (
          (status = 'RUNNING' AND completed_at IS NULL) OR
          (status IN ('COMPLETED', 'PARTIAL', 'FAILED') AND completed_at IS NOT NULL)
        ),
        CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
      ) STRICT;

      CREATE INDEX ingest_runs_account_started_idx
      ON ingest_runs(provider_account_key, started_at DESC, ingest_run_id);

      CREATE UNIQUE INDEX ingest_runs_one_running_account
      ON ingest_runs(provider_account_key)
      WHERE status = 'RUNNING';

      CREATE TRIGGER ingest_runs_identity_immutable
      BEFORE UPDATE OF
        ingest_run_id, provider_account_key, window_start, window_end,
        page_size, started_at
      ON ingest_runs
      BEGIN
        SELECT RAISE(ABORT, 'ingest run identity is immutable');
      END;

      CREATE TRIGGER ingest_runs_progress_monotonic
      BEFORE UPDATE ON ingest_runs
      WHEN
        NEW.pages_received < OLD.pages_received OR
        NEW.details_received < OLD.details_received OR
        OLD.status != 'RUNNING'
      BEGIN
        SELECT RAISE(ABORT, 'ingest run progress or terminal transition is invalid');
      END;

      CREATE TRIGGER ingest_runs_no_delete
      BEFORE DELETE ON ingest_runs
      BEGIN
        SELECT RAISE(ABORT, 'ingest runs cannot be deleted');
      END;

      CREATE TABLE ingest_segments (
        ingest_segment_id TEXT PRIMARY KEY CHECK (length(ingest_segment_id) = 36),
        ingest_run_id TEXT NOT NULL REFERENCES ingest_runs(ingest_run_id),
        parent_segment_id TEXT REFERENCES ingest_segments(ingest_segment_id),
        window_start TEXT NOT NULL CHECK (
          length(window_start) BETWEEN 1 AND 64 AND instr(window_start, char(0)) = 0
        ),
        window_end TEXT NOT NULL CHECK (
          length(window_end) BETWEEN 1 AND 64 AND instr(window_end, char(0)) = 0
        ),
        depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 63),
        state TEXT NOT NULL CHECK (state IN ('PENDING', 'SPLIT', 'COMPLETE')),
        split_at TEXT CHECK (
          split_at IS NULL OR
          (length(split_at) BETWEEN 1 AND 64 AND instr(split_at, char(0)) = 0)
        ),
        accepted_raw_page_id TEXT REFERENCES provider_raw_pages(raw_page_id),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        completed_at INTEGER,
        UNIQUE (ingest_run_id, window_start, window_end),
        CHECK (window_start < window_end),
        CHECK (
          (parent_segment_id IS NULL AND depth = 0) OR
          (parent_segment_id IS NOT NULL AND depth > 0)
        ),
        CHECK (
          (state = 'PENDING' AND split_at IS NULL AND accepted_raw_page_id IS NULL AND completed_at IS NULL) OR
          (state = 'SPLIT' AND split_at IS NOT NULL AND accepted_raw_page_id IS NULL AND completed_at IS NOT NULL) OR
          (state = 'COMPLETE' AND split_at IS NULL AND accepted_raw_page_id IS NOT NULL AND completed_at IS NOT NULL)
        ),
        CHECK (completed_at IS NULL OR completed_at >= created_at)
      ) STRICT;

      CREATE INDEX ingest_segments_pending_idx
      ON ingest_segments(ingest_run_id, state, window_start, depth, ingest_segment_id);

      CREATE INDEX ingest_segments_parent_idx
      ON ingest_segments(parent_segment_id, window_start, window_end, ingest_segment_id);

      CREATE UNIQUE INDEX ingest_segments_one_root
      ON ingest_segments(ingest_run_id)
      WHERE parent_segment_id IS NULL;

      CREATE TRIGGER ingest_segments_valid_insert
      BEFORE INSERT ON ingest_segments
      WHEN NOT EXISTS (
        SELECT 1
          FROM ingest_runs AS run
         WHERE run.ingest_run_id = NEW.ingest_run_id
           AND (
             (NEW.parent_segment_id IS NULL AND
              NEW.window_start = run.window_start AND
              NEW.window_end = run.window_end AND
              NEW.depth = 0) OR
             (NEW.parent_segment_id IS NOT NULL AND EXISTS (
               SELECT 1
                 FROM ingest_segments AS parent
                WHERE parent.ingest_segment_id = NEW.parent_segment_id
                  AND parent.ingest_run_id = NEW.ingest_run_id
                  AND parent.state = 'SPLIT'
                  AND NEW.depth = parent.depth + 1
                  AND NEW.window_start >= parent.window_start
                  AND NEW.window_end <= parent.window_end
             ))
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'ingest segment must belong to its run and parent window');
      END;

      CREATE TRIGGER ingest_segments_terminal_immutable
      BEFORE UPDATE ON ingest_segments
      WHEN OLD.state != 'PENDING'
      BEGIN
        SELECT RAISE(ABORT, 'terminal ingest segments are immutable');
      END;

      CREATE TRIGGER ingest_segments_identity_immutable
      BEFORE UPDATE OF
        ingest_segment_id, ingest_run_id, parent_segment_id,
        window_start, window_end, depth, created_at
      ON ingest_segments
      BEGIN
        SELECT RAISE(ABORT, 'ingest segment identity is immutable');
      END;

      CREATE TRIGGER ingest_segments_no_delete
      BEFORE DELETE ON ingest_segments
      BEGIN
        SELECT RAISE(ABORT, 'ingest segments cannot be deleted');
      END;

      CREATE TABLE provider_raw_pages (
        raw_page_id TEXT PRIMARY KEY CHECK (length(raw_page_id) = 36),
        ingest_run_id TEXT NOT NULL REFERENCES ingest_runs(ingest_run_id),
        provider_account_key TEXT NOT NULL CHECK (
          length(provider_account_key) BETWEEN 1 AND 128 AND
          instr(provider_account_key, char(0)) = 0
        ),
        window_start TEXT NOT NULL CHECK (length(window_start) BETWEEN 1 AND 64),
        window_end TEXT NOT NULL CHECK (length(window_end) BETWEEN 1 AND 64),
        page_no INTEGER NOT NULL CHECK (page_no >= 1),
        page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 2000),
        total_size INTEGER NOT NULL CHECK (total_size >= 0),
        has_more INTEGER NOT NULL CHECK (has_more IN (0, 1)),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        response_fingerprint TEXT NOT NULL CHECK (
          length(response_fingerprint) = 64 AND
          response_fingerprint = lower(response_fingerprint) AND
          response_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
        headers_json TEXT NOT NULL CHECK (
          json_valid(headers_json) AND json_type(headers_json) = 'object' AND
          length(CAST(headers_json AS BLOB)) <= 16384
        ),
        raw_body BLOB NOT NULL CHECK (
          typeof(raw_body) = 'blob' AND length(raw_body) <= 2097152
        ),
        trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 256),
        signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
        received_at INTEGER NOT NULL CHECK (received_at >= 0),
        UNIQUE (provider_account_key, request_fingerprint, response_fingerprint),
        CHECK (provider_account_key IS NOT NULL)
      ) STRICT;

      CREATE INDEX provider_raw_pages_request_idx
      ON provider_raw_pages(provider_account_key, request_fingerprint, received_at);

      CREATE INDEX provider_raw_pages_run_idx
      ON provider_raw_pages(ingest_run_id, page_no, received_at);

      CREATE TRIGGER provider_raw_pages_valid_insert
      BEFORE INSERT ON provider_raw_pages
      WHEN NOT EXISTS (
        SELECT 1
          FROM ingest_runs AS run
         WHERE run.ingest_run_id = NEW.ingest_run_id
           AND run.provider_account_key = NEW.provider_account_key
           AND run.page_size = NEW.page_size
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider raw page must match its originating run');
      END;

      CREATE TRIGGER provider_raw_pages_no_update
      BEFORE UPDATE ON provider_raw_pages
      BEGIN
        SELECT RAISE(ABORT, 'provider raw pages are immutable');
      END;

      CREATE TRIGGER provider_raw_pages_no_delete
      BEFORE DELETE ON provider_raw_pages
      BEGIN
        SELECT RAISE(ABORT, 'provider raw pages cannot be deleted');
      END;

      CREATE TABLE ingest_run_page_observations (
        ingest_run_id TEXT NOT NULL REFERENCES ingest_runs(ingest_run_id),
        ingest_segment_id TEXT NOT NULL REFERENCES ingest_segments(ingest_segment_id),
        raw_page_id TEXT NOT NULL REFERENCES provider_raw_pages(raw_page_id),
        observation_kind TEXT NOT NULL CHECK (observation_kind IN ('OVERSIZED_PROBE', 'ACCEPTED_LEAF')),
        http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
        headers_json TEXT NOT NULL CHECK (
          json_valid(headers_json) AND json_type(headers_json) = 'object' AND
          length(CAST(headers_json AS BLOB)) <= 16384
        ),
        trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 256),
        signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
        PRIMARY KEY (ingest_segment_id, raw_page_id)
      ) STRICT;

      CREATE INDEX ingest_run_page_observations_page_idx
      ON ingest_run_page_observations(ingest_run_id, raw_page_id, observed_at);

      CREATE INDEX ingest_run_page_observations_raw_page_idx
      ON ingest_run_page_observations(raw_page_id, ingest_segment_id, ingest_run_id, observation_kind);

      CREATE TRIGGER ingest_run_page_observations_no_update
      BEFORE UPDATE ON ingest_run_page_observations
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observations are immutable');
      END;

      CREATE TRIGGER ingest_run_page_observations_valid_insert
      BEFORE INSERT ON ingest_run_page_observations
      WHEN NOT EXISTS (
        SELECT 1
          FROM ingest_runs AS run
          JOIN ingest_segments AS segment ON segment.ingest_segment_id = NEW.ingest_segment_id
          JOIN provider_raw_pages AS page ON page.raw_page_id = NEW.raw_page_id
         WHERE run.ingest_run_id = NEW.ingest_run_id
           AND segment.ingest_run_id = run.ingest_run_id
           AND run.provider_account_key = page.provider_account_key
           AND segment.window_start = page.window_start
           AND segment.window_end = page.window_end
           AND run.page_size = page.page_size
           AND page.page_no = 1
           AND NEW.http_status = page.http_status
           AND NEW.signature_verified = 1
           AND page.signature_verified = 1
           AND (
             (NEW.observation_kind = 'OVERSIZED_PROBE' AND page.has_more = 1) OR
             (NEW.observation_kind = 'ACCEPTED_LEAF' AND page.has_more = 0)
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observation must match its run and page');
      END;

      CREATE TRIGGER ingest_run_page_observations_no_delete
      BEFORE DELETE ON ingest_run_page_observations
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observations cannot be deleted');
      END;

      CREATE TABLE provider_raw_events (
        raw_event_id TEXT PRIMARY KEY CHECK (length(raw_event_id) = 36),
        raw_page_id TEXT NOT NULL REFERENCES provider_raw_pages(raw_page_id),
        provider_account_key TEXT NOT NULL CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        external_event_id TEXT CHECK (
          external_event_id IS NULL OR length(external_event_id) BETWEEN 1 AND 256
        ),
        occurred_at_text TEXT CHECK (
          occurred_at_text IS NULL OR length(occurred_at_text) BETWEEN 1 AND 128
        ),
        amount_text TEXT CHECK (amount_text IS NULL OR length(amount_text) BETWEEN 1 AND 128),
        direction_text TEXT CHECK (direction_text IS NULL OR length(direction_text) BETWEEN 1 AND 64),
        alipay_order_no TEXT CHECK (alipay_order_no IS NULL OR length(alipay_order_no) BETWEEN 1 AND 128),
        merchant_order_no TEXT CHECK (merchant_order_no IS NULL OR length(merchant_order_no) BETWEEN 1 AND 128),
        trans_memo TEXT CHECK (trans_memo IS NULL OR length(trans_memo) <= 1024),
        other_account TEXT CHECK (other_account IS NULL OR length(other_account) <= 256),
        payload_fingerprint TEXT NOT NULL CHECK (
          length(payload_fingerprint) = 64 AND
          payload_fingerprint = lower(payload_fingerprint) AND
          payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        raw_payload BLOB NOT NULL CHECK (
          typeof(raw_payload) = 'blob' AND length(raw_payload) <= 524288
        ),
        observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
        UNIQUE (raw_page_id, ordinal)
      ) STRICT;

      CREATE INDEX provider_raw_events_external_idx
      ON provider_raw_events(provider_account_key, external_event_id, observed_at);

      CREATE TRIGGER provider_raw_events_valid_insert
      BEFORE INSERT ON provider_raw_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM provider_raw_pages AS page
         WHERE page.raw_page_id = NEW.raw_page_id
           AND page.provider_account_key = NEW.provider_account_key
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider raw event must share its page account');
      END;

      CREATE TRIGGER provider_raw_events_no_update
      BEFORE UPDATE ON provider_raw_events
      BEGIN
        SELECT RAISE(ABORT, 'provider raw events are immutable');
      END;

      CREATE TRIGGER provider_raw_events_no_delete
      BEFORE DELETE ON provider_raw_events
      BEGIN
        SELECT RAISE(ABORT, 'provider raw events cannot be deleted');
      END;

      CREATE TABLE ledger_entries (
        ledger_entry_id TEXT PRIMARY KEY CHECK (length(ledger_entry_id) = 36),
        provider_account_key TEXT NOT NULL CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        raw_event_id TEXT NOT NULL UNIQUE REFERENCES provider_raw_events(raw_event_id),
        external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 256),
        semantic_fingerprint TEXT NOT NULL CHECK (
          length(semantic_fingerprint) = 64 AND
          semantic_fingerprint = lower(semantic_fingerprint) AND
          semantic_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
        direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        alipay_order_no TEXT CHECK (alipay_order_no IS NULL OR length(alipay_order_no) BETWEEN 1 AND 128),
        merchant_order_no TEXT CHECK (merchant_order_no IS NULL OR length(merchant_order_no) BETWEEN 1 AND 128),
        trans_memo TEXT CHECK (trans_memo IS NULL OR length(trans_memo) <= 1024),
        other_account TEXT CHECK (other_account IS NULL OR length(other_account) <= 256),
        state TEXT NOT NULL DEFAULT 'UNALLOCATED' CHECK (
          state IN ('UNALLOCATED', 'CANDIDATE', 'ALLOCATED', 'CONFLICT', 'ISOLATED', 'IGNORED')
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (provider_account_key, external_event_id)
      ) STRICT;

      CREATE INDEX ledger_entries_matching_idx
      ON ledger_entries(provider_account_key, direction, amount_cents, occurred_at, state);

      CREATE INDEX ledger_entries_external_idx
      ON ledger_entries(provider_account_key, external_event_id);

      CREATE TRIGGER ledger_entries_valid_insert
      BEFORE INSERT ON ledger_entries
      WHEN NOT EXISTS (
        SELECT 1
          FROM provider_raw_events AS raw
         WHERE raw.raw_event_id = NEW.raw_event_id
           AND raw.provider_account_key = NEW.provider_account_key
           AND raw.external_event_id = NEW.external_event_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'normalized ledger entry must match its raw event identity');
      END;

      CREATE TRIGGER ledger_entries_facts_immutable
      BEFORE UPDATE OF
        ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
        semantic_fingerprint, occurred_at, amount_cents, direction, currency,
        alipay_order_no, merchant_order_no, trans_memo, other_account, created_at
      ON ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'normalized ledger facts are immutable');
      END;

      CREATE TRIGGER ledger_entries_updated_at_monotonic
      BEFORE UPDATE OF updated_at ON ledger_entries
      WHEN NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'ledger entry updated_at cannot move backwards');
      END;

      CREATE TRIGGER ledger_entries_no_delete
      BEFORE DELETE ON ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'ledger entries cannot be deleted');
      END;

      CREATE TABLE ledger_conflicts (
        conflict_id TEXT PRIMARY KEY CHECK (length(conflict_id) = 36),
        provider_account_key TEXT NOT NULL CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        conflict_type TEXT NOT NULL CHECK (
          conflict_type IN (
            'RAW_PAGE_VARIANT', 'DUPLICATE_EXTERNAL_ID', 'MISSING_EXTERNAL_ID',
            'INVALID_AMOUNT', 'INVALID_TIMESTAMP', 'INVALID_DIRECTION', 'INVALID_SHAPE'
          )
        ),
        raw_page_id TEXT REFERENCES provider_raw_pages(raw_page_id),
        raw_event_id TEXT REFERENCES provider_raw_events(raw_event_id),
        existing_ledger_entry_id TEXT REFERENCES ledger_entries(ledger_entry_id),
        external_event_id TEXT CHECK (external_event_id IS NULL OR length(external_event_id) BETWEEN 1 AND 256),
        existing_semantic_fingerprint TEXT CHECK (
          existing_semantic_fingerprint IS NULL OR
          (length(existing_semantic_fingerprint) = 64 AND existing_semantic_fingerprint = lower(existing_semantic_fingerprint) AND existing_semantic_fingerprint NOT GLOB '*[^0-9a-f]*')
        ),
        incoming_semantic_fingerprint TEXT CHECK (
          incoming_semantic_fingerprint IS NULL OR
          (length(incoming_semantic_fingerprint) = 64 AND incoming_semantic_fingerprint = lower(incoming_semantic_fingerprint) AND incoming_semantic_fingerprint NOT GLOB '*[^0-9a-f]*')
        ),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND json_type(details_json) = 'object' AND
          length(CAST(details_json AS BLOB)) <= 8192
        ),
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
        resolution_json TEXT CHECK (
          resolution_json IS NULL OR
          (json_valid(resolution_json) AND json_type(resolution_json) = 'object' AND length(CAST(resolution_json AS BLOB)) <= 8192)
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        resolved_at INTEGER,
        conflict_fingerprint TEXT NOT NULL CHECK (
          length(conflict_fingerprint) = 64 AND conflict_fingerprint = lower(conflict_fingerprint) AND conflict_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        UNIQUE (provider_account_key, conflict_fingerprint),
        CHECK (
          (status = 'OPEN' AND resolved_at IS NULL AND resolution_json IS NULL) OR
          (status IN ('RESOLVED', 'IGNORED') AND resolved_at IS NOT NULL AND resolution_json IS NOT NULL)
        ),
        CHECK (resolved_at IS NULL OR resolved_at >= created_at)
      ) STRICT;

      CREATE INDEX ledger_conflicts_open_idx
      ON ledger_conflicts(provider_account_key, status, created_at, conflict_id);

      CREATE TRIGGER ledger_conflicts_valid_insert
      BEFORE INSERT ON ledger_conflicts
      WHEN
        (NEW.raw_page_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM provider_raw_pages AS page
           WHERE page.raw_page_id = NEW.raw_page_id
             AND page.provider_account_key = NEW.provider_account_key
        )) OR
        (NEW.raw_event_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM provider_raw_events AS raw
           WHERE raw.raw_event_id = NEW.raw_event_id
             AND raw.provider_account_key = NEW.provider_account_key
        )) OR
        (NEW.existing_ledger_entry_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM ledger_entries AS entry
           WHERE entry.ledger_entry_id = NEW.existing_ledger_entry_id
             AND entry.provider_account_key = NEW.provider_account_key
        ))
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict references a different provider account');
      END;

      CREATE TRIGGER ledger_conflicts_evidence_immutable
      BEFORE UPDATE OF
        conflict_id, provider_account_key, conflict_type, raw_page_id, raw_event_id,
        existing_ledger_entry_id, external_event_id, existing_semantic_fingerprint,
        incoming_semantic_fingerprint, details_json, created_at, conflict_fingerprint
      ON ledger_conflicts
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict evidence is immutable');
      END;

      CREATE TRIGGER ledger_conflicts_resolution_consistent
      BEFORE UPDATE OF status, resolution_json, resolved_at ON ledger_conflicts
      WHEN NOT (
        (NEW.status = 'OPEN' AND NEW.resolved_at IS NULL AND NEW.resolution_json IS NULL) OR
        (NEW.status IN ('RESOLVED', 'IGNORED') AND NEW.resolved_at IS NOT NULL AND NEW.resolution_json IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict resolution is inconsistent');
      END;

      CREATE TRIGGER ledger_conflicts_no_delete
      BEFORE DELETE ON ledger_conflicts
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflicts cannot be deleted');
      END;

      CREATE TABLE ingest_errors (
        ingest_error_id TEXT PRIMARY KEY CHECK (length(ingest_error_id) = 36),
        ingest_run_id TEXT NOT NULL REFERENCES ingest_runs(ingest_run_id),
        provider_account_key TEXT NOT NULL CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        page_no INTEGER CHECK (page_no IS NULL OR page_no >= 1),
        error_kind TEXT NOT NULL CHECK (length(error_kind) BETWEEN 1 AND 64),
        error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 128),
        retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
        http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
        headers_json TEXT CHECK (
          headers_json IS NULL OR
          (json_valid(headers_json) AND json_type(headers_json) = 'object' AND length(CAST(headers_json AS BLOB)) <= 16384)
        ),
        raw_body BLOB CHECK (
          raw_body IS NULL OR (typeof(raw_body) = 'blob' AND length(raw_body) <= 2097152)
        ),
        response_fingerprint TEXT CHECK (
          response_fingerprint IS NULL OR
          (length(response_fingerprint) = 64 AND response_fingerprint = lower(response_fingerprint) AND response_fingerprint NOT GLOB '*[^0-9a-f]*')
        ),
        trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 256),
        signature_verified INTEGER CHECK (signature_verified IS NULL OR signature_verified IN (0, 1)),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND json_type(details_json) = 'object' AND length(CAST(details_json AS BLOB)) <= 8192
        ),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        CHECK (
          (raw_body IS NULL AND http_status IS NULL AND headers_json IS NULL AND response_fingerprint IS NULL AND trace_id IS NULL AND signature_verified IS NULL) OR
          (raw_body IS NOT NULL AND http_status IS NOT NULL AND headers_json IS NOT NULL AND response_fingerprint IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX ingest_errors_run_idx
      ON ingest_errors(ingest_run_id, occurred_at, ingest_error_id);

      CREATE TRIGGER ingest_errors_valid_insert
      BEFORE INSERT ON ingest_errors
      WHEN NOT EXISTS (
        SELECT 1 FROM ingest_runs AS run
         WHERE run.ingest_run_id = NEW.ingest_run_id
           AND run.provider_account_key = NEW.provider_account_key
      )
      BEGIN
        SELECT RAISE(ABORT, 'ingest error must share its run account');
      END;

      CREATE TRIGGER ingest_errors_no_update
      BEFORE UPDATE ON ingest_errors
      BEGIN
        SELECT RAISE(ABORT, 'ingest errors are append-only');
      END;

      CREATE TRIGGER ingest_errors_no_delete
      BEFORE DELETE ON ingest_errors
      BEGIN
        SELECT RAISE(ABORT, 'ingest errors cannot be deleted');
      END;

      CREATE TABLE ledger_cursors (
        provider_account_key TEXT PRIMARY KEY CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        window_start TEXT NOT NULL CHECK (length(window_start) BETWEEN 1 AND 64),
        window_end TEXT NOT NULL CHECK (length(window_end) BETWEEN 1 AND 64),
        next_page_no INTEGER CHECK (next_page_no IS NULL OR next_page_no = 1),
        page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 2000),
        expected_total_size INTEGER CHECK (expected_total_size IS NULL OR expected_total_size >= 0),
        overlap_milliseconds INTEGER NOT NULL DEFAULT 300000 CHECK (overlap_milliseconds BETWEEN 0 AND 604800000),
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        last_event_occurred_at INTEGER CHECK (last_event_occurred_at IS NULL OR last_event_occurred_at >= 0),
        last_completed_at INTEGER CHECK (last_completed_at IS NULL OR last_completed_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        CHECK (expected_total_size IS NULL),
        CHECK ((complete = 1 AND next_page_no IS NULL) OR (complete = 0 AND next_page_no = 1))
      ) STRICT;

      CREATE TRIGGER ledger_cursors_monotonic_version
      BEFORE UPDATE ON ledger_cursors
      WHEN NEW.version != OLD.version + 1
      BEGIN
        SELECT RAISE(ABORT, 'ledger cursor version must advance exactly once');
      END;

      CREATE TRIGGER ledger_cursors_updated_at_monotonic
      BEFORE UPDATE ON ledger_cursors
      WHEN NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'ledger cursor updated_at cannot move backwards');
      END;

      CREATE INDEX ledger_cursors_updated_idx
      ON ledger_cursors(updated_at, provider_account_key);
    `,
  },
  {
    version: 5,
    name: "reconciliation_and_financial_ledger_schema",
    postApply: "upgrade_ledger_semantic_fingerprints_v2",
    sql: `
      /*
       * Payment decisions are append-only financial operations. Candidate
       * evidence, effective allocations, accounting entries, exceptions, and
       * delivery intent remain separate so no single association can masquerade
       * as both provider fact and business decision.
       */
      ALTER TABLE ledger_entries
      ADD COLUMN occurred_at_precision_ms INTEGER NOT NULL DEFAULT 1000 CHECK (
        occurred_at_precision_ms IN (1, 10, 100, 1000)
      );

      UPDATE ledger_entries
         SET occurred_at_precision_ms = (
           SELECT CASE
                    WHEN instr(trim(raw.occurred_at_text), '.') = 0 THEN 1000
                    WHEN substr(
                           trim(raw.occurred_at_text),
                           instr(trim(raw.occurred_at_text), '.') + 1,
                           3
                         ) GLOB '[0-9][0-9][0-9]' THEN 1
                    WHEN substr(
                           trim(raw.occurred_at_text),
                           instr(trim(raw.occurred_at_text), '.') + 1,
                           2
                         ) GLOB '[0-9][0-9]' THEN 10
                    WHEN substr(
                           trim(raw.occurred_at_text),
                           instr(trim(raw.occurred_at_text), '.') + 1,
                           1
                         ) GLOB '[0-9]' THEN 100
                    ELSE 1000
                  END
             FROM provider_raw_events AS raw
            WHERE raw.raw_event_id = ledger_entries.raw_event_id
         );

      DROP TRIGGER ledger_entries_valid_insert;
      CREATE TRIGGER ledger_entries_valid_insert
      BEFORE INSERT ON ledger_entries
      WHEN NOT EXISTS (
        SELECT 1
          FROM provider_raw_events AS raw
         WHERE raw.raw_event_id = NEW.raw_event_id
           AND raw.provider_account_key = NEW.provider_account_key
           AND raw.external_event_id = NEW.external_event_id
           AND NEW.occurred_at_precision_ms = CASE
                 WHEN instr(trim(raw.occurred_at_text), '.') = 0 THEN 1000
                 WHEN substr(
                        trim(raw.occurred_at_text),
                        instr(trim(raw.occurred_at_text), '.') + 1,
                        3
                      ) GLOB '[0-9][0-9][0-9]' THEN 1
                 WHEN substr(
                        trim(raw.occurred_at_text),
                        instr(trim(raw.occurred_at_text), '.') + 1,
                        2
                      ) GLOB '[0-9][0-9]' THEN 10
                 WHEN substr(
                        trim(raw.occurred_at_text),
                        instr(trim(raw.occurred_at_text), '.') + 1,
                        1
                      ) GLOB '[0-9]' THEN 100
                 ELSE 1000
               END
      )
      BEGIN
        SELECT RAISE(ABORT, 'normalized ledger entry must match its raw event identity');
      END;

      DROP TRIGGER ledger_entries_facts_immutable;
      CREATE TRIGGER ledger_entries_facts_immutable
      BEFORE UPDATE OF
        ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
        semantic_fingerprint, occurred_at, occurred_at_precision_ms, amount_cents,
        direction, currency, alipay_order_no, merchant_order_no, trans_memo,
        other_account, created_at
      ON ledger_entries
      BEGIN
        SELECT RAISE(ABORT, 'normalized ledger facts are immutable');
      END;

      DROP TRIGGER payment_orders_checkout_transition;
      DROP TRIGGER payment_orders_payment_state_locked;

      CREATE TRIGGER payment_orders_checkout_transition
      BEFORE UPDATE OF checkout_status ON payment_orders
      WHEN
        NEW.checkout_status != OLD.checkout_status AND
        NOT (
          OLD.checkout_status = 'OPEN' AND
          NEW.checkout_status IN ('EXPIRED', 'CLOSED')
        )
      BEGIN
        SELECT RAISE(ABORT, 'checkout status transition is invalid');
      END;

      CREATE TRIGGER payment_orders_payment_state_transition
      BEFORE UPDATE OF received_amount_cents, payment_status, refund_status, payment_basis
      ON payment_orders
      WHEN NOT (
        (
          OLD.payment_status = 'UNPAID' AND
          OLD.payment_basis = 'NONE' AND
          OLD.received_amount_cents IS NULL AND
          OLD.refund_status = 'NONE' AND
          NEW.payment_status = 'CONFIRMED' AND
          NEW.payment_basis = 'INFERRED' AND
          NEW.received_amount_cents IS NOT NULL AND
          NEW.refund_status = 'NONE'
        ) OR
        (
          OLD.payment_status = 'UNPAID' AND
          OLD.payment_basis = 'NONE' AND
          OLD.received_amount_cents IS NULL AND
          OLD.refund_status = 'NONE' AND
          NEW.payment_status = 'CONFIRMED' AND
          NEW.payment_basis = 'MANUAL' AND
          NEW.received_amount_cents IS NOT NULL AND
          NEW.refund_status = 'NONE'
        ) OR
        (
          OLD.payment_status = 'CONFIRMED' AND
          NEW.payment_status = 'DISPUTED' AND
          NEW.payment_basis = OLD.payment_basis AND
          NEW.received_amount_cents = OLD.received_amount_cents AND
          NEW.refund_status = OLD.refund_status
        ) OR
        (
          OLD.payment_status IN ('CONFIRMED', 'DISPUTED') AND
          NEW.payment_status = OLD.payment_status AND
          NEW.payment_basis = OLD.payment_basis AND
          NEW.received_amount_cents = OLD.received_amount_cents AND
          (
            (OLD.refund_status = 'NONE' AND NEW.refund_status IN ('PARTIAL', 'FULL')) OR
            (OLD.refund_status = 'PARTIAL' AND NEW.refund_status IN ('PARTIAL', 'FULL'))
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'payment state transition is invalid');
      END;

      DROP TRIGGER order_events_valid_insert;
      DROP TRIGGER order_events_no_update;
      DROP TRIGGER order_events_no_delete;
      DROP INDEX order_events_occurred_idx;
      ALTER TABLE order_events RENAME TO order_events_v3;

      CREATE TABLE order_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        order_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'CREATED', 'CHECKOUT_CLOSED', 'CHECKOUT_EXPIRED',
            'PAYMENT_CONFIRMED', 'PAYMENT_DISPUTED', 'REFUND_UPDATED'
          )
        ),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND
          json_type(details_json) = 'object' AND
          length(CAST(details_json AS BLOB)) <= 8192
        ),
        UNIQUE (order_id, sequence)
      ) STRICT;

      INSERT INTO order_events(
        event_id, order_id, sequence, event_type, occurred_at, details_json
      )
      SELECT event_id, order_id, sequence, event_type, occurred_at, details_json
        FROM order_events_v3;

      DROP TABLE order_events_v3;

      CREATE INDEX order_events_occurred_idx
      ON order_events(occurred_at, event_id);

      CREATE TRIGGER order_events_valid_insert
      BEFORE INSERT ON order_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM payment_orders AS orders
         WHERE orders.order_id = NEW.order_id
           AND orders.version = NEW.sequence
           AND orders.updated_at = NEW.occurred_at
           AND (
             (
               NEW.event_type = 'CREATED' AND
               orders.version = 1 AND
               orders.checkout_status = 'OPEN' AND
               orders.payment_status = 'UNPAID'
             ) OR
             (NEW.event_type = 'CHECKOUT_CLOSED' AND orders.checkout_status = 'CLOSED') OR
             (NEW.event_type = 'CHECKOUT_EXPIRED' AND orders.checkout_status = 'EXPIRED') OR
             (
               NEW.event_type = 'PAYMENT_CONFIRMED' AND
               orders.payment_status = 'CONFIRMED'
             ) OR
             (
               NEW.event_type = 'PAYMENT_DISPUTED' AND
               orders.payment_status = 'DISPUTED'
             ) OR
             (
               NEW.event_type = 'REFUND_UPDATED' AND
               orders.refund_status IN ('PARTIAL', 'FULL')
             )
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'order event must match the current order version');
      END;

      CREATE TRIGGER order_events_no_update
      BEFORE UPDATE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are append-only');
      END;

      CREATE TRIGGER order_events_no_delete
      BEFORE DELETE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are append-only');
      END;

      CREATE TABLE financial_operations (
        financial_operation_id TEXT PRIMARY KEY CHECK (length(financial_operation_id) = 36),
        operation_key TEXT NOT NULL UNIQUE CHECK (
          length(operation_key) BETWEEN 1 AND 128 AND
          instr(operation_key, char(0)) = 0
        ),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_json TEXT NOT NULL CHECK (
          json_valid(request_json) AND
          json_type(request_json) = 'object' AND
          length(CAST(request_json AS BLOB)) <= 8192
        ),
        operation_type TEXT NOT NULL CHECK (
          operation_type IN (
            'AUTO_SETTLEMENT', 'SUPERSEDE_CANDIDATE',
            'MANUAL_SETTLEMENT', 'REVERSE_SETTLEMENT', 'RECORD_REFUND'
          )
        ),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'ADMIN')),
        actor_id TEXT CHECK (
          actor_id IS NULL OR
          (length(actor_id) BETWEEN 1 AND 128 AND instr(actor_id, char(0)) = 0)
        ),
        order_id TEXT REFERENCES payment_orders(order_id),
        ledger_entry_id TEXT REFERENCES ledger_entries(ledger_entry_id),
        reverses_operation_id TEXT UNIQUE REFERENCES financial_operations(financial_operation_id),
        reason TEXT CHECK (
          reason IS NULL OR
          (length(reason) BETWEEN 1 AND 512 AND instr(reason, char(0)) = 0)
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        CHECK (
          (actor_type = 'SYSTEM' AND actor_id IS NULL) OR
          (actor_type = 'ADMIN' AND actor_id IS NOT NULL)
        ),
        CHECK (
          (operation_type = 'REVERSE_SETTLEMENT' AND reverses_operation_id IS NOT NULL) OR
          (operation_type != 'REVERSE_SETTLEMENT' AND reverses_operation_id IS NULL)
        ),
        CHECK (
          operation_type = 'RECORD_REFUND' OR
          (order_id IS NOT NULL AND ledger_entry_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX financial_operations_order_idx
      ON financial_operations(order_id, created_at, financial_operation_id);

      CREATE INDEX financial_operations_entry_idx
      ON financial_operations(ledger_entry_id, created_at, financial_operation_id);

      CREATE INDEX ledger_entries_reconciliation_idx
      ON ledger_entries(state, occurred_at, ledger_entry_id);

      CREATE TRIGGER financial_operations_valid_insert
      BEFORE INSERT ON financial_operations
      WHEN
        (
          NEW.operation_type IN ('AUTO_SETTLEMENT', 'SUPERSEDE_CANDIDATE') AND
          NEW.actor_type != 'SYSTEM'
        ) OR
        (
          NEW.operation_type IN (
            'MANUAL_SETTLEMENT', 'REVERSE_SETTLEMENT', 'RECORD_REFUND'
          ) AND
          NEW.actor_type != 'ADMIN'
        ) OR
        (
          NEW.reverses_operation_id IS NOT NULL AND
          NOT EXISTS (
            SELECT 1
              FROM financial_operations AS original
             WHERE original.financial_operation_id = NEW.reverses_operation_id
               AND original.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')
               AND original.order_id = NEW.order_id
               AND original.ledger_entry_id = NEW.ledger_entry_id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'financial operation actor or reversal is invalid');
      END;

      CREATE TRIGGER financial_operations_no_update
      BEFORE UPDATE ON financial_operations
      BEGIN
        SELECT RAISE(ABORT, 'financial operations are append-only');
      END;

      CREATE TRIGGER financial_operations_no_delete
      BEFORE DELETE ON financial_operations
      BEGIN
        SELECT RAISE(ABORT, 'financial operations are append-only');
      END;

      CREATE TABLE match_candidates (
        candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) = 36),
        ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(ledger_entry_id),
        order_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        slot_id TEXT NOT NULL REFERENCES amount_slots(slot_id),
        evidence_type TEXT NOT NULL CHECK (evidence_type = 'AMOUNT_INFERRED'),
        rule_version INTEGER NOT NULL CHECK (rule_version = 3),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND
          json_type(evidence_json) = 'object' AND
          length(CAST(evidence_json AS BLOB)) <= 8192
        ),
        candidate_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(candidate_fingerprint) = 64 AND
          candidate_fingerprint = lower(candidate_fingerprint) AND
          candidate_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        status TEXT NOT NULL CHECK (
          status IN ('ELIGIBLE', 'SELECTED', 'SUPERSEDED')
        ),
        decided_by_operation_id TEXT UNIQUE REFERENCES financial_operations(financial_operation_id),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
        UNIQUE (ledger_entry_id, order_id, slot_id, evidence_type, rule_version),
        CHECK (
          (status = 'ELIGIBLE' AND decided_by_operation_id IS NULL AND decided_at IS NULL) OR
          (status IN ('SELECTED', 'SUPERSEDED') AND decided_by_operation_id IS NOT NULL AND decided_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX match_candidates_entry_status_idx
      ON match_candidates(ledger_entry_id, status, created_at, candidate_id);

      CREATE INDEX match_candidates_order_status_idx
      ON match_candidates(order_id, status, created_at, candidate_id);

      CREATE TRIGGER match_candidates_valid_insert
      BEFORE INSERT ON match_candidates
      WHEN NOT EXISTS (
        SELECT 1
          FROM ledger_entries AS entry
          JOIN payment_orders AS orders
            ON orders.order_id = NEW.order_id
          JOIN collection_profiles AS profile
            ON profile.profile_id = orders.collection_profile_id
          JOIN amount_slots AS slot
            ON slot.slot_id = NEW.slot_id
         WHERE entry.ledger_entry_id = NEW.ledger_entry_id
           AND entry.provider_account_key = profile.provider_account_key
           AND entry.direction = 'CREDIT'
           AND entry.currency = orders.currency
           AND entry.amount_cents = orders.payable_amount_cents
           AND entry.occurred_at + entry.occurred_at_precision_ms > orders.eligible_from
           AND entry.occurred_at + entry.occurred_at_precision_ms > slot.occupied_from
           AND entry.occurred_at < orders.expires_at
           AND (slot.released_at IS NULL OR entry.occurred_at < slot.released_at)
           AND entry.state IN ('UNALLOCATED', 'CANDIDATE')
           AND orders.payment_status = 'UNPAID'
           AND slot.order_id = orders.order_id
           AND slot.collection_profile_id = orders.collection_profile_id
           AND slot.payable_amount_cents = orders.payable_amount_cents
      )
      BEGIN
        SELECT RAISE(ABORT, 'match candidate is not supported by current facts');
      END;

      CREATE TRIGGER match_candidates_evidence_immutable
      BEFORE UPDATE OF
        candidate_id, ledger_entry_id, order_id, slot_id, evidence_type,
        rule_version, evidence_json, candidate_fingerprint, created_at
      ON match_candidates
      BEGIN
        SELECT RAISE(ABORT, 'match candidate evidence is immutable');
      END;

      CREATE TRIGGER match_candidates_status_transition
      BEFORE UPDATE ON match_candidates
      WHEN NOT (
        OLD.status = 'ELIGIBLE' AND NEW.status IN ('SELECTED', 'SUPERSEDED')
      )
      BEGIN
        SELECT RAISE(ABORT, 'match candidate transition is invalid');
      END;

      CREATE TRIGGER match_candidates_decision_operation
      BEFORE UPDATE OF status, decided_by_operation_id, decided_at ON match_candidates
      WHEN
        NEW.status IN ('SELECTED', 'SUPERSEDED') AND
        NOT EXISTS (
          SELECT 1
            FROM financial_operations AS operation
           WHERE operation.financial_operation_id = NEW.decided_by_operation_id
             AND operation.order_id = NEW.order_id
             AND operation.ledger_entry_id = NEW.ledger_entry_id
             AND (
               (NEW.status = 'SELECTED' AND operation.operation_type = 'AUTO_SETTLEMENT') OR
               (NEW.status = 'SUPERSEDED' AND operation.operation_type = 'SUPERSEDE_CANDIDATE')
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'match candidate decision operation is invalid');
      END;

      CREATE TRIGGER match_candidates_updated_at_monotonic
      BEFORE UPDATE ON match_candidates
      WHEN NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'match candidate updated_at cannot move backwards');
      END;

      CREATE TRIGGER match_candidates_no_delete
      BEFORE DELETE ON match_candidates
      BEGIN
        SELECT RAISE(ABORT, 'match candidates cannot be deleted');
      END;

      CREATE TABLE payment_matches (
        payment_match_id TEXT PRIMARY KEY CHECK (length(payment_match_id) = 36),
        ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(ledger_entry_id),
        order_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        candidate_id TEXT UNIQUE REFERENCES match_candidates(candidate_id),
        match_role TEXT NOT NULL CHECK (match_role = 'PRIMARY_SETTLEMENT'),
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('AMOUNT_INFERRED', 'MANUAL')),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND
          json_type(evidence_json) = 'object' AND
          length(CAST(evidence_json AS BLOB)) <= 8192
        ),
        status TEXT NOT NULL CHECK (status IN ('SETTLED', 'REVERSED')),
        created_by_operation_id TEXT NOT NULL UNIQUE REFERENCES financial_operations(financial_operation_id),
        resolved_by_operation_id TEXT UNIQUE REFERENCES financial_operations(financial_operation_id),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= created_at),
        CHECK (
          status IN ('SETTLED', 'REVERSED') AND
          resolved_by_operation_id IS NOT NULL AND resolved_at IS NOT NULL
        )
      ) STRICT;

      CREATE UNIQUE INDEX payment_matches_one_active_entry
      ON payment_matches(ledger_entry_id)
      WHERE status = 'SETTLED';

      CREATE UNIQUE INDEX payment_matches_one_active_primary_order
      ON payment_matches(order_id)
      WHERE match_role = 'PRIMARY_SETTLEMENT' AND status = 'SETTLED';

      CREATE INDEX payment_matches_order_history_idx
      ON payment_matches(order_id, created_at, payment_match_id);

      CREATE TRIGGER payment_matches_valid_insert
      BEFORE INSERT ON payment_matches
      WHEN NOT EXISTS (
        SELECT 1
          FROM financial_operations AS operation
          JOIN ledger_entries AS entry
            ON entry.ledger_entry_id = NEW.ledger_entry_id
          JOIN payment_orders AS orders
            ON orders.order_id = NEW.order_id
         WHERE operation.financial_operation_id = NEW.created_by_operation_id
           AND NEW.resolved_by_operation_id = NEW.created_by_operation_id
           AND NEW.resolved_at = NEW.created_at
           AND operation.order_id = NEW.order_id
           AND operation.ledger_entry_id = NEW.ledger_entry_id
           AND entry.currency = orders.currency
           AND (
             (
               NEW.status = 'SETTLED' AND
               entry.state IN ('UNALLOCATED', 'CANDIDATE') AND
               entry.direction = 'CREDIT' AND
               orders.payment_status = 'UNPAID' AND
               orders.payment_basis = 'NONE' AND
               orders.received_amount_cents IS NULL AND
               NOT EXISTS (
                 SELECT 1
                   FROM ledger_conflicts AS conflict
                  WHERE conflict.existing_ledger_entry_id = NEW.ledger_entry_id
                    AND conflict.status = 'OPEN'
               ) AND
               (
                 SELECT COUNT(*)
                   FROM match_candidates AS active_candidate
                  WHERE active_candidate.ledger_entry_id = NEW.ledger_entry_id
                    AND active_candidate.status IN ('ELIGIBLE', 'SELECTED')
               ) = 1 AND
               entry.amount_cents = orders.payable_amount_cents AND
               operation.operation_type = 'AUTO_SETTLEMENT' AND
               NEW.evidence_type = 'AMOUNT_INFERRED' AND
               NEW.candidate_id IS NOT NULL AND
               EXISTS (
                 SELECT 1
                   FROM match_candidates AS candidate
                  WHERE candidate.candidate_id = NEW.candidate_id
                    AND candidate.ledger_entry_id = NEW.ledger_entry_id
                    AND candidate.order_id = NEW.order_id
                    AND candidate.status = 'SELECTED'
                    AND candidate.decided_by_operation_id = NEW.created_by_operation_id
                    AND candidate.evidence_type = NEW.evidence_type
                    AND candidate.evidence_json = NEW.evidence_json
                )
              ) OR
              (
                NEW.status = 'SETTLED' AND
                entry.state IN ('UNALLOCATED', 'CANDIDATE', 'CONFLICT') AND
                operation.operation_type = 'MANUAL_SETTLEMENT' AND
                NEW.evidence_type = 'MANUAL' AND
                NEW.candidate_id IS NULL
              )
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'payment match is not supported by its operation and facts');
      END;

      CREATE TRIGGER payment_matches_facts_immutable
      BEFORE UPDATE OF
        payment_match_id, ledger_entry_id, order_id, candidate_id, match_role,
        evidence_type, evidence_json, created_by_operation_id, created_at
      ON payment_matches
      BEGIN
        SELECT RAISE(ABORT, 'payment match facts are immutable');
      END;

      CREATE TRIGGER payment_matches_status_transition
      BEFORE UPDATE ON payment_matches
      WHEN NOT (
        OLD.status = 'SETTLED' AND NEW.status = 'REVERSED'
      )
      BEGIN
        SELECT RAISE(ABORT, 'payment match transition is invalid');
      END;

      CREATE TRIGGER payment_matches_resolution_operation
      BEFORE UPDATE ON payment_matches
      WHEN NOT EXISTS (
        SELECT 1
          FROM financial_operations AS operation
         WHERE operation.financial_operation_id = NEW.resolved_by_operation_id
           AND operation.order_id = NEW.order_id
           AND operation.ledger_entry_id = NEW.ledger_entry_id
           AND NEW.status = 'REVERSED'
           AND operation.operation_type = 'REVERSE_SETTLEMENT'
      )
      BEGIN
        SELECT RAISE(ABORT, 'payment match resolution operation is invalid');
      END;

      CREATE TRIGGER payment_matches_updated_at_monotonic
      BEFORE UPDATE ON payment_matches
      WHEN NEW.updated_at < OLD.updated_at
      BEGIN
        SELECT RAISE(ABORT, 'payment match updated_at cannot move backwards');
      END;

      CREATE TRIGGER payment_matches_no_delete
      BEFORE DELETE ON payment_matches
      BEGIN
        SELECT RAISE(ABORT, 'payment matches cannot be deleted');
      END;

      CREATE TRIGGER ledger_entries_state_transition
      BEFORE UPDATE OF state ON ledger_entries
      WHEN NOT (
        (OLD.state = 'UNALLOCATED' AND NEW.state IN ('CANDIDATE', 'ALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'CANDIDATE' AND NEW.state IN ('UNALLOCATED', 'ALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'ALLOCATED' AND NEW.state IN ('UNALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'CONFLICT' AND NEW.state IN ('ALLOCATED', 'IGNORED'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'ledger entry state transition is invalid');
      END;

      CREATE TABLE ledger_transactions (
        ledger_transaction_id TEXT PRIMARY KEY CHECK (length(ledger_transaction_id) = 36),
        financial_operation_id TEXT NOT NULL UNIQUE REFERENCES financial_operations(financial_operation_id),
        order_id TEXT REFERENCES payment_orders(order_id),
        ledger_entry_id TEXT REFERENCES ledger_entries(ledger_entry_id),
        transaction_type TEXT NOT NULL CHECK (
          transaction_type IN ('SETTLEMENT', 'REVERSAL', 'REFUND')
        ),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'POSTED')),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        posted_at INTEGER CHECK (posted_at IS NULL OR posted_at >= created_at),
        CHECK (
          (status = 'DRAFT' AND posted_at IS NULL) OR
          (status = 'POSTED' AND posted_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX ledger_transactions_order_idx
      ON ledger_transactions(order_id, created_at, ledger_transaction_id);

      CREATE TRIGGER ledger_transactions_draft_insert
      BEFORE INSERT ON ledger_transactions
      WHEN
        NEW.status != 'DRAFT' OR
        NEW.posted_at IS NOT NULL OR
        NOT EXISTS (
          SELECT 1
            FROM financial_operations AS operation
           WHERE operation.financial_operation_id = NEW.financial_operation_id
             AND operation.order_id IS NEW.order_id
             AND operation.ledger_entry_id IS NEW.ledger_entry_id
             AND (
               (NEW.transaction_type = 'SETTLEMENT' AND operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')) OR
               (NEW.transaction_type = 'REVERSAL' AND operation.operation_type = 'REVERSE_SETTLEMENT') OR
               (NEW.transaction_type = 'REFUND' AND operation.operation_type = 'RECORD_REFUND')
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'ledger transaction must begin as a valid draft');
      END;

      CREATE TRIGGER ledger_transactions_post_balanced
      BEFORE UPDATE OF status, posted_at ON ledger_transactions
      WHEN
        OLD.status != 'DRAFT' OR
        NEW.status != 'POSTED' OR
        NEW.posted_at IS NULL OR
        NEW.posted_at < NEW.created_at OR
        (
          SELECT COUNT(*) FROM ledger_postings AS posting
           WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
        ) < 2 OR
        COALESCE((
          SELECT SUM(posting.amount_cents)
            FROM ledger_postings AS posting
           WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
             AND posting.side = 'DEBIT'
        ), 0) != COALESCE((
          SELECT SUM(posting.amount_cents)
            FROM ledger_postings AS posting
           WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
             AND posting.side = 'CREDIT'
        ), 0) OR
        (
          NEW.transaction_type IN ('SETTLEMENT', 'REVERSAL', 'REFUND') AND
          (
            (SELECT COUNT(*) FROM ledger_postings AS posting
              WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id) != 2 OR
            NOT EXISTS (
              SELECT 1
                FROM ledger_entries AS entry
               WHERE entry.ledger_entry_id = NEW.ledger_entry_id
                 AND (
                   (
                     NEW.transaction_type = 'SETTLEMENT' AND
                     entry.direction = 'CREDIT' AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'PROVIDER_CASH'
                          AND posting.side = 'DEBIT'
                          AND posting.amount_cents = entry.amount_cents
                     ) AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'ORDER_SETTLEMENT'
                          AND posting.side = 'CREDIT'
                          AND posting.amount_cents = entry.amount_cents
                     )
                   ) OR
                   (
                     NEW.transaction_type = 'REVERSAL' AND
                     entry.direction = 'CREDIT' AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'ORDER_SETTLEMENT'
                          AND posting.side = 'DEBIT'
                          AND posting.amount_cents = entry.amount_cents
                     ) AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'PROVIDER_CASH'
                          AND posting.side = 'CREDIT'
                          AND posting.amount_cents = entry.amount_cents
                     )
                   ) OR
                   (
                     NEW.transaction_type = 'REFUND' AND
                     entry.direction = 'DEBIT' AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'REFUND_CLEARING'
                          AND posting.side = 'DEBIT'
                          AND posting.amount_cents = entry.amount_cents
                     ) AND
                     EXISTS (
                       SELECT 1 FROM ledger_postings AS posting
                        WHERE posting.ledger_transaction_id = NEW.ledger_transaction_id
                          AND posting.account_code = 'PROVIDER_CASH'
                          AND posting.side = 'CREDIT'
                          AND posting.amount_cents = entry.amount_cents
                     )
                   )
                 )
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'ledger transaction must be balanced before posting');
      END;

      CREATE TRIGGER ledger_transactions_facts_immutable
      BEFORE UPDATE OF
        ledger_transaction_id, financial_operation_id, order_id, ledger_entry_id,
        transaction_type, currency, created_at
      ON ledger_transactions
      BEGIN
        SELECT RAISE(ABORT, 'ledger transaction facts are immutable');
      END;

      CREATE TRIGGER ledger_transactions_no_delete
      BEFORE DELETE ON ledger_transactions
      BEGIN
        SELECT RAISE(ABORT, 'ledger transactions cannot be deleted');
      END;

      CREATE TABLE ledger_postings (
        posting_id TEXT PRIMARY KEY CHECK (length(posting_id) = 36),
        ledger_transaction_id TEXT NOT NULL REFERENCES ledger_transactions(ledger_transaction_id),
        account_code TEXT NOT NULL CHECK (
          account_code IN ('PROVIDER_CASH', 'ORDER_SETTLEMENT', 'REFUND_CLEARING')
        ),
        side TEXT NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        order_id TEXT REFERENCES payment_orders(order_id),
        ledger_entry_id TEXT REFERENCES ledger_entries(ledger_entry_id),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        UNIQUE (ledger_transaction_id, account_code, side)
      ) STRICT;

      CREATE INDEX ledger_postings_order_idx
      ON ledger_postings(order_id, created_at, posting_id);

      CREATE TRIGGER ledger_postings_draft_only
      BEFORE INSERT ON ledger_postings
      WHEN NOT EXISTS (
        SELECT 1
          FROM ledger_transactions AS transaction_record
         WHERE transaction_record.ledger_transaction_id = NEW.ledger_transaction_id
           AND transaction_record.status = 'DRAFT'
           AND transaction_record.currency = NEW.currency
           AND transaction_record.order_id IS NEW.order_id
           AND transaction_record.ledger_entry_id IS NEW.ledger_entry_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'postings can only be appended to their draft transaction');
      END;

      CREATE TRIGGER ledger_postings_no_update
      BEFORE UPDATE ON ledger_postings
      BEGIN
        SELECT RAISE(ABORT, 'ledger postings are append-only');
      END;

      CREATE TRIGGER ledger_postings_no_delete
      BEFORE DELETE ON ledger_postings
      BEGIN
        SELECT RAISE(ABORT, 'ledger postings are append-only');
      END;

      CREATE TABLE refund_records (
        refund_record_id TEXT PRIMARY KEY CHECK (length(refund_record_id) = 36),
        financial_operation_id TEXT NOT NULL UNIQUE REFERENCES financial_operations(financial_operation_id),
        ledger_entry_id TEXT NOT NULL UNIQUE REFERENCES ledger_entries(ledger_entry_id),
        order_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9999999999),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND
          json_type(evidence_json) = 'object' AND
          length(CAST(evidence_json AS BLOB)) <= 8192
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0)
      ) STRICT;

      CREATE INDEX refund_records_order_idx
      ON refund_records(order_id, created_at, refund_record_id);

      CREATE TRIGGER refund_records_valid_insert
      BEFORE INSERT ON refund_records
      WHEN NOT EXISTS (
        SELECT 1
          FROM financial_operations AS operation
          JOIN ledger_entries AS entry
            ON entry.ledger_entry_id = NEW.ledger_entry_id
          JOIN payment_orders AS orders
            ON orders.order_id = NEW.order_id
         WHERE operation.financial_operation_id = NEW.financial_operation_id
           AND operation.operation_type = 'RECORD_REFUND'
           AND operation.actor_type = 'ADMIN'
           AND operation.order_id = NEW.order_id
           AND operation.ledger_entry_id = NEW.ledger_entry_id
           AND entry.direction = 'DEBIT'
           AND entry.currency = orders.currency
           AND entry.amount_cents = NEW.amount_cents
           AND entry.state IN ('UNALLOCATED', 'CONFLICT')
           AND orders.payment_status IN ('CONFIRMED', 'DISPUTED')
           AND orders.refund_status != 'FULL'
      )
      BEGIN
        SELECT RAISE(ABORT, 'refund record is not supported by its operation and facts');
      END;

      CREATE TRIGGER refund_records_no_update
      BEFORE UPDATE ON refund_records
      BEGIN
        SELECT RAISE(ABORT, 'refund records are append-only');
      END;

      CREATE TRIGGER refund_records_no_delete
      BEFORE DELETE ON refund_records
      BEGIN
        SELECT RAISE(ABORT, 'refund records are append-only');
      END;

      CREATE TABLE financial_exceptions (
        exception_id TEXT PRIMARY KEY CHECK (length(exception_id) = 36),
        provider_account_key TEXT NOT NULL CHECK (length(provider_account_key) BETWEEN 1 AND 128),
        exception_type TEXT NOT NULL CHECK (
          exception_type IN (
            'UNMATCHED_CREDIT', 'UNMATCHED_DEBIT', 'AMBIGUOUS_MATCH',
            'CHECKOUT_ENDED_PAYMENT', 'DUPLICATE_PAYMENT', 'AMOUNT_MISMATCH',
            'UNLINKED_REFUND', 'RECONCILIATION_CONFLICT'
          )
        ),
        ledger_entry_id TEXT REFERENCES ledger_entries(ledger_entry_id),
        order_id TEXT REFERENCES payment_orders(order_id),
        candidate_id TEXT REFERENCES match_candidates(candidate_id),
        context_key TEXT NOT NULL CHECK (
          length(context_key) BETWEEN 1 AND 128 AND instr(context_key, char(0)) = 0
        ),
        details_json TEXT NOT NULL CHECK (
          json_valid(details_json) AND
          json_type(details_json) = 'object' AND
          length(CAST(details_json AS BLOB)) <= 8192
        ),
        exception_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(exception_fingerprint) = 64 AND
          exception_fingerprint = lower(exception_fingerprint) AND
          exception_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
        resolution_operation_id TEXT REFERENCES financial_operations(financial_operation_id),
        resolution_json TEXT CHECK (
          resolution_json IS NULL OR
          (json_valid(resolution_json) AND json_type(resolution_json) = 'object' AND length(CAST(resolution_json AS BLOB)) <= 8192)
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= created_at),
        CHECK (
          (status = 'OPEN' AND resolution_operation_id IS NULL AND resolution_json IS NULL AND resolved_at IS NULL) OR
          (status = 'RESOLVED' AND resolution_operation_id IS NOT NULL AND resolution_json IS NOT NULL AND resolved_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX financial_exceptions_open_idx
      ON financial_exceptions(provider_account_key, status, created_at, exception_id);

      CREATE INDEX financial_exceptions_entry_idx
      ON financial_exceptions(ledger_entry_id, created_at, exception_id);

      CREATE TRIGGER financial_exceptions_valid_insert
      BEFORE INSERT ON financial_exceptions
      WHEN
        (NEW.ledger_entry_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM ledger_entries AS entry
           WHERE entry.ledger_entry_id = NEW.ledger_entry_id
             AND entry.provider_account_key = NEW.provider_account_key
        )) OR
        (NEW.candidate_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM match_candidates AS candidate
           WHERE candidate.candidate_id = NEW.candidate_id
             AND candidate.ledger_entry_id IS NEW.ledger_entry_id
             AND candidate.order_id IS NEW.order_id
        ))
      BEGIN
        SELECT RAISE(ABORT, 'financial exception references inconsistent facts');
      END;

      CREATE TRIGGER financial_exceptions_evidence_immutable
      BEFORE UPDATE OF
        exception_id, provider_account_key, exception_type, ledger_entry_id,
        order_id, candidate_id, context_key, details_json, exception_fingerprint, created_at
      ON financial_exceptions
      BEGIN
        SELECT RAISE(ABORT, 'financial exception evidence is immutable');
      END;

      CREATE TRIGGER financial_exceptions_resolution_once
      BEFORE UPDATE ON financial_exceptions
      WHEN
        OLD.status != 'OPEN' OR
        NEW.status != 'RESOLVED' OR
        NEW.resolution_operation_id IS NULL OR
        NEW.resolution_json IS NULL OR
        NEW.resolved_at IS NULL OR
        NOT EXISTS (
          SELECT 1
            FROM financial_operations AS operation
           WHERE operation.financial_operation_id = NEW.resolution_operation_id
             AND operation.ledger_entry_id IS NEW.ledger_entry_id
             AND (NEW.order_id IS NULL OR operation.order_id IS NEW.order_id)
             AND operation.created_at = NEW.resolved_at
             AND operation.operation_type IN (
               'AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT', 'RECORD_REFUND'
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'financial exception resolution is invalid');
      END;

      CREATE TRIGGER financial_exceptions_no_delete
      BEFORE DELETE ON financial_exceptions
      BEGIN
        SELECT RAISE(ABORT, 'financial exceptions cannot be deleted');
      END;

      CREATE TABLE outbox_events (
        outbox_event_id TEXT PRIMARY KEY CHECK (length(outbox_event_id) = 36),
        financial_operation_id TEXT NOT NULL UNIQUE REFERENCES financial_operations(financial_operation_id),
        aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'PAYMENT_ORDER'),
        aggregate_id TEXT NOT NULL REFERENCES payment_orders(order_id),
        aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
        event_type TEXT NOT NULL CHECK (
          event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_DISPUTED', 'REFUND_UPDATED')
        ),
        payload_json TEXT NOT NULL CHECK (
          json_valid(payload_json) AND
          json_type(payload_json) = 'object' AND
          length(CAST(payload_json AS BLOB)) <= 65536
        ),
        payload_fingerprint TEXT NOT NULL CHECK (
          length(payload_fingerprint) = 64 AND
          payload_fingerprint = lower(payload_fingerprint) AND
          payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        UNIQUE (aggregate_id, aggregate_version, event_type)
      ) STRICT;

      CREATE INDEX outbox_events_created_idx
      ON outbox_events(created_at, outbox_event_id);

      CREATE TRIGGER outbox_events_valid_insert
      BEFORE INSERT ON outbox_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM payment_orders AS orders
          JOIN financial_operations AS operation
            ON operation.financial_operation_id = NEW.financial_operation_id
         WHERE orders.order_id = NEW.aggregate_id
           AND orders.version = NEW.aggregate_version
           AND orders.updated_at = NEW.created_at
           AND operation.order_id = NEW.aggregate_id
           AND (
             (NEW.event_type = 'PAYMENT_CONFIRMED' AND orders.payment_status = 'CONFIRMED' AND operation.operation_type IN ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')) OR
             (NEW.event_type = 'PAYMENT_DISPUTED' AND orders.payment_status = 'DISPUTED' AND operation.operation_type = 'REVERSE_SETTLEMENT') OR
             (NEW.event_type = 'REFUND_UPDATED' AND orders.refund_status IN ('PARTIAL', 'FULL') AND operation.operation_type = 'RECORD_REFUND')
           )
      )
      BEGIN
        SELECT RAISE(ABORT, 'outbox event must match the committed order operation');
      END;

      CREATE TRIGGER outbox_events_no_update
      BEFORE UPDATE ON outbox_events
      BEGIN
        SELECT RAISE(ABORT, 'outbox events are append-only');
      END;

      CREATE TRIGGER outbox_events_no_delete
      BEFORE DELETE ON outbox_events
      BEGIN
        SELECT RAISE(ABORT, 'outbox events are append-only');
      END;
    `,
  },
  {
    version: 6,
    name: "reliable_webhook_delivery_schema",
    sql: `
      ALTER TABLE payment_orders
      ADD COLUMN webhook_target_request_fingerprint TEXT CHECK (
        webhook_target_request_fingerprint IS NULL OR (
          length(webhook_target_request_fingerprint) = 64 AND
          webhook_target_request_fingerprint = lower(webhook_target_request_fingerprint) AND
          webhook_target_request_fingerprint NOT GLOB '*[^0-9a-f]*'
        )
      );

      CREATE TRIGGER payment_orders_webhook_target_commitment_immutable
      BEFORE UPDATE OF webhook_target_request_fingerprint ON payment_orders
      BEGIN
        SELECT RAISE(ABORT, 'order webhook target commitment is immutable');
      END;

      CREATE TABLE webhook_targets (
        target_id TEXT PRIMARY KEY CHECK (length(target_id) = 36),
        order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
        api_client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        target_format TEXT NOT NULL CHECK (target_format = 'NATIVE_JSON_V1'),
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

      CREATE TABLE webhook_signing_keys (
        key_version INTEGER PRIMARY KEY CHECK (key_version >= 1),
        key_id TEXT NOT NULL UNIQUE CHECK (length(key_id) = 36),
        secret_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= activated_at)
      ) STRICT;

      CREATE UNIQUE INDEX webhook_signing_keys_one_active
      ON webhook_signing_keys((1)) WHERE retired_at IS NULL;

      CREATE TRIGGER webhook_signing_keys_valid_update
      BEFORE UPDATE ON webhook_signing_keys
      WHEN
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

      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY CHECK (length(delivery_id) = 36),
        outbox_event_id TEXT NOT NULL REFERENCES outbox_events(outbox_event_id),
        target_id TEXT NOT NULL REFERENCES webhook_targets(target_id),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        predecessor_delivery_id TEXT REFERENCES webhook_deliveries(delivery_id),
        request_key TEXT NOT NULL UNIQUE CHECK (length(request_key) = 36),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_fingerprint_version INTEGER NOT NULL CHECK (request_fingerprint_version = 1),
        requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('SYSTEM', 'ADMIN')),
        requested_by_actor_id TEXT CHECK (
          requested_by_actor_id IS NULL OR
          length(requested_by_actor_id) BETWEEN 1 AND 128
        ),
        reason TEXT CHECK (
          reason IS NULL OR
          (length(reason) BETWEEN 1 AND 500 AND reason = trim(reason))
        ),
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'LEASED', 'RETRY_WAIT', 'ACKNOWLEDGED', 'DEAD_LETTER')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
        lease_token TEXT UNIQUE CHECK (lease_token IS NULL OR length(lease_token) = 36),
        lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
        acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0),
        dead_lettered_at INTEGER CHECK (dead_lettered_at IS NULL OR dead_lettered_at >= 0),
        last_error_code TEXT CHECK (
          last_error_code IS NULL OR
          (length(last_error_code) BETWEEN 1 AND 100 AND
           last_error_code GLOB '[a-z]*' AND
           last_error_code NOT GLOB '*[^a-z0-9_]*')
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE (outbox_event_id, target_id, generation),
        CHECK (
          (requested_by_type = 'SYSTEM' AND generation = 1 AND
           predecessor_delivery_id IS NULL AND requested_by_actor_id IS NULL AND reason IS NULL) OR
          (requested_by_type = 'ADMIN' AND generation > 1 AND
           predecessor_delivery_id IS NOT NULL AND requested_by_actor_id IS NOT NULL AND reason IS NOT NULL)
        ),
        CHECK (
          (status IN ('PENDING', 'RETRY_WAIT') AND lease_token IS NULL AND
           lease_expires_at IS NULL AND acknowledged_at IS NULL AND dead_lettered_at IS NULL) OR
          (status = 'LEASED' AND attempt_count >= 1 AND lease_token IS NOT NULL AND
           lease_expires_at IS NOT NULL AND acknowledged_at IS NULL AND dead_lettered_at IS NULL) OR
          (status = 'ACKNOWLEDGED' AND attempt_count >= 1 AND lease_token IS NULL AND
           lease_expires_at IS NULL AND acknowledged_at IS NOT NULL AND dead_lettered_at IS NULL AND
           last_error_code IS NULL) OR
          (status = 'DEAD_LETTER' AND attempt_count >= 1 AND lease_token IS NULL AND
           lease_expires_at IS NULL AND acknowledged_at IS NULL AND dead_lettered_at IS NOT NULL AND
           last_error_code IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX webhook_deliveries_due_idx
      ON webhook_deliveries(status, next_attempt_at, created_at, delivery_id);

      CREATE INDEX webhook_deliveries_event_idx
      ON webhook_deliveries(outbox_event_id, generation DESC);

      CREATE UNIQUE INDEX webhook_deliveries_one_active
      ON webhook_deliveries(outbox_event_id, target_id)
      WHERE status IN ('PENDING', 'LEASED', 'RETRY_WAIT');

      CREATE TRIGGER webhook_deliveries_valid_insert
      BEFORE INSERT ON webhook_deliveries
      WHEN
        NOT EXISTS (
          SELECT 1
            FROM outbox_events AS outbox
            JOIN webhook_targets AS target
              ON target.target_id = NEW.target_id
           WHERE outbox.outbox_event_id = NEW.outbox_event_id
             AND outbox.aggregate_id = target.order_id
        ) OR
        (NEW.generation = 1 AND (
          NEW.requested_by_type != 'SYSTEM' OR
          NEW.request_key != NEW.outbox_event_id OR
          EXISTS (
            SELECT 1 FROM webhook_deliveries AS existing
             WHERE existing.outbox_event_id = NEW.outbox_event_id
               AND existing.target_id = NEW.target_id
          )
        )) OR
        (NEW.generation > 1 AND NOT EXISTS (
          SELECT 1
            FROM webhook_deliveries AS predecessor
           WHERE predecessor.delivery_id = NEW.predecessor_delivery_id
             AND predecessor.outbox_event_id = NEW.outbox_event_id
             AND predecessor.target_id = NEW.target_id
             AND predecessor.generation = NEW.generation - 1
             AND predecessor.status IN ('ACKNOWLEDGED', 'DEAD_LETTER')
        ))
      BEGIN
        SELECT RAISE(ABORT, 'webhook delivery request is inconsistent');
      END;

      CREATE TRIGGER webhook_deliveries_valid_update
      BEFORE UPDATE ON webhook_deliveries
      WHEN
        NEW.delivery_id != OLD.delivery_id OR
        NEW.outbox_event_id != OLD.outbox_event_id OR
        NEW.target_id != OLD.target_id OR
        NEW.generation != OLD.generation OR
        NEW.predecessor_delivery_id IS NOT OLD.predecessor_delivery_id OR
        NEW.request_key != OLD.request_key OR
        NEW.request_fingerprint != OLD.request_fingerprint OR
        NEW.request_fingerprint_version != OLD.request_fingerprint_version OR
        NEW.requested_by_type != OLD.requested_by_type OR
        NEW.requested_by_actor_id IS NOT OLD.requested_by_actor_id OR
        NEW.reason IS NOT OLD.reason OR
        NEW.created_at != OLD.created_at OR
        NEW.updated_at < OLD.updated_at OR
        NOT (
          (OLD.status IN ('PENDING', 'RETRY_WAIT') AND NEW.status = 'LEASED' AND
           NEW.attempt_count = OLD.attempt_count + 1) OR
          (OLD.status IN ('PENDING', 'RETRY_WAIT') AND NEW.status = 'DEAD_LETTER' AND
           NEW.attempt_count = OLD.attempt_count AND OLD.attempt_count >= 1) OR
          (OLD.status = 'LEASED' AND NEW.status IN ('RETRY_WAIT', 'ACKNOWLEDGED', 'DEAD_LETTER') AND
           NEW.attempt_count = OLD.attempt_count)
        )
      BEGIN
        SELECT RAISE(ABORT, 'webhook delivery transition is invalid');
      END;

      CREATE TRIGGER webhook_deliveries_no_delete
      BEFORE DELETE ON webhook_deliveries
      BEGIN
        SELECT RAISE(ABORT, 'webhook deliveries cannot be deleted');
      END;

      CREATE TABLE webhook_attempts (
        attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
        delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        lease_token TEXT NOT NULL UNIQUE CHECK (length(lease_token) = 36),
        key_version INTEGER NOT NULL REFERENCES webhook_signing_keys(key_version),
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
        CHECK (
          (outcome = 'STARTED' AND resolved_addresses_fingerprint IS NULL AND
           connected_address IS NULL AND http_status IS NULL AND response_bytes IS NULL AND
           response_fingerprint IS NULL AND ack_code IS NULL AND error_code IS NULL AND
           finished_at IS NULL) OR
          (outcome = 'ACKNOWLEDGED' AND http_status = 200 AND response_bytes IS NOT NULL AND
           response_fingerprint IS NOT NULL AND ack_code = 'acknowledged' AND
           error_code IS NULL AND finished_at IS NOT NULL) OR
          (outcome IN ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'OUTCOME_UNKNOWN') AND
           error_code IS NOT NULL AND finished_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX webhook_attempts_delivery_idx
      ON webhook_attempts(delivery_id, attempt_number DESC);

      CREATE TRIGGER webhook_attempts_valid_insert
      BEFORE INSERT ON webhook_attempts
      WHEN NOT EXISTS (
        SELECT 1
          FROM webhook_deliveries AS delivery
          JOIN webhook_signing_keys AS signing_key
            ON signing_key.key_version = NEW.key_version
         WHERE delivery.delivery_id = NEW.delivery_id
           AND delivery.status = 'LEASED'
           AND delivery.attempt_count = NEW.attempt_number
           AND delivery.lease_token = NEW.lease_token
           AND signing_key.retired_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'webhook attempt must match an active lease and signing key');
      END;

      CREATE TRIGGER webhook_attempts_valid_update
      BEFORE UPDATE ON webhook_attempts
      WHEN
        NEW.attempt_id != OLD.attempt_id OR
        NEW.delivery_id != OLD.delivery_id OR
        NEW.attempt_number != OLD.attempt_number OR
        NEW.lease_token != OLD.lease_token OR
        NEW.key_version != OLD.key_version OR
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
    `,
  },
  {
    version: 7,
    name: "ledger_page_stability",
    sql: `
      ALTER TABLE ingest_run_page_observations
        ADD COLUMN disposition TEXT
          CHECK (disposition IN ('PROCESSED', 'REJECTED_VARIANT'));

      ALTER TABLE ingest_run_page_observations
        ADD COLUMN observation_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (observation_sequence >= 0);

      /*
       * v6 accepted page changes immediately. Preserve that immutable history
       * as a migration boundary; every observation written by v7 must obey
       * the consecutive-response state machine below.
       */
      ALTER TABLE ingest_run_page_observations
        ADD COLUMN transition_enforced INTEGER NOT NULL DEFAULT 1
          CHECK (transition_enforced IN (0, 1));

      DROP TRIGGER ingest_run_page_observations_no_update;

      CREATE TEMP TABLE migration_v7_observation_sequences (
        observation_rowid INTEGER PRIMARY KEY,
        observation_sequence INTEGER NOT NULL UNIQUE CHECK (observation_sequence >= 1)
      ) STRICT;

      INSERT INTO migration_v7_observation_sequences(observation_rowid, observation_sequence)
      SELECT rowid, ROW_NUMBER() OVER (ORDER BY rowid)
        FROM ingest_run_page_observations;

      UPDATE ingest_run_page_observations AS observation
         SET disposition = 'PROCESSED',
             transition_enforced = 0,
             observation_sequence = (
               SELECT sequence.observation_sequence
                 FROM migration_v7_observation_sequences AS sequence
                WHERE sequence.observation_rowid = observation.rowid
             );

      DROP TABLE migration_v7_observation_sequences;

      CREATE TRIGGER ingest_run_page_observations_no_update
      BEFORE UPDATE ON ingest_run_page_observations
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observations are immutable');
      END;

      CREATE INDEX ingest_run_page_observations_disposition_idx
      ON ingest_run_page_observations(ingest_run_id, disposition, observation_kind, observed_at);

      CREATE UNIQUE INDEX ingest_run_page_observations_sequence_idx
      ON ingest_run_page_observations(observation_sequence);

      CREATE TRIGGER ingest_run_page_observations_sequence_valid_insert
      BEFORE INSERT ON ingest_run_page_observations
      WHEN
        NEW.disposition IS NULL OR
        NEW.disposition NOT IN ('PROCESSED', 'REJECTED_VARIANT') OR
        NEW.transition_enforced != 1 OR
        NEW.observation_sequence < 1 OR
        NEW.observation_sequence != COALESCE((
          SELECT MAX(observation_sequence) + 1
            FROM ingest_run_page_observations
        ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observation sequence or disposition is invalid');
      END;

      CREATE TRIGGER ingest_run_page_observations_transition_valid_insert
      BEFORE INSERT ON ingest_run_page_observations
      WHEN EXISTS (
        SELECT 1
          FROM provider_raw_pages AS incoming
         WHERE incoming.raw_page_id = NEW.raw_page_id
           AND NEW.disposition != CASE
             WHEN (
               SELECT previous_page.response_fingerprint
                 FROM ingest_run_page_observations AS previous_observation
                 JOIN provider_raw_pages AS previous_page
                   ON previous_page.raw_page_id = previous_observation.raw_page_id
                WHERE previous_page.provider_account_key = incoming.provider_account_key
                  AND previous_page.request_fingerprint = incoming.request_fingerprint
                ORDER BY previous_observation.observation_sequence DESC
                LIMIT 1
             ) IS NULL THEN 'PROCESSED'
             WHEN (
               SELECT previous_page.response_fingerprint
                 FROM ingest_run_page_observations AS previous_observation
                 JOIN provider_raw_pages AS previous_page
                   ON previous_page.raw_page_id = previous_observation.raw_page_id
                WHERE previous_page.provider_account_key = incoming.provider_account_key
                  AND previous_page.request_fingerprint = incoming.request_fingerprint
                ORDER BY previous_observation.observation_sequence DESC
                LIMIT 1
             ) = incoming.response_fingerprint THEN 'PROCESSED'
             ELSE 'REJECTED_VARIANT'
           END
      )
      BEGIN
        SELECT RAISE(ABORT, 'ingest page observation transition is invalid');
      END;

      CREATE TRIGGER ingest_run_page_observations_rejected_variant_valid_insert
      BEFORE INSERT ON ingest_run_page_observations
      WHEN NEW.disposition = 'REJECTED_VARIANT' AND NOT EXISTS (
        SELECT 1
          FROM ingest_runs AS run
          JOIN ingest_segments AS segment
            ON segment.ingest_segment_id = NEW.ingest_segment_id
          JOIN provider_raw_pages AS page
            ON page.raw_page_id = NEW.raw_page_id
          JOIN ledger_conflicts AS conflict
            ON conflict.raw_page_id = page.raw_page_id
         WHERE run.ingest_run_id = NEW.ingest_run_id
           AND segment.ingest_run_id = run.ingest_run_id
           AND run.status = 'RUNNING'
           AND segment.state = 'PENDING'
           AND conflict.provider_account_key = run.provider_account_key
           AND conflict.conflict_type = 'RAW_PAGE_VARIANT'
           AND conflict.incoming_semantic_fingerprint = page.response_fingerprint
           AND conflict.existing_semantic_fingerprint IS NOT page.response_fingerprint
      )
      BEGIN
        SELECT RAISE(ABORT, 'rejected provider variant lacks matching conflict evidence');
      END;

      CREATE TRIGGER provider_raw_events_require_processed_leaf_insert
      BEFORE INSERT ON provider_raw_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM ingest_run_page_observations AS observation
         WHERE observation.raw_page_id = NEW.raw_page_id
           AND observation.observation_kind = 'ACCEPTED_LEAF'
           AND observation.disposition = 'PROCESSED'
      )
      BEGIN
        SELECT RAISE(ABORT, 'provider raw events require a processed accepted leaf');
      END;
    `,
  },
  {
    version: 8,
    name: "payment_match_settlement_history",
    sql: `
      CREATE TABLE payment_match_events (
        event_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (event_sequence >= 1),
        payment_match_id TEXT NOT NULL REFERENCES payment_matches(payment_match_id),
        status TEXT NOT NULL CHECK (status IN ('SETTLED', 'REVERSED')),
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        UNIQUE (payment_match_id, status)
      ) STRICT;

      INSERT INTO payment_match_events(
        event_sequence, payment_match_id, status, occurred_at
      )
      WITH expected_events(payment_match_id, status, occurred_at, status_order) AS (
        SELECT payment_match_id, 'SETTLED', created_at, 1
          FROM payment_matches
         WHERE status IN ('SETTLED', 'REVERSED')

        UNION ALL

        SELECT payment_match_id, 'REVERSED', updated_at, 2
          FROM payment_matches
         WHERE status = 'REVERSED'
      ),
      ordered_events AS (
        SELECT
          ROW_NUMBER() OVER (
            ORDER BY occurred_at, status_order, payment_match_id
          ) AS event_sequence,
          payment_match_id,
          status,
          occurred_at
        FROM expected_events
      )
      SELECT event_sequence, payment_match_id, status, occurred_at
        FROM ordered_events
       ORDER BY event_sequence;

      CREATE INDEX payment_match_events_history_idx
      ON payment_match_events(status, event_sequence);

      CREATE TRIGGER payment_match_events_valid_insert
      BEFORE INSERT ON payment_match_events
      WHEN NOT EXISTS (
        SELECT 1
          FROM payment_matches AS payment_match
         WHERE payment_match.payment_match_id = NEW.payment_match_id
           AND payment_match.status = NEW.status
           AND payment_match.updated_at = NEW.occurred_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'payment match event does not match current state');
      END;

      CREATE TRIGGER payment_match_events_no_update
      BEFORE UPDATE ON payment_match_events
      BEGIN
        SELECT RAISE(ABORT, 'payment match events are immutable');
      END;

      CREATE TRIGGER payment_match_events_no_delete
      BEFORE DELETE ON payment_match_events
      BEGIN
        SELECT RAISE(ABORT, 'payment match events cannot be deleted');
      END;

      CREATE TRIGGER payment_matches_event_insert
      AFTER INSERT ON payment_matches
      BEGIN
        INSERT INTO payment_match_events(payment_match_id, status, occurred_at)
        VALUES (NEW.payment_match_id, NEW.status, NEW.updated_at);
      END;

      CREATE TRIGGER payment_matches_event_status_update
      AFTER UPDATE OF status ON payment_matches
      WHEN NEW.status != OLD.status
      BEGIN
        INSERT INTO payment_match_events(payment_match_id, status, occurred_at)
        VALUES (NEW.payment_match_id, NEW.status, NEW.updated_at);
      END;
    `,
  },
  {
    version: 9,
    name: "audit_anchor_and_evidence_fingerprints",
    postApply: "backfill_evidence_fingerprints_v1",
    sql: `
      CREATE TABLE audit_chain_state (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        event_count INTEGER NOT NULL CHECK (event_count >= 0),
        last_sequence INTEGER UNIQUE CHECK (last_sequence IS NULL OR last_sequence >= 1),
        last_event_hash TEXT UNIQUE CHECK (
          last_event_hash IS NULL OR
          (
            length(last_event_hash) = 64 AND
            last_event_hash = lower(last_event_hash) AND
            last_event_hash NOT GLOB '*[^0-9a-f]*'
          )
        ),
        CHECK (
          (event_count = 0 AND last_sequence IS NULL AND last_event_hash IS NULL) OR
          (event_count >= 1 AND last_sequence = event_count AND last_event_hash IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO audit_chain_state(
        singleton_key, event_count, last_sequence, last_event_hash
      )
      SELECT
        1,
        COUNT(*),
        MAX(sequence),
        (SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1)
        FROM audit_events;

      CREATE TRIGGER audit_chain_state_no_insert
      BEFORE INSERT ON audit_chain_state
      BEGIN
        SELECT RAISE(ABORT, 'audit chain state is a singleton');
      END;

      CREATE TRIGGER audit_chain_state_no_delete
      BEFORE DELETE ON audit_chain_state
      BEGIN
        SELECT RAISE(ABORT, 'audit chain state cannot be deleted');
      END;

      CREATE TRIGGER audit_chain_state_valid_update
      BEFORE UPDATE ON audit_chain_state
      WHEN
        NEW.singleton_key != OLD.singleton_key OR
        NEW.event_count != OLD.event_count + 1 OR
        NEW.last_sequence != COALESCE(OLD.last_sequence, 0) + 1 OR
        NOT EXISTS (
          SELECT 1
            FROM audit_events AS event
           WHERE event.sequence = NEW.last_sequence
             AND event.event_hash = NEW.last_event_hash
             AND event.previous_hash IS OLD.last_event_hash
        )
      BEGIN
        SELECT RAISE(ABORT, 'audit chain state transition is invalid');
      END;

      CREATE TRIGGER audit_events_update_chain_state
      AFTER INSERT ON audit_events
      BEGIN
        UPDATE audit_chain_state
           SET event_count = event_count + 1,
               last_sequence = NEW.sequence,
               last_event_hash = NEW.event_hash
         WHERE singleton_key = 1;
        SELECT CASE
          WHEN changes() != 1
            THEN RAISE(ABORT, 'audit chain state was not advanced')
        END;
      END;

      ALTER TABLE order_events
        ADD COLUMN details_fingerprint TEXT CHECK (
          details_fingerprint IS NULL OR
          (
            length(details_fingerprint) = 64 AND
            details_fingerprint = lower(details_fingerprint) AND
            details_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        );

      DROP TRIGGER order_events_no_update;

      CREATE TRIGGER order_events_fingerprint_required_insert
      BEFORE INSERT ON order_events
      WHEN NEW.details_fingerprint IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'order event details fingerprint is required');
      END;

      CREATE TRIGGER order_events_no_update
      BEFORE UPDATE ON order_events
      BEGIN
        SELECT RAISE(ABORT, 'order events are append-only');
      END;

      ALTER TABLE financial_exceptions
        ADD COLUMN details_fingerprint TEXT CHECK (
          details_fingerprint IS NULL OR
          (
            length(details_fingerprint) = 64 AND
            details_fingerprint = lower(details_fingerprint) AND
            details_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        );

      ALTER TABLE financial_exceptions
        ADD COLUMN resolution_fingerprint TEXT CHECK (
          resolution_fingerprint IS NULL OR
          (
            length(resolution_fingerprint) = 64 AND
            resolution_fingerprint = lower(resolution_fingerprint) AND
            resolution_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        );

      DROP TRIGGER financial_exceptions_evidence_immutable;
      DROP TRIGGER financial_exceptions_resolution_once;

      CREATE TRIGGER financial_exceptions_fingerprints_required_insert
      BEFORE INSERT ON financial_exceptions
      WHEN
        NEW.details_fingerprint IS NULL OR
        (NEW.status = 'OPEN' AND NEW.resolution_fingerprint IS NOT NULL) OR
        (NEW.status = 'RESOLVED' AND NEW.resolution_fingerprint IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'financial exception evidence fingerprints are invalid');
      END;

      CREATE TRIGGER financial_exceptions_evidence_immutable
      BEFORE UPDATE OF
        exception_id, provider_account_key, exception_type, ledger_entry_id,
        order_id, candidate_id, context_key, details_json, details_fingerprint,
        exception_fingerprint, created_at
      ON financial_exceptions
      BEGIN
        SELECT RAISE(ABORT, 'financial exception evidence is immutable');
      END;

      CREATE TRIGGER financial_exceptions_resolution_once
      BEFORE UPDATE OF
        status, resolution_operation_id, resolution_json,
        resolution_fingerprint, resolved_at
      ON financial_exceptions
      WHEN
        OLD.status != 'OPEN' OR
        NEW.status != 'RESOLVED' OR
        NEW.resolution_operation_id IS NULL OR
        NEW.resolution_json IS NULL OR
        NEW.resolution_fingerprint IS NULL OR
        NEW.resolved_at IS NULL OR
        NOT EXISTS (
          SELECT 1
            FROM financial_operations AS operation
           WHERE operation.financial_operation_id = NEW.resolution_operation_id
             AND operation.ledger_entry_id IS NEW.ledger_entry_id
             AND (NEW.order_id IS NULL OR operation.order_id IS NEW.order_id)
             AND operation.created_at = NEW.resolved_at
             AND operation.operation_type IN (
               'AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT', 'RECORD_REFUND'
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'financial exception resolution is invalid');
      END;
    `,
  },
  {
    version: 10,
    name: "preserve_financial_state_during_provider_conflicts",
    sql: `
      DROP TRIGGER ledger_entries_state_transition;

      UPDATE ledger_entries AS entry
         SET state = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM payment_matches AS payment_match
                  WHERE payment_match.ledger_entry_id = entry.ledger_entry_id
                    AND payment_match.status = 'SETTLED'
               ) OR EXISTS (
                 SELECT 1
                   FROM refund_records AS refund
                  WHERE refund.ledger_entry_id = entry.ledger_entry_id
               ) THEN 'ALLOCATED'
               WHEN 2 <= (
                 SELECT COUNT(*)
                   FROM match_candidates AS candidate
                  WHERE candidate.ledger_entry_id = entry.ledger_entry_id
                    AND candidate.status = 'ELIGIBLE'
               ) THEN 'CANDIDATE'
               WHEN EXISTS (
                 SELECT 1
                   FROM payment_matches AS payment_match
                  WHERE payment_match.ledger_entry_id = entry.ledger_entry_id
                    AND payment_match.status = 'REVERSED'
               ) THEN 'CONFLICT'
               ELSE 'UNALLOCATED'
             END
       WHERE entry.state = 'CONFLICT'
         AND EXISTS (
           SELECT 1
             FROM ledger_conflicts AS conflict
            WHERE conflict.existing_ledger_entry_id = entry.ledger_entry_id
              AND conflict.conflict_type = 'DUPLICATE_EXTERNAL_ID'
         );

      CREATE TRIGGER ledger_entries_state_transition
      BEFORE UPDATE OF state ON ledger_entries
      WHEN NOT (
        (OLD.state = 'UNALLOCATED' AND NEW.state IN ('CANDIDATE', 'ALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'CANDIDATE' AND NEW.state IN ('UNALLOCATED', 'ALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'ALLOCATED' AND NEW.state IN ('UNALLOCATED', 'CONFLICT', 'IGNORED')) OR
        (OLD.state = 'CONFLICT' AND NEW.state IN ('ALLOCATED', 'IGNORED'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'ledger entry state transition is invalid');
      END;
    `,
  },
  {
    version: 11,
    name: "retain_api_client_key_history",
    sql: `
      CREATE TABLE api_client_keys (
        client_id TEXT NOT NULL REFERENCES api_client_config(client_id),
        key_version INTEGER NOT NULL CHECK (key_version >= 1),
        secret_fingerprint TEXT NOT NULL UNIQUE CHECK (
          length(secret_fingerprint) = 64 AND
          secret_fingerprint = lower(secret_fingerprint) AND
          secret_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= activated_at),
        PRIMARY KEY (client_id, key_version)
      ) STRICT;

      INSERT INTO api_client_keys(
        client_id, key_version, secret_fingerprint, activated_at, retired_at
      )
      SELECT client_id, key_version, secret_fingerprint, created_at, NULL
        FROM api_client_config;

      CREATE UNIQUE INDEX api_client_keys_one_active
      ON api_client_keys(client_id) WHERE retired_at IS NULL;

      CREATE TRIGGER api_client_keys_monotonic_insert
      BEFORE INSERT ON api_client_keys
      WHEN NEW.key_version != COALESCE(
        (SELECT MAX(key_version) + 1 FROM api_client_keys WHERE client_id = NEW.client_id),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'API client key version must advance exactly once');
      END;

      CREATE TRIGGER api_client_keys_valid_update
      BEFORE UPDATE ON api_client_keys
      WHEN
        NEW.client_id != OLD.client_id OR
        NEW.key_version != OLD.key_version OR
        NEW.secret_fingerprint != OLD.secret_fingerprint OR
        NEW.activated_at != OLD.activated_at OR
        OLD.retired_at IS NOT NULL OR
        NEW.retired_at IS NULL OR
        NEW.retired_at < OLD.activated_at
      BEGIN
        SELECT RAISE(ABORT, 'API client key transition is invalid');
      END;

      CREATE TRIGGER api_client_keys_no_delete
      BEFORE DELETE ON api_client_keys
      BEGIN
        SELECT RAISE(ABORT, 'API client keys cannot be deleted');
      END;

      ALTER TABLE api_nonces RENAME TO api_nonces_v10;

      CREATE TABLE api_nonces (
        client_id TEXT NOT NULL,
        key_version INTEGER NOT NULL,
        nonce TEXT NOT NULL CHECK (
          length(nonce) = 43 AND nonce NOT GLOB '*[^A-Za-z0-9_-]*'
        ),
        request_timestamp_seconds INTEGER NOT NULL CHECK (
          request_timestamp_seconds BETWEEN 1 AND 999999999999
        ),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (client_id, key_version, nonce),
        FOREIGN KEY (client_id, key_version)
          REFERENCES api_client_keys(client_id, key_version),
        CHECK (created_at >= 0 AND created_at < expires_at),
        CHECK (expires_at > 0),
        CHECK (expires_at = (request_timestamp_seconds * 1000) + 301000)
      ) STRICT;

      INSERT INTO api_nonces(
        client_id, key_version, nonce, request_timestamp_seconds, expires_at, created_at
      )
      SELECT nonce.client_id, client.key_version, nonce.nonce,
             nonce.request_timestamp_seconds, nonce.expires_at, nonce.created_at
        FROM api_nonces_v10 AS nonce
        JOIN api_client_config AS client ON client.client_id = nonce.client_id;

      DROP TABLE api_nonces_v10;

      CREATE INDEX api_nonces_expiry_idx ON api_nonces(expires_at);

      CREATE TRIGGER api_client_config_key_transition
      BEFORE UPDATE OF client_id, secret_fingerprint, key_version ON api_client_config
      WHEN
        NEW.client_id != OLD.client_id OR
        NOT EXISTS (
          SELECT 1
            FROM api_client_keys AS key
           WHERE key.client_id = NEW.client_id
             AND key.key_version = NEW.key_version
             AND key.secret_fingerprint = NEW.secret_fingerprint
             AND key.retired_at IS NULL
        )
      BEGIN
        SELECT RAISE(ABORT, 'API client config must reference the active key');
      END;
    `,
  },
  {
    version: 12,
    name: "version_checkout_token_keys",
    sql: `
      CREATE TABLE checkout_token_keys (
        key_version INTEGER PRIMARY KEY CHECK (key_version >= 1),
        key_material BLOB NOT NULL CHECK (
          typeof(key_material) = 'blob' AND length(key_material) = 32
        ),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= activated_at)
      ) STRICT;

      INSERT INTO checkout_token_keys(
        key_version, key_material, activated_at, retired_at
      )
      SELECT 1, key_material, created_at, NULL
        FROM checkout_token_key;

      CREATE UNIQUE INDEX checkout_token_keys_one_active
      ON checkout_token_keys((1)) WHERE retired_at IS NULL;

      CREATE TRIGGER checkout_token_keys_monotonic_insert
      BEFORE INSERT ON checkout_token_keys
      WHEN
        NEW.key_version != COALESCE(
          (SELECT MAX(key_version) + 1 FROM checkout_token_keys),
          1
        ) OR
        EXISTS (SELECT 1 FROM checkout_token_keys WHERE retired_at IS NULL) OR
        NEW.activated_at < COALESCE(
          (SELECT MAX(activated_at) FROM checkout_token_keys),
          0
        )
      BEGIN
        SELECT RAISE(ABORT, 'checkout token key version is invalid');
      END;

      CREATE TRIGGER checkout_token_keys_valid_update
      BEFORE UPDATE ON checkout_token_keys
      WHEN
        NEW.key_version != OLD.key_version OR
        NEW.key_material != OLD.key_material OR
        NEW.activated_at != OLD.activated_at OR
        OLD.retired_at IS NOT NULL OR
        NEW.retired_at IS NULL OR
        NEW.retired_at < OLD.activated_at
      BEGIN
        SELECT RAISE(ABORT, 'checkout token key transition is invalid');
      END;

      CREATE TRIGGER checkout_token_keys_no_delete
      BEFORE DELETE ON checkout_token_keys
      BEGIN
        SELECT RAISE(ABORT, 'checkout token keys cannot be deleted');
      END;

      DROP TRIGGER checkout_sessions_no_update;
      DROP TRIGGER checkout_sessions_no_delete;
      ALTER TABLE checkout_sessions RENAME TO checkout_sessions_v11;

      CREATE TABLE checkout_sessions (
        checkout_id TEXT PRIMARY KEY CHECK (length(checkout_id) = 36),
        order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
        token_digest TEXT NOT NULL UNIQUE CHECK (
          length(token_digest) = 64 AND
          token_digest = lower(token_digest) AND
          token_digest NOT GLOB '*[^0-9a-f]*'
        ),
        token_key_version INTEGER NOT NULL REFERENCES checkout_token_keys(key_version),
        terminal_observation_milliseconds INTEGER NOT NULL CHECK (
          terminal_observation_milliseconds BETWEEN 60000 AND 604800000
        )
      ) STRICT;

      INSERT INTO checkout_sessions(
        checkout_id, order_id, token_digest, token_key_version,
        terminal_observation_milliseconds
      )
      SELECT checkout_id, order_id, token_digest, 1, 86400000
        FROM checkout_sessions_v11;

      DROP TABLE checkout_sessions_v11;

      CREATE TRIGGER checkout_sessions_no_update
      BEFORE UPDATE ON checkout_sessions
      BEGIN
        SELECT RAISE(ABORT, 'checkout sessions are immutable');
      END;

      CREATE TRIGGER checkout_sessions_no_delete
      BEFORE DELETE ON checkout_sessions
      BEGIN
        SELECT RAISE(ABORT, 'checkout sessions cannot be deleted');
      END;

      DROP TRIGGER checkout_token_key_no_update;
      DROP TRIGGER checkout_token_key_no_delete;
      DROP TABLE checkout_token_key;
    `,
  },
  {
    version: 13,
    name: "ledger_conflict_operations",
    sql: `
      CREATE TABLE schema_13_conflict_state_guard (
        terminal_conflicts INTEGER NOT NULL CHECK (terminal_conflicts = 0)
      ) STRICT;

      INSERT INTO schema_13_conflict_state_guard(terminal_conflicts)
      SELECT COUNT(*) FROM ledger_conflicts WHERE status != 'OPEN';

      DROP TABLE schema_13_conflict_state_guard;

      CREATE TABLE ledger_conflict_operations (
        conflict_operation_id TEXT PRIMARY KEY CHECK (length(conflict_operation_id) = 36),
        operation_key TEXT NOT NULL UNIQUE CHECK (length(operation_key) BETWEEN 1 AND 256),
        conflict_id TEXT NOT NULL UNIQUE REFERENCES ledger_conflicts(conflict_id),
        request_fingerprint TEXT NOT NULL CHECK (
          length(request_fingerprint) = 64 AND
          request_fingerprint = lower(request_fingerprint) AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        request_json TEXT NOT NULL CHECK (
          json_valid(request_json) AND json_type(request_json) = 'object' AND
          length(CAST(request_json AS BLOB)) <= 8192
        ),
        action TEXT NOT NULL CHECK (
          action IN ('CONFIRM_VARIANT', 'KEEP_EXISTING', 'ACKNOWLEDGE_ISOLATED')
        ),
        actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'ADMIN')),
        actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
        reason TEXT NOT NULL CHECK (
          length(reason) BETWEEN 1 AND 512 AND length(CAST(reason AS BLOB)) <= 2048
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        CHECK (
          (action = 'CONFIRM_VARIANT' AND actor_type = 'SYSTEM' AND actor_id IS NULL) OR
          (action IN ('KEEP_EXISTING', 'ACKNOWLEDGE_ISOLATED') AND
           actor_type = 'ADMIN' AND actor_id IS NOT NULL)
        )
      ) STRICT;

      ALTER TABLE ledger_conflicts
        ADD COLUMN resolution_operation_id TEXT
          REFERENCES ledger_conflict_operations(conflict_operation_id);
      ALTER TABLE ledger_conflicts
        ADD COLUMN resolution_fingerprint TEXT CHECK (
          resolution_fingerprint IS NULL OR (
            length(resolution_fingerprint) = 64 AND
            resolution_fingerprint = lower(resolution_fingerprint) AND
            resolution_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        );

      CREATE UNIQUE INDEX ledger_conflicts_resolution_operation_unique
      ON ledger_conflicts(resolution_operation_id)
      WHERE resolution_operation_id IS NOT NULL;

      DROP TRIGGER ledger_conflicts_resolution_consistent;

      CREATE TRIGGER ledger_conflicts_resolution_valid_insert
      BEFORE INSERT ON ledger_conflicts
      WHEN
        NEW.status != 'OPEN' OR NEW.resolution_json IS NOT NULL OR NEW.resolved_at IS NOT NULL OR
        NEW.resolution_operation_id IS NOT NULL OR NEW.resolution_fingerprint IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'new ledger conflicts cannot be resolved');
      END;

      CREATE TRIGGER ledger_conflicts_resolution_transition
      BEFORE UPDATE OF
        status, resolution_json, resolved_at,
        resolution_operation_id, resolution_fingerprint
      ON ledger_conflicts
      WHEN NOT (
        OLD.status = 'OPEN' AND
        OLD.resolution_json IS NULL AND OLD.resolved_at IS NULL AND
        OLD.resolution_operation_id IS NULL AND OLD.resolution_fingerprint IS NULL AND
        NEW.status IN ('RESOLVED', 'IGNORED') AND
        NEW.resolution_json IS NOT NULL AND NEW.resolved_at IS NOT NULL AND
        NEW.resolution_operation_id IS NOT NULL AND NEW.resolution_fingerprint IS NOT NULL AND
        NEW.resolved_at >= NEW.created_at AND
        EXISTS (
          SELECT 1
            FROM ledger_conflict_operations AS operation
           WHERE operation.conflict_operation_id = NEW.resolution_operation_id
             AND operation.conflict_id = OLD.conflict_id
             AND operation.request_json = NEW.resolution_json
             AND operation.request_fingerprint = NEW.resolution_fingerprint
             AND operation.created_at = NEW.resolved_at
             AND (
               (operation.action = 'CONFIRM_VARIANT' AND NEW.status = 'RESOLVED') OR
               (operation.action = 'KEEP_EXISTING' AND NEW.status = 'RESOLVED') OR
               (operation.action = 'ACKNOWLEDGE_ISOLATED' AND NEW.status = 'IGNORED')
             )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict resolution transition is invalid');
      END;

      CREATE TRIGGER ledger_conflict_operations_valid_insert
      BEFORE INSERT ON ledger_conflict_operations
      WHEN
        json_extract(NEW.request_json, '$.schema') IS NOT
          'perpay:ledger-conflict-operation:v1' OR
        json_extract(NEW.request_json, '$.conflict_id') IS NOT NEW.conflict_id OR
        json_extract(NEW.request_json, '$.action') IS NOT NEW.action OR
        json_extract(NEW.request_json, '$.actor_type') IS NOT NEW.actor_type OR
        json_extract(NEW.request_json, '$.actor_id') IS NOT NEW.actor_id OR
        json_extract(NEW.request_json, '$.reason') IS NOT NEW.reason OR
        NOT EXISTS (
          SELECT 1
            FROM ledger_conflicts AS conflict
           WHERE conflict.conflict_id = NEW.conflict_id
             AND conflict.status = 'OPEN'
             AND (
               (conflict.conflict_type = 'RAW_PAGE_VARIANT' AND
                NEW.action = 'CONFIRM_VARIANT' AND NEW.actor_type = 'SYSTEM') OR
               (conflict.conflict_type = 'DUPLICATE_EXTERNAL_ID' AND
                NEW.action = 'KEEP_EXISTING' AND NEW.actor_type = 'ADMIN') OR
               (conflict.conflict_type IN (
                  'MISSING_EXTERNAL_ID', 'INVALID_AMOUNT', 'INVALID_TIMESTAMP',
                  'INVALID_DIRECTION', 'INVALID_SHAPE'
                ) AND NEW.action = 'ACKNOWLEDGE_ISOLATED' AND NEW.actor_type = 'ADMIN')
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict operation is invalid');
      END;

      CREATE TRIGGER ledger_conflict_operations_apply
      AFTER INSERT ON ledger_conflict_operations
      BEGIN
        UPDATE ledger_conflicts
           SET status = CASE NEW.action
                 WHEN 'ACKNOWLEDGE_ISOLATED' THEN 'IGNORED'
                 ELSE 'RESOLVED'
               END,
               resolution_json = NEW.request_json,
               resolution_operation_id = NEW.conflict_operation_id,
               resolution_fingerprint = NEW.request_fingerprint,
               resolved_at = NEW.created_at
         WHERE conflict_id = NEW.conflict_id AND status = 'OPEN';

        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
            FROM ledger_conflicts
           WHERE conflict_id = NEW.conflict_id
             AND resolution_operation_id = NEW.conflict_operation_id
        ) THEN RAISE(ABORT, 'ledger conflict operation was not applied') END;
      END;

      CREATE TRIGGER ledger_conflict_operations_no_update
      BEFORE UPDATE ON ledger_conflict_operations
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict operations are immutable');
      END;

      CREATE TRIGGER ledger_conflict_operations_no_delete
      BEFORE DELETE ON ledger_conflict_operations
      BEGIN
        SELECT RAISE(ABORT, 'ledger conflict operations cannot be deleted');
      END;
    `,
  },
] as const;
