import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderStore } from "../src/database/order-store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { RuntimeSettingsService, SettingsError } from "../src/settings/index.ts";
import { withHttpFixture } from "./reconciliation-http-fixture.ts";

const blocked = (error: unknown) => error instanceof SettingsError && error.code === "provider_switch_blocked";

describe("provider switch final collection guard", () => {
  for (const terminal of ["CLOSED", "EXPIRED"] as const) {
    it(`requires final collection for a zero-ledger ${terminal} order`, async (t) => {
      await withHttpFixture(async (f) => {
        let now = Date.now();
        const runtime = new RuntimeController({ database: f.database, orders: f.services.orders,
          ledger: f.ledger, reconciliation: f.reconciliation, webhooks: f.webhooks, clock: () => now });
        const snapshot = f.services.settings.snapshot();
        assert.doesNotThrow(() => runtime.assertProviderSwitchAllowed(snapshot));
        const order = f.createOrder("switch-zero-ledger", 1000);
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const store = new OrderStore(f.database, () => now);
        now = terminal === "CLOSED" ? order.createdAt + 120_000 : order.checkout.expiresAt + 1;
        const ended = terminal === "CLOSED" ? store.closeOrder("default", order.orderId) : store.orderById("default", order.orderId);
        assert.equal(ended?.order.checkoutStatus, terminal);
        assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM ledger_entries").get()?.n), 0n);
        const endedAt = ended!.order.closedAt!;
        now += 1000;
        // Freshly restarted / never-collected accounts must not bypass the guard.
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const baseLedger = runtime.ledgerHealth();
        const baseReconciliation = runtime.reconciliationHealth();
        let lastSuccessAt = endedAt - 1;
        let paymentRevision = snapshot.paymentRevision;
        t.mock.method(runtime, "ledgerHealth", () => ({ ...baseLedger, enabled: true,
          state: "healthy" as const, paymentRevision, lastSuccessAt }));
        t.mock.method(runtime, "reconciliationHealth", () => ({ ...baseReconciliation, enabled: true,
          state: "healthy" as const, paymentRevision, lastSuccessAt }));
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        lastSuccessAt = now;
        paymentRevision -= 1;
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        paymentRevision = snapshot.paymentRevision;
        assert.doesNotThrow(() => runtime.assertProviderSwitchAllowed(snapshot));
        now += snapshot.provider!.maximumSuccessAgeMilliseconds + 1;
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
      });
    });
  }

  it("does not publish a new account before the first ended order is reviewed", async () => {
    await withHttpFixture(async (f) => {
      const runtime = new RuntimeController({ database: f.database, orders: f.services.orders,
        ledger: f.ledger, reconciliation: f.reconciliation, webhooks: f.webhooks });
      const settings = new RuntimeSettingsService({ store: f.services.settingsStore,
        guardProviderSwitch: ({ current, currentProviderAccountKey }) =>
          runtime.assertProviderSwitchAllowed(current, currentProviderAccountKey) });
      const before = settings.initialize();
      const order = f.createOrder("switch-first-payment", 1000);
      // The provider timestamps in this fixture are deliberately late-visible but in-window.
      new OrderStore(f.database, () => order.createdAt + 120_000).closeOrder("default", order.orderId);
      const provider = before.provider!;
      await assert.rejects(() => settings.saveProvider({
        revision: before.revision, environment: provider.environment, app_id: "2026000000000002",
        private_key: provider.privateKeyPem, platform_public_key: provider.publicKeyPem,
        timeout_milliseconds: provider.timeoutMilliseconds,
        scan_interval_seconds: provider.scanIntervalMilliseconds / 1000,
        active_scan_interval_seconds: provider.activeScanIntervalMilliseconds / 1000,
        safety_lag_seconds: provider.safetyLagMilliseconds / 1000,
        maximum_success_age_seconds: provider.maximumSuccessAgeMilliseconds / 1000,
      }, { actorId: "admin" }), blocked);
      assert.equal(settings.snapshot().activeProviderAccountKey, before.activeProviderAccountKey);
      assert.equal(settings.snapshot().revision, before.revision);
      const entry = f.recordCredit("first-late-credit", order.payableAmountCents, 0);
      assert.equal(f.reconciliation.reconcileEntry(entry.ledgerEntryId, order.createdAt + 121_000).kind, "auto_settled");
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });
});
