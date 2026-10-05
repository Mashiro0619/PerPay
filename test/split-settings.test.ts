import { createSitePaymentFixture } from "./site-payment-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { collectionCodeInputSchema, providerApplicationInputSchema } from "../src/settings/model.ts";
import { collectionPolicyInputSchema } from "../src/settings/collection-policy.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

const audit = { actorId: "admin" };
function remove(directory: string) {
  const path = resolve(directory);
  assert.ok(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith("perpay-split-settings-"));
  rmSync(path, { recursive: true });
}
describe("separate instance settings responsibilities", () => {
  it("saves collection policy before any application or QR configuration exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-split-settings-"));
    const database = await AppDatabase.open(join(directory, "db.sqlite3"));
    try {
      const store = new RuntimeSettingsStore(database, Buffer.alloc(32, 8));
      const service = new RuntimeSettingsService({ store }); service.initialize();
      const policy = service.collectionPolicy();
      await service.saveCollectionPolicy({ ...policy, scan_interval_seconds: 30, maximum_success_age_seconds: 60 }, audit);
      assert.equal(store.snapshot().provider, null);
      assert.equal(store.snapshot().collection, null);
      assert.equal(service.collectionPolicy().scan_interval_seconds, 30);
      assert.equal(database.integrityCheck().ok, true);
    } finally { database.close(); remove(directory); }
  });
  it("does not write application keys, source identity or order policy when changing cadence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-split-settings-"));
    const f = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/split-settings" });
    try {
      const readUnrelated = () => f.database.read(connection => ({
        secrets: connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all(),
        identity: connection.prepare("SELECT * FROM provider_account_bindings ORDER BY provider_account_key").all(),
        collection: connection.prepare("SELECT collection_code_payload, order_ttl_seconds, amount_offset_maximum_cents, amount_reuse_cooldown_seconds FROM runtime_configuration").get(),
      }));
      const before = readUnrelated();
      const policy = f.settings.collectionPolicy();
      await f.settings.saveCollectionPolicy({ ...policy, scan_interval_seconds: 30, maximum_success_age_seconds: 60 }, audit);
      assert.deepEqual(readUnrelated(), before);
      assert.equal(f.settings.collectionPolicy().scan_interval_seconds, 30);
      await assert.rejects(f.settings.saveCollectionPolicy(policy, audit));
      assert.deepEqual(readUnrelated(), before);
    } finally { f.database.close(); remove(directory); }
  });
  it("updates the QR alone and preserves collection policy when saving the application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-split-settings-"));
    const f = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/old-code" });
    try {
      const before = f.settings.collectionPolicy();
      await f.settings.saveCollectionCode({ revision: before.revision, code_payload: "https://qr.alipay.com/new-code" }, audit);
      const afterQr = f.settings.collectionPolicy();
      assert.deepEqual({ ...afterQr, revision: before.revision }, before);
      assert.equal(f.settings.snapshot().collection?.codePayload, "https://qr.alipay.com/new-code");
      await f.settings.saveProviderApplication({ revision: afterQr.revision, environment: "PRODUCTION", app_id: "2026000000000001" }, audit);
      assert.deepEqual({ ...f.settings.collectionPolicy(), revision: before.revision }, before);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.database.close(); remove(directory); }
  });
  it("rejects mixed old fields rather than silently dropping other settings", () => {
    const application = { revision: 0, environment: "PRODUCTION", app_id: "2026000000000001" };
    assert.equal(providerApplicationInputSchema.safeParse(application).success, true);
    assert.equal(providerApplicationInputSchema.safeParse({ ...application, scan_interval_seconds: 8 }).success, false);
    const code = { revision: 0, code_payload: "https://qr.alipay.com/split-settings" };
    assert.equal(collectionCodeInputSchema.safeParse(code).success, true);
    assert.equal(collectionCodeInputSchema.safeParse({ ...code, order_ttl_seconds: 300 }).success, false);
    const policy = { revision: 0, timeout_milliseconds: 8000, scan_interval_seconds: 60, active_scan_interval_seconds: 8, minimum_scan_interval_seconds: 5, safety_lag_seconds: 10, maximum_success_age_seconds: 120 };
    assert.equal(collectionPolicyInputSchema.safeParse(policy).success, true);
    assert.equal(collectionPolicyInputSchema.safeParse({ ...policy, app_id: "2026000000000001" }).success, false);
    assert.equal(collectionPolicyInputSchema.safeParse({ ...policy, minimum_scan_interval_seconds: 9 }).success, false);
  });
});

it("saves split instance settings on schema 34 without rewriting any website policy or business secret", async () => {
  const f = await createSitePaymentFixture();
  try {
    const site = f.createSite("独立网站");
    f.sites.rotateSecret(site.clientId, "api_secret", site.revision, audit);
    const untouched = () => f.database.read(connection => ({
      sites: connection.prepare("SELECT * FROM sites ORDER BY client_id").all(),
      defaults: connection.prepare("SELECT * FROM site_defaults").all(),
      secrets: connection.prepare("SELECT * FROM site_secrets ORDER BY client_id, secret_name").all(),
    }));
    const before = untouched();
    const policy = f.settings.collectionPolicy();
    await f.settings.saveCollectionPolicy({ ...policy, scan_interval_seconds: 30, maximum_success_age_seconds: 60 }, audit);
    await f.settings.saveCollectionCode({ revision: f.settings.view().revision, code_payload: "https://qr.alipay.com/updated-site-code" }, audit);
    await f.settings.saveProviderApplication({ revision: f.settings.view().revision, environment: "PRODUCTION", app_id: "2026000000000001" }, audit);
    assert.deepEqual(untouched(), before);
    assert.equal(f.settings.collectionPolicy().scan_interval_seconds, 30);
  } finally { f.close(); }
});
