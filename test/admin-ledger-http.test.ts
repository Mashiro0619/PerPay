import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { encodeAdminLedgerCursor, readAdminLedgerPageQuery, resolveAdminLedgerEnvironment } from "../src/http/admin-ledger-query.ts";
import type { AdminLedgerDetail, AdminLedgerSummary } from "../src/ledger/admin-query.ts";
import type { LedgerStore } from "../src/ledger/store.ts";
import { providerEndpoint } from "../src/settings/model.ts";
import { login, recordLedgerEntry, withHttpFixture } from "./reconciliation-http-fixture.ts";

const PATH = "/api/admin/v1/ledger/entries";
interface Page { data: AdminLedgerSummary[]; environment: "PRODUCTION" | "SANDBOX" | null; page: { next_cursor: string | null } }
function recordEntry(ledger: LedgerStore, providerAccountKey: string, externalEventId: string, at: number, now: number, amountCents = 1234) {
  const timestamp = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const detail = {
    accountLogId: externalEventId, occurredAt: timestamp(at), amount: (amountCents / 100).toFixed(2), direction: "CREDIT",
    alipayOrderNo: "provider-http-fixed-id", merchantOrderNo: null, transMemo: null, otherAccount: null,
    raw: { account_log_id: externalEventId, amount: (amountCents / 100).toFixed(2), occurred_at: timestamp(at), direction: "CREDIT" },
  };
  const run = ledger.startIngestRun({ providerAccountKey, start: timestamp(at - 60_000), end: timestamp(at + 60_000), pageSize: 1, now });
  const result = ledger.recordPage({ ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [detail] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(detail), traceId: "synthetic-ledger-http", signatureVerified: true }, now: now + 1 });
  assert.equal(result.normalized[0]?.kind, "created");
}
function financialSnapshot(database: AppDatabase) {
  return database.read(db => JSON.stringify(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .filter(({ name }) => /ledger|payment|provider|webhook|audit|admin_operation|order/.test(name))
      .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]),
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
  ));
}

describe("administrator read-only ledger HTTP", () => {
  it("requires authentication and returns associated facts without collection or financial writes", async t => {
    await withHttpFixture(async f => {
      const settled = f.createSettlement("ledger-http-settled", 1234);
      f.recordDebit("ledger-http-debit", 900, 5);
      assert.equal((await f.app.request(PATH)).status, 401);
      assert.equal((await f.app.request(PATH + "/" + settled.entry.ledgerEntryId)).status, 401);
      const auth = await login(f.app);
      const snapshot = financialSnapshot(f.database);
      const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("ledger reads must not contact a provider"); });
      const response = await f.app.request(PATH, { headers: { cookie: auth.cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const page = await response.json() as Page;
      assert.equal(page.environment, "PRODUCTION");
      assert.equal(page.data.length, 2);
      const group = page.data.find(item => item.ledger_entry_id === settled.entry.ledgerEntryId)!;
      assert.equal(group.active_match?.order_id, settled.order.orderId);
      const detailResponse = await f.app.request(PATH + "/" + group.ledger_entry_id, { headers: { cookie: auth.cookie } });
      assert.equal(detailResponse.status, 200);
      const detail = (await detailResponse.json() as { data: AdminLedgerDetail }).data;
      assert.equal(detail.sources[0]?.ledger_entry_id, settled.entry.ledgerEntryId);
      assert.equal(detail.matches[0]?.ledger_entry_id, settled.entry.ledgerEntryId);
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(financialSnapshot(f.database), snapshot);
      for (const id of ["not-a-real-id", randomUUID()]) {
        assert.equal((await f.app.request(PATH + "/" + id, { headers: { cookie: auth.cookie } })).status, 404);
      }
      assert.equal((await f.app.request(PATH + "/" + group.ledger_entry_id + "?q=a", { headers: { cookie: auth.cookie } })).status, 422);
    });
  });

  it("validates all filters, pages special 256-character IDs and binds every cursor input", async () => {
    await withHttpFixture(async f => {
      const specialId = "流水/?&=+#%😀\n".padEnd(256, "长");
      assert.equal(specialId.length, 256);
      f.recordCredit("before", 300, 0);
      recordEntry(f.ledger, f.services.settings.instanceSnapshot().activeProviderAccountKey!, specialId, f.baseTime + 61_000, f.baseTime);
      f.recordCredit("after", 2500, 2);
      const auth = await login(f.app);
      const get = (query: string) => f.app.request(PATH + "?" + query, { headers: { cookie: auth.cookie } });
      const first = await (await get("limit=1&sort_order=asc")).json() as Page;
      const second = await (await get("limit=1&sort_order=asc&cursor=" + first.page.next_cursor)).json() as Page;
      assert.equal(second.data[0]?.external_event_id, specialId);
      assert.ok(second.page.next_cursor);
      const last = await (await get("limit=1&sort_order=asc&cursor=" + second.page.next_cursor)).json() as Page;
      assert.equal(last.data[0]?.external_event_id, "after");
      assert.equal(last.page.next_cursor, null);
      for (const change of [
        "q=changed", "direction=DEBIT", "state=ALLOCATED", "occurred_from=2026-10-01&occurred_to=2026-10-21",
        "min_amount_cents=1", "max_amount_cents=9999", "sort_order=desc", "limit=2",
      ]) {
        const values = new URLSearchParams("limit=1&sort_order=asc");
        for (const [key, value] of new URLSearchParams(change)) values.set(key, value);
        values.set("cursor", second.page.next_cursor!);
        assert.equal((await get(values.toString())).status, 422, change);
      }
      const exact = await (await get("q=" + encodeURIComponent(specialId.slice(0, 6)) + "&min_amount_cents=1234&max_amount_cents=1234&direction=CREDIT&state=UNALLOCATED")).json() as Page;
      assert.equal(exact.data[0]?.external_event_id, specialId);
      for (const query of [
        "limit=0", "limit=101", "limit=01", "limit=1e2", "limit=", "limit=1&limit=1", "q=a&q=a",
        "sort_by=created_at", "sort_order=ASC", "direction=ALL", "state=ALL", "environment=SANDBOX", "site_id=a",
        "unknown=x", "occurred_from=2026-10-20", "occurred_to=2026-10-20", "occurred_from=2026-02-30&occurred_to=2026-03-01",
        "occurred_from=2026-10-21&occurred_to=2026-10-20", "min_amount_cents=-1", "max_amount_cents=1000000000000",
        "min_amount_cents=1.2", "min_amount_cents=01", "max_amount_cents=", "min_amount_cents=2&max_amount_cents=1",
        "max_amount_cents=1&max_amount_cents=1", "cursor=", "cursor=x", "cursor=" + second.page.next_cursor + "=",
        "q=" + encodeURIComponent("😀".repeat(101)), "q=x%00y",
      ]) assert.equal((await get(query)).status, 422, query);
      for (const query of ["limit=100", "min_amount_cents=0&max_amount_cents=999999999999", "q=" + encodeURIComponent("😀".repeat(100))]) {
        assert.equal((await get(query)).status, 200, query);
      }
    });
  });

  it("uses configured environment, falls back through retained evidence, and resolves historical details by source", async () => {
    await withHttpFixture(async f => {
      const production = f.recordCredit("same-event", 1234, 0);
      const auth = await login(f.app);
      const headers = { cookie: auth.cookie };
      const key = "sandbox:" + randomUUID();
      const now = f.baseTime + 1000;
      f.ledger.bindProviderIdentity({ providerAccountKey: key, providerKind: "alipay", endpoint: providerEndpoint("SANDBOX"), externalAccountId: "2026000000000002" }, now);
      const sandbox = recordLedgerEntry(f.ledger,
        { start: "2026-10-19 00:00:00", end: "2026-10-21 00:00:00" }, "same-event", 9900,
        Date.parse("2026-10-20T04:00:00Z"), now + 1, "CREDIT", key);
      const app = createApp({ ...f.services, ledger: f.ledger, startedAt: new Date(0) });
      const page = await (await app.request(PATH, { headers })).json() as Page;
      assert.equal(page.environment, "PRODUCTION");
      assert.deepEqual(page.data.map(item => item.ledger_entry_id), [production.ledgerEntryId]);
      for (const [id, environment, amount] of [[production.ledgerEntryId, "PRODUCTION", 1234], [sandbox.ledgerEntryId, "SANDBOX", 9900]] as const) {
        const response = await app.request(PATH + "/" + id, { headers });
        assert.equal(response.status, 200);
        const detail = (await response.json() as { data: AdminLedgerDetail }).data;
        assert.equal(detail.environment, environment);
        assert.equal(detail.amount_cents, amount);
        assert.equal(detail.source_record_count, 1);
      }
      const { settings: _settings, ...withoutSettings } = f.services;
      const fallback = createApp({ ...withoutSettings, startedAt: new Date(0) });
      const fallbackPage = await (await fallback.request(PATH, { headers })).json() as Page;
      assert.equal(fallbackPage.environment, "SANDBOX");
      assert.deepEqual(fallbackPage.data.map(item => item.ledger_entry_id), [sandbox.ledgerEntryId]);
      const query = readAdminLedgerPageQuery(new URLSearchParams("limit=1"), "PRODUCTION");
      const cursor = encodeAdminLedgerCursor({ occurred_at_ms: 1, external_event_id: "same-event" }, query)!;
      assert.equal((await fallback.request(PATH + "?limit=1&cursor=" + cursor, { headers })).status, 422);
      assert.equal(resolveAdminLedgerEnvironment(f.database, () => { throw new Error("configuration unavailable"); }), "SANDBOX");
      const empty = await AppDatabase.open(join(f.directory, "empty.sqlite"), { masterKey: f.services.config.masterKey });
      try {
        const emptyApp = createApp({ ...withoutSettings, database: empty, startedAt: new Date(0) });
        assert.deepEqual(await (await emptyApp.request(PATH, { headers })).json(), { data: [], page: { next_cursor: null }, environment: null });
        // A retained binding without an activation still identifies the readable environment.
        const binding = f.database.read(db => db.prepare("SELECT * FROM provider_account_bindings WHERE provider_account_key = ?").get(key))!;
        empty.write(db => db.prepare(`INSERT INTO provider_account_bindings
          (provider_account_key, provider_kind, provider_endpoint, external_account_id,
           identity_fingerprint_version, identity_fingerprint, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(binding.provider_account_key!, binding.provider_kind!, binding.provider_endpoint!, binding.external_account_id!,
            binding.identity_fingerprint_version!, binding.identity_fingerprint!, binding.bound_at!));
        assert.equal(resolveAdminLedgerEnvironment(empty, () => null), "SANDBOX");
        assert.equal((await emptyApp.request(PATH, { headers })).status, 200);
      } finally { empty.close(); }
    });
  });

  it("uses inclusive Beijing transaction dates and defaults to twenty descending event groups", async () => {
    await withHttpFixture(async f => {
      const key = f.services.settings.instanceSnapshot().activeProviderAccountKey!;
      const start = Date.parse("2026-10-19T16:00:00Z");
      recordEntry(f.ledger, key, "outside-before", start - 1_000, f.baseTime);
      for (let index = 0; index < 21; index++) {
        recordEntry(f.ledger, key, "beijing-" + index.toString().padStart(2, "0"), start + index * 1_000, f.baseTime + index + 2, index === 0 ? 999_999_999_999 : 1234);
      }
      recordEntry(f.ledger, key, "inside-last-second", start + 86_399_000, f.baseTime + 25);
      recordEntry(f.ledger, key, "outside-after", start + 86_400_000, f.baseTime + 26);
      const auth = await login(f.app);
      const get = (query: string) => f.app.request(PATH + "?" + query, { headers: { cookie: auth.cookie } });
      const dateQuery = "occurred_from=2026-10-20&occurred_to=2026-10-20";
      const first = await (await get(dateQuery)).json() as Page;
      assert.equal(first.data.length, 20);
      assert.equal(first.data[0]?.external_event_id, "inside-last-second");
      assert.ok(first.page.next_cursor);
      const last = await (await get(dateQuery + "&cursor=" + first.page.next_cursor)).json() as Page;
      assert.deepEqual(last.data.map(item => item.external_event_id), ["beijing-01", "beijing-00"]);
      assert.equal(last.page.next_cursor, null);
      const all = await (await get(dateQuery + "&limit=100&sort_order=asc")).json() as Page;
      assert.equal(all.data.length, 22);
      assert.equal(all.data[0]?.external_event_id, "beijing-00");
      assert.equal(all.data.at(-1)?.external_event_id, "inside-last-second");
      assert.equal(all.page.next_cursor, null);
      const maximum = await (await get(dateQuery + "&min_amount_cents=999999999999&max_amount_cents=999999999999")).json() as Page;
      assert.deepEqual(maximum.data.map(item => item.external_event_id), ["beijing-00"]);
      const zero = await (await get("max_amount_cents=0")).json() as Page;
      assert.deepEqual(zero.data, []);
    });
  });
});
