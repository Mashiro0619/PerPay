import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../src/database/database.ts";
import { normalizeProviderIdentity } from "../src/ledger/model.ts";
import { bindProviderIdentityInTransaction } from "../src/ledger/store.ts";
import { SANDBOX_PROVIDER_ENDPOINT } from "../src/settings/model.ts";

/** Seed the persisted state of an older release without reopening a sandbox write API. */
export function seedHistoricalSandboxAccount(database: AppDatabase, accountId: string, appId?: string): void {
  database.write(connection => {
    const account = connection.prepare("SELECT app_id, updated_at FROM alipay_accounts WHERE account_id=?").get(accountId)!;
    const now = Math.max(Date.now(), Number(account.updated_at));
    const identity = normalizeProviderIdentity({ providerAccountKey: "alipay:" + randomUUID(), providerKind: "alipay",
      endpoint: SANDBOX_PROVIDER_ENDPOINT, externalAccountId: appId ?? String(account.app_id) });
    connection.prepare("INSERT INTO provider_account_bindings VALUES (?,?,?,?,?,?,?)").run(identity.providerAccountKey,
      identity.providerKind, identity.endpoint, identity.externalAccountId, identity.identityFingerprintVersion, identity.identityFingerprint, now);
    const previous = connection.prepare("SELECT MAX(created_at) AS time FROM alipay_account_generations WHERE account_id=?").get(accountId)!;
    connection.prepare("INSERT INTO alipay_account_generations VALUES (?,?,?)").run(identity.providerAccountKey, accountId, Math.max(now, Number(previous.time ?? 0) + 1));
    connection.prepare("UPDATE alipay_accounts SET environment='SANDBOX',app_id=?,provider_account_key=?,revision=revision+1,updated_at=? WHERE account_id=?")
      .run(identity.externalAccountId, identity.providerAccountKey, now, accountId);
    connection.prepare("UPDATE alipay_application_key_changes SET environment='SANDBOX',app_id=?,provider_account_key=? WHERE account_id=? AND state='PENDING'")
      .run(identity.externalAccountId, identity.providerAccountKey, accountId);
  });
}

/** Preserve the old singleton gateway and identity so migration and read paths see real legacy data. */
export function seedHistoricalSandboxProvider(database: AppDatabase, appId?: string): void {
  database.write(connection => {
    const row = connection.prepare("SELECT provider_app_id,updated_at FROM runtime_configuration WHERE singleton_key=1").get()!;
    const now = Math.max(Date.now(), Number(row.updated_at));
    const key = "source:" + randomUUID();
    const externalAccountId = appId ?? String(row.provider_app_id);
    bindProviderIdentityInTransaction(connection, { providerAccountKey: key, providerKind: "alipay",
      endpoint: SANDBOX_PROVIDER_ENDPOINT, externalAccountId }, now);
    connection.prepare("UPDATE runtime_configuration SET provider_environment='SANDBOX',provider_app_id=?,provider_account_key=?,revision=revision+1,payment_revision=payment_revision+1,updated_at=? WHERE singleton_key=1")
      .run(externalAccountId, key, now);
  });
}
