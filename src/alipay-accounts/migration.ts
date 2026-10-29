import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher, type EncryptedSecret } from "../settings/crypto.ts";

interface CipherRow { cipher_version: number | bigint; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array }
const encrypted = (row: CipherRow): EncryptedSecret => ({ cipherVersion: Number(row.cipher_version) as 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });

/** Runs atomically with schema 37, including account-bound encryption of legacy keys. */
export function migrateAlipayAccounts(connection: DatabaseSync, masterKey?: Uint8Array): void {
  if (!connection.isTransaction) throw new Error("Alipay account migration requires a transaction");
  const config = connection.prepare("SELECT * FROM runtime_configuration WHERE singleton_key = 1").get() as {
    revision: number | bigint; collection_code_payload: string | null; provider_environment: string | null;
    provider_app_id: string | null; provider_account_key: string | null; updated_at: number | bigint;
  };
  const hasState = config.collection_code_payload !== null || config.provider_app_id !== null || Boolean(connection.prepare(
    "SELECT 1 FROM runtime_secrets WHERE secret_name IN ('provider_private_key','provider_public_key') UNION ALL SELECT 1 FROM provider_account_bindings UNION ALL SELECT 1 FROM sites LIMIT 1",
  ).get());
  if (!hasState) return;
  connection.prepare(`INSERT INTO alipay_accounts(account_id,revision,name,enabled,code_payload,environment,app_id,provider_account_key,created_at,updated_at)
    VALUES ('default',?,'默认支付宝账号',1,?,?,?,?,?,?)`).run(config.revision, config.collection_code_payload,
    config.provider_environment ?? "PRODUCTION", config.provider_app_id, config.provider_account_key, config.updated_at, config.updated_at);
  connection.prepare("INSERT INTO alipay_account_generations(provider_account_key,account_id,created_at) SELECT provider_account_key,'default',bound_at FROM provider_account_bindings").run();

  const rows = connection.prepare("SELECT * FROM runtime_secrets WHERE secret_name IN ('provider_private_key','provider_public_key')").all() as unknown as Array<CipherRow & {
    secret_name: "provider_private_key" | "provider_public_key"; secret_version: number | bigint; secret_fingerprint: string; updated_at: number | bigint;
  }>;
  const changes = connection.prepare("SELECT * FROM provider_application_key_changes").all() as unknown as Array<CipherRow & {
    change_id: string; requested_revision: number | bigint; base_fingerprint: string; new_fingerprint: string;
    provider_account_key: string | null; app_id: string | null; environment: string | null; state: string;
    created_at: number | bigint; finished_revision: number | bigint | null; finished_at: number | bigint | null;
  }>;
  const hasEncrypted = rows.length > 0 || changes.some(row => row.state === "PENDING");
  if (hasEncrypted && !masterKey) throw new Error("PERPAY_MASTER_KEY is required to migrate this database");
  const instanceId = String(connection.prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'").get()!.value);
  const cipher = masterKey ? new RuntimeSecretCipher(masterKey, instanceId) : null;
  if (hasEncrypted) {
    const guard = connection.prepare("SELECT * FROM runtime_master_key_guard WHERE singleton_key = 1").get() as unknown as CipherRow | undefined;
    if (!guard) throw new Error("master key guard is missing while encrypted settings exist");
    cipher!.verifyGuard(encrypted(guard));
  }
  for (const row of rows) {
    const purpose = row.secret_name === "provider_private_key" ? "private_key" : "public_key";
    const value = cipher!.decrypt(row.secret_name, Number(row.secret_version), encrypted(row));
    try {
      const next = cipher!.encrypt(`alipay:default:${purpose}`, Number(row.secret_version), value);
      connection.prepare("INSERT INTO alipay_account_secrets VALUES ('default',?,?,?,?,?,?,?,?)").run(
        purpose, row.secret_version, next.cipherVersion, next.nonce, next.ciphertext, next.authenticationTag, row.secret_fingerprint, row.updated_at,
      );
    } finally { value.fill(0); }
  }
  for (const row of changes) {
    let next: EncryptedSecret | null = null;
    if (row.state === "PENDING") {
      const value = cipher!.decrypt(`provider_application_key_change:${row.change_id}`, 1, encrypted(row));
      try { next = cipher!.encrypt(`alipay:default:key_change:${row.change_id}`, 1, value); }
      finally { value.fill(0); }
    }
    connection.prepare(`INSERT INTO alipay_application_key_changes VALUES (?,'default',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.change_id,row.requested_revision,row.base_fingerprint,row.new_fingerprint,row.provider_account_key,row.app_id,row.environment,row.state,
      next?.cipherVersion ?? null,next?.nonce ?? null,next?.ciphertext ?? null,next?.authenticationTag ?? null,row.created_at,row.finished_revision,row.finished_at,
    );
  }
  // Preserve site revisions during migration, including sites which had been deleted.
  const siteGuard = connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'sites_revision_guard'").get() as {sql: string};
  connection.exec("DROP TRIGGER sites_revision_guard");
  connection.prepare(`UPDATE sites SET configuration = json_set(configuration,'$.collection',json('{"mode":"FIXED","accounts":[{"account_id":"default","weight":1}]}'))`).run();
  connection.exec(siteGuard.sql);
}
