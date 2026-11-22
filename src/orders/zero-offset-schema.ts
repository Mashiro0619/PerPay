/**
 * Migration 48: relax amount-offset lower bounds on payment_orders and amount_slots
 * so websites that explicitly opt into starting from +0.00 can allocate exact-price
 * slots (including ¥0.01 -> ¥0.01) while keeping every index, trigger, foreign key,
 * and historical row invariant intact.
 */
export const ZERO_AMOUNT_OFFSET_SCHEMA_SQL = `
PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE perpay_v48_amount_slots AS SELECT * FROM amount_slots;
DROP TABLE amount_slots;

CREATE TEMP TABLE perpay_v48_payment_orders AS SELECT * FROM payment_orders;
DROP TABLE payment_orders;

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
    payable_amount_cents BETWEEN 1 AND 9999999999 AND
    payable_amount_cents >= requested_amount_cents
  ),
  allocation_offset_max_cents INTEGER NOT NULL CHECK (
    allocation_offset_max_cents BETWEEN 0 AND 99
  ),
  received_amount_cents INTEGER CHECK (
    received_amount_cents IS NULL OR
    received_amount_cents BETWEEN 1 AND 9999999999
  ),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  product_name TEXT CHECK (product_name IS NULL OR length(product_name) BETWEEN 1 AND 200),
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
  webhook_target_request_fingerprint TEXT CHECK (
    webhook_target_request_fingerprint IS NULL OR (
      length(webhook_target_request_fingerprint) = 64 AND
      webhook_target_request_fingerprint = lower(webhook_target_request_fingerprint) AND
      webhook_target_request_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  note TEXT,
  note_fingerprint TEXT,
  note_fingerprint_version INTEGER,
  return_url TEXT,
  return_url_fingerprint TEXT NOT NULL
    DEFAULT 'e693e547327adfdd93722cbb053560a5df0dbbdb46a55a47d8efd75de4e16320',
  return_url_fingerprint_version INTEGER NOT NULL DEFAULT 1,
  amount_reuse_cooldown_seconds INTEGER NOT NULL DEFAULT 600
    CHECK (amount_reuse_cooldown_seconds BETWEEN 60 AND 3600),
  alipay_account_id TEXT NOT NULL DEFAULT 'default',
  UNIQUE (api_client_id, merchant_order_no),
  UNIQUE (api_client_id, idempotency_key_digest),
  CHECK (
    payable_amount_cents - requested_amount_cents
    BETWEEN 0 AND allocation_offset_max_cents
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

INSERT INTO payment_orders (
  order_id, api_client_id, merchant_order_no, idempotency_key_digest,
  idempotency_key_digest_version, request_fingerprint, request_fingerprint_version,
  requested_amount_cents, payable_amount_cents, allocation_offset_max_cents,
  received_amount_cents, currency, product_name, collection_profile_id,
  checkout_status, payment_status, refund_status, payment_basis,
  eligible_from, created_at, expires_at, closed_at, updated_at, version,
  webhook_target_request_fingerprint, note, note_fingerprint, note_fingerprint_version,
  return_url, return_url_fingerprint, return_url_fingerprint_version,
  amount_reuse_cooldown_seconds, alipay_account_id
)
SELECT
  order_id, api_client_id, merchant_order_no, idempotency_key_digest,
  idempotency_key_digest_version, request_fingerprint, request_fingerprint_version,
  requested_amount_cents, payable_amount_cents, allocation_offset_max_cents,
  received_amount_cents, currency, product_name, collection_profile_id,
  checkout_status, payment_status, refund_status, payment_basis,
  eligible_from, created_at, expires_at, closed_at, updated_at, version,
  webhook_target_request_fingerprint, note, note_fingerprint, note_fingerprint_version,
  return_url, return_url_fingerprint, return_url_fingerprint_version,
  amount_reuse_cooldown_seconds, alipay_account_id
FROM perpay_v48_payment_orders;

DROP TABLE perpay_v48_payment_orders;

CREATE INDEX payment_orders_active_scan_idx
  ON payment_orders(collection_profile_id, expires_at)
  WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID';
CREATE INDEX payment_orders_alipay_account_idx
  ON payment_orders(alipay_account_id, created_at DESC, order_id DESC);
CREATE INDEX payment_orders_checkout_created_idx
  ON payment_orders(checkout_status, created_at DESC, order_id DESC);
CREATE INDEX payment_orders_checkout_expiry_idx
  ON payment_orders(checkout_status, expires_at, order_id);
CREATE INDEX payment_orders_checkout_payment_created_idx
  ON payment_orders(checkout_status, payment_status, created_at DESC, order_id DESC);
CREATE INDEX payment_orders_created_idx
  ON payment_orders(created_at DESC, order_id DESC);
CREATE UNIQUE INDEX payment_orders_one_open_amount
  ON payment_orders(alipay_account_id, payable_amount_cents)
  WHERE checkout_status = 'OPEN';
CREATE INDEX payment_orders_payable_list_idx
  ON payment_orders(payable_amount_cents, order_id);
CREATE INDEX payment_orders_received_list_idx
  ON payment_orders(received_amount_cents, order_id);
CREATE INDEX payment_orders_scan_tail_idx
  ON payment_orders(collection_profile_id, CASE WHEN checkout_status = 'CLOSED' THEN closed_at ELSE expires_at END)
  WHERE payment_status = 'UNPAID';
CREATE INDEX payment_orders_site_pending
  ON payment_orders(api_client_id, expires_at)
  WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID';

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

CREATE TRIGGER payment_orders_no_delete
  BEFORE DELETE ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'payment orders cannot be deleted');
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

CREATE TRIGGER payment_orders_webhook_target_commitment_immutable
  BEFORE UPDATE OF webhook_target_request_fingerprint ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'order webhook target commitment is immutable');
  END;

CREATE TRIGGER payment_orders_version_step
  BEFORE UPDATE ON payment_orders
  WHEN NEW.version != OLD.version + 1
  BEGIN
    SELECT RAISE(ABORT, 'order version must advance exactly once');
  END;

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

CREATE TRIGGER payment_orders_product_metadata_insert_guard
  BEFORE INSERT ON payment_orders
  WHEN NEW.product_name IS NULL OR
       NEW.product_name != trim(NEW.product_name) OR
       trim(NEW.product_name) = '' OR
       length(NEW.product_name) > 200 OR
       length(CAST(NEW.product_name AS BLOB)) > 800 OR
       (NEW.note IS NOT NULL AND (
         trim(NEW.note) = '' OR
         NEW.note != trim(NEW.note) OR
         length(NEW.note) > 500 OR
         length(CAST(NEW.note AS BLOB)) > 2000 OR
         NEW.note_fingerprint IS NULL OR
         NEW.note_fingerprint_version != 1 OR
         length(NEW.note_fingerprint) != 64 OR
         NEW.note_fingerprint GLOB '*[^0-9a-f]*'
       )) OR
       NEW.note IS NULL AND (
         NEW.note_fingerprint IS NULL OR
         NEW.note_fingerprint_version != 1 OR
         length(NEW.note_fingerprint) != 64 OR
         NEW.note_fingerprint GLOB '*[^0-9a-f]*'
       )
  BEGIN
    SELECT RAISE(ABORT, 'order product metadata is invalid');
  END;

CREATE TRIGGER payment_orders_product_metadata_immutable
  BEFORE UPDATE OF product_name, note, note_fingerprint, note_fingerprint_version
  ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'order product metadata is immutable');
  END;

CREATE TRIGGER payment_orders_snapshot_immutable
  BEFORE UPDATE OF
    order_id, api_client_id, merchant_order_no, idempotency_key_digest,
    idempotency_key_digest_version,
    request_fingerprint, request_fingerprint_version, requested_amount_cents,
    payable_amount_cents, allocation_offset_max_cents, currency, product_name,
    collection_profile_id, eligible_from, created_at, expires_at,
    return_url, return_url_fingerprint, return_url_fingerprint_version
  ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'order request and collection snapshot are immutable');
  END;

CREATE TRIGGER payment_orders_return_url_insert_guard
  BEFORE INSERT ON payment_orders
  WHEN
    (NEW.return_url IS NULL AND (
      NEW.return_url_fingerprint IS NULL OR
      NEW.return_url_fingerprint_version != 1
    )) OR
    (NEW.return_url IS NOT NULL AND (
      NEW.return_url = trim(NEW.return_url) AND
      length(NEW.return_url) > 0 AND
      length(CAST(NEW.return_url AS BLOB)) <= 4096 AND
      NEW.return_url_fingerprint IS NOT NULL AND
      NEW.return_url_fingerprint_version = 1 AND
      length(NEW.return_url_fingerprint) = 64 AND
      NEW.return_url_fingerprint NOT GLOB '*[^0-9a-f]*'
    ) = 0)
  BEGIN
    SELECT RAISE(ABORT, 'order return URL is invalid');
  END;

CREATE TRIGGER payment_orders_return_url_immutable
  BEFORE UPDATE OF return_url, return_url_fingerprint, return_url_fingerprint_version
  ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'order return URL is immutable');
  END;

CREATE TRIGGER payment_orders_cooldown_immutable
  BEFORE UPDATE OF amount_reuse_cooldown_seconds ON payment_orders
  BEGIN
    SELECT RAISE(ABORT, 'order amount reuse policy is immutable');
  END;

CREATE TRIGGER payment_orders_site_admission
  BEFORE INSERT ON payment_orders
  WHEN NOT EXISTS (SELECT 1 FROM sites WHERE client_id = NEW.api_client_id AND deleted_at IS NULL
    AND json_extract(configuration, '$.accepting_orders') = 1)
  BEGIN SELECT RAISE(ABORT, 'website does not accept new orders'); END;

CREATE TRIGGER payment_orders_site_capacity
  BEFORE INSERT ON payment_orders
  WHEN EXISTS (SELECT 1 FROM sites WHERE client_id = NEW.api_client_id
    AND json_extract(configuration, '$.policy.orders.pending_order_limit') IS NOT NULL
    AND (SELECT count(*) FROM payment_orders WHERE api_client_id = NEW.api_client_id
      AND checkout_status = 'OPEN' AND payment_status = 'UNPAID' AND expires_at > NEW.created_at)
    >= json_extract(configuration, '$.policy.orders.pending_order_limit'))
  BEGIN SELECT RAISE(ABORT, 'website pending order limit exceeded'); END;

CREATE TRIGGER payment_orders_alipay_account_immutable
  BEFORE UPDATE OF alipay_account_id ON payment_orders
  BEGIN SELECT RAISE(ABORT, 'order Alipay account is immutable'); END;

CREATE TRIGGER payment_orders_payment_state_transition
  BEFORE UPDATE OF received_amount_cents, payment_status, refund_status, payment_basis ON payment_orders
  WHEN NOT (
    (OLD.payment_status = 'UNPAID' AND OLD.payment_basis = 'NONE'
      AND OLD.received_amount_cents IS NULL AND OLD.refund_status = 'NONE'
      AND NEW.payment_status = 'CONFIRMED' AND NEW.payment_basis IN ('INFERRED', 'MANUAL')
      AND NEW.received_amount_cents IS NOT NULL AND NEW.refund_status = 'NONE') OR
    (OLD.payment_status = 'CONFIRMED' AND NEW.payment_status = 'DISPUTED'
      AND NEW.payment_basis = OLD.payment_basis AND NEW.received_amount_cents = OLD.received_amount_cents
      AND NEW.refund_status = OLD.refund_status) OR
    (OLD.payment_status IN ('CONFIRMED', 'DISPUTED') AND NEW.payment_status = OLD.payment_status
      AND NEW.payment_basis = OLD.payment_basis AND NEW.received_amount_cents = OLD.received_amount_cents
      AND ((OLD.refund_status = 'NONE' AND NEW.refund_status IN ('PARTIAL', 'FULL'))
        OR (OLD.refund_status = 'PARTIAL' AND NEW.refund_status IN ('PARTIAL', 'FULL')))) OR
    (OLD.payment_status = 'DISPUTED' AND NEW.payment_status = 'CONFIRMED'
      AND NEW.payment_basis = 'MANUAL' AND OLD.refund_status = 'NONE' AND NEW.refund_status = 'NONE'
      AND NOT EXISTS (SELECT 1 FROM admin_refund_marks AS current
        JOIN admin_refund_mark_events AS mark ON mark.order_id = current.order_id AND mark.version = current.version
        WHERE current.order_id = OLD.order_id AND mark.marked = 1)
      AND EXISTS (SELECT 1 FROM payment_matches AS replacement
        JOIN financial_operations AS operation ON operation.financial_operation_id = replacement.created_by_operation_id
        JOIN ledger_entries AS entry ON entry.ledger_entry_id = replacement.ledger_entry_id
        WHERE replacement.order_id = OLD.order_id AND replacement.status = 'SETTLED'
          AND replacement.evidence_type = 'MANUAL' AND operation.operation_type = 'MANUAL_SETTLEMENT'
          AND operation.reason IS NOT NULL AND operation.created_at = NEW.updated_at
          AND entry.amount_cents = NEW.received_amount_cents))
  )
  BEGIN SELECT RAISE(ABORT, 'payment state transition is invalid'); END;

CREATE TABLE amount_slots (
  slot_id TEXT PRIMARY KEY CHECK(length(slot_id) = 36),
  order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
  collection_profile_id TEXT NOT NULL REFERENCES collection_profiles(profile_id),
  payable_amount_cents INTEGER NOT NULL CHECK(payable_amount_cents BETWEEN 1 AND 9999999999),
  generation INTEGER NOT NULL CHECK(generation >= 1),
  occupied_from INTEGER NOT NULL CHECK(occupied_from >= 0),
  released_at INTEGER,
  release_reason TEXT CHECK(release_reason IN ('CLOSED','EXPIRED')),
  alipay_account_id TEXT NOT NULL DEFAULT 'default',
  UNIQUE(alipay_account_id, payable_amount_cents, generation),
  CHECK(released_at IS NULL OR released_at >= occupied_from),
  CHECK((released_at IS NULL) = (release_reason IS NULL))
) STRICT;

INSERT INTO amount_slots (
  slot_id, order_id, collection_profile_id, payable_amount_cents,
  generation, occupied_from, released_at, release_reason, alipay_account_id
)
SELECT
  slot_id, order_id, collection_profile_id, payable_amount_cents,
  generation, occupied_from, released_at, release_reason, alipay_account_id
FROM perpay_v48_amount_slots;

DROP TABLE perpay_v48_amount_slots;

CREATE UNIQUE INDEX amount_slots_one_active_amount
  ON amount_slots(alipay_account_id, payable_amount_cents)
  WHERE released_at IS NULL;
CREATE INDEX amount_slots_order_interval_idx
  ON amount_slots(order_id, occupied_from, released_at);
CREATE INDEX amount_slots_matching_interval_idx
  ON amount_slots(collection_profile_id, payable_amount_cents, occupied_from, released_at, generation);

CREATE TRIGGER amount_slots_valid_insert
  BEFORE INSERT ON amount_slots
  WHEN NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM payment_orders AS orders WHERE orders.order_id = NEW.order_id
      AND orders.collection_profile_id = NEW.collection_profile_id AND orders.payable_amount_cents = NEW.payable_amount_cents
      AND orders.alipay_account_id = NEW.alipay_account_id AND orders.eligible_from = NEW.occupied_from AND orders.checkout_status = 'OPEN')
  BEGIN SELECT RAISE(ABORT, 'new amount slot must match an open order'); END;

CREATE TRIGGER amount_slots_generation_step
  BEFORE INSERT ON amount_slots
  WHEN NEW.generation != MAX(
    COALESCE((SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id
      AND payable_amount_cents = NEW.payable_amount_cents), 0),
    COALESCE((SELECT generation FROM archived_amount_slot_anchors WHERE alipay_account_id = NEW.alipay_account_id
      AND payable_amount_cents = NEW.payable_amount_cents), 0)
  ) + 1
  BEGIN SELECT RAISE(ABORT, 'amount slot generation must advance exactly once'); END;

CREATE TRIGGER amount_slots_no_overlap
  BEFORE INSERT ON amount_slots
  WHEN EXISTS (SELECT 1 FROM amount_slots AS previous WHERE previous.alipay_account_id = NEW.alipay_account_id
    AND previous.payable_amount_cents = NEW.payable_amount_cents
    AND previous.generation = (SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id AND payable_amount_cents = NEW.payable_amount_cents)
    AND (previous.released_at IS NULL OR previous.released_at > NEW.occupied_from))
  BEGIN SELECT RAISE(ABORT, 'amount slot intervals cannot overlap'); END;

CREATE TRIGGER amount_slots_cooldown_guard
  BEFORE INSERT ON amount_slots
  WHEN EXISTS (SELECT 1 FROM amount_slots AS previous JOIN payment_orders AS orders ON orders.order_id = previous.order_id
    WHERE previous.alipay_account_id = NEW.alipay_account_id AND previous.payable_amount_cents = NEW.payable_amount_cents
      AND previous.generation = (SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id AND payable_amount_cents = NEW.payable_amount_cents)
      AND previous.released_at IS NOT NULL AND NEW.occupied_from < (CASE WHEN orders.checkout_status = 'EXPIRED' THEN orders.expires_at ELSE orders.closed_at END + orders.amount_reuse_cooldown_seconds * 1000))
  BEGIN SELECT RAISE(ABORT, 'amount slot is still cooling down'); END;

CREATE TRIGGER amount_slots_archived_cooldown_guard
  BEFORE INSERT ON amount_slots
  WHEN EXISTS (SELECT 1 FROM archived_amount_slot_anchors WHERE alipay_account_id = NEW.alipay_account_id
    AND payable_amount_cents = NEW.payable_amount_cents AND available_at > NEW.occupied_from)
  BEGIN SELECT RAISE(ABORT, 'archived amount slot is still cooling down'); END;

CREATE TRIGGER amount_slots_release_only
  BEFORE UPDATE ON amount_slots
  WHEN OLD.slot_id IS NOT NEW.slot_id OR OLD.order_id IS NOT NEW.order_id OR OLD.collection_profile_id IS NOT NEW.collection_profile_id
    OR OLD.alipay_account_id IS NOT NEW.alipay_account_id OR OLD.payable_amount_cents IS NOT NEW.payable_amount_cents OR OLD.generation IS NOT NEW.generation
    OR OLD.occupied_from IS NOT NEW.occupied_from OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.release_reason IS NULL
    OR NOT EXISTS (SELECT 1 FROM payment_orders AS orders WHERE orders.order_id = NEW.order_id AND orders.checkout_status = NEW.release_reason AND orders.closed_at = NEW.released_at)
  BEGIN SELECT RAISE(ABORT, 'amount slots can only be released once'); END;

CREATE TRIGGER amount_slots_no_delete
  BEFORE DELETE ON amount_slots
  BEGIN SELECT RAISE(ABORT, 'amount slot history cannot be deleted'); END;
`;
