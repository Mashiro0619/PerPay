// SPDX-License-Identifier: MIT
export const EPAY_SCHEMA_SQL = String.raw`
CREATE TABLE epay_sites (
  pid INTEGER PRIMARY KEY AUTOINCREMENT CHECK(pid BETWEEN 1 AND 9007199254740991),
  site_id TEXT NOT NULL UNIQUE REFERENCES sites(client_id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  v1_enabled INTEGER NOT NULL DEFAULT 0 CHECK(v1_enabled IN (0, 1)),
  v2_enabled INTEGER NOT NULL DEFAULT 0 CHECK(v2_enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
INSERT INTO sqlite_sequence(name, seq) VALUES ('epay_sites', 1000);
INSERT INTO epay_sites(site_id, created_at, updated_at)
SELECT client_id, created_at, created_at FROM sites ORDER BY created_at, client_id;
CREATE TRIGGER sites_assign_epay_pid AFTER INSERT ON sites
BEGIN
  INSERT INTO epay_sites(site_id, created_at, updated_at) VALUES (NEW.client_id, NEW.created_at, NEW.created_at);
END;
CREATE TRIGGER epay_sites_update_guard BEFORE UPDATE ON epay_sites
WHEN NEW.pid != OLD.pid OR NEW.site_id != OLD.site_id OR NEW.created_at != OLD.created_at
 OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'epay site identity or revision is invalid'); END;
CREATE TRIGGER epay_sites_no_delete BEFORE DELETE ON epay_sites
BEGIN SELECT RAISE(ABORT, 'epay merchant identities are permanently reserved'); END;

CREATE TABLE epay_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL CHECK(length(credential_id) = 36),
  site_id TEXT NOT NULL REFERENCES sites(client_id),
  purpose TEXT NOT NULL CHECK(purpose IN ('v1_key', 'v2_merchant', 'v2_platform')),
  key_version INTEGER NOT NULL CHECK(key_version >= 1),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  public_key TEXT,
  public_fingerprint TEXT CHECK(public_fingerprint IS NULL OR
    (length(public_fingerprint) = 64 AND public_fingerprint NOT GLOB '*[^0-9a-f]*')),
  cipher_version INTEGER NOT NULL CHECK(cipher_version = 1),
  nonce BLOB NOT NULL CHECK(typeof(nonce) = 'blob' AND length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK(typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 1 AND 32768),
  authentication_tag BLOB NOT NULL CHECK(typeof(authentication_tag) = 'blob' AND length(authentication_tag) = 16),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  retired_at INTEGER CHECK(retired_at IS NULL OR retired_at >= created_at),
  UNIQUE(site_id, purpose, key_version),
  CHECK((purpose = 'v1_key' AND public_key IS NULL AND public_fingerprint IS NULL)
    OR (purpose != 'v1_key' AND public_key IS NOT NULL AND public_fingerprint IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX epay_credentials_current ON epay_credentials(site_id, purpose) WHERE retired_at IS NULL;
CREATE TRIGGER epay_credentials_retirement_guard BEFORE UPDATE ON epay_credentials
WHEN NEW.credential_id != OLD.credential_id OR NEW.site_id != OLD.site_id OR NEW.purpose != OLD.purpose
 OR NEW.key_version != OLD.key_version OR NEW.fingerprint != OLD.fingerprint
 OR NEW.public_key IS NOT OLD.public_key OR NEW.public_fingerprint IS NOT OLD.public_fingerprint
 OR NEW.cipher_version != OLD.cipher_version OR NEW.nonce != OLD.nonce OR NEW.ciphertext != OLD.ciphertext
 OR NEW.authentication_tag != OLD.authentication_tag OR NEW.created_at != OLD.created_at
 OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
BEGIN SELECT RAISE(ABORT, 'epay credentials can only be retired once'); END;
CREATE TRIGGER epay_credentials_no_delete BEFORE DELETE ON epay_credentials
BEGIN SELECT RAISE(ABORT, 'epay credential history is immutable'); END;

CREATE TABLE epay_orders (
  trade_no INTEGER PRIMARY KEY AUTOINCREMENT CHECK(trade_no BETWEEN 1 AND 9007199254740991),
  order_id TEXT NOT NULL UNIQUE REFERENCES payment_orders(order_id),
  site_id TEXT NOT NULL REFERENCES sites(client_id),
  pid INTEGER NOT NULL REFERENCES epay_sites(pid),
  protocol TEXT NOT NULL CHECK(protocol IN ('epay_v1', 'epay_v2')),
  param TEXT CHECK(param IS NULL OR length(CAST(param AS BLOB)) <= 4096),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  return_url TEXT CHECK(return_url IS NULL OR length(CAST(return_url AS BLOB)) <= 4096),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX epay_orders_site_created ON epay_orders(site_id, created_at DESC, trade_no DESC);
CREATE TRIGGER epay_orders_insert_guard BEFORE INSERT ON epay_orders
WHEN NOT EXISTS (SELECT 1 FROM payment_orders AS orders JOIN epay_sites AS merchant ON merchant.site_id = orders.api_client_id
  WHERE orders.order_id = NEW.order_id AND orders.api_client_id = NEW.site_id AND merchant.pid = NEW.pid
    AND orders.created_at = NEW.created_at)
 OR EXISTS (SELECT 1 FROM order_events WHERE order_id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'epay metadata must belong to an uncommitted order'); END;
CREATE TRIGGER epay_orders_no_update BEFORE UPDATE ON epay_orders
BEGIN SELECT RAISE(ABORT, 'epay order metadata is immutable'); END;
CREATE TRIGGER epay_orders_no_delete BEFORE DELETE ON epay_orders
BEGIN SELECT RAISE(ABORT, 'epay order metadata is immutable'); END;
`;
