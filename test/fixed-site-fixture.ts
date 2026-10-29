import type { AppDatabase } from "../src/database/database.ts";
import { IdentityTransaction } from "../src/database/identity-store.ts";
import { SiteStore } from "../src/sites/store.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

/** Low-level store tests use a known identity, without manufacturing API credentials. */
export function seedFixedSite(database: AppDatabase, clientId: string, now: number, masterKey: Uint8Array = Buffer.alloc(32, 7)) {
  new RuntimeSettingsStore(database, masterKey).initialize();
  const sites = new SiteStore(database, masterKey);
  const configuration = { name: "Store test website", accepting_orders: true,
    notifications_enabled: false, notification_origin: null, return_origin: null,
    collection: { mode: "FIXED", accounts: [{ account_id: "default", weight: 1 }] },
    policy: sites.defaults().policy };
  database.write(connection => {
    connection.prepare(`INSERT OR IGNORE INTO alipay_accounts(account_id,revision,name,enabled,code_payload,environment,app_id,provider_account_key,created_at,updated_at)
      VALUES ('default',0,'Store test account',1,NULL,'PRODUCTION',NULL,NULL,?,?)`).run(now,now);
    new IdentityTransaction(connection).ensureApiClientIdentity(clientId, now);
    connection.prepare("INSERT INTO sites(client_id, revision, configuration, created_at, updated_at, deleted_at) VALUES (?, 0, ?, ?, ?, NULL)")
      .run(clientId, JSON.stringify(configuration), now, now);
  });
}
