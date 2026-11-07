// SPDX-License-Identifier: MIT
import { createHash, createPublicKey } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Applies to live databases and offline backup inspection without decrypting secrets. */
export function countEpayDomainViolations(connection: DatabaseSync): number {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'epay_sites'").get()) return 0;
  const count = (sql: string): number => Number(connection.prepare(sql).get()!.total);
  let violations = count(`SELECT count(*) AS total FROM sites AS site
    LEFT JOIN epay_sites AS epay ON epay.site_id = site.client_id WHERE epay.site_id IS NULL`);
  violations += count(`SELECT count(*) AS total FROM epay_sites AS epay WHERE
    (epay.v1_enabled = 1 AND NOT EXISTS(SELECT 1 FROM epay_credentials WHERE site_id = epay.site_id AND purpose = 'v1_key' AND retired_at IS NULL))
    OR (epay.v2_enabled = 1 AND (SELECT count(*) FROM epay_credentials
      WHERE site_id = epay.site_id AND purpose IN ('v2_merchant','v2_platform') AND retired_at IS NULL) != 2)`);
  violations += count(`SELECT count(*) AS total FROM
    (SELECT key_version, row_number() OVER(PARTITION BY site_id, purpose ORDER BY key_version) AS expected FROM epay_credentials)
    WHERE key_version != expected`);
  violations += count(`SELECT count(*) AS total FROM epay_credentials AS current WHERE
    (current.retired_at IS NULL AND current.key_version !=
      (SELECT max(key_version) FROM epay_credentials WHERE site_id = current.site_id AND purpose = current.purpose))
    OR (current.retired_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM epay_credentials AS successor
      WHERE successor.site_id = current.site_id AND successor.purpose = current.purpose
        AND successor.key_version = current.key_version + 1 AND successor.created_at >= current.retired_at))`);
  violations += count(`SELECT count(*) AS total FROM epay_orders AS epay
    JOIN payment_orders AS orders ON orders.order_id = epay.order_id
    JOIN epay_sites AS merchant ON merchant.pid = epay.pid
    WHERE epay.site_id != orders.api_client_id OR merchant.site_id != epay.site_id OR epay.created_at != orders.created_at`);
  violations += count(`SELECT CASE WHEN EXISTS(SELECT 1 FROM epay_credentials)
    AND (SELECT count(*) FROM runtime_master_key_guard) != 1 THEN 1 ELSE 0 END AS total`);
  const keys = connection.prepare("SELECT public_key, public_fingerprint FROM epay_credentials WHERE public_key IS NOT NULL").all() as Array<{ public_key: string; public_fingerprint: string }>;
  for (const row of keys) {
    try {
      const key = createPublicKey(row.public_key);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
          createHash("sha256").update(row.public_key).digest("hex") !== row.public_fingerprint) violations++;
    } catch { violations++; }
  }
  return violations;
}
