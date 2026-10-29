import type { DatabaseSync } from "node:sqlite";
import { siteClientIdSchema, siteConfigurationSchema, sitePolicySchema } from "./model.ts";

/** Domain validation for schema 34; older compatible backups have no site tables. */
export function countSiteDomainViolations(connection: DatabaseSync): number {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sites'").get()) return 0;
  let violations = 0;
  const templates = connection.prepare("SELECT policy FROM site_defaults").all() as Array<{ policy: string }>;
  if (templates.length !== 1) violations++;
  for (const row of templates) {
    try { if (!sitePolicySchema.safeParse(JSON.parse(row.policy)).success) violations++; }
    catch { violations++; }
  }
  const sites = connection.prepare("SELECT client_id, configuration FROM sites").all() as Array<{ client_id: string; configuration: string }>;
  const accountsAvailable = !!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'alipay_accounts'").get();
  for (const row of sites) {
    if (!siteClientIdSchema.safeParse(row.client_id).success) violations++;
    try {
      const parsed = siteConfigurationSchema.safeParse(JSON.parse(row.configuration));
      if (!parsed.success) violations++;
      else if (accountsAvailable) {
        if (!parsed.data.collection) violations++;
        else for (const account of parsed.data.collection.accounts) {
          if (!connection.prepare("SELECT 1 FROM alipay_accounts WHERE account_id = ?").get(account.account_id)) violations++;
        }
      }
    }
    catch { violations++; }
  }
  const count = (sql: string): number => Number((connection.prepare(sql).get() as { total: number | bigint }).total);
  violations += count(
    "SELECT count(*) AS total FROM api_client_config AS identity LEFT JOIN sites AS site ON site.client_id = identity.client_id WHERE site.client_id IS NULL OR (site.deleted_at IS NOT NULL AND identity.enabled != 0)",
  );
  violations += count(
    "SELECT count(*) AS total FROM sites AS site WHERE site.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM payment_orders WHERE api_client_id = site.client_id)",
  );
  violations += count(
    "SELECT count(*) AS total FROM api_client_config AS identity LEFT JOIN site_secrets AS secret ON secret.client_id = identity.client_id AND secret.secret_name = 'api_secret' WHERE identity.enabled = 1 AND (secret.secret_fingerprint IS NULL OR secret.secret_fingerprint != identity.secret_fingerprint)",
  );
  violations += count(
    "SELECT count(*) AS total FROM sites AS site LEFT JOIN site_secrets AS secret ON secret.client_id = site.client_id AND secret.secret_name = 'webhook_secret' WHERE json_extract(site.configuration, '$.notifications_enabled') = 1 AND secret.client_id IS NULL",
  );
  violations += count(
    "SELECT count(*) AS total FROM site_secrets AS secret LEFT JOIN webhook_signing_keys AS key ON key.client_id = secret.client_id AND key.retired_at IS NULL WHERE secret.secret_name = 'webhook_secret' AND (key.key_version IS NULL OR key.secret_fingerprint != secret.secret_fingerprint)",
  );
  violations += count(
    "SELECT count(*) AS total FROM (SELECT key_version, row_number() OVER (ORDER BY key_version) AS expected FROM webhook_signing_keys) WHERE key_version != expected",
  );
  violations += count(
    "SELECT count(*) AS total FROM (SELECT site_key_version, row_number() OVER (PARTITION BY client_id ORDER BY site_key_version) AS expected FROM webhook_signing_keys) WHERE site_key_version != expected",
  );
  violations += count(
    "SELECT count(*) AS total FROM (SELECT client_id FROM webhook_signing_keys WHERE retired_at IS NULL GROUP BY client_id HAVING count(*) > 1)",
  );
  violations += count(
    "SELECT count(*) AS total FROM webhook_signing_keys AS active WHERE active.retired_at IS NULL AND active.site_key_version != (SELECT max(site_key_version) FROM webhook_signing_keys WHERE client_id = active.client_id)",
  );
  violations += count(
    "SELECT count(*) AS total FROM webhook_signing_keys AS prior JOIN webhook_signing_keys AS next ON next.client_id = prior.client_id AND next.site_key_version = prior.site_key_version + 1 WHERE prior.retired_at IS NULL OR prior.retired_at > next.activated_at",
  );
  violations += count(
    "SELECT count(*) AS total FROM webhook_attempts AS attempt JOIN webhook_signing_keys AS key ON key.key_version = attempt.key_version JOIN webhook_deliveries AS delivery ON delivery.delivery_id = attempt.delivery_id JOIN webhook_targets AS target ON target.target_id = delivery.target_id WHERE key.client_id != target.api_client_id",
  );
  return violations;
}
