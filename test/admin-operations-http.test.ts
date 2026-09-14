import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { adminRefundMarkHistory, adminRefundMarks, setAdminRefundMark } from "../src/database/admin-refund-mark-store.ts";
import { adminWorkItemPage, ignoreAllAdminWorkItems } from "../src/http/admin-work-items.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { API_SECRET, withHttpFixture, login, financialHeaders, postFinancial, responseData, responseErrorCode, readCount, type ReconciliationHttpFixture, type SessionAuth } from "./reconciliation-http-fixture.ts";
import { seedLegacyDebitException } from "./legacy-debit-exception-fixture.ts";

const financialTables = ["payment_orders", "order_events", "financial_operations", "ledger_entries", "ledger_transactions", "ledger_postings", "refund_records", "outbox_events", "webhook_deliveries"] as const;
const context = { actorId: "admin", requestId: "admin-operation-test", remoteAddressHash: "a".repeat(64) };
function financialSnapshot(fixture: ReconciliationHttpFixture) {
  return fixture.database.read((connection) => Object.fromEntries(financialTables.map((table) => [table, connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()])));
}
async function mark(fixture: ReconciliationHttpFixture, auth: SessionAuth, orderId: string, body: Record<string, unknown>) {
  return fixture.app.request("/api/admin/v1/orders/" + orderId + "/refund-mark", { method: "PUT", headers: financialHeaders(auth), body: JSON.stringify(body) });
}
async function okData<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200, await response.clone().text()); return responseData<T>(response);
}
function signedHeaders(target: string) {
  const signed = signApiRequest({ secret: Buffer.from(API_SECRET, "base64url"), method: "GET", target, body: Buffer.alloc(0), clientId: "default", timestamp: String(Math.floor(Date.now() / 1000)), nonce: randomBytes(32).toString("base64url") });
  return { "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature };
}

describe("administrator operation HTTP contracts", () => {
  it("keeps refund declarations independent, versioned, idempotent and private to admin order views", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const { order } = fixture.createSettlement("admin-refund-mark", 999);
      const before = financialSnapshot(fixture);
      const body = { operation_id: randomUUID(), version: 0, marked: true, note: "私有退款说明\n仅供管理员追溯" };
      const first = await okData<Record<string, any>>(await mark(fixture, auth, order.orderId, body));
      assert.equal(first.refund_mark.marked, true); assert.equal(first.refund_mark.version, 1);
      assert.equal(first.refund_mark.updated_by, "admin"); assert.equal(first.refund_mark.note, body.note);
      const replay = await okData(await mark(fixture, auth, order.orderId, body));
      assert.deepEqual(replay, first);
      for (const path of ["/api/admin/v1/orders/" + order.orderId, "/api/admin/v1/orders/by-merchant-no/" + order.merchantOrderNo]) {
        const detail = await okData<Record<string, any>>(await fixture.app.request(path, { headers: { cookie: auth.cookie } }));
        assert.deepEqual(detail.refund_mark, first.refund_mark); assert.equal(detail.refund_mark_history.length, 1);
        assert.equal(detail.version, order.version + 1); assert.equal(detail.refund.status, "NONE");
      }
      const list = await okData<Array<Record<string, any>>>(await fixture.app.request("/api/admin/v1/orders", { headers: { cookie: auth.cookie } }));
      assert.deepEqual(list[0]?.refund_mark, first.refund_mark);
      const event = fixture.database.read((connection) => connection.prepare("SELECT outbox_event_id FROM outbox_events WHERE aggregate_id = ?").get(order.orderId)) as { outbox_event_id: string };
      for (const path of ["/api/v1/orders/" + order.orderId, "/api/v1/orders/by-merchant-no/" + order.merchantOrderNo, "/api/v1/events/" + event.outbox_event_id]) {
        const response = await fixture.app.request(path, { headers: signedHeaders(path) });
        assert.equal(response.status, 200, await response.clone().text());
        const text = await response.text(); assert.equal(text.includes("refund_mark"), false); assert.equal(text.includes("私有退款说明"), false);
      }
      for (const path of ["/api/public/v1/checkouts/" + order.checkoutToken, "/checkout/" + order.checkoutToken]) {
        const response = await fixture.app.request(path); assert.equal(response.status, 200);
        const text = await response.text(); assert.equal(text.includes("refund_mark"), false); assert.equal(text.includes("私有退款说明"), false);
      }
      const stale = await mark(fixture, auth, order.orderId, { ...body, operation_id: randomUUID(), marked: false });
      assert.equal(stale.status, 409); assert.equal(await responseErrorCode(stale), "refund_mark_version_conflict");
      const changed = await mark(fixture, auth, order.orderId, { ...body, note: "different" });
      assert.equal(changed.status, 409); assert.equal(await responseErrorCode(changed), "admin_operation_conflict");
      const undoBody = { operation_id: randomUUID(), version: 1, marked: false };
      const undo = await okData<Record<string, any>>(await mark(fixture, auth, order.orderId, undoBody));
      assert.equal(undo.refund_mark.marked, false); assert.equal(undo.refund_mark.version, 2);
      assert.deepEqual(await okData(await mark(fixture, auth, order.orderId, body)), first, "old retries must not reapply an old state");
      assert.equal(adminRefundMarks(fixture.database, [order.orderId]).get(order.orderId)?.marked, false);
      assert.deepEqual(adminRefundMarkHistory(fixture.database, order.orderId).map((event) => event.marked), [false, true]);
      assert.deepEqual(financialSnapshot(fixture), before);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("rejects unpaid marks, permits disputed receipts, validates notes, and serializes competing versions", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app); const unpaid = fixture.createOrder("unpaid-mark", 100);
      const denied = await mark(fixture, auth, unpaid.orderId, { operation_id: randomUUID(), version: 0, marked: true });
      assert.equal(denied.status, 409); assert.equal(await responseErrorCode(denied), "refund_mark_not_allowed");
      const settled = fixture.createSettlement("disputed-mark", 1999);
      fixture.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: settled.result.paymentMatchId, actorId: "admin", reason: "test disputed receipt" });
      const before = financialSnapshot(fixture);
      for (const invalid of [{ note: "a".repeat(501) }, { note: "\u0000" }, { note: "\ud800" }, { marked: "true" }, { version: -1 }, { unknown: true }]) {
        const response = await mark(fixture, auth, settled.order.orderId, { operation_id: randomUUID(), version: 0, marked: true, ...invalid });
        assert.equal(response.status, 422); assert.equal(await responseErrorCode(response), "validation_failed");
      }
      const result = await okData<Record<string, any>>(await mark(fixture, auth, settled.order.orderId, { operation_id: randomUUID(), version: 0, marked: true, note: "🙂".repeat(500) }));
      assert.equal(result.refund_mark.note.length, 1000);
      const concurrent = await Promise.all([false, true].map((marked) => mark(fixture, auth, settled.order.orderId, { operation_id: randomUUID(), version: 1, marked })));
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
      assert.equal(adminRefundMarkHistory(fixture.database, settled.order.orderId).length, 2);
      assert.deepEqual(financialSnapshot(fixture), before); assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("requires admin session, same-origin JSON, CSRF and strict bodies on every write endpoint", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app); const order = fixture.createOrder("protected", 100);
      const endpoints = [
        { method: "POST", path: "/api/admin/v1/work-items/actions/ignore-all", body: { operation_id: randomUUID(), type: "ALL" } },
        { method: "POST", path: "/api/admin/v1/work-items/FINANCIAL_EXCEPTION/" + randomUUID() + "/actions/restore", body: { operation_id: randomUUID() } },
        { method: "PUT", path: "/api/admin/v1/orders/" + order.orderId + "/refund-mark", body: { operation_id: randomUUID(), version: 0, marked: true } },
        { method: "POST", path: "/api/admin/v1/reconciliation/refunds", body: { financial_operation_id: randomUUID(), order_id: order.orderId, ledger_entry_id: randomUUID(), reason: "legacy client" } },
      ];
      for (const endpoint of endpoints) {
        const headers = financialHeaders(auth);
        for (const [override, expected] of [[{ cookie: "" }, 401], [{ origin: "https://other.invalid" }, 403], [{ "x-csrf-token": "" }, 403], [{ "content-type": "text/plain" }, 415]] as const) {
          const response = await fixture.app.request(endpoint.path, { method: endpoint.method, headers: { ...headers, ...override }, body: JSON.stringify(endpoint.body) });
          assert.equal(response.status, expected, endpoint.path);
        }
        const invalid = await fixture.app.request(endpoint.path, { method: endpoint.method, headers, body: JSON.stringify({ ...endpoint.body, unrecognized: true }) });
        assert.equal(invalid.status, 422, endpoint.path);
      }
      fixture.database.read((connection) => { assert.equal(readCount(connection, "admin_operation_log"), 0); assert.equal(readCount(connection, "refund_records"), 0); });
    });
  });

  it("dismisses every page atomically, synchronizes home, preserves runtime counts, and never widens retries", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app); const resources: Array<{ id: string; ledgerId: string }> = [];
      for (let i = 0; i < 25; i += 1) {
        const entry = fixture.recordCredit("work-" + i, 100 + i, i);
        const result = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId);
        assert.equal(result.kind, "unmatched"); if (result.kind !== "unmatched") assert.fail("expected an unmatched credit");
        resources.push({ id: result.exceptionId, ledgerId: entry.ledgerEntryId });
      }
      const before = financialSnapshot(fixture);
      const input = { operation_id: randomUUID(), type: "FINANCIAL_EXCEPTION" };
      const first = await okData<Record<string, any>>(await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, input));
      assert.equal(first.ignored_count, 25); assert.deepEqual(financialSnapshot(fixture), before);
      assert.deepEqual(await okData(await fixture.app.request("/api/admin/v1/work-items?limit=4", { headers: { cookie: auth.cookie } })), []);
      const runtime = await okData<Record<string, any>>(await fixture.app.request("/api/admin/v1/system/status", { headers: { cookie: auth.cookie } }));
      assert.equal(runtime.reconciliation.exceptions.open, 25);
      const analytics = await okData<Record<string, any>>(await fixture.app.request("/api/admin/v1/system/analytics", { headers: { cookie: auth.cookie } }));
      assert.equal(analytics.pending.exceptions, 25);
      const ignored = await fixture.app.request("/api/admin/v1/work-items?visibility=IGNORED&type=FINANCIAL_EXCEPTION&limit=2", { headers: { cookie: auth.cookie } });
      const ignoredBody = await ignored.json() as { data: Array<Record<string, any>>; page: { next_cursor: string } };
      assert.equal(ignoredBody.data.length, 2); assert.ok(ignoredBody.page.next_cursor);
      assert.equal(ignoredBody.data[0]?.ignored_by, "admin"); assert.equal(ignoredBody.data[0]?.ended, false);
      const entry = fixture.recordCredit("work-new", 1000, 50); const added = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId);
      assert.equal(added.kind, "unmatched");
      assert.deepEqual(await okData(await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, input)), first);
      assert.equal(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 200 }).items.length, 1);
      const changed = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, { ...input, type: "ALL" });
      assert.equal(changed.status, 409); assert.equal(await responseErrorCode(changed), "admin_operation_conflict");
      const restorePath = "/api/admin/v1/work-items/FINANCIAL_EXCEPTION/" + resources[0]!.id + "/actions/restore";
      const restoreInput = { operation_id: randomUUID() };
      const restored = await okData<Record<string, any>>(await postFinancial(fixture.app, restorePath, auth, restoreInput));
      assert.equal(restored.restored, true); assert.deepEqual(await okData(await postFinancial(fixture.app, restorePath, auth, restoreInput)), restored);
      const claim = fixture.createOrder("resolve-ignored", 9999);
      fixture.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: claim.orderId, ledgerEntryId: resources[1]!.ledgerId, actorId: "admin", reason: "resolve an ignored financial exception" });
      const history = adminWorkItemPage(fixture.database, { type: "FINANCIAL_EXCEPTION", visibility: "IGNORED", cursor: null, limit: 200 });
      assert.equal(history.items.find((item) => item.itemId === resources[1]!.id)?.ended, true);
      const ended = await postFinancial(fixture.app, "/api/admin/v1/work-items/FINANCIAL_EXCEPTION/" + resources[1]!.id + "/actions/restore", auth, { operation_id: randomUUID() });
      assert.equal(ended.status, 409); assert.equal(await responseErrorCode(ended), "work_item_ended");
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("retains debit evidence and legacy warnings without putting them back into pending scans or reminder counts", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const debit = fixture.recordDebit("quiet-debit", 111, 1);
      for (let i = 0; i < 3; i += 1) assert.equal(fixture.reconciliation.reconcileEntry(debit.ledgerEntryId).kind, "ignored");
      assert.equal(fixture.reconciliation.reconcilePending().processed, 0);
      assert.equal(fixture.reconciliation.exceptionSummary(fixture.services.settings.snapshot().activeProviderAccountKey!).total, 0);
      for (const type of ["UNMATCHED_DEBIT", "UNLINKED_REFUND"] as const) {
        const id = seedLegacyDebitException(fixture.database, debit.ledgerEntryId, type);
        const detail = await okData<Record<string, any>>(await fixture.app.request("/api/admin/v1/reconciliation/exceptions/" + id, { headers: { cookie: auth.cookie } }));
        assert.equal(detail.status, "OPEN"); assert.equal(detail.resolution, null);
      }
      assert.deepEqual(await okData(await fixture.app.request("/api/admin/v1/reconciliation/exceptions", { headers: { cookie: auth.cookie } })), []);
      const summary = fixture.reconciliation.exceptionSummary(fixture.services.settings.snapshot().activeProviderAccountKey!);
      assert.equal(summary.open, 0); assert.equal(summary.resolved, 0); assert.equal(summary.total, 2);
      assert.equal(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.length, 0);
      const analytics = await okData<Record<string, any>>(await fixture.app.request("/api/admin/v1/system/analytics", { headers: { cookie: auth.cookie } }));
      assert.equal(analytics.pending.exceptions, 0);
      assert.equal(fixture.reconciliation.ledgerEntry(debit.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("rolls back refund history and audit when a version write fails", async () => {
    await withHttpFixture(async (fixture) => {
      const order = fixture.createSettlement("mark-rollback", 199).order;
      const before = fixture.database.read((connection) => readCount(connection, "audit_events"));
      fixture.database.write((connection) => connection.exec("CREATE TRIGGER test_block_mark BEFORE INSERT ON admin_refund_marks BEGIN SELECT RAISE(ABORT, 'test mark failure'); END"));
      const body = { operation_id: randomUUID(), version: 0, marked: true };
      assert.throws(() => setAdminRefundMark(fixture.database, order.orderId, body, context), /test mark failure/);
      fixture.database.read((connection) => { assert.equal(readCount(connection, "admin_operation_log"), 0); assert.equal(readCount(connection, "admin_refund_mark_events"), 0); assert.equal(readCount(connection, "admin_refund_marks"), 0); assert.equal(readCount(connection, "audit_events"), before); });
      fixture.database.write((connection) => connection.exec("DROP TRIGGER test_block_mark"));
      assert.equal(setAdminRefundMark(fixture.database, order.orderId, body, context).refund_mark.version, 1);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("rolls back the full ignore batch, member list and audit when a member write fails", async () => {
    await withHttpFixture(async (fixture) => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const entry = fixture.recordCredit("rollback-batch-" + i, 100 + i, i);
        const result = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId);
        if (result.kind !== "unmatched") assert.fail("expected an unmatched exception"); ids.push(result.exceptionId);
      }
      const before = financialSnapshot(fixture);
      const auditCount = fixture.database.read((connection) => readCount(connection, "audit_events"));
      fixture.database.write((connection) => connection.exec("CREATE TRIGGER test_fail_member BEFORE INSERT ON admin_work_item_states WHEN NEW.item_id = '" + ids[1] + "' BEGIN SELECT RAISE(ABORT, 'test batch failure'); END"));
      const input = { operation_id: randomUUID(), type: "ALL" as const };
      assert.throws(() => ignoreAllAdminWorkItems(fixture.database, input, context), /test batch failure/);
      fixture.database.read((connection) => {
        for (const table of ["admin_operation_log", "admin_work_item_operations", "admin_work_item_states"]) assert.equal(readCount(connection, table), 0);
        assert.equal(readCount(connection, "audit_events"), auditCount);
      });
      assert.deepEqual(financialSnapshot(fixture), before);
      fixture.database.write((connection) => connection.exec("DROP TRIGGER test_fail_member"));
      assert.equal(ignoreAllAdminWorkItems(fixture.database, input, context).ignored_count, 2);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("detects admin history tampering even if immutable triggers were bypassed and restored", async () => {
    await withHttpFixture(async (fixture) => {
      const order = fixture.createSettlement("admin-history-integrity", 199).order;
      const result = setAdminRefundMark(fixture.database, order.orderId, { operation_id: randomUUID(), version: 0, marked: true, note: "original" }, context);
      const rewriteNote = (note: string) => fixture.database.write((connection) => {
        const trigger = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'admin_refund_mark_events_no_update'").get() as { sql: string };
        connection.exec("DROP TRIGGER admin_refund_mark_events_no_update");
        connection.prepare("UPDATE admin_refund_mark_events SET note = ? WHERE operation_id = ?").run(note, result.operation_id);
        connection.exec(trigger.sql);
      });
      rewriteNote("changed without matching operation/audit");
      const damaged = fixture.database.integrityCheck(); assert.equal(damaged.schema, "ok"); assert.ok(damaged.domainViolations > 0);
      rewriteNote("original"); assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

});
