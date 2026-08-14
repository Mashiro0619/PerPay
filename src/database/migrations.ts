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
] as const;
