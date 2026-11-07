import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore, SettingsError } from "../src/settings/store.ts";
import { AlipayAccountStore, AlipayAccountService } from "../src/alipay-accounts/index.ts";
import { OrderService } from "../src/orders/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { SdkAlipayLedgerProvider } from "../src/infrastructure/alipay/sdk-provider.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";
import { keyMaster, privatePem, platformPem, keyAudit } from "./application-key-fixture.ts";

for (const materialize of [false, true]) it(`preserves final reconciliation before changing applications with ${materialize ? "later materialized" : "unread"} expiry`, async t => {
  // The upstream page is synthetic; application guards, workers and database are real.
  t.mock.method(SdkAlipayLedgerProvider.prototype, "queryPage", async (input: Parameters<SdkAlipayLedgerProvider["queryPage"]>[0]) => ({
    pageNo: input.pageNo, pageSize: input.pageSize, totalSize: 0, details: [], hasMore: false,
    traceId: "expiry-guard", rawResponse: { status: 200, headers: {}, body: '{"details":[]}', traceId: "expiry-guard", signatureVerified: true },
  }));
  const directory = mkdtempSync(join(tmpdir(), "perpay-provider-expiry-"));
  const db = await AppDatabase.open(join(directory, "state.sqlite3"), { masterKey: keyMaster });
  let runtime: RuntimeController | undefined;
  let now = Date.now() + 20_000;
  try {
    const settings = new RuntimeSettingsStore(db, keyMaster);
    settings.initialize();
    const store = new AlipayAccountStore(db, keyMaster);
    const accounts = new AlipayAccountService({
      store, clock: () => now,
      onMutationStarted: id => runtime?.beginAccountTransition(id),
      onApplied: id => runtime?.applyAccounts(id),
      guardProviderSwitch: ({ current }) => runtime?.assertAccountProviderSwitchAllowed(current),
    });
    const account = await accounts.create({ name: "到期保护", app_id: "expiry-before", code_payload: "https://qr.alipay.com/expiry",
      private_key: privatePem, platform_public_key: platformPem }, keyAudit());
    const sites = settings.siteStore()!;
    const defaults = sites.defaults().policy;
    const site = sites.create({ operation_id: randomUUID(), configuration: {
      name: "到期订单网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
      collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] },
      policy: { ...defaults, orders: { ...defaults.orders, order_ttl_seconds: 60 } },
    } }, keyAudit());
    const orders = new OrderService(db, () => settings.instanceSnapshot(), () => now, sites, undefined, {
      accounts: () => store.snapshots(), available: id => runtime?.accountHealth(id).collectionReady ?? false,
    });
    runtime = new RuntimeController({ database: db, orders, ledger: new LedgerStore(db),
      reconciliation: new ReconciliationStore(db), webhooks: new WebhookStore(db), sites,
      accounts: () => store.snapshots(), clock: () => now });
    const waitForIdle = async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (!runtime!.ledgerHealth().inFlight && !runtime!.reconciliationHealth().inFlight) return;
        await delay(10);
      }
      assert.fail("runtime workers did not become idle");
    };
    await runtime.start(settings.instanceSnapshot());
    await waitForIdle();
    const scoped = orders.forSite(site.clientId);
    const order = scoped.create({ merchant_order_no: "unread-expired", idempotency_key: "unread-expired", amount_cents: 1000, product_name: "到期保护" }).order;
    await runtime.triggerOrder(order.orderId);
    await waitForIdle();
    const storedStatus = () => db.read(connection => connection.prepare("SELECT checkout_status FROM payment_orders WHERE order_id = ?").get(order.orderId)!.checkout_status);
    const eventCount = () => db.read(connection => Number(connection.prepare("SELECT COUNT(*) AS count FROM order_events WHERE order_id = ?").get(order.orderId)!.count));
    const beforeEvents = eventCount();
    now = order.checkout.expiresAt - 1;
    assert.throws(() => store.assertProviderSwitchAllowed(account.id, now), /未支付订单/);
    assert.throws(() => runtime!.assertAccountProviderSwitchAllowed(store.snapshot(account.id)), /未支付订单/);
    for (const clientId of [null, site.clientId]) {
      const analytics = systemAnalytics(db, 7, now, clientId);
      assert.equal(analytics.pending.orders, 1);
      assert.equal(analytics.orders.expired, 0);
    }

    now = order.checkout.expiresAt;
    await runtime.triggerReconciliation("expiry-test");
    await waitForIdle();
    for (const time of [now, now + 1]) {
      assert.doesNotThrow(() => store.assertProviderSwitchAllowed(account.id, time));
      for (const clientId of [null, site.clientId]) {
        const analytics = systemAnalytics(db, 7, time, clientId);
        assert.equal(analytics.pending.orders, 0);
        assert.equal(analytics.orders.expired, 1);
      }
    }
    assert.throws(() => runtime!.assertAccountProviderSwitchAllowed(store.snapshot(account.id)),
      error => error instanceof SettingsError && error.code === "provider_switch_blocked" && /复核/.test(error.message));
    assert.equal(storedStatus(), "OPEN", "guard and analytics must not materialize expiry");
    assert.equal(eventCount(), beforeEvents, "read-only checks must not append order events");

    // Passing the deadline is insufficient: a scan and reconciliation after it remain required.
    now += 20_000;
    runtime.requestLedgerScan(account.id);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (runtime.ledgerManualScan(account.id).request?.finished_at) break;
      await delay(10);
    }
    assert.ok(runtime.ledgerManualScan(account.id).request?.finished_at);
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((runtime.accountHealth(account.id).lastSuccessAt ?? 0) >= order.checkout.expiresAt) break;
      await delay(10);
    }
    await runtime.triggerReconciliation("expiry-final-check");
    await waitForIdle();
    assert.ok(runtime.accountHealth(account.id).lastSuccessAt! >= order.checkout.expiresAt,
      JSON.stringify({ now, expiry: order.checkout.expiresAt, health: runtime.accountHealth(account.id), scan: runtime.ledgerManualScan(account.id) }));
    if (materialize) {
      // Late materialization must not move the deadline past the already completed final scan.
      now += 1_000;
      scoped.get(order.orderId);
      assert.equal(storedStatus(), "EXPIRED");
      assert.doesNotThrow(() => runtime!.assertAccountProviderSwitchAllowed(store.snapshot(account.id)));
    }
    const updated = await accounts.update(account.id, { revision: account.revision, name: account.name, enabled: true,
      code_payload: account.code_payload, environment: "PRODUCTION", app_id: "expiry-after", platform_public_key: platformPem }, keyAudit());
    assert.equal(updated.app_id, "expiry-after");
    assert.equal(storedStatus(), materialize ? "EXPIRED" : "OPEN", "application switching does not need an order read first");
    const beforeRead = systemAnalytics(db, 7, now, site.clientId).orders;
    scoped.get(order.orderId);
    assert.equal(storedStatus(), "EXPIRED");
    assert.deepEqual(systemAnalytics(db, 7, now, site.clientId).orders, beforeRead);
    assert.equal(db.integrityCheck().ok, true);
  } finally {
    await runtime?.stop();
    db.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
