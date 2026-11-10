import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { migrations } from "../src/database/migrations.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { financialHeaders, login, postFinancial, recordLedgerEntry, responseData, withHttpFixture, type ReconciliationHttpFixture } from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";

const manual = "/api/admin/v1/reconciliation/settlements/manual";
const openExceptions = (f: ReconciliationHttpFixture) => f.reconciliation.listOpenExceptions(f.services.settings.instanceSnapshot().activeProviderAccountKey!);

it("reviews a disputed payment, preserves reversal history and emits one new confirmation across retries", async () => {
  await withHttpFixture(async f => {
    const auth = await login(f.app);
    configureTestSiteNotifications(f.services.settings.siteStore()!, f.services.settings.siteStore()!.list()[0]!.clientId,
      { enabled: true, allowed_origin: "https://merchant.example.test" });
    const settled = f.createSettlement("reconfirm", 999, "https://merchant.example.test/notify");
    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: settled.result.paymentMatchId,
      actorId: "admin", reason: "付款凭证需要重新核对" });
    const input = { financial_operation_id: randomUUID(), order_id: settled.order.orderId,
      ledger_entry_id: settled.entry.ledgerEntryId, reason: "已核对付款人和支付宝交易凭证" };
    const candidates = f.reconciliation.manualOrderPage({ contextId: settled.entry.ledgerEntryId, q: settled.order.merchantOrderNo,
      view: "all", limit: 20, position: null });
    assert.deepEqual(candidates?.items.map(item => item.record.orderId), [settled.order.orderId]);
    assert.equal((await postFinancial(f.app, manual, auth, { ...input, reason: null })).status, 409);
    f.ledger.bindProviderIdentity({ providerAccountKey: "another-receiving-account", providerKind: "alipay",
      endpoint: "https://openapi.alipay.com", externalAccountId: "another-app" }, f.baseTime);
    const timestamp = (value: number) => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    const foreign = recordLedgerEntry(f.ledger, { start: timestamp(f.baseTime - 60000), end: timestamp(f.baseTime + 3600000) },
      "unrelated-account-income", settled.entry.amountCents, f.baseTime + 65000, f.baseTime, "CREDIT", "another-receiving-account");
    assert.equal((await postFinancial(f.app, manual, auth, { ...input, ledger_entry_id: foreign.ledgerEntryId })).status, 409);
    assert.deepEqual(f.reconciliation.manualOrderPage({ contextId: foreign.ledgerEntryId, q: "", view: "all", limit: 20, position: null })?.items, []);
    const responses = await Promise.all([postFinancial(f.app, manual, auth, input), postFinancial(f.app, manual, auth, input)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const decisions = await Promise.all(responses.map(response => responseData<any>(response)));
    assert.deepEqual(decisions.map(decision => decision.replayed).sort(), [false, true]);
    assert.notEqual(decisions[0].payment_match.payment_match_id, settled.result.paymentMatchId);
    const order = f.services.orders.get(settled.order.orderId);
    assert.equal(order.payment.status, "CONFIRMED");
    assert.equal(order.payment.basis, "MANUAL");
    assert.equal(f.reconciliation.paymentMatch(settled.result.paymentMatchId)?.status, "REVERSED");
    assert.equal(openExceptions(f).length, 0);
    f.webhooks.materialize(20, f.baseTime + 1_000);
    f.database.read(db => {
      const events = db.prepare("SELECT event_type, aggregate_version FROM outbox_events ORDER BY aggregate_version").all();
      assert.deepEqual(events.map(event => event.event_type), ["PAYMENT_CONFIRMED", "PAYMENT_DISPUTED", "PAYMENT_CONFIRMED"]);
      assert.equal(new Set(events.map(event => Number(event.aggregate_version))).size, 3);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()!.n), 3);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get()!.n), 3);
      assert.equal(Number(db.prepare("SELECT SUM(CASE side WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END) AS net FROM ledger_postings WHERE account_code = 'ORDER_SETTLEMENT'").get()!.net), settled.entry.amountCents);
    });
    assert.equal((await postFinancial(f.app, manual, auth, { ...input, financial_operation_id: randomUUID() })).status, 409);
    assert.equal((await postFinancial(f.app, manual, auth, { ...input, reason: "修改已完成的核对理由" })).status, 409);
    assert.equal(f.database.integrityCheck().ok, true);
  });
});

it("can confirm another receipt while preserving an unresolved original income as a separate reminder", async () => {
  await withHttpFixture(async f => {
    const settled = f.createSettlement("replacement", 1499);
    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: settled.result.paymentMatchId,
      actorId: "admin", reason: "原流水不属于本订单" });
    const originalException = openExceptions(f)[0]!;
    const replacement = f.recordCredit("replacement-receipt", 1503, 9);
    const input = { financialOperationId: randomUUID(), orderId: settled.order.orderId, ledgerEntryId: replacement.ledgerEntryId,
      actorId: "admin", reason: "根据付款人提供的凭证关联实际付款" };
    f.reconciliation.settleManually(input);
    assert.equal(f.reconciliation.exception(originalException.exceptionId)?.resolution?.resolution, "dispute_reconfirmed");
    const pending = openExceptions(f);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.ledgerEntryId, settled.entry.ledgerEntryId);
    assert.equal(pending[0]!.orderId, null);
    assert.equal(pending[0]!.exceptionType, "UNMATCHED_CREDIT");
    assert.equal(f.services.orders.get(settled.order.orderId).payment.receivedAmountCents, 1503);
    assert.equal(f.database.integrityCheck().ok, true);
    const backup = f.directory + "/reconfirmed.sqlite3";
    await f.database.backup(backup);
    const reopened = await AppDatabase.open(backup);
    try {
      assert.equal(new ReconciliationStore(reopened).settleManually(input).replayed, true);
      assert.equal(reopened.integrityCheck().ok, true);
    } finally { reopened.close(); }
  });
});

it("refuses an allocated original payment and a refunded disputed order, and can dismiss only its refund reminder", async () => {
  await withHttpFixture(async f => {
    const auth = await login(f.app);
    const first = f.createSettlement("already-owned", 1999);
    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: first.result.paymentMatchId,
      actorId: "admin", reason: "原关联错误" });
    const correct = f.createOrder("correct-owner", 2199);
    f.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: correct.orderId, ledgerEntryId: first.entry.ledgerEntryId,
      actorId: "admin", reason: "核对后关联正确订单" });
    const rejected = { financial_operation_id: randomUUID(), order_id: first.order.orderId,
      ledger_entry_id: first.entry.ledgerEntryId, reason: "再次核对" };
    assert.equal((await postFinancial(f.app, manual, auth, rejected)).status, 409);

    const refunded = f.createSettlement("refunded", 2999);
    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: refunded.result.paymentMatchId,
      actorId: "admin", reason: "收到退款申请" });
    const exception = openExceptions(f).find(item => item.orderId === refunded.order.orderId)!;
    const mark = await f.app.request(`/api/admin/v1/orders/${refunded.order.orderId}/refund-mark`, {
      method: "PUT", headers: financialHeaders(auth),
      body: JSON.stringify({ operation_id: randomUUID(), version: 0, marked: true, note: "已在支付宝完成退款" }),
    });
    assert.equal(mark.status, 200, await mark.clone().text());
    assert.equal((await postFinancial(f.app, manual, auth, { ...rejected, financial_operation_id: randomUUID(),
      order_id: refunded.order.orderId, ledger_entry_id: refunded.entry.ledgerEntryId })).status, 409);
    assert.equal(f.reconciliation.manualLedgerPage({ contextId: refunded.order.orderId, q: "", view: "all", limit: 20, position: null })?.items.length, 0);

    const unrelated = f.recordCredit("still-needs-review", 5300, 15);
    f.reconciliation.reconcileEntry(unrelated.ledgerEntryId);
    const request = { operation_id: randomUUID(), type: "FINANCIAL_EXCEPTION", resource_id: exception.exceptionId };
    const ignored = await postFinancial(f.app, "/api/admin/v1/work-items/actions/ignore-all", auth, request);
    assert.equal(ignored.status, 200);
    assert.equal((await responseData<any>(ignored)).ignored_count, 1);
    const retry = await postFinancial(f.app, "/api/admin/v1/work-items/actions/ignore-all", auth, request);
    assert.equal((await responseData<any>(retry)).ignored_count, 1);
    const active = await f.app.request("/api/admin/v1/work-items?type=FINANCIAL_EXCEPTION", { headers: { cookie: auth.cookie } });
    const reminders = await responseData<any[]>(active);
    assert.ok(reminders.every(item => item.resource_id !== exception.exceptionId));
    assert.ok(reminders.some(item => item.ledger_entry_id === unrelated.ledgerEntryId));
    assert.equal(f.services.orders.get(refunded.order.orderId).payment.status, "DISPUTED");
    assert.equal(f.reconciliation.exception(exception.exceptionId)?.status, "OPEN");
    assert.equal(f.database.integrityCheck().ok, true);
  });
});

it("upgrades a schema 43 dispute without rewriting the original evidence", async () => {
  await withHttpFixture(async f => {
    const settled = f.createSettlement("upgrade-dispute", 4999);
    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: settled.result.paymentMatchId,
      actorId: "admin", reason: "待升级后继续核对" });
    const before = f.database.read(db => db.prepare("SELECT * FROM payment_matches").all());
    const path = f.services.config.databasePath;
    f.database.close();
    const previous = new DatabaseSync(path);
    try {
      const trigger = (version: number, name: string) => {
        const sql = migrations.find(migration => migration.version === version)!.sql;
        const start = sql.indexOf("CREATE TRIGGER " + name);
        return sql.slice(start, sql.indexOf("END;", start) + 4);
      };
      previous.exec("DROP TRIGGER payment_orders_payment_state_transition; DROP TRIGGER financial_exceptions_resolution_once; DROP TRIGGER disputed_manual_settlement_reason;");
      previous.exec(trigger(5, "payment_orders_payment_state_transition"));
      previous.exec(trigger(9, "financial_exceptions_resolution_once"));
      previous.exec("DELETE FROM schema_migrations WHERE version = 44;");
    } finally { previous.close(); }
    const upgraded = await AppDatabase.open(path, { masterKey: f.services.config.masterKey });
    try {
      assert.deepEqual(upgraded.read(db => db.prepare("SELECT * FROM payment_matches").all()), before);
      new ReconciliationStore(upgraded).settleManually({ financialOperationId: randomUUID(), actorId: "admin",
        orderId: settled.order.orderId, ledgerEntryId: settled.entry.ledgerEntryId, reason: "升级后核对原付款凭证" });
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally { upgraded.close(); }
  });
});
