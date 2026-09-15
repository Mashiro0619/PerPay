import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { login, postFinancial, withHttpFixture, type ReconciliationHttpFixture } from "./reconciliation-http-fixture.ts";

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
        const account = fixture.services.settings.snapshot().activeProviderAccountKey!;
        const before = await readPages();
        assert.deepEqual(new Set(before), new Set(ids));
        const summaries = { conflicts: fixture.ledger.conflictSummary(account), exceptions: fixture.reconciliation.exceptionSummary(account) };
        const batch = { operation_id: randomUUID(), type: scenario.type };
        assert.equal((await post("/api/admin/v1/work-items/actions/ignore-all", batch)).data.ignored_count, ids.length);
        assert.deepEqual(await get<ReviewPage>(scenario.path), { data: [], page: { next_cursor: null } });
        assert.deepEqual((await get<ReviewPage>(other.path)).data.map(item => item[other.idKey]), otherIds);
        assert.deepEqual({ conflicts: fixture.ledger.conflictSummary(account), exceptions: fixture.reconciliation.exceptionSummary(account) }, summaries);
        const runtime = await get<{ data: { ledger: { conflicts: { open: number } }; reconciliation: { exceptions: { open: number } } } }>("/api/admin/v1/system/status");
        assert.equal(runtime.data.ledger.conflicts.open, summaries.conflicts.open);
        assert.equal(runtime.data.reconciliation.exceptions.open, summaries.exceptions.open);
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
  const run = fixture.ledger.startIngestRun({ start, end, pageSize: count, providerAccountKey: fixture.services.settings.snapshot().activeProviderAccountKey!, now: fixture.baseTime });
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
