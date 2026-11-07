import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore, SettingsError } from "../src/settings/store.ts";
import { RuntimeSettingsService } from "../src/settings/service.ts";
import { AlipayAccountStore, AlipayAccountService } from "../src/alipay-accounts/index.ts";
import { OrderService } from "../src/orders/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { parseOccurredAt } from "../src/ledger/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { SdkAlipayLedgerProvider } from "../src/infrastructure/alipay/sdk-provider.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";
import { keyMaster, privatePem, platformPem, keyAudit } from "./application-key-fixture.ts";

const scenarios = [
  { materialize: "never", tailPayment: false, reloadPolicy: false, name: "unread expiry" },
  { materialize: "before-coverage", tailPayment: false, reloadPolicy: false, name: "expiry materialized before final coverage" },
  { materialize: "after-coverage", tailPayment: false, reloadPolicy: false, name: "expiry materialized after final coverage" },
  { materialize: "never", tailPayment: true, reloadPolicy: false, name: "a payment in the final second before expiry" },
  { materialize: "never", tailPayment: false, reloadPolicy: true, name: "a collection policy reload before final coverage" },
];

for (const { materialize, tailPayment, reloadPolicy, name } of scenarios) it(`preserves final reconciliation before changing applications with ${name}`, async t => {
  let upstreamPayment: AccountLogDetail | null = null;
  // The upstream page is synthetic; application guards, workers and database are real.
  t.mock.method(SdkAlipayLedgerProvider.prototype, "queryPage", async (input: Parameters<SdkAlipayLedgerProvider["queryPage"]>[0]) => {
    const paymentTime = upstreamPayment?.occurredAt;
    const details = paymentTime && parseOccurredAt(input.startTime) <= parseOccurredAt(paymentTime) &&
      parseOccurredAt(input.endTime) >= parseOccurredAt(paymentTime) ? [upstreamPayment!] : [];
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: details.length, details, hasMore: false,
      traceId: "expiry-guard", rawResponse: { status: 200, headers: {}, body: JSON.stringify({ details }), traceId: "expiry-guard", signatureVerified: true } };
  });
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
    const ledger = new LedgerStore(db);
    const reconciliation = new ReconciliationStore(db);
    // Store transactions use their own clock argument; keep the real work on
    // the same test clock as the scheduler and ingested ledger timestamps.
    const reconcileEntry = reconciliation.reconcileEntry.bind(reconciliation);
    const reconcileOrder = reconciliation.reconcileOrder.bind(reconciliation);
    t.mock.method(reconciliation, "reconcileEntry", (id: string, timestamp?: number) => reconcileEntry(id, timestamp ?? now));
    t.mock.method(reconciliation, "reconcileOrder", (id: string, limit?: number, timestamp?: number) => reconcileOrder(id, limit, timestamp ?? now));
    runtime = new RuntimeController({ database: db, orders, ledger,
      reconciliation, webhooks: new WebhookStore(db), sites,
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
    if (tailPayment) {
      const amount = (order.payableAmountCents / 100).toFixed(2);
      const occurredAt = new Date(order.checkout.expiresAt - 1 + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
      upstreamPayment = { accountLogId: "expiry-tail-payment", occurredAt, amount, direction: "CREDIT",
        alipayOrderNo: "expiry-tail-payment", merchantOrderNo: null, transMemo: null, otherAccount: null,
        raw: { account_log_id: "expiry-tail-payment", amount, occurred_at: occurredAt } };
    }
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

    const scanAndReconcile = async () => {
      const scanAt = now;
      runtime!.requestLedgerScan(account.id);
      for (let attempt = 0; attempt < 300; attempt++) {
        if (runtime!.ledgerManualScan(account.id).request?.finished_at &&
          (runtime!.accountHealth(account.id).lastSuccessAt ?? 0) >= scanAt) break;
        await delay(10);
      }
      assert.ok(runtime!.ledgerManualScan(account.id).request?.finished_at);
      assert.ok((runtime!.accountHealth(account.id).lastSuccessAt ?? 0) >= scanAt,
        JSON.stringify({ now, health: runtime!.accountHealth(account.id), scan: runtime!.ledgerManualScan(account.id) }));
      await runtime!.triggerReconciliation("expiry-final-check");
      await waitForIdle();
      assert.equal(runtime!.reconciliationHealth().lastErrorCode, null);
    };
    const updateInput = { revision: account.revision, name: account.name, enabled: true,
      code_payload: account.code_payload, environment: "PRODUCTION" as const, app_id: "expiry-after", platform_public_key: platformPem };
    const blocksSwitch = (error: unknown) => error instanceof SettingsError && error.code === "provider_switch_blocked";

    // A successful request after expiry can still end before the deadline.
    now = order.checkout.expiresAt + 1_000;
    await scanAndReconcile();
    const earlyCursor = ledger.getCursor(account.provider_account_key!);
    assert.ok(earlyCursor?.complete);
    assert.ok(parseOccurredAt(earlyCursor.windowEnd) < order.checkout.expiresAt);
    assert.ok(runtime.accountHealth(account.id).lastSuccessAt! > order.checkout.expiresAt);
    if (materialize === "before-coverage") {
      now += 1_000;
      scoped.get(order.orderId);
      assert.equal(storedStatus(), "EXPIRED");
    }
    assert.throws(() => runtime!.assertAccountProviderSwitchAllowed(store.snapshot(account.id)), blocksSwitch);
    await assert.rejects(() => accounts.update(account.id, updateInput, keyAudit()), blocksSwitch);
    assert.equal(store.snapshot(account.id).appId, "expiry-before");
    assert.equal(store.snapshot(account.id).providerAccountKey, account.provider_account_key);
    assert.equal(store.snapshot(account.id).revision, account.revision);
    await waitForIdle();
    assert.equal(db.read(connection => Number(connection.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get()!.count)), 0);

    let reconciliationBeforePolicyReload: number | null = null;
    if (reloadPolicy) {
      // The rejected account edit restored a fresh worker. Give it a healthy
      // scan before the global pause, while the safe tail is still incomplete.
      now = order.checkout.expiresAt + store.snapshot(account.id).provider!.safetyLagMilliseconds - 1_000;
      await scanAndReconcile();
      assert.ok(parseOccurredAt(ledger.getCursor(account.provider_account_key!)!.windowEnd) < order.checkout.expiresAt);
      reconciliationBeforePolicyReload = runtime.reconciliationHealth().lastSuccessAt;
      const settingsService = new RuntimeSettingsService({ store: settings, alipayAccounts: accounts,
        onPaymentMutationStarted: () => runtime!.beginPaymentTransition(),
        onApplied: () => runtime!.apply(settings.instanceSnapshot()),
      });
      const beforePaymentRevision = settings.instanceSnapshot().paymentRevision;
      const policy = settingsService.collectionPolicy();
      await settingsService.saveCollectionPolicy({ ...policy, timeout_milliseconds: policy.timeout_milliseconds + 1_000 }, keyAudit());
      await waitForIdle();
      assert.equal(settings.instanceSnapshot().paymentRevision, beforePaymentRevision + 1);
      assert.equal(store.snapshot(account.id).providerAccountKey, account.provider_account_key);
    }

    // Keep the original source active until its normal scan covers the deadline.
    now = order.checkout.expiresAt + store.snapshot(account.id).provider!.safetyLagMilliseconds + 20_000;
    await scanAndReconcile();
    const finalCursor = ledger.getCursor(account.provider_account_key!);
    assert.ok(finalCursor?.complete);
    assert.ok(parseOccurredAt(finalCursor.windowEnd) >= order.checkout.expiresAt);
    if (reloadPolicy) {
      assert.ok(runtime.reconciliationHealth().lastSuccessAt! > reconciliationBeforePolicyReload!);
      assert.ok(runtime.reconciliationHealth().lastSuccessAt! >= finalCursor.lastCompletedAt!);
    }
    if (materialize === "after-coverage") {
      // A later order read must not invalidate an already covered deadline.
      now += 1_000;
      scoped.get(order.orderId);
      assert.equal(storedStatus(), "EXPIRED");
      assert.ok(runtime.accountHealth(account.id).lastSuccessAt! < now);
    }
    if (tailPayment) {
      const payment = db.read(connection => connection.prepare("SELECT payment_status,received_amount_cents FROM payment_orders WHERE order_id=?").get(order.orderId)!);
      assert.equal(payment.payment_status, "CONFIRMED");
      assert.equal(Number(payment.received_amount_cents), order.payableAmountCents);
      assert.equal(db.read(connection => Number(connection.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE provider_account_key=? AND external_event_id='expiry-tail-payment'").get(account.provider_account_key!)!.count)), 1);
      assert.equal(db.read(connection => Number(connection.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE aggregate_id=? AND event_type='PAYMENT_CONFIRMED'").get(order.orderId)!.count)), 1);
    }
    assert.doesNotThrow(() => runtime!.assertAccountProviderSwitchAllowed(store.snapshot(account.id)));
    const updated = await accounts.update(account.id, updateInput, keyAudit());
    assert.equal(updated.app_id, "expiry-after");
    assert.equal(storedStatus(), materialize === "never" ? "OPEN" : "EXPIRED", "application switching does not need an order read first");
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
