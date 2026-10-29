import { seedFixedSite } from "./fixed-site-fixture.ts";
import { SiteStore } from "../src/sites/store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { IdentityStore } from "../src/database/identity-store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { apiClientCredentialsDowngradeSql } from "./api-client-schema-fixture.ts";

describe("API client identity without credentials", () => {
  it("persists a disabled identity without key material, then issues version one after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-unissued-client-"));
    const path = join(directory, "database.sqlite3");
    let database = await AppDatabase.open(path);
    try {
      const now = Date.now();
      seedFixedSite(database, "default", now);
      new IdentityStore(database).transaction((identity) => {
        identity.ensureApiClientIdentity("default", now);
        identity.ensureApiClientIdentity("default", now + 1);
        assert.equal(identity.activeApiClient("default"), undefined);
      });
      database.read((connection) => {
        const row = connection.prepare("SELECT enabled, key_version, secret_fingerprint FROM api_client_config").get();
        assert.deepEqual({ ...row }, { enabled: 0n, key_version: null, secret_fingerprint: null });
        assert.equal(connection.prepare("SELECT 1 FROM api_client_keys").get(), undefined);
        assert.equal(connection.prepare("SELECT 1 FROM runtime_secrets WHERE secret_name = 'api_secret'").get(), undefined);
      });
      assert.equal(database.integrityCheck().ok, true);
      assert.throws(() => database.write((connection) => {
        connection.exec("UPDATE api_client_config SET enabled = 1");
      }), /CHECK constraint failed/);
      database.close();
      database = await AppDatabase.open(path);
      const sites = new SiteStore(database, Buffer.alloc(32, 7));
      const first = sites.rotateSecret("default", "api_secret", 0, { actorId: "admin" }, now - 100);
      assert.equal(sites.credential("default")?.keyVersion, 1);
      sites.rotateSecret("default", "api_secret", first.site.revision, { actorId: "admin" }, now + 2);
      assert.equal(sites.credential("default")?.keyVersion, 2);
      assert.equal(database.integrityCheck().ok, true);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-unissued-client-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates issued credentials without changing orders, nonces, key history or audit evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-client-identity-migration-"));
    const services = await createConfiguredLegacyHttpServices({
      directory,
      apiSecret: Buffer.alloc(32, 7).toString("base64url"),
      collectionCodePayload: "https://qr.alipay.com/client-identity-migration",
    });
    let reopened: AppDatabase | undefined;
    try {
      const rotatedSecret = Buffer.alloc(32, 8).toString("base64url");
      services.settingsStore.saveApiSecret(rotatedSecret, services.settings.view().revision, { actorId: "admin" });
      services.orders.create(createOrderRequestSchema.parse({
        idempotency_key: "identity-migration", merchant_order_no: "identity-migration",
        amount_cents: 100, product_name: "migration test",
      }));
      const credential = services.settings.apiCredential()!;
      assert.equal(credential.keyVersion, 2);
      const now = Date.now();
      new IdentityStore(services.database).transaction((identity) => {
        assert.equal(identity.consumeApiNonce("default", Buffer.alloc(32, 9).toString("base64url"),
          Math.floor(now / 1000), credential.keyVersion, credential.secretFingerprint, now), true);
      });
      const history = (database: AppDatabase) => database.read((connection) => ({
        client: connection.prepare("SELECT client_id, secret_fingerprint, key_version, enabled, created_at, updated_at FROM api_client_config").all(),
        keys: connection.prepare("SELECT * FROM api_client_keys ORDER BY key_version").all(),
        nonces: connection.prepare("SELECT * FROM api_nonces ORDER BY nonce").all(),
        orders: connection.prepare("SELECT * FROM payment_orders ORDER BY order_id").all(),
        events: connection.prepare("SELECT * FROM order_events ORDER BY event_id").all(),
        audit: connection.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
      }));
      const before = history(services.database);
      for (const row of before.orders) row.alipay_account_id = "default";
      services.database.close();
      const legacy = new DatabaseSync(services.config.databasePath);
      try {
        legacy.exec(`BEGIN IMMEDIATE; ${apiClientCredentialsDowngradeSql()} COMMIT;`);
      } finally { legacy.close(); }
      reopened = await AppDatabase.open(services.config.databasePath, { masterKey: services.config.masterKey });
      assert.deepEqual(history(reopened), before);
      assert.equal(reopened.integrityCheck().ok, true);
      const settings = new RuntimeSettingsStore(reopened, services.config.masterKey);
      settings.initialize();
      assert.equal(settings.siteStore()!.credential("default")?.secret, rotatedSecret);
      assert.equal(settings.siteStore()!.credential("default")?.keyVersion, 2);
    } finally {
      reopened?.close();
      services.database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-client-identity-migration-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
