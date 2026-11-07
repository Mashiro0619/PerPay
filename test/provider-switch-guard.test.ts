import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderStore } from "../src/database/order-store.ts";
import { type IngestScanKind } from "../src/ledger/model.ts";
import { type LedgerStore } from "../src/ledger/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { RuntimeSettingsService, SettingsError } from "../src/settings/index.ts";
import { withHttpFixture } from "./reconciliation-http-fixture.ts";

const blocked = (error: unknown) => error instanceof SettingsError && error.code === "provider_switch_blocked";

const providerTime = (value: number) => new Date(value + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
function startEmptyScan(ledger: LedgerStore, providerAccountKey: string, end: number, now: number, scanKind: IngestScanKind = "NORMAL") {
  return ledger.startIngestRun({ providerAccountKey, start: providerTime(end - 60_000), end: providerTime(end),
    pageSize: 10, scanKind, now });
}
function completeEmptyScan(ledger: LedgerStore, ingestRunId: string, now: number) {
  ledger.recordPage({ ingestRunId, page: { pageNo: 1, pageSize: 10, totalSize: 0, hasMore: false, details: [] },
    evidence: { httpStatus: 200, headers: {}, body: '{"details":[]}', traceId: "switch-coverage", signatureVerified: true }, now });
}

describe("provider switch final collection guard", () => {
  for (const terminal of ["CLOSED", "EXPIRED"] as const) {
    it(`requires final collection for a zero-ledger ${terminal} order`, async (t) => {
      await withHttpFixture(async (f) => {
        let now = Date.now();
        const runtime = new RuntimeController({ database: f.database, orders: f.services.orders,
          ledger: f.ledger, reconciliation: f.reconciliation, webhooks: f.webhooks, clock: () => now });
        const snapshot = f.services.settings.instanceSnapshot();
        assert.doesNotThrow(() => runtime.assertProviderSwitchAllowed(snapshot));
        const order = f.createOrder("switch-zero-ledger", 1000);
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const store = new OrderStore(f.database, () => now);
        now = terminal === "CLOSED" ? Math.floor((order.createdAt + 120_000) / 1000) * 1000 + 125 : order.checkout.expiresAt + 1;
        const ended = terminal === "CLOSED" ? store.closeOrder("default", order.orderId) : store.orderById("default", order.orderId);
        assert.equal(ended?.order.checkoutStatus, terminal);
        assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM ledger_entries").get()?.n), 0n);
        // Expiry may be materialized later; final collection is anchored to the
        // actual payment deadline, while an explicit close uses its close time.
        const endedAt = terminal === "CLOSED" ? ended!.order.closedAt! : ended!.order.expiresAt;
        now += 1000;
        // Freshly restarted / never-collected accounts must not bypass the guard.
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const baseLedger = runtime.ledgerHealth();
        const baseReconciliation = runtime.reconciliationHealth();
        let lastSuccessAt = endedAt - 1;
        let reconciliationSuccessAt = lastSuccessAt;
        let reconciliationInFlight = false;
        let continuationPending = false;
        let paymentRevision = snapshot.paymentRevision;
        t.mock.method(runtime, "ledgerHealth", () => ({ ...baseLedger, enabled: true,
          state: "healthy" as const, paymentRevision, lastSuccessAt }));
        t.mock.method(runtime, "reconciliationHealth", () => ({ ...baseReconciliation, enabled: true,
          state: "healthy" as const, paymentRevision, lastSuccessAt: reconciliationSuccessAt,
          inFlight: reconciliationInFlight, continuationPending }));
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        lastSuccessAt = now;
        reconciliationSuccessAt = now;
        paymentRevision -= 1;
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        paymentRevision = snapshot.paymentRevision;

        // Health alone and a completed compensation scan cannot prove normal coverage.
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const coveredEnd = Math.ceil(endedAt / 1000) * 1000;
        now = coveredEnd + snapshot.provider!.safetyLagMilliseconds + 1000;
        lastSuccessAt = reconciliationSuccessAt = now;
        const accountKey = snapshot.activeProviderAccountKey!;
        const compensation = startEmptyScan(f.ledger, accountKey, coveredEnd, now, "COMPENSATION_10M");
        completeEmptyScan(f.ledger, compensation.ingestRunId, now);
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);

        // Keep the original millisecond deadline when comparing second-granularity windows.
        const short = startEmptyScan(f.ledger, accountKey, coveredEnd - 1000, now);
        completeEmptyScan(f.ledger, short.ingestRunId, now);
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        const covering = startEmptyScan(f.ledger, accountKey, coveredEnd, now);
        f.ledger.recordIngestError({ ingestRunId: covering.ingestRunId, errorKind: "provider", errorCode: "temporary_failure", retryable: true, now });
        assert.equal(f.ledger.getCursor(accountKey)!.complete, false);
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);

        const resumed = startEmptyScan(f.ledger, accountKey, coveredEnd, now);
        completeEmptyScan(f.ledger, resumed.ingestRunId, now + 1);
        now += 1;
        // Final reconciliation must include the completed scan, not an earlier success.
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        reconciliationSuccessAt = now;
        reconciliationInFlight = true;
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        reconciliationInFlight = false;
        continuationPending = true;
        assert.throws(() => runtime.assertProviderSwitchAllowed(snapshot), blocked);
        continuationPending = false;
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
        revision: before.revision, environment: "PRODUCTION", app_id: "2026000000000002",
        private_key: provider.privateKeyPem, platform_public_key: provider.publicKeyPem,
        timeout_milliseconds: provider.timeoutMilliseconds,
        scan_interval_seconds: provider.scanIntervalMilliseconds / 1000,
        active_scan_interval_seconds: provider.activeScanIntervalMilliseconds / 1000,
        safety_lag_seconds: provider.safetyLagMilliseconds / 1000,
        maximum_success_age_seconds: provider.maximumSuccessAgeMilliseconds / 1000,
      }, { actorId: "admin" }), blocked);
      assert.equal(settings.instanceSnapshot().activeProviderAccountKey, before.activeProviderAccountKey);
      assert.equal(settings.instanceSnapshot().revision, before.revision);
      const entry = f.recordCredit("first-late-credit", order.payableAmountCents, 0);
      assert.equal(f.reconciliation.reconcileEntry(entry.ledgerEntryId, order.createdAt + 121_000).kind, "auto_settled");
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });
});
