import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { AlipayLedgerProvider } from "../src/infrastructure/alipay/provider.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { ReconciliationScheduler } from "../src/reconciliation/scheduler.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500 && !predicate(); i++) await setImmediate();
  assert.ok(predicate(), "expected asynchronous runtime stage");
}

it("merges HTTP checks from different websites into one protected scan and awaits actual reconciliation", async t => {
  const f = await createSitePaymentFixture();
  const scan = Promise.withResolvers<void>(), reconcile = Promise.withResolvers<void>();
  let runtime: RuntimeController | undefined;
  try {
    const a = f.createSite("A"), b = f.createSite("B");
    const orders = [a, b, b].map((site, index) => f.orders.forSite(site.clientId).create(createOrderRequestSchema.parse({
      merchant_order_no: "check-" + index, idempotency_key: "check-" + index, amount_cents: 1000, product_name: "核实验收",
    })).order);
    await f.settings.saveCollectionPolicy({ ...f.settings.collectionPolicy(), scan_interval_seconds: 60, active_scan_interval_seconds: 8,
      minimum_scan_interval_seconds: 5, safety_lag_seconds: 10, maximum_success_age_seconds: 120 }, { actorId: "admin" });
    f.setNow(f.now() + 30_000);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const queries: { at: number; request: Parameters<AlipayLedgerProvider["queryPage"]>[0] }[] = [];
    t.mock.method(AlipayLedgerProvider.prototype, "queryPage", async (request: Parameters<AlipayLedgerProvider["queryPage"]>[0]) => {
      queries.push({ at: f.now(), request });
      if (queries.length === 2) await scan.promise;
      return { pageNo: 1, pageSize: request.pageSize, totalSize: 0, hasMore: false, details: [], traceId: "multi-site-test",
        rawResponse: { status: 200, headers: {}, body: '{"total_size":0}', traceId: "multi-site-test", signatureVerified: true } };
    });
    const verifyOrder = ReconciliationScheduler.prototype.verifyOrder;
    let confirmations = 0;
    t.mock.method(ReconciliationScheduler.prototype, "verifyOrder", async function(this: ReconciliationScheduler, id: string) {
      confirmations++; await reconcile.promise; return verifyOrder.call(this, id);
    });
    const ledger = new LedgerStore(f.database), reconciliation = new ReconciliationStore(f.database), webhooks = new WebhookStore(f.database);
    runtime = new RuntimeController({ database: f.database, orders: f.orders, sites: f.sites, ledger, reconciliation, webhooks, clock: f.now });
    const current = runtime;
    const snapshot = f.settings.instanceSnapshot();
    await current.start(snapshot);
    await until(() => current.ledgerHealth().lastSuccessAt === f.now() && !current.ledgerHealth().inFlight);
    await current.triggerReconciliation("test-warmup");
    assert.equal(queries.length, 1);
    const app = createApp({ ...f, ledger, reconciliation, webhookStore: webhooks, startedAt: new Date(), clock: f.now,
      runtimeStatus: () => current.status(), ledgerHealth: () => current.ledgerHealth(), reconciliationHealth: () => current.reconciliationHealth(),
      checkoutVerification: id => current.checkoutVerification(id), requestCheckoutVerification: id => current.requestCheckoutVerification(id) });
    const path = (index: number) => "/api/public/v1/checkouts/" + orders[index]!.checkoutToken;
    const get = async (index: number) => {
      const response = await app.request(path(index)); assert.equal(response.status, 200);
      return (await response.json() as { data: { payment: { status: string }; verification?: { id: string; state: string } } }).data;
    };
    const post = (index: number) => app.request(path(index) + "/check", { method: "POST", headers: { origin: f.config.publicOrigin, "content-type": "application/json" }, body: "{}" });
    await get(0); await get(1); assert.equal(queries.length, 1, "GET never requests a provider scan");
    const responses = await Promise.all([post(0), post(1), post(0)]);
    assert.deepEqual(responses.map(r => r.status), [202, 202, 202]);
    const stages = await Promise.all(responses.map(async r => (await r.json() as { data: { verification: { id: string; state: string } } }).data.verification));
    assert.equal(stages[0]!.id, stages[2]!.id); assert.notEqual(stages[0]!.id, stages[1]!.id);
    assert.equal(stages[0]!.state, "WAITING"); assert.equal((await get(2)).verification, undefined);
    f.setNow(f.now() + 4000); t.mock.timers.tick(4000); await setImmediate(); assert.equal(queries.length, 1);
    f.setNow(f.now() + 1000); t.mock.timers.tick(1000);
    await until(() => queries.length === 2);
    assert.equal((await get(0)).verification?.state, "SCANNING");
    assert.equal((await get(1)).verification?.state, "SCANNING");
    // Site and template edits must not replace the shared in-flight runtime.
    f.sites.update(a.clientId, { revision: a.revision, configuration: { ...a.configuration, name: "A 已更新", accepting_orders: false } }, { actorId: "admin" });
    const defaults = f.sites.defaults(); f.sites.saveDefaults({ ...defaults, policy: { ...defaults.policy, orders: { ...defaults.policy.orders, pending_order_limit: 2 } } }, { actorId: "admin" });
    assert.equal(f.settings.instanceSnapshot().paymentRevision, snapshot.paymentRevision);
    assert.equal((await post(1)).status, 202); assert.equal(queries.length, 2);
    assert.equal((await post(0)).status, 202, "pausing new orders must not stop verification of an existing order");
    scan.resolve();
    await until(() => confirmations === 2);
    for (const index of [0, 1]) assert.equal((await get(index)).verification?.state, "RECONCILING");
    reconcile.resolve();
    await until(() => orders.slice(0, 2).every(order => current.checkoutVerification(order.orderId)?.state === "COMPLETED"));
    for (const index of [0, 1]) {
      const latest = await get(index); assert.equal(latest.verification?.state, "COMPLETED"); assert.equal(latest.payment.status, "UNPAID");
    }
    assert.equal(queries.length, 2);
    f.setNow(f.now() + 7999); t.mock.timers.tick(7999); await setImmediate(); assert.equal(queries.length, 2);
    f.setNow(f.now() + 1); t.mock.timers.tick(1); await until(() => queries.length === 3);
    assert.equal(queries[2]!.at - queries[1]!.at, 8000);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally {
    scan.resolve(); reconcile.resolve(); await runtime?.stop(); t.mock.timers.reset(); f.close();
  }
});
