import type { DatabaseSync } from "node:sqlite";
import { alipayAccountIdSchema } from "./model.ts";
import { RuntimeSecretCipher, type AlipayCipherSecretName } from "../settings/crypto.ts";
import { parseProviderApplicationPrivateKey, parsePlatformPublicKey, publicKeyFingerprint } from "../settings/model.ts";

/** Verify encrypted account material before startup or accepting a restore. */
export function verifyAlipayAccountSecrets(connection: DatabaseSync, cipher: RuntimeSecretCipher): void {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='alipay_accounts'").get()) return;
  type Row = {account_id:string;secret_name:string;secret_version:number|bigint;cipher_version:number|bigint;nonce:Uint8Array;ciphertext:Uint8Array;authentication_tag:Uint8Array;secret_fingerprint:string};
  const rows = connection.prepare(`SELECT account_id,secret_name,secret_version,cipher_version,nonce,ciphertext,authentication_tag,secret_fingerprint FROM alipay_account_secrets
    UNION ALL SELECT account_id,'key_change:'||change_id,1,cipher_version,nonce,ciphertext,authentication_tag,new_fingerprint FROM alipay_application_key_changes WHERE state='PENDING'`).all() as unknown as Row[];
  for (const row of rows) {
    const plaintext = cipher.decrypt(`alipay:${row.account_id}:${row.secret_name}` as AlipayCipherSecretName, Number(row.secret_version), {
      cipherVersion:Number(row.cipher_version) as 1,nonce:Buffer.from(row.nonce),ciphertext:Buffer.from(row.ciphertext),authenticationTag:Buffer.from(row.authentication_tag),
    });
    try {
      const pem = plaintext.toString("utf8");
      const fingerprint = row.secret_name === "public_key" ? publicKeyFingerprint(parsePlatformPublicKey(pem).publicKey) : parseProviderApplicationPrivateKey(pem).fingerprint;
      if (fingerprint !== row.secret_fingerprint) throw new Error("Alipay account key fingerprint is invalid");
    } finally { plaintext.fill(0); }
  }
}

export function countAlipayAccountDomainViolations(connection: DatabaseSync): number {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='alipay_accounts'").get()) return 0;
  let violations = 0;
  for (const account of connection.prepare("SELECT account_id,code_payload FROM alipay_accounts").all() as Array<{account_id:string;code_payload:string|null}>) {
    if (!alipayAccountIdSchema.safeParse(account.account_id).success) violations++;
  }
  const count = (sql: string) => Number((connection.prepare(sql).get() as {total:number|bigint}).total);
  violations += count(`SELECT count(*) AS total FROM alipay_accounts AS account WHERE account.provider_account_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM alipay_account_generations AS generation JOIN provider_account_bindings AS binding USING(provider_account_key)
    WHERE generation.account_id=account.account_id AND generation.provider_account_key=account.provider_account_key
    AND binding.external_account_id=account.app_id AND binding.provider_endpoint=CASE account.environment WHEN 'PRODUCTION' THEN 'https://openapi.alipay.com' ELSE 'https://openapi-sandbox.dl.alipaydev.com' END)`);
  violations += count(`SELECT count(*) AS total FROM alipay_application_key_changes AS change WHERE change.state='PENDING' AND NOT EXISTS (
    SELECT 1 FROM alipay_accounts AS account JOIN alipay_account_secrets AS secret ON secret.account_id=account.account_id AND secret.secret_name='private_key'
    WHERE account.account_id=change.account_id AND account.provider_account_key=change.provider_account_key AND account.app_id=change.app_id
    AND account.environment=change.environment AND secret.secret_fingerprint=change.base_fingerprint AND account.revision>change.requested_revision)`);
  violations += count(`SELECT CASE WHEN (EXISTS(SELECT 1 FROM alipay_account_secrets) OR EXISTS(SELECT 1 FROM alipay_application_key_changes WHERE state='PENDING'))
    AND NOT EXISTS(SELECT 1 FROM runtime_master_key_guard WHERE singleton_key=1) THEN 1 ELSE 0 END AS total`);
  violations += count(`SELECT count(*) AS total FROM payment_orders AS orders JOIN collection_profiles AS profile ON profile.profile_id=orders.collection_profile_id
    JOIN amount_slots AS slot ON slot.order_id=orders.order_id WHERE orders.alipay_account_id != profile.alipay_account_id OR slot.alipay_account_id != orders.alipay_account_id`);
  return violations;
}
