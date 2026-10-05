import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher, type EncryptedSecret, type SiteSecretPurpose } from "../../settings/crypto.ts";
import { fingerprintSecret, isCanonicalSecret } from "../../settings/model.ts";
import { fingerprintApiSecret } from "../../identity/service.ts";
import { SiteSecretCipher } from "../crypto.ts";
import { siteConfigurationSchema, sitePolicySchema } from "../model.ts";
import { syncSiteSigningKey } from "../store.ts";
import { countSiteDomainViolations } from "../integrity.ts";

interface CipherRow {
  cipher_version: number | bigint;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authentication_tag: Uint8Array;
}
function encrypted(row: CipherRow): EncryptedSecret {
  return { cipherVersion: Number(row.cipher_version) as 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) };
}

/** Must run inside the same transaction as MULTI_SITE_SCHEMA_SQL. */
export function migrateSiteData(connection: DatabaseSync, masterKey?: Uint8Array): void {
  if (!connection.isTransaction) throw new Error("website migration requires a transaction");
  const instance = connection.prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'").get() as { value: string } | undefined;
  if (!instance) throw new Error("database instance identity is missing");
  const guard = connection.prepare("SELECT * FROM runtime_master_key_guard WHERE singleton_key = 1").get() as unknown as CipherRow | undefined;
  const hasEncrypted = connection.prepare("SELECT 1 FROM perpay_v34_secrets UNION ALL SELECT 1 FROM provider_application_key_changes WHERE state = 'PENDING' LIMIT 1").get();
  if (!guard && hasEncrypted) throw new Error("master key guard is missing while encrypted settings exist");
  if (guard && !masterKey) throw new Error("PERPAY_MASTER_KEY is required to migrate this database");
  const legacy = masterKey ? new RuntimeSecretCipher(masterKey, instance.value) : null;
  if (guard) legacy!.verifyGuard(encrypted(guard));
  const rows = connection.prepare("SELECT * FROM perpay_v34_secrets WHERE secret_name IN ('api_secret', 'webhook_secret')").all() as unknown as Array<CipherRow & {
    secret_name: SiteSecretPurpose; secret_version: number | bigint; secret_fingerprint: string; updated_at: number | bigint;
  }>;
  for (const row of rows) {
    if (!legacy || !masterKey) throw new Error("master key is required for encrypted website settings");
    const version = Number(row.secret_version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("website secret version is invalid");
    const plaintext = legacy.decrypt(row.secret_name, version, encrypted(row));
    try {
      const value = plaintext.toString("utf8");
      const expected = row.secret_name === "api_secret" ? fingerprintApiSecret(value) : fingerprintSecret(value, "webhook-signing-key");
      if (!isCanonicalSecret(value) || expected !== row.secret_fingerprint) throw new Error("legacy business credential fingerprint is invalid");
      const next = new SiteSecretCipher(masterKey, instance.value).encrypt("default", row.secret_name, version, plaintext);
      connection.prepare(
        "INSERT INTO site_secrets(client_id, secret_name, secret_version, cipher_version, nonce, ciphertext, authentication_tag, secret_fingerprint, updated_at) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.secret_name, version, next.cipherVersion, next.nonce, next.ciphertext, next.authenticationTag, row.secret_fingerprint, row.updated_at);
      if (row.secret_name === "webhook_secret") syncSiteSigningKey(connection, "default", row.secret_fingerprint, Number(row.updated_at));
    } finally { plaintext.fill(0); }
  }
  for (const row of connection.prepare("SELECT configuration FROM sites").all() as Array<{ configuration: string }>) {
    siteConfigurationSchema.parse(JSON.parse(row.configuration));
  }
  const defaults = connection.prepare("SELECT policy FROM site_defaults WHERE singleton_key = 1").get() as { policy: string };
  sitePolicySchema.parse(JSON.parse(defaults.policy));
  if (connection.prepare("PRAGMA foreign_key_check").all().length) throw new Error("website migration foreign key violation");
  if (countSiteDomainViolations(connection) !== 0) throw new Error("website migration domain integrity violation");
  connection.exec("DROP TABLE perpay_v34_secrets");
}
