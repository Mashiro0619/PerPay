import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { login, postFinancial, withHttpFixture, type ReconciliationHttpFixture } from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";

interface ReviewItem { status: string; reminder_ignored: boolean; exception_id?: string; conflict_id?: string; }
interface ReviewPage { data: ReviewItem[]; page: { next_cursor: string | null }; }
const cases = [
  { type: "FINANCIAL_EXCEPTION", path: "/api/admin/v1/reconciliation/exceptions", idKey: "exception_id", seed: seedExceptions },
  { type: "LEDGER_CONFLICT", path: "/api/admin/v1/ledger/conflicts", idKey: "conflict_id", seed: seedConflicts },
] as const;

describe("reconciliation reminder visibility", () => {
  for (const scenario of cases) {
    it("filters ignored " + scenario.type + " before pagination and restores reminders without changing evidence", async () => {
      await withHttpFixture(async (fixture) => {
        const auth = await login(fixture.app);
        const headers = { cookie: auth.cookie };
        async function get<T>(path: string): Promise<T> {
          const response = await fixture.app.request(path, { headers });
          assert.equal(response.status, 200, await response.clone().text());
          return response.json() as Promise<T>;
        }
        async function post(path: string, body: Record<string, unknown>) {
          const response = await postFinancial(fixture.app, path, auth, body);
          assert.equal(response.status, 200, await response.clone().text());
          return response.json() as Promise<{ data: { ignored_count?: number; restored?: boolean } }>;
        }
        async function readPages() {
          const pages: ReviewPage[] = [];
          let cursor: string | null = null;
          do {
            assert.ok(pages.length < 10, "pagination must terminate");
            const page: ReviewPage = await get<ReviewPage>(scenario.path + "?limit=2" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
            assert.ok(page.data.every(item => item.reminder_ignored === false));
            if (page.page.next_cursor) assert.equal(page.data.length, 2, "ignored rows must not consume the page limit");
            pages.push(page); cursor = page.page.next_cursor;
          } while (cursor);
          return pages.flatMap(page => page.data.map(item => item[scenario.idKey]!));
        }
        const ids = scenario.seed(fixture, 5, 0);
        const other = cases.find(item => item.type !== scenario.type)!;
        const otherIds = other.seed(fixture, 1, 1);
        const account = fixture.services.settings.instanceSnapshot().activeProviderAccountKey!;
        const before = await readPages();
        assert.deepEqual(new Set(before), new Set(ids));
        const summaries = { conflicts: fixture.ledger.conflictSummary(account), exceptions: fixture.reconciliation.exceptionSummary(account) };
        const batch = { operation_id: randomUUID(), type: scenario.type };
        assert.equal((await post("/api/admin/v1/work-items/actions/ignore-all", batch)).data.ignored_count, ids.length);
        assert.deepEqual(await get<ReviewPage>(scenario.path), { data: [], page: { next_cursor: null } });
        assert.deepEqual((await get<ReviewPage>(other.path)).data.map(item => item[other.idKey]), otherIds);
        assert.deepEqual({ conflicts: fixture.ledger.conflictSummary(account), exceptions: fixture.reconciliation.exceptionSummary(account) }, summaries);
        const runtime = await get<{ data: { work_items: { total: number; financial_exceptions: number; ledger_conflicts: number; notification_failures: number }; ledger: { conflicts: { open: number } }; reconciliation: { exceptions: { open: number } } } }>("/api/admin/v1/system/status");
        assert.equal(runtime.data.ledger.conflicts.open, summaries.conflicts.open);
        assert.equal(runtime.data.reconciliation.exceptions.open, summaries.exceptions.open);
        assert.deepEqual(runtime.data.work_items, {
          total: 1,
          financial_exceptions: scenario.type === "FINANCIAL_EXCEPTION" ? 0 : 1,
          ledger_conflicts: scenario.type === "LEDGER_CONFLICT" ? 0 : 1,
          notification_failures: 0,
        });
        const ignored = await get<{ data: Array<{ resource_id: string; ended: boolean }> }>("/api/admin/v1/work-items?type=" + scenario.type + "&visibility=IGNORED");
        assert.deepEqual(new Set(ignored.data.map(item => item.resource_id)), new Set(ids));
        assert.ok(ignored.data.every(item => !item.ended));
        for (const id of ids) {
          const detail = await get<{ data: { status?: string; reminder_ignored: boolean; conflict?: { status: string; reminder_ignored: boolean } } }>(scenario.path + "/" + id);
          assert.equal(detail.data.conflict?.status ?? detail.data.status, "OPEN");
          assert.equal(detail.data.conflict?.reminder_ignored ?? detail.data.reminder_ignored, true);
        }
        if (scenario.type === "LEDGER_CONFLICT") {
          assert.deepEqual(new Set(fixture.ledger.listOpenConflicts(account).map(item => item.conflictId)), new Set(ids));
          const all = await get<ReviewPage>(scenario.path + "?status=ALL");
          assert.ok(ids.every(id => all.data.some(item => item.conflict_id === id && item.reminder_ignored === true)));
        } else {
          assert.deepEqual(new Set(fixture.reconciliation.listOpenExceptions(account).map(item => item.exceptionId)), new Set(ids));
        }
        const restored = before.filter((_, index) => index % 2 === 0);
        for (const id of restored) {
          assert.equal((await post("/api/admin/v1/work-items/" + scenario.type + "/" + id + "/actions/restore", { operation_id: randomUUID() })).data.restored, true);
        }
        assert.deepEqual(await readPages(), restored);
        const newIds = scenario.seed(fixture, 1, 2);
        assert.equal((await post("/api/admin/v1/work-items/actions/ignore-all", batch)).data.ignored_count, ids.length);
        assert.deepEqual(new Set(await readPages()), new Set([...restored, ...newIds]));
        const active = await get<{ data: Array<{ resource_id: string }> }>("/api/admin/v1/work-items?type=" + scenario.type);
        assert.deepEqual(new Set(active.data.map(item => item.resource_id)), new Set([...restored, ...newIds]));
        assert.equal(fixture.database.integrityCheck().ok, true);
      });
    });
  }

  it("does not resurrect an ignored financial exception on reclassification and keeps terminal reminder_ignored false", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const headers = { cookie: auth.cookie };
      const firstOrder = fixture.createOrder("ignore-reclassify-1", 1_000);
      const credit = fixture.recordCredit("ignore-reclassify-credit", 1_501, 1);
      const firstPass = fixture.reconciliation.reconcileEntry(credit.ledgerEntryId, fixture.baseTime + 200);
      assert.equal(firstPass.kind, "unmatched");
      if (firstPass.kind !== "unmatched") assert.fail("expected unmatched");
      const exceptionId = firstPass.exceptionId;
      assert.equal(fixture.reconciliation.exception(exceptionId)?.exceptionType, "AMOUNT_MISMATCH");

      const ignoreResponse = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-selected", auth, {
        operation_id: randomUUID(),
        items: [{ type: "FINANCIAL_EXCEPTION", resource_id: exceptionId }],
      });
      assert.equal(ignoreResponse.status, 200, await ignoreResponse.clone().text());
      assert.equal(((await ignoreResponse.json()) as { data: { ignored_count: number } }).data.ignored_count, 1);

      // Close the first order so a naive reclassification would produce UNMATCHED_CREDIT.
      fixture.closeOrder(firstOrder.orderId);
      const secondPass = fixture.reconciliation.reconcileEntry(credit.ledgerEntryId, fixture.baseTime + 2_000);
      assert.equal(secondPass.kind, "unmatched");
      if (secondPass.kind !== "unmatched") assert.fail("expected unmatched");
      assert.equal(secondPass.exceptionId, exceptionId);
      const account = fixture.services.settings.instanceSnapshot().activeProviderAccountKey!;
      assert.equal(fixture.reconciliation.listOpenExceptions(account).length, 1);

      const summaryAfterResweep = await fixture.app.request("/api/admin/v1/work-items/summary", { headers });
      assert.equal(summaryAfterResweep.status, 200);
      assert.equal(((await summaryAfterResweep.json()) as { data: { total: number } }).data.total, 0);

      // A later exact-amount order still auto-settles and resolves the ignored exception cleanly.
      const exactOrder = fixture.createOrder("ignore-reclassify-exact", 1_500);
      assert.equal(exactOrder.payableAmountCents, credit.amountCents);
      const settled = fixture.reconciliation.reconcileEntry(credit.ledgerEntryId, fixture.baseTime + 3_000);
      assert.equal(settled.kind, "auto_settled");

      const resolvedDetail = await fixture.app.request(`/api/admin/v1/reconciliation/exceptions/${exceptionId}`, { headers });
      assert.equal(resolvedDetail.status, 200);
      const resolvedJson = (await resolvedDetail.json()) as { data: { status: string; reminder_ignored: boolean } };
      assert.equal(resolvedJson.data.status, "RESOLVED");
      assert.equal(resolvedJson.data.reminder_ignored, false);

      // Verify work_items audit category & safe details.
      const auditResponse = await fixture.app.request("/api/admin/v1/audit-events?category=reconciliation&action=work_items.ignore_all", { headers });
      assert.equal(auditResponse.status, 200, await auditResponse.clone().text());
      const auditEvents = (await auditResponse.json()) as { data: Array<{ event_id: string; action: string; category: string }> };
      assert.ok(auditEvents.data.length >= 1);
      assert.equal(auditEvents.data[0]?.category, "reconciliation");
      const auditDetailRes = await fixture.app.request(`/api/admin/v1/audit-events/core/${auditEvents.data[0]!.event_id}`, { headers });
      assert.equal(auditDetailRes.status, 200);
      const auditDetail = (await auditDetailRes.json()) as { data: { details: Record<string, unknown> } };
      assert.equal(auditDetail.data.details.ignore_scope, "selected");
      assert.equal(auditDetail.data.details.selected_count, 1);
      assert.equal(auditDetail.data.details.ignored_count, 1);

      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("exposes live reminder_ignored on webhook delivery endpoints and clears it after acknowledgement", async () => {
    await withHttpFixture(async (fixture) => {
      const siteId = fixture.services.sites.list()[0]!.clientId;
      configureTestSiteNotifications(fixture.services.sites, siteId, {
        enabled: true,
        allowed_origin: "https://merchant.example.com",
      });
      const auth = await login(fixture.app);
      const headers = { cookie: auth.cookie };
      const order = fixture.createOrder("webhook-reminder-1", 1_200, "https://merchant.example.com/notify");
      const credit = fixture.recordCredit("webhook-reminder-credit", order.payableAmountCents, 1);
      const settledAt = Date.now() + 500;
      assert.equal(fixture.reconciliation.reconcileEntry(credit.ledgerEntryId, settledAt).kind, "auto_settled");
      fixture.webhooks.materialize(10, settledAt + 100, siteId);
      const siteRevision = fixture.services.sites.get(siteId)!.revision;
      const claimed = fixture.webhooks.claimNext({
        clientId: siteId,
        siteRevision,
        now: settledAt + 200,
        leaseMilliseconds: 30_000,
        maximumAttempts: 5,
      });
      assert.ok(claimed);
      fixture.webhooks.completeAttempt({
        deliveryId: claimed.delivery.deliveryId,
        attemptId: claimed.attempt.attemptId,
        leaseToken: claimed.attempt.leaseToken,
        outcome: "RETRYABLE_FAILURE",
        now: settledAt + 300,
        maximumAttempts: 5,
        retryBaseMilliseconds: 10_000,
        retryMaximumMilliseconds: 60_000,
        errorCode: "http_status_rejected",
      });
      const deliveryId = claimed.delivery.deliveryId;

      const ignoreRes = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-selected", auth, {
        operation_id: randomUUID(),
        items: [{ type: "NOTIFICATION_FAILURE", resource_id: deliveryId }],
      });
      assert.equal(ignoreRes.status, 200, await ignoreRes.clone().text());

      const detailRes = await fixture.app.request(`/api/admin/v1/webhooks/deliveries/${deliveryId}`, { headers });
      assert.equal(detailRes.status, 200);
      assert.equal(((await detailRes.json()) as { data: { reminder_ignored: boolean } }).data.reminder_ignored, true);

      const listRes = await fixture.app.request("/api/admin/v1/webhooks/deliveries", { headers });
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as { data: Array<{ delivery_id: string; reminder_ignored: boolean }> };
      assert.equal(listData.data.find((d) => d.delivery_id === deliveryId)?.reminder_ignored, true);

      const orderDelivRes = await fixture.app.request(`/api/admin/v1/orders/${order.orderId}/notifications/deliveries`, { headers });
      assert.equal(orderDelivRes.status, 200);
      const orderDelivData = (await orderDelivRes.json()) as { data: Array<{ delivery: { delivery_id: string }; reminder_ignored: boolean }> };
      assert.equal(orderDelivData.data.find((d) => d.delivery.delivery_id === deliveryId)?.reminder_ignored, true);

      // Acknowledge the retry: reminder_ignored must now be false on all webhook endpoints.
      const retryClaim = fixture.webhooks.claimNext({
        clientId: siteId,
        siteRevision,
        now: settledAt + 20_000,
        leaseMilliseconds: 30_000,
        maximumAttempts: 5,
      });
      assert.ok(retryClaim);
      fixture.webhooks.completeAttempt({
        deliveryId: retryClaim.delivery.deliveryId,
        attemptId: retryClaim.attempt.attemptId,
        leaseToken: retryClaim.attempt.leaseToken,
        outcome: "ACKNOWLEDGED",
        httpStatus: 200,
        responseBytes: 15,
        responseFingerprint: "b".repeat(64),
        ackCode: "acknowledged",
        resolvedAddressesFingerprint: "a".repeat(64),
        connectedAddress: "203.0.113.10",
        now: settledAt + 20_100,
        maximumAttempts: 5,
        retryBaseMilliseconds: 10_000,
        retryMaximumMilliseconds: 60_000,
      });

      const ackDetailRes = await fixture.app.request(`/api/admin/v1/webhooks/deliveries/${deliveryId}`, { headers });
      assert.equal(ackDetailRes.status, 200);
      assert.equal(((await ackDetailRes.json()) as { data: { reminder_ignored: boolean } }).data.reminder_ignored, false);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });
});

function seedExceptions(fixture: ReconciliationHttpFixture, count: number, batch: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const entry = fixture.recordCredit("reminder-exception-" + batch + "-" + index, 101 + index, batch * 10 + index);
    const result = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId);
    if (result.kind !== "unmatched") assert.fail("expected an unmatched income exception");
    return result.exceptionId;
  });
}

function seedConflicts(fixture: ReconciliationHttpFixture, count: number, batch: number): string[] {
  const start = "2026-08-" + (10 + batch) + " 00:00:00";
  const end = "2026-08-" + (10 + batch) + " 01:00:00";
  const run = fixture.ledger.startIngestRun({ start, end, pageSize: count, providerAccountKey: fixture.services.settings.instanceSnapshot().activeProviderAccountKey!, now: fixture.baseTime });
  const details = Array.from({ length: count }, (_, index) => ({
    raw: { account_log_id: "reminder-conflict-" + batch + "-" + index, amount: "1.001", direction: "DEBIT", occurred_at: start },
    accountLogId: "reminder-conflict-" + batch + "-" + index, amount: "1.001", direction: "DEBIT" as const,
    occurredAt: start, alipayOrderNo: null, merchantOrderNo: null, transMemo: null, otherAccount: null,
  }));
  const page = fixture.ledger.recordPage({
    ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: count, totalSize: count, hasMore: false, details },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(details), traceId: null, signatureVerified: true },
    now: fixture.baseTime + batch + 1,
  });
  return page.normalized.map(result => {
    if (result.kind !== "isolated") assert.fail("expected a retained invalid-amount conflict");
    return result.conflict.conflictId;
  });
}
