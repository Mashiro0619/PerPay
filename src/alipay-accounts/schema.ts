/** Schema 37: account identities are separate from immutable provider generations. */
export const ALIPAY_ACCOUNTS_SCHEMA_SQL = String.raw`
PRAGMA defer_foreign_keys = ON;
CREATE TABLE alipay_accounts (
 account_id TEXT PRIMARY KEY CHECK(length(account_id) BETWEEN 3 AND 64),
 revision INTEGER NOT NULL CHECK(revision >= 0),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 code_payload TEXT,
 environment TEXT NOT NULL CHECK(environment IN ('PRODUCTION','SANDBOX')),
 app_id TEXT,
 provider_account_key TEXT REFERENCES provider_account_bindings(provider_account_key),
 created_at INTEGER NOT NULL CHECK(created_at >= 0),
 updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
 UNIQUE(environment, app_id)
) STRICT;
CREATE TABLE alipay_account_generations (
 provider_account_key TEXT PRIMARY KEY REFERENCES provider_account_bindings(provider_account_key),
 account_id TEXT NOT NULL REFERENCES alipay_accounts(account_id),
 created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX alipay_account_generations_account_idx ON alipay_account_generations(account_id, provider_account_key);
CREATE TABLE alipay_account_secrets (
 account_id TEXT NOT NULL REFERENCES alipay_accounts(account_id),
 secret_name TEXT NOT NULL CHECK(secret_name IN ('private_key','public_key')),
 secret_version INTEGER NOT NULL CHECK(secret_version >= 1),
 cipher_version INTEGER NOT NULL CHECK(cipher_version = 1),
 nonce BLOB NOT NULL CHECK(length(nonce) = 12),
 ciphertext BLOB NOT NULL,
 authentication_tag BLOB NOT NULL CHECK(length(authentication_tag) = 16),
 secret_fingerprint TEXT NOT NULL CHECK(length(secret_fingerprint) = 64),
 updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
 PRIMARY KEY(account_id, secret_name)
) STRICT;
CREATE TABLE alipay_application_key_changes (
 change_id TEXT PRIMARY KEY CHECK(length(change_id) = 36),
 account_id TEXT NOT NULL REFERENCES alipay_accounts(account_id),
 requested_revision INTEGER NOT NULL CHECK(requested_revision >= 0),
 base_fingerprint TEXT NOT NULL CHECK(length(base_fingerprint) = 64),
 new_fingerprint TEXT NOT NULL CHECK(length(new_fingerprint) = 64),
 provider_account_key TEXT REFERENCES provider_account_bindings(provider_account_key),
 app_id TEXT, environment TEXT CHECK(environment IN ('PRODUCTION','SANDBOX')),
 state TEXT NOT NULL CHECK(state IN ('PENDING','ACTIVATED','DISCARDED')),
 cipher_version INTEGER, nonce BLOB, ciphertext BLOB, authentication_tag BLOB,
 created_at INTEGER NOT NULL CHECK(created_at >= 0), finished_revision INTEGER, finished_at INTEGER,
 CHECK((state = 'PENDING' AND cipher_version = 1 AND length(nonce) = 12 AND ciphertext IS NOT NULL AND length(authentication_tag) = 16 AND finished_revision IS NULL AND finished_at IS NULL)
 OR (state != 'PENDING' AND cipher_version IS NULL AND nonce IS NULL AND ciphertext IS NULL AND authentication_tag IS NULL AND finished_revision IS NOT NULL AND finished_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX alipay_application_key_pending_idx ON alipay_application_key_changes(account_id) WHERE state = 'PENDING';
CREATE TABLE alipay_account_checks (
 account_id TEXT PRIMARY KEY REFERENCES alipay_accounts(account_id),
 revision INTEGER NOT NULL CHECK(revision >= 0),
 ok INTEGER NOT NULL CHECK(ok IN (0,1)), checked_at INTEGER NOT NULL CHECK(checked_at >= 0),
 message TEXT NOT NULL
) STRICT;
CREATE TRIGGER alipay_accounts_revision_guard BEFORE UPDATE ON alipay_accounts
WHEN NEW.account_id != OLD.account_id OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'Alipay account revision is invalid'); END;

ALTER TABLE collection_profiles ADD COLUMN alipay_account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE payment_orders ADD COLUMN alipay_account_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX payment_orders_alipay_account_idx ON payment_orders(alipay_account_id, created_at DESC, order_id DESC);
CREATE TRIGGER payment_orders_alipay_account_immutable BEFORE UPDATE OF alipay_account_id ON payment_orders
BEGIN SELECT RAISE(ABORT, 'order Alipay account is immutable'); END;
DROP INDEX payment_orders_one_open_amount;
CREATE UNIQUE INDEX payment_orders_one_open_amount ON payment_orders(alipay_account_id,payable_amount_cents) WHERE checkout_status = 'OPEN';

CREATE TEMP TABLE perpay_v37_amount_slots AS SELECT * FROM amount_slots;
DROP TABLE amount_slots;
CREATE TABLE amount_slots (
 slot_id TEXT PRIMARY KEY CHECK(length(slot_id) = 36),
 order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
 collection_profile_id TEXT NOT NULL REFERENCES collection_profiles(profile_id),
 payable_amount_cents INTEGER NOT NULL CHECK(payable_amount_cents BETWEEN 2 AND 9999999999),
 generation INTEGER NOT NULL CHECK(generation >= 1),
 occupied_from INTEGER NOT NULL CHECK(occupied_from >= 0),
 released_at INTEGER, release_reason TEXT CHECK(release_reason IN ('CLOSED','EXPIRED')),
 alipay_account_id TEXT NOT NULL DEFAULT 'default',
 UNIQUE(alipay_account_id,payable_amount_cents,generation),
 CHECK(released_at IS NULL OR released_at >= occupied_from),
 CHECK((released_at IS NULL) = (release_reason IS NULL))
) STRICT;
INSERT INTO amount_slots(slot_id,order_id,collection_profile_id,payable_amount_cents,generation,occupied_from,released_at,release_reason)
 SELECT slot_id,order_id,collection_profile_id,payable_amount_cents,generation,occupied_from,released_at,release_reason FROM perpay_v37_amount_slots;
DROP TABLE perpay_v37_amount_slots;
CREATE UNIQUE INDEX amount_slots_one_active_amount ON amount_slots(alipay_account_id,payable_amount_cents) WHERE released_at IS NULL;
CREATE INDEX amount_slots_order_interval_idx ON amount_slots(order_id,occupied_from,released_at);
CREATE INDEX amount_slots_matching_interval_idx ON amount_slots(collection_profile_id,payable_amount_cents,occupied_from,released_at,generation);
CREATE TRIGGER amount_slots_valid_insert BEFORE INSERT ON amount_slots
WHEN NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL OR NOT EXISTS (
 SELECT 1 FROM payment_orders AS orders WHERE orders.order_id = NEW.order_id
 AND orders.collection_profile_id = NEW.collection_profile_id AND orders.payable_amount_cents = NEW.payable_amount_cents
 AND orders.alipay_account_id = NEW.alipay_account_id AND orders.eligible_from = NEW.occupied_from AND orders.checkout_status = 'OPEN')
BEGIN SELECT RAISE(ABORT, 'new amount slot must match an open order'); END;
CREATE TRIGGER amount_slots_generation_step BEFORE INSERT ON amount_slots
WHEN NEW.generation != COALESCE((SELECT MAX(generation)+1 FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id AND payable_amount_cents = NEW.payable_amount_cents),1)
BEGIN SELECT RAISE(ABORT, 'amount slot generation must advance exactly once'); END;
CREATE TRIGGER amount_slots_no_overlap BEFORE INSERT ON amount_slots
WHEN EXISTS (SELECT 1 FROM amount_slots AS previous WHERE previous.alipay_account_id = NEW.alipay_account_id
 AND previous.payable_amount_cents = NEW.payable_amount_cents
 AND previous.generation = (SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id AND payable_amount_cents = NEW.payable_amount_cents)
 AND (previous.released_at IS NULL OR previous.released_at > NEW.occupied_from))
BEGIN SELECT RAISE(ABORT, 'amount slot intervals cannot overlap'); END;
CREATE TRIGGER amount_slots_cooldown_guard BEFORE INSERT ON amount_slots
WHEN EXISTS (SELECT 1 FROM amount_slots AS previous JOIN payment_orders AS orders ON orders.order_id = previous.order_id
 WHERE previous.alipay_account_id = NEW.alipay_account_id AND previous.payable_amount_cents = NEW.payable_amount_cents
 AND previous.generation = (SELECT MAX(generation) FROM amount_slots WHERE alipay_account_id = NEW.alipay_account_id AND payable_amount_cents = NEW.payable_amount_cents)
 AND previous.released_at IS NOT NULL AND NEW.occupied_from < (CASE WHEN orders.checkout_status = 'EXPIRED' THEN orders.expires_at ELSE orders.closed_at END + orders.amount_reuse_cooldown_seconds * 1000))
BEGIN SELECT RAISE(ABORT, 'amount slot is still cooling down'); END;
CREATE TRIGGER amount_slots_release_only BEFORE UPDATE ON amount_slots
WHEN OLD.slot_id IS NOT NEW.slot_id OR OLD.order_id IS NOT NEW.order_id OR OLD.collection_profile_id IS NOT NEW.collection_profile_id
 OR OLD.alipay_account_id IS NOT NEW.alipay_account_id OR OLD.payable_amount_cents IS NOT NEW.payable_amount_cents OR OLD.generation IS NOT NEW.generation
 OR OLD.occupied_from IS NOT NEW.occupied_from OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.release_reason IS NULL
 OR NOT EXISTS (SELECT 1 FROM payment_orders AS orders WHERE orders.order_id = NEW.order_id AND orders.checkout_status = NEW.release_reason AND orders.closed_at = NEW.released_at)
BEGIN SELECT RAISE(ABORT, 'amount slots can only be released once'); END;
CREATE TRIGGER amount_slots_no_delete BEFORE DELETE ON amount_slots
BEGIN SELECT RAISE(ABORT, 'amount slot history cannot be deleted'); END;
`;
