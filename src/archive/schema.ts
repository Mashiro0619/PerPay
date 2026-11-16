import { archivedAccountHistorySql } from "./account-history.ts";

export const ARCHIVE_BUSINESS_TABLES = [
  "payment_orders", "checkout_sessions", "amount_slots", "order_events",
  "financial_operations", "match_candidates", "payment_matches", "payment_match_events",
  "ledger_transactions", "ledger_postings", "refund_records", "financial_exceptions",
  "outbox_events", "webhook_targets", "webhook_deliveries", "webhook_attempts", "epay_orders",
  "admin_refund_mark_events", "admin_refund_marks", "admin_operation_log", "admin_work_item_operations", "admin_work_item_states",
  "ledger_entries", "provider_raw_events",
  "provider_raw_pages", "ingest_runs", "ingest_segments", "ingest_run_page_observations",
  "ingest_errors", "ledger_conflicts", "ledger_conflict_operations",
] as const;

export const HISTORY_ARCHIVE_SCHEMA_SQL = `
  CREATE TABLE history_archives (
    archive_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    before_timestamp INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    order_count INTEGER NOT NULL,
    ledger_count INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    payment_match_event_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('AVAILABLE', 'DELETED')),
    deleted_at INTEGER,
    CHECK ((status = 'AVAILABLE' AND deleted_at IS NULL) OR (status = 'DELETED' AND deleted_at IS NOT NULL))
  ) STRICT;

  CREATE TABLE archived_order_keys (
    order_id TEXT PRIMARY KEY,
    archive_id TEXT NOT NULL REFERENCES history_archives(archive_id),
    api_client_id TEXT NOT NULL,
    merchant_order_digest BLOB NOT NULL CHECK(length(merchant_order_digest) = 32),
    idempotency_key_digest TEXT NOT NULL,
    UNIQUE(api_client_id, merchant_order_digest),
    UNIQUE(api_client_id, idempotency_key_digest)
  ) STRICT;

  CREATE TABLE archived_ledger_keys (
    ledger_entry_id TEXT PRIMARY KEY,
    archive_id TEXT NOT NULL REFERENCES history_archives(archive_id),
    provider_account_key TEXT NOT NULL,
    external_event_digest BLOB NOT NULL CHECK(length(external_event_digest) = 32),
    semantic_fingerprint TEXT NOT NULL,
    payment_settled INTEGER NOT NULL CHECK(payment_settled IN (0, 1)),
    UNIQUE(provider_account_key, external_event_digest)
  ) STRICT;

  CREATE TABLE archived_amount_slot_anchors (
    alipay_account_id TEXT NOT NULL,
    payable_amount_cents INTEGER NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    released_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    PRIMARY KEY(alipay_account_id, payable_amount_cents)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE archived_admin_operation_keys (
    operation_id TEXT PRIMARY KEY,
    archive_id TEXT NOT NULL REFERENCES history_archives(archive_id),
    audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(event_id)
  ) STRICT;

  CREATE TABLE archived_operation_keys (
    operation_kind TEXT NOT NULL CHECK(operation_kind IN ('FINANCIAL', 'LEDGER_CONFLICT')),
    operation_id TEXT NOT NULL,
    operation_key_digest BLOB NOT NULL CHECK(length(operation_key_digest) = 32),
    archive_id TEXT NOT NULL REFERENCES history_archives(archive_id),
    PRIMARY KEY(operation_kind, operation_id),
    UNIQUE(operation_kind, operation_key_digest)
  ) STRICT, WITHOUT ROWID;

  CREATE TRIGGER alipay_accounts_archived_history_guard
  BEFORE UPDATE OF deleted_at ON alipay_accounts
  WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    AND ${archivedAccountHistorySql("OLD.account_id")}
  BEGIN
    SELECT RAISE(ABORT, 'Alipay accounts with archived history cannot be deleted');
  END;

  CREATE TRIGGER history_archives_identity_immutable
  BEFORE UPDATE ON history_archives
  WHEN OLD.status != 'AVAILABLE' OR NEW.status != 'DELETED' OR NEW.deleted_at < OLD.created_at
    OR NEW.archive_id != OLD.archive_id OR NEW.created_at != OLD.created_at
    OR NEW.before_timestamp != OLD.before_timestamp OR NEW.schema_version != OLD.schema_version
    OR NEW.size_bytes != OLD.size_bytes OR NEW.sha256 != OLD.sha256
    OR NEW.order_count != OLD.order_count OR NEW.ledger_count != OLD.ledger_count
    OR NEW.record_count != OLD.record_count OR NEW.payment_match_event_count != OLD.payment_match_event_count
  BEGIN SELECT RAISE(ABORT, 'archive identity is immutable'); END;
  CREATE TRIGGER history_archives_no_delete BEFORE DELETE ON history_archives
  BEGIN SELECT RAISE(ABORT, 'archive deletion receipt must be retained'); END;
  CREATE TRIGGER archived_order_keys_no_update BEFORE UPDATE ON archived_order_keys
  BEGIN SELECT RAISE(ABORT, 'archived order identities are immutable'); END;
  CREATE TRIGGER archived_order_keys_no_delete BEFORE DELETE ON archived_order_keys
  BEGIN SELECT RAISE(ABORT, 'archived order identities cannot be reused'); END;
  CREATE TRIGGER archived_ledger_keys_no_update BEFORE UPDATE ON archived_ledger_keys
  BEGIN SELECT RAISE(ABORT, 'archived ledger identities are immutable'); END;
  CREATE TRIGGER archived_ledger_keys_no_delete BEFORE DELETE ON archived_ledger_keys
  BEGIN SELECT RAISE(ABORT, 'archived ledger identities cannot be reused'); END;
  CREATE TRIGGER archived_admin_operation_keys_no_update BEFORE UPDATE ON archived_admin_operation_keys
  BEGIN SELECT RAISE(ABORT, 'archived administrator operations are immutable'); END;
  CREATE TRIGGER archived_admin_operation_keys_no_delete BEFORE DELETE ON archived_admin_operation_keys
  BEGIN SELECT RAISE(ABORT, 'archived administrator operations cannot be reused'); END;
  CREATE TRIGGER admin_operation_log_archived_identity_guard BEFORE INSERT ON admin_operation_log
  WHEN EXISTS (SELECT 1 FROM archived_admin_operation_keys WHERE operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'archived administrator operation identity cannot be reused'); END;
  CREATE TRIGGER archived_operation_keys_no_update BEFORE UPDATE ON archived_operation_keys
  BEGIN SELECT RAISE(ABORT, 'archived operation identities are immutable'); END;
  CREATE TRIGGER archived_operation_keys_no_delete BEFORE DELETE ON archived_operation_keys
  BEGIN SELECT RAISE(ABORT, 'archived operation identities cannot be reused'); END;
  CREATE TRIGGER financial_operations_archived_identity_guard BEFORE INSERT ON financial_operations
  WHEN EXISTS (SELECT 1 FROM archived_operation_keys WHERE operation_kind = 'FINANCIAL' AND operation_id = NEW.financial_operation_id)
  BEGIN SELECT RAISE(ABORT, 'archived financial operation identity cannot be reused'); END;
  CREATE TRIGGER ledger_conflict_operations_archived_identity_guard BEFORE INSERT ON ledger_conflict_operations
  WHEN EXISTS (SELECT 1 FROM archived_operation_keys WHERE operation_kind = 'LEDGER_CONFLICT' AND operation_id = NEW.conflict_operation_id)
  BEGIN SELECT RAISE(ABORT, 'archived conflict operation identity cannot be reused'); END;
  CREATE TRIGGER archived_amount_slot_anchors_monotonic BEFORE UPDATE ON archived_amount_slot_anchors
  WHEN NEW.alipay_account_id != OLD.alipay_account_id OR NEW.payable_amount_cents != OLD.payable_amount_cents
    OR NEW.generation <= OLD.generation OR NEW.released_at < OLD.released_at
  BEGIN SELECT RAISE(ABORT, 'archived amount slot generations must advance'); END;
  CREATE TRIGGER archived_amount_slot_anchors_no_delete BEFORE DELETE ON archived_amount_slot_anchors
  BEGIN SELECT RAISE(ABORT, 'archived amount slot generations cannot be reused'); END;

  DROP TRIGGER amount_slots_generation_step;
  CREATE TRIGGER amount_slots_generation_step BEFORE INSERT ON amount_slots
  WHEN NEW.generation != MAX(
    COALESCE((SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id
      AND payable_amount_cents = NEW.payable_amount_cents), 0),
    COALESCE((SELECT generation FROM archived_amount_slot_anchors WHERE alipay_account_id = NEW.alipay_account_id
      AND payable_amount_cents = NEW.payable_amount_cents), 0)
  ) + 1
  BEGIN SELECT RAISE(ABORT, 'amount slot generation must advance exactly once'); END;

  CREATE TRIGGER amount_slots_archived_cooldown_guard BEFORE INSERT ON amount_slots
  WHEN EXISTS (SELECT 1 FROM archived_amount_slot_anchors WHERE alipay_account_id = NEW.alipay_account_id
    AND payable_amount_cents = NEW.payable_amount_cents AND available_at > NEW.occupied_from)
  BEGIN SELECT RAISE(ABORT, 'archived amount slot is still cooling down'); END;
`;
