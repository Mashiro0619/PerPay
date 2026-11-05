// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assertIsolation, loadImageModules, seedBusinessData, captureSnapshot, verifyBusinessData, advanceBusinessData, verifyHttpIdentity } from "../scripts/validation/upgrade-fixture.mjs";
import { createApp } from "../src/http/app.ts";

describe("isolated cross-version business fixture", () => {
  it("refuses missing isolation and non-Linux command execution before accessing a volume", () => {
    assert.throws(() => assertIsolation({}, "linux"), /explicit_isolation_required/);
    assert.throws(() => assertIsolation({ PERPAY_UPGRADE_ISOLATED: "1" }, "win32"), /linux_container_required/);
    assert.throws(() => assertIsolation({ PERPAY_UPGRADE_ISOLATED: "1", PERPAY_UPGRADE_RUN_ID: "upgrade-test-20261105", PERPAY_DATA_DIR: "./data" }, "linux"), /isolated_volume_paths_required/);
  });

  it("seeds real services, preserves secret capabilities across reopen, and detects changed historical business rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-upgrade-fixture-"));
    const m = await loadImageModules(fileURLToPath(new URL("../src/", import.meta.url)), ".ts");
    const config = m.loadConfig({ PERPAY_MASTER_KEY: "42".repeat(32), PERPAY_DATA_DIR: join(directory, "data"), PERPAY_BACKUP_DIR: join(directory, "backups"), PERPAY_PUBLIC_URL: "http://127.0.0.1:6190" });
    let database;
    try {
      database = await m.AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
      const seeded = await seedBusinessData({ modules: m, database, config });
      const baseline = captureSnapshot(database, seeded.fixture, m.APP_VERSION);
      const serialized = JSON.stringify(baseline);
      for (const secret of [seeded.fixture.adminPassword, seeded.fixture.apiSecret, seeded.fixture.webhookSecret,
        ...Object.values(seeded.fixture.orders).map(order => order.checkoutToken)]) assert.equal(serialized.includes(secret), false);
      assert.ok(baseline.audit.length > 0);
      assert.equal(baseline.tables.payment_orders.rows.length, 2);
      database.close();
      database = await m.AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
      const verified = await verifyBusinessData({ modules: m, database, config, fixture: seeded.fixture, baseline, expectedSchema: 39 });
      assert.equal(verified.originalCredentialsVerified, true);
      assert.equal(verified.originalCheckoutTokensVerified, true);
      const advanced = await advanceBusinessData({ modules: m, database, config, fixture: seeded.fixture });
      assert.notEqual(advanced.orders.upgraded.orderId, seeded.fixture.orders.paid.orderId);
      const upgraded = captureSnapshot(database, advanced, m.APP_VERSION);
      assert.equal(upgraded.tables.payment_orders.rows.length, 3);
      assert.ok(upgraded.audit.length > baseline.audit.length);
      await verifyBusinessData({ modules: m, database, config, fixture: advanced, baseline: upgraded, expectedSchema: 39 });
      const settingsStore = new m.RuntimeSettingsStore(database, config.masterKey), sites = settingsStore.siteStore();
      const settings = new m.RuntimeSettingsService({ store: settingsStore });
      const identity = new m.IdentityService(database); await identity.initialize();
      const orders = new m.OrderService(database, () => settings.instanceSnapshot(), undefined, sites, seeded.siteId,
        { accounts: () => settingsStore.accountStore().snapshots() });
      const app = createApp({ config, database, identity, settings, sites, orders, startedAt: new Date(),
        accountHealth: () => ({ state: "stopped", lastSuccessAt: null, lastErrorCode: "isolated_no_provider", collectionReady: false }) });
      const httpVerified = await verifyHttpIdentity({ modules: m, config, fixture: advanced, request: (url, options) => app.request(url, options) });
      assert.equal(httpVerified.orders.length, 3);
      assert.deepEqual(httpVerified.orders.map(order => order.idempotentReplayStatus), [200, 200, 200]);
      assert.equal(httpVerified.orders.find(order => order.kind === "paid").checkoutHttpStatus, 200);
      assert.equal(httpVerified.orders.find(order => order.kind === "open").checkoutHttpStatus, 503);
      const invalidCheckout = await app.request("http://127.0.0.1:6190/api/public/v1/checkouts/" + "A".repeat(43));
      assert.equal(invalidCheckout.status, 404, "provider unavailability must not mask an invalid capability");
      const site = sites.get(seeded.siteId);
      sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, name: "Intentional changed fixture" } }, { actorId: "admin" });
      await assert.rejects(verifyBusinessData({ modules: m, database, config, fixture: seeded.fixture, baseline, expectedSchema: 39 }), /preserved_row_changed:sites/);
    } finally {
      database?.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.match(directory, /perpay-upgrade-fixture-/);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
