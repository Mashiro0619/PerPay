import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { migrations } from "../src/database/migrations.ts";
import { OrderStore } from "../src/database/order-store.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import {
  readAdminLedgerDetail,
  readAdminLedgerPage,
  type AdminLedgerDatabase,
  type AdminLedgerQuery,
} from "../src/ledger/admin-query.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import { createOrderRequestSchema, digestIdempotencyKey, fingerprintCreateOrderRequest } from "../src/orders/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { providerEndpoint, type ProviderEnvironment } from "../src/settings/model.ts";
import { beijingDate, createdDateRange } from "../src/shared/created-dates.ts";
import { ListQueryError } from "../src/shared/list-query.ts";
import { createSiteFixture } from "./site-fixture.ts";

const BASE = Date.parse("2026-10-19T16:00:00.000Z");
const ENVIRONMENT = "PRODUCTION" as const;
const PROVIDER_ORDER = "2026102012345678901234567890";

interface RecordInput {
  id: string;
  amount?: number;
  at?: number;
  direction?: "CREDIT" | "DEBIT";
  memo?: string | null;
  otherAccount?: string | null;
  merchantOrderNo?: string | null;
  occurredText?: string;
  amountText?: string;
  directionText?: string;
}

function recorder(ledger: LedgerStore, key: () => string, tick: () => number) {
  return (input: RecordInput) => {
    const at = input.at ?? BASE;
    const amount = input.amount ?? 1234;
    const detail: AccountLogDetail = {
      accountLogId: input.id,
      occurredAt: input.occurredText ?? providerTimestamp(at, true),
      amount: input.amountText ?? (amount / 100).toFixed(2),
      direction: input.directionText ?? input.direction ?? "CREDIT",
      alipayOrderNo: PROVIDER_ORDER,
      merchantOrderNo: input.merchantOrderNo ?? null,
      transMemo: input.memo ?? null,
      otherAccount: input.otherAccount ?? null,
      raw: {
        account_log_id: input.id,
        trans_amount: input.amountText ?? (amount / 100).toFixed(2),
        direction: input.directionText ?? input.direction ?? "CREDIT",
        trans_dt: input.occurredText ?? providerTimestamp(at, true),
        trans_memo: input.memo ?? null,
      },
    };
    const record = () => {
      const run = ledger.startIngestRun({
        providerAccountKey: key(), pageSize: 1,
        start: providerTimestamp(at - 60_000), end: providerTimestamp(at + 60_000),
        now: tick(),
      });
      return ledger.recordPage({
        ingestRunId: run.ingestRunId,
        page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [detail] },
        evidence: {
          httpStatus: 200, headers: {}, body: JSON.stringify(detail),
          traceId: "synthetic-admin-ledger-query", signatureVerified: true,
        },
        now: tick(),
      });
    };
    let result = record();
    if (result.kind === "variant") result = record();
    assert.notEqual(result.kind, "variant");
    const normalized = result.normalized[0];
    assert.ok(normalized);
    return normalized;
  };
}

function fixture(indexes = true, initialTime = Date.now()) {
  const f = createSiteFixture();
  f.migrate();
  if (indexes) f.connection.exec(migrations.find(migration => migration.version === 35)!.sql);
  const ledger = new LedgerStore(f.owner);
  let clock = initialTime, key = "";
  const tick = () => ++clock;
  f.owner.write(db => db.prepare("INSERT INTO checkout_token_keys(key_version, key_material, activated_at, retired_at) VALUES (1, ?, ?, NULL)").run(randomBytes(32), tick()));
  const orders = new OrderStore(f.owner, tick);
  const reconciliation = new ReconciliationStore(f.owner);
  const activate = (environment: ProviderEnvironment = ENVIRONMENT, appId = "2026000000000001") => {
    key = "source:" + randomUUID();
    ledger.bindProviderIdentity({
      providerAccountKey: key, providerKind: "alipay", endpoint: providerEndpoint(environment), externalAccountId: appId,
    }, tick());
    return key;
  };
  const record = recorder(ledger, () => key, tick);
  const entry = (input: RecordInput): LedgerEntry => {
    const result = record(input);
    assert.ok(result.kind === "created" || result.kind === "duplicate", result.kind);
    return result.entry;
  };
  const order = (merchantOrderNo: string, siteName = "账本关联网站", productName = "关联订单商品") => {
    const sites = f.store();
    const site = sites.create({
      operation_id: randomUUID(), configuration: {
        name: siteName, accepting_orders: true, notifications_enabled: false,
        notification_origin: null, return_origin: null, policy: sites.defaults().policy,
      },
    }, { actorId: "admin" }, tick());
    const codePayload = "https://qr.alipay.com/admin-ledger-query";
    orders.syncCollectionProfile({ providerAccountKey: key, codePayload, ...fingerprintCollectionCodeProfile(codePayload, key) });
    const request = createOrderRequestSchema.parse({
      merchant_order_no: merchantOrderNo, idempotency_key: merchantOrderNo,
      amount_cents: 1233, product_name: productName,
    });
    const result = orders.createOrder({
      apiClientId: site.clientId, request, idempotencyKeyDigest: digestIdempotencyKey(site.clientId, request.idempotency_key),
      requestFingerprint: fingerprintCreateOrderRequest(request), ttlMilliseconds: 300_000, amountOffsetMaximumCents: 99,
    });
    assert.equal(result.kind, "created");
    if (result.kind !== "created") throw new Error("expected real order creation");
    return { ...result.aggregate.order, site };
  };
  const settle = (orderId: string, ledgerEntryId: string, now = tick()) => reconciliation.settleManually({
    financialOperationId: randomUUID(), orderId, ledgerEntryId, actorId: "admin", now,
  });
  return { ...f, ledger, reconciliation, activate, record, entry, tick, order, settle, advance: (now: number) => { clock = now; } };
}

function providerTimestamp(milliseconds: number, fractional = false) {
  return new Date(milliseconds + 8 * 3_600_000).toISOString().slice(0, fractional ? -1 : 19).replace("T", " ");
}

describe("administrator grouped ledger queries", () => {
  it("includes old source generations once and keeps sandbox records separate", () => {
    const f = fixture();
    try {
      const firstKey = f.activate();
      const first = f.entry({ id: "shared-event" });
      const secondKey = f.activate(ENVIRONMENT, "2026000000000002");
      const second = f.entry({ id: "shared-event" });
      f.activate("SANDBOX", "2026000000000003");
      const sandbox = f.entry({ id: "shared-event", amount: 9900 });
      const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT });
      assert.equal(page.items.length, 1);
      assert.equal(page.next_cursor, null);
      const group = page.items[0]!;
      assert.equal(group.amount_cents, 1234);
      assert.equal(group.source_record_count, 2);
      assert.equal(group.content_consistent, true);
      assert.equal(group.has_conflicts, false);
      assert.equal(group.active_match_count, 0);
      assert.equal(group.active_match, null);
      assert.deepEqual(group.states, ["UNALLOCATED"]);
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, second.ledgerEntryId)!;
      assert.deepEqual(detail.sources.map(source => source.ledger_entry_id), [first.ledgerEntryId, second.ledgerEntryId]);
      assert.deepEqual(detail.sources.map(source => source.provider_account_key), [firstKey, secondKey]);
      assert.deepEqual(detail.sources.map(source => source.app_id), ["2026000000000001", "2026000000000002"]);
      assert.equal(new Set(detail.sources.map(source => source.semantic_fingerprint)).size, 1);
      assert.deepEqual(detail, readAdminLedgerDetail(f.owner, ENVIRONMENT, first.ledgerEntryId));
      assert.equal(readAdminLedgerDetail(f.owner, ENVIRONMENT, sandbox.ledgerEntryId), null);
      assert.equal(readAdminLedgerPage(f.owner, { environment: "SANDBOX" }).items[0]!.amount_cents, 9900);
      assert.equal(readAdminLedgerDetail(f.owner, ENVIRONMENT, randomUUID()), null);
      assert.equal(readAdminLedgerDetail(f.owner, ENVIRONMENT, "not-a-real-entry"), null);
    } finally { f.close(); }
  });

  it("hydrates every variant after any member matches filters and nulls only disputed facts", () => {
    const f = fixture();
    try {
      f.activate();
      f.entry({ id: "variants", amount: 1234, at: BASE - 86_400_000, memo: "旧备注", otherAccount: "陈*安" });
      f.activate();
      const newer = f.entry({ id: "variants", amount: 4567, at: BASE, direction: "DEBIT", memo: "核对%_'中文", otherAccount: "林*宁" });
      f.owner.write(db => db.prepare("UPDATE ledger_entries SET state='IGNORED', updated_at=updated_at+1 WHERE ledger_entry_id=?").run(newer.ledgerEntryId));
      const page = readAdminLedgerPage(f.owner, {
        environment: ENVIRONMENT, q: "%_'", direction: "DEBIT", state: "IGNORED",
        occurredFrom: "2026-10-20", occurredTo: "2026-10-20", minAmountCents: 4500, maxAmountCents: 4600,
      });
      assert.equal(page.items.length, 1);
      const group = page.items[0]!;
      assert.equal(group.source_record_count, 2);
      assert.equal(group.content_consistent, false);
      assert.equal(group.has_conflicts, true);
      for (const key of ["amount_cents", "occurred_at", "direction", "memo", "other_account"] as const) assert.equal(group[key], null, key);
      assert.equal(group.currency, "CNY");
      assert.equal(group.provider_order_no, PROVIDER_ORDER);
      assert.deepEqual(group.states, ["UNALLOCATED", "IGNORED"]);
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, newer.ledgerEntryId)!;
      assert.deepEqual(detail.sources.map(source => source.amount_cents), [1234, 4567]);
      assert.deepEqual(detail.sources.map(source => source.direction), ["CREDIT", "DEBIT"]);
    } finally { f.close(); }
  });

  it("does not choose one source state when otherwise identical copies disagree", () => {
    const f = fixture();
    try {
      f.activate();
      const first = f.entry({ id: "state-difference" });
      f.activate();
      f.entry({ id: "state-difference" });
      f.owner.write(db => db.prepare("UPDATE ledger_entries SET state='IGNORED', updated_at=updated_at+1 WHERE ledger_entry_id=?").run(first.ledgerEntryId));
      const group = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, state: "IGNORED" }).items[0]!;
      assert.deepEqual(group.states, ["UNALLOCATED", "IGNORED"]);
      assert.equal(group.content_consistent, true);
      assert.equal(group.amount_cents, 1234);
      assert.equal(group.source_record_count, 2);
    } finally { f.close(); }
  });

  it("includes same-source duplicate evidence and preserves resolved conflict history", () => {
    const f = fixture();
    try {
      f.activate();
      const first = f.entry({ id: "same-source-variant", amount: 1234 });
      const incoming = f.record({ id: "same-source-variant", amount: 4321 });
      assert.equal(incoming.kind, "conflict");
      if (incoming.kind !== "conflict") throw new Error("expected duplicate conflict");
      const before = readAdminLedgerDetail(f.owner, ENVIRONMENT, first.ledgerEntryId)!;
      assert.equal(before.source_record_count, 1);
      assert.equal(before.content_consistent, false);
      assert.equal(before.has_conflicts, true);
      assert.equal(before.amount_cents, null);
      assert.equal(before.direction, "CREDIT");
      assert.equal(before.occurred_at, new Date(BASE).toISOString());
      assert.equal(before.sources[0]!.amount_cents, 1234);
      assert.equal(before.conflicts[0]!.conflict_id, incoming.conflict.conflictId);
      f.ledger.resolveConflict({
        conflictOperationId: randomUUID(), conflictId: incoming.conflict.conflictId,
        action: "KEEP_EXISTING", actorId: "admin", reason: "核对保留原始证据", now: f.tick(),
      });
      const after = readAdminLedgerDetail(f.owner, ENVIRONMENT, first.ledgerEntryId)!;
      assert.equal(after.conflicts[0]!.status, "RESOLVED");
      assert.equal(after.content_consistent, false);
      assert.equal(after.amount_cents, null);
    } finally { f.close(); }
  });

  it("filters same-source duplicate facts before pagination using the ledger normalization rules", () => {
    const f = fixture();
    try {
      f.activate();
      const first = f.entry({ id: "same-source-filtered", at: BASE - 86_400_000, memo: "原始备注" });
      const incoming = f.record({
        id: "same-source-filtered", amount: 4321, amountText: " -43.21 ", directionText: " 转出 ", at: BASE,
        occurredText: "2026-10-19T16:00:00.000Z", memo: "差异%_'备注", otherAccount: "差异对方", merchantOrderNo: "差异订单",
      });
      assert.equal(incoming.kind, "conflict");
      if (incoming.kind !== "conflict") throw new Error("expected duplicate conflict");
      f.entry({ id: "another-match", amount: 4321, direction: "DEBIT" });
      f.ledger.resolveConflict({
        conflictOperationId: randomUUID(), conflictId: incoming.conflict.conflictId,
        action: "KEEP_EXISTING", actorId: "admin", reason: "保留差异版本供查询", now: f.tick(),
      });
      f.activate("SANDBOX");
      f.entry({ id: "same-source-filtered" });
      f.record({ id: "same-source-filtered", amount: 9876, memo: "沙箱差异备注" });
      const filters = {
        environment: ENVIRONMENT, direction: "DEBIT", state: "UNALLOCATED",
        occurredFrom: "2026-10-20", occurredTo: "2026-10-20", minAmountCents: 4321, maxAmountCents: 4321,
      } as const;
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      for (const q of ["%_'", "差异对方", "差异订单", first.ledgerEntryId]) {
        const page = readAdminLedgerPage(f.owner, { ...filters, q });
        assert.equal(page.items.length, 1, q);
        const group = page.items[0]!;
        assert.equal(group.external_event_id, first.externalEventId);
        assert.equal(group.ledger_entry_id, first.ledgerEntryId);
        assert.equal(group.source_record_count, 1);
        assert.equal(group.content_consistent, false);
        assert.equal(group.amount_cents, null);
        assert.equal(group.direction, null);
        const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, group.ledger_entry_id)!;
        assert.equal(detail.sources[0]!.amount_cents, 1234);
        assert.equal(detail.conflicts[0]!.status, "RESOLVED");
      }
      const firstPage = readAdminLedgerPage(f.owner, { ...filters, limit: 1 });
      assert.deepEqual(firstPage.items.map(item => item.external_event_id), ["another-match"]);
      assert.equal(firstPage.next_cursor?.occurred_at_ms, BASE);
      const nextPage = readAdminLedgerPage(f.owner, { ...filters, limit: 1, cursor: firstPage.next_cursor });
      assert.deepEqual(nextPage.items.map(item => item.external_event_id), [first.externalEventId]);
      assert.equal(nextPage.next_cursor, null);
      assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: "沙箱差异备注" }).items.length, 0);
      assert.equal(readAdminLedgerPage(f.owner, { environment: "SANDBOX", q: "沙箱差异备注", minAmountCents: 9876, maxAmountCents: 9876 }).items.length, 1);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("requires one valid duplicate variant and its own source to satisfy every filter", () => {
    const f = fixture();
    try {
      f.activate();
      const first = f.entry({ id: "no-combined-variants", at: BASE - 86_400_000 });
      f.record({ id: "no-combined-variants", amount: 4321, direction: "DEBIT", at: BASE, memo: "差异甲" });
      f.record({ id: "no-combined-variants", amount: 7654, direction: "CREDIT", at: BASE + 86_400_000, memo: "差异乙" });
      const invalid = f.record({ id: "no-combined-variants", amountText: "invalid", memo: "无效金额备注" });
      assert.equal(invalid.kind, "isolated");
      f.owner.write(db => db.prepare("UPDATE ledger_entries SET state='IGNORED', updated_at=updated_at+1 WHERE ledger_entry_id=?").run(first.ledgerEntryId));
      f.activate();
      const second = f.entry({ id: "no-combined-variants" });
      const order = f.order("another-source-real-order");
      f.settle(order.orderId, second.ledgerEntryId);
      const misses: Partial<AdminLedgerQuery>[] = [
        { q: "差异甲", direction: "CREDIT" },
        { q: "差异甲", minAmountCents: 7654, maxAmountCents: 7654 },
        { q: "差异甲", occurredFrom: "2026-10-21", occurredTo: "2026-10-21" },
        { q: "差异甲", state: "ALLOCATED" },
        { q: order.orderId, minAmountCents: 4321, maxAmountCents: 4321 },
        { q: "无效金额备注" },
      ];
      for (const filters of misses) {
        assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, ...filters }).items.length, 0, JSON.stringify(filters));
      }
      const found = readAdminLedgerPage(f.owner, {
        environment: ENVIRONMENT, q: "差异甲", direction: "DEBIT", state: "IGNORED",
        occurredFrom: "2026-10-20", occurredTo: "2026-10-20", minAmountCents: 4321, maxAmountCents: 4321,
      });
      assert.equal(found.items.length, 1);
      assert.equal(found.items[0]!.source_record_count, 2);
      assert.equal(found.items[0]!.active_match?.ledger_entry_id, second.ledgerEntryId);
    } finally { f.close(); }
  });

  it("treats differing timestamp precision as distinct evidence", () => {
    const f = fixture();
    try {
      f.activate();
      f.entry({ id: "precision", occurredText: "2026-10-20 00:00:00" });
      f.activate();
      f.entry({ id: "precision", occurredText: "2026-10-20 00:00:00.000" });
      const group = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT }).items[0]!;
      assert.equal(group.content_consistent, false);
      assert.equal(group.occurred_at, new Date(BASE).toISOString());
      assert.equal(group.occurred_at_precision_milliseconds, null);
      assert.equal(group.occurred_at_interval_end_exclusive, null);
    } finally { f.close(); }
  });

  it("paginates event groups in both directions with same-time and 256-character IDs", () => {
    const f = fixture();
    try {
      const ids = [...Array.from({ length: 137 }, (_, index) => "event-" + String(index).padStart(3, "0")), "8".repeat(256), "流水%_'中文"];
      f.activate();
      for (const id of ids) f.entry({ id });
      f.activate();
      for (const id of ids.slice(0, 30)) f.entry({ id });
      assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT }).items.length, 20);
      for (const sortOrder of ["asc", "desc"] as const) {
        const actual: string[] = [];
        let cursor: AdminLedgerQuery["cursor"] = null;
        do {
          const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortOrder, limit: 7, cursor });
          actual.push(...page.items.map(item => item.external_event_id));
          cursor = page.next_cursor;
          if (cursor) assert.equal(cursor.occurred_at_ms, BASE);
          assert.ok(actual.length <= ids.length);
        } while (cursor);
        const expected = [...ids].sort();
        assert.deepEqual(actual, sortOrder === "asc" ? expected : expected.reverse());
      }
    } finally { f.close(); }
  });

  it("keeps descending pagination stable when a later source disputes an already seen event's time", () => {
    const f = fixture();
    try {
      const originalKey = f.activate();
      for (const [id, seconds] of [["a", 10], ["b", 20], ["c", 30]] as const) f.entry({ id, at: BASE + seconds * 1_000 });
      const original = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1 });
      assert.deepEqual(original.items.map(item => item.external_event_id), ["c"]);
      assert.equal(original.next_cursor?.occurred_at_ms, BASE + 30_000);
      const firstSourceId = original.items[0]!.ledger_entry_id;
      const laterKey = f.activate();
      const copy = f.entry({ id: "c", at: BASE + 5_000 });
      const before = financialSnapshot(f.connection);
      const seen = original.items.map(item => item.external_event_id);
      let cursor: AdminLedgerQuery["cursor"] = original.next_cursor;
      while (cursor) {
        const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1, cursor });
        seen.push(...page.items.map(item => item.external_event_id));
        cursor = page.next_cursor;
        assert.ok(seen.length <= 3);
      }
      assert.deepEqual(seen, ["c", "b", "a"]);
      const refreshed = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1 });
      assert.equal(refreshed.next_cursor?.occurred_at_ms, BASE + 30_000);
      assert.equal(refreshed.items[0]!.occurred_at, null);
      assert.equal(refreshed.items[0]!.content_consistent, false);
      assert.equal(refreshed.items[0]!.ledger_entry_id, firstSourceId);
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, copy.ledgerEntryId)!;
      assert.equal(detail.ledger_entry_id, firstSourceId);
      assert.deepEqual(detail.sources.map(source => source.provider_account_key), [originalKey, laterKey]);
      assert.deepEqual(detail.sources.map(source => source.occurred_at), [new Date(BASE + 30_000).toISOString(), new Date(BASE + 5_000).toISOString()]);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("keeps ascending pagination from skipping an unseen event when its later source has an earlier time", () => {
    const f = fixture();
    try {
      f.activate();
      for (const [id, seconds] of [["a", 10], ["b", 20], ["c", 30]] as const) f.entry({ id, at: BASE + seconds * 1_000 });
      const original = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortOrder: "asc", limit: 1 });
      assert.deepEqual(original.items.map(item => item.external_event_id), ["a"]);
      assert.equal(original.next_cursor?.occurred_at_ms, BASE + 10_000);
      f.activate();
      f.entry({ id: "b", at: BASE + 5_000 });
      const before = financialSnapshot(f.connection);
      const second = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortOrder: "asc", limit: 1, cursor: original.next_cursor });
      assert.deepEqual(second.items.map(item => item.external_event_id), ["b"]);
      assert.equal(second.items[0]!.occurred_at, null);
      assert.equal(second.items[0]!.content_consistent, false);
      assert.equal(second.next_cursor?.occurred_at_ms, BASE + 20_000);
      const last = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortOrder: "asc", limit: 1, cursor: second.next_cursor });
      assert.deepEqual(last.items.map(item => item.external_event_id), ["c"]);
      assert.equal(last.next_cursor, null);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("retains an unactivated legacy binding as the stable anchor when a recorded generation adds a copy", () => {
    const f = fixture();
    try {
      const legacyKey = f.activate();
      const original = f.entry({ id: "legacy-event", at: BASE + 30_000 });
      f.entry({ id: "middle-event", at: BASE + 20_000 });
      // Model historical/imported evidence with no activation. Normal migrations
      // backfill primary, so this exceptional fixture bypasses only the delete guard.
      const guard = f.connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'provider_account_activations_no_delete'").get() as { sql: string };
      f.owner.write(db => {
        db.exec("DROP TRIGGER provider_account_activations_no_delete");
        db.prepare("DELETE FROM provider_account_activations WHERE provider_account_key = ?").run(legacyKey);
        db.exec(guard.sql);
      });
      const first = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1 });
      assert.equal(first.items[0]!.ledger_entry_id, original.ledgerEntryId);
      const laterKey = f.activate();
      const copy = f.entry({ id: "legacy-event", at: BASE + 5_000 });
      const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1 });
      assert.equal(page.items[0]!.ledger_entry_id, original.ledgerEntryId);
      assert.equal(page.items[0]!.occurred_at, null);
      assert.equal(page.next_cursor?.occurred_at_ms, BASE + 30_000);
      const second = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, limit: 1, cursor: first.next_cursor });
      assert.deepEqual(second.items.map(item => item.external_event_id), ["middle-event"]);
      assert.equal(second.next_cursor, null);
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, copy.ledgerEntryId)!;
      assert.deepEqual(detail.sources.map(source => source.provider_account_key), [legacyKey, laterKey]);
    } finally { f.close(); }
  });

  it("uses transaction dates in Beijing with inclusive civil dates and an exclusive upper instant", () => {
    const f = fixture();
    try {
      const range = createdDateRange("2024-02-29", "2024-02-29")!;
      f.activate();
      f.entry({ id: "before", at: range.start - 1 });
      f.entry({ id: "start", at: range.start });
      f.entry({ id: "last", at: range.end - 1 });
      f.entry({ id: "after", at: range.end });
      const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, occurredFrom: "2024-02-29", occurredTo: "2024-02-29" });
      assert.deepEqual(page.items.map(item => item.external_event_id), ["last", "start"]);
      assert.ok(page.items.every(item => item.created_at > "2024-03-01"));
    } finally { f.close(); }
  });

  it("searches percent, underscore, quotes and long numeric identities literally", () => {
    const f = fixture();
    try {
      f.activate();
      const target = f.entry({ id: "76123456789012345678901234", memo: "费用%_'核对", merchantOrderNo: "9912345678901234567890" });
      f.entry({ id: "other", memo: "普通费用" });
      for (const q of ["%_'", target.ledgerEntryId, target.externalEventId, "9912345678901234567890"]) {
        const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q });
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0]!.external_event_id, target.externalEventId);
      }
      assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: "%missing%" }).items.length, 0);
      assert.equal(readAdminLedgerDetail(f.owner, ENVIRONMENT, target.ledgerEntryId)!.sources[0]!.provider_order_no, PROVIDER_ORDER);
    } finally { f.close(); }
  });

  it("uses only real financial links for order identity and preserves reversed history", () => {
    const f = fixture();
    try {
      const oldKey = f.activate();
      const first = f.entry({ id: "retained-association" });
      const order = f.order("9912345678901234567890", "真实关联网站");
      const settlement = f.settle(order.orderId, first.ledgerEntryId);
      f.activate(ENVIRONMENT, "2026000000000002");
      const second = f.entry({ id: "retained-association" });
      const unrelated = f.entry({ id: "source-claims-order", merchantOrderNo: order.merchantOrderNo });
      for (const q of [order.orderId, order.merchantOrderNo, oldKey, "2026000000000001"]) {
        const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q });
        const group = page.items.find(item => item.external_event_id === first.externalEventId)!;
        assert.ok(group, q);
        assert.equal(group.source_record_count, 2);
        assert.equal(group.active_match_count, 1);
        assert.equal(group.active_match?.payment_match_id, settlement.paymentMatch!.paymentMatchId);
        assert.equal(group.active_match?.ledger_entry_id, first.ledgerEntryId);
        assert.equal(group.active_match?.order_id, order.orderId);
        assert.equal(group.active_match?.api_client_id, order.apiClientId);
        assert.equal(group.active_match?.site_name, order.site.configuration.name);
      }
      assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: order.orderId }).items.length, 1);
      assert.equal(readAdminLedgerDetail(f.owner, ENVIRONMENT, unrelated.ledgerEntryId)!.active_match_count, 0);
      assert.equal(readAdminLedgerDetail(f.owner, "SANDBOX", first.ledgerEntryId), null);
      f.reconciliation.reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: settlement.paymentMatch!.paymentMatchId,
        actorId: "admin", reason: "保留真实撤销记录", now: f.tick(),
      });
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, second.ledgerEntryId)!;
      assert.equal(detail.active_match_count, 0);
      assert.equal(detail.active_match, null);
      assert.equal(detail.matches.length, 1);
      assert.equal(detail.matches[0]!.status, "REVERSED");
      assert.equal(detail.matches[0]!.order_id, order.orderId);
      assert.equal(detail.matches[0]!.ledger_entry_id, first.ledgerEntryId);
      assert.ok(detail.matches[0]!.resolved_at);
      assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: order.orderId }).items[0]!.active_match, null);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("flags multiple real settled relations across copies and selects only a unique surviving relation", () => {
    const f = fixture();
    try {
      f.activate();
      const first = f.entry({ id: "multiple-real-links" });
      const firstOrder = f.order("first-real-order");
      const firstMatch = f.settle(firstOrder.orderId, first.ledgerEntryId).paymentMatch!;
      f.activate(ENVIRONMENT, "2026000000000002");
      const second = f.entry({ id: "multiple-real-links" });
      const secondOrder = f.order("second-real-order");
      const secondMatch = f.settle(secondOrder.orderId, second.ledgerEntryId).paymentMatch!;
      const before = financialSnapshot(f.connection);
      const group = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT }).items[0]!;
      assert.equal(group.content_consistent, true);
      assert.equal(group.active_match_count, 2);
      assert.equal(group.active_match, null);
      assert.equal(group.has_conflicts, true);
      const detail = readAdminLedgerDetail(f.owner, ENVIRONMENT, first.ledgerEntryId)!;
      assert.deepEqual(new Set(detail.matches.map(match => match.payment_match_id)), new Set([firstMatch.paymentMatchId, secondMatch.paymentMatchId]));
      assert.deepEqual(financialSnapshot(f.connection), before);
      f.reconciliation.reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: secondMatch.paymentMatchId,
        actorId: "admin", reason: "核对重复来源中的重复入账", now: f.tick(),
      });
      const after = readAdminLedgerDetail(f.owner, ENVIRONMENT, second.ledgerEntryId)!;
      assert.equal(after.active_match_count, 1);
      assert.equal(after.active_match?.payment_match_id, firstMatch.paymentMatchId);
      assert.deepEqual(after.matches.map(match => match.status), ["SETTLED", "REVERSED"]);
      for (const orderId of [firstOrder.orderId, secondOrder.orderId]) {
        assert.equal(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: orderId }).items[0]!.external_event_id, first.externalEventId);
      }
    } finally { f.close(); }
  });

  it("reads one snapshot without writes and uses the targeted source/group/history indexes", () => {
    const f = fixture();
    try {
      f.activate();
      const entry = f.entry({ id: "query-plan" });
      const order = f.order("query-plan-real-order");
      f.settle(order.orderId, entry.ledgerEntryId);
      for (let index = 0; index < 24; index++) f.entry({ id: "query-plan-extra-" + index });
      let sql = "", prepares = 0;
      const watched: AdminLedgerDatabase = {
        read(operation) {
          return operation({
            function: f.connection.function.bind(f.connection),
            prepare(statement: string) { sql = statement; prepares += 1; return f.connection.prepare(statement); },
          } as unknown as DatabaseSync);
        },
      };
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      const page = readAdminLedgerPage(watched, { environment: ENVIRONMENT, occurredFrom: "2026-10-20", occurredTo: "2026-10-20" });
      assert.equal(prepares, 1);
      assert.equal(page.items.length, 20);
      assert.ok(page.next_cursor);
      const range = createdDateRange("2026-10-20", "2026-10-20")!;
      const plan = f.connection.prepare("EXPLAIN QUERY PLAN " + sql)
        .all(providerEndpoint(ENVIRONMENT), providerEndpoint(ENVIRONMENT), range.start, range.end,
          providerEndpoint(ENVIRONMENT), range.start, range.end, providerEndpoint(ENVIRONMENT), 21);
      const explanation = plan.map(row => String(row.detail)).join("\n");
      for (const index of ["ledger_entries_provider_occurrence_list_idx", "ledger_entries_external_group_idx", "payment_matches_ledger_history_idx", "ledger_conflicts_entry_history_idx"]) {
        assert.ok(explanation.includes(index), index + "\n" + explanation);
      }
      const duplicateRoot = plan.find(row => row.detail === "MATERIALIZE duplicate_inputs");
      assert.ok(duplicateRoot);
      const duplicatePlanIds = new Set([String(duplicateRoot.id)]);
      for (const row of plan) if (duplicatePlanIds.has(String(row.parent))) duplicatePlanIds.add(String(row.id));
      const duplicatePlan = plan.filter(row => duplicatePlanIds.has(String(row.id))).map(row => String(row.detail)).join("\n");
      for (const index of ["ledger_conflicts_entry_history_idx", "ledger_conflicts_external_list_idx", "sqlite_autoindex_provider_raw_events_1"]) {
        assert.ok(duplicatePlan.includes(index), index + "\n" + duplicatePlan);
      }
      assert.doesNotMatch(duplicatePlan, /SCAN (?:conflict|raw)\b/);
      readAdminLedgerDetail(watched, ENVIRONMENT, entry.ledgerEntryId);
      assert.equal(prepares, 2);
      const linkedPage = readAdminLedgerPage(watched, { environment: ENVIRONMENT, q: order.orderId });
      assert.equal(prepares, 3);
      assert.equal(linkedPage.items[0]!.external_event_id, entry.externalEventId);
      const linkedPlan = f.connection.prepare("EXPLAIN QUERY PLAN " + sql)
        .all(providerEndpoint(ENVIRONMENT), providerEndpoint(ENVIRONMENT), ...Array.from({ length: 12 }, () => order.orderId),
          providerEndpoint(ENVIRONMENT), ...Array.from({ length: 12 }, () => order.orderId), providerEndpoint(ENVIRONMENT), 21);
      const linkedExplanation = linkedPlan.map(row => String(row.detail)).join("\n");
      assert.ok(linkedExplanation.includes("payment_matches_ledger_history_idx"), linkedExplanation);
      assert.ok(linkedExplanation.includes("sqlite_autoindex_payment_orders_1"), linkedExplanation);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("filters effective associations and reversed history over the complete event group before paging", () => {
    const f = fixture();
    try {
      f.activate();
      f.entry({ id: "unmatched" });
      const records = new Map(["single", "reversed", "mixed", "multiple"].map(id => {
        const entry = f.entry({ id });
        const order = f.order("search-" + id, "账本关联网站", "关联订单商品 %_'" + id);
        return [id, { entry, order, match: f.settle(order.orderId, entry.ledgerEntryId).paymentMatch! }] as const;
      }));
      for (const id of ["reversed", "mixed"]) f.reconciliation.reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: records.get(id)!.match.paymentMatchId,
        actorId: "admin", reason: "保留关联撤销历史", now: f.tick(),
      });
      f.activate(ENVIRONMENT, "2026000000000002");
      for (const id of ["mixed", "multiple"]) {
        const copy = f.entry({ id });
        const order = f.order("new-" + id);
        f.settle(order.orderId, copy.ledgerEntryId);
      }
      f.activate("SANDBOX");
      const sandbox = f.entry({ id: "multiple" });
      const sandboxOrder = f.order("sandbox-only-match");
      const sandboxMatch = f.settle(sandboxOrder.orderId, sandbox.ledgerEntryId).paymentMatch!;
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      const ids = (query: Partial<AdminLedgerQuery>) => readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortOrder: "asc", ...query }).items.map(item => item.external_event_id);
      assert.deepEqual(ids({ associationStatus: "UNMATCHED" }), ["reversed", "unmatched"]);
      assert.deepEqual(ids({ associationStatus: "MATCHED" }), ["mixed", "multiple", "single"]);
      assert.deepEqual(ids({ associationStatus: "MULTIPLE" }), ["multiple"]);
      assert.deepEqual(ids({ hasReversals: true }), ["mixed", "reversed"]);
      assert.deepEqual(ids({ hasReversals: false }), ["multiple", "single", "unmatched"]);
      assert.deepEqual(ids({ associationStatus: "MATCHED", hasReversals: true }), ["mixed"]);
      assert.deepEqual(ids({ associationStatus: "MULTIPLE", hasReversals: true }), []);
      for (const q of [records.get("mixed")!.match.paymentMatchId, "%_'mixed"]) {
        const result = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q, associationStatus: "MATCHED", hasReversals: true, limit: 1 });
        assert.equal(result.items[0]!.external_event_id, "mixed");
        assert.equal(result.items[0]!.source_record_count, 2);
        assert.equal(result.items[0]!.active_match_count, 1);
        assert.equal(result.items[0]!.reversed_match_count, 1);
        assert.notEqual(result.items[0]!.active_match!.payment_match_id, records.get("mixed")!.match.paymentMatchId);
      }
      assert.deepEqual(ids({ q: "关联订单商品" }), ["mixed", "multiple", "reversed", "single"]);
      assert.deepEqual(ids({ q: sandboxMatch.paymentMatchId }), []);
      let cursor: AdminLedgerQuery["cursor"] = null;
      const paged: string[] = [];
      do {
        const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, hasReversals: true, limit: 1, cursor });
        paged.push(...page.items.map(item => item.external_event_id)); cursor = page.next_cursor;
      } while (cursor);
      assert.deepEqual(paged, ["reversed", "mixed"]);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("uses real association creation times for inclusive Beijing dates independently of transaction dates", () => {
    const day = beijingDate(Date.now() + 2 * 86_400_000);
    const start = createdDateRange(day, day)!.start;
    const f = fixture(true, start - 60_000);
    try {
      f.activate();
      const associated = ["before", "first", "last", "after"].map(id => {
        const entry = f.entry({ id, at: BASE - 7 * 86_400_000 });
        const order = f.order("association-date-" + id);
        return { entry, order };
      });
      const times = [start - 1, start, start + 86_399_999, start + 86_400_000];
      const matches = associated.map(({ entry, order }, index) => f.settle(order.orderId, entry.ledgerEntryId, times[index]!).paymentMatch!);
      f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: matches[1]!.paymentMatchId,
        actorId: "admin", reason: "日期筛选仍包含已撤销关联", now: start + 86_400_001 });
      const query = { environment: ENVIRONMENT, associatedFrom: day, associatedTo: day, sortBy: "associated_at", sortOrder: "asc" } as const;
      const page = readAdminLedgerPage(f.owner, query);
      assert.deepEqual(page.items.map(item => item.external_event_id), ["first", "last"]);
      assert.equal(page.items[0]!.active_match_count, 0);
      assert.equal(page.items[0]!.reversed_match_count, 1);
      assert.equal(page.items[0]!.last_associated_at, new Date(start).toISOString());
      assert.equal(page.items[0]!.last_handled_at, new Date(start + 86_400_001).toISOString());
      assert.equal(page.items[1]!.last_handled_at, new Date(start + 86_399_999).toISOString());
      assert.deepEqual(readAdminLedgerPage(f.owner, { ...query, occurredFrom: day, occurredTo: day }).items, []);
      assert.deepEqual(readAdminLedgerPage(f.owner, { ...query, hasReversals: true }).items.map(item => item.external_event_id), ["first"]);
      // A later association outside the date range must not hide an earlier
      // real association inside it, even when that earlier match was reversed.
      f.advance(start + 86_400_100);
      f.activate(ENVIRONMENT, "2026000000000002");
      const copy = f.entry({ id: "first", at: BASE - 7 * 86_400_000 });
      const laterOrder = f.order("association-date-first-later");
      const laterMatch = f.settle(laterOrder.orderId, copy.ledgerEntryId).paymentMatch!;
      const stillFound = readAdminLedgerPage(f.owner, { ...query, associationStatus: "MATCHED", hasReversals: true });
      assert.deepEqual(stillFound.items.map(item => item.external_event_id), ["first"]);
      assert.equal(stillFound.items[0]!.source_record_count, 2);
      assert.equal(stillFound.items[0]!.last_associated_at, new Date(laterMatch.createdAt).toISOString());
      assert.equal(stillFound.items[0]!.last_handled_at, new Date(laterMatch.createdAt).toISOString());
    } finally { f.close(); }
  });

  it("uses indexed association and duplicate-version reads for the new grouped query paths", () => {
    const f = fixture();
    try {
      f.activate();
      const source = f.entry({ id: "indexed-association" });
      const order = f.order("indexed-association");
      f.settle(order.orderId, source.ledgerEntryId);
      f.record({ id: "indexed-association", amount: 4321 });
      for (let index = 0; index < 24; index++) f.entry({ id: "indexed-extra-" + index });
      let captured = { sql: "", parameters: [] as Array<string | number> };
      const watched: AdminLedgerDatabase = { read(operation) {
        return operation({
          function: f.connection.function.bind(f.connection),
          prepare(sql: string) {
            const statement = f.connection.prepare(sql);
            return { all(...parameters: Array<string | number>) {
              captured = { sql, parameters }; return statement.all(...parameters);
            } };
          },
        } as unknown as DatabaseSync);
      } };
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      for (const query of [
        { associationStatus: "MATCHED" }, { hasReversals: false },
        { associatedFrom: "2026-10-20", associatedTo: "2026-10-20" },
        { sortBy: "event_sequence" }, { sortBy: "amount_cents" },
      ] satisfies Partial<AdminLedgerQuery>[]) {
        readAdminLedgerPage(watched, { environment: ENVIRONMENT, ...query });
        const explanation = f.connection.prepare("EXPLAIN QUERY PLAN " + captured.sql).all(...captured.parameters)
          .map(row => String(row.detail)).join("\n");
        for (const index of ["ledger_entries_external_group_idx", "payment_matches_ledger_history_idx"]) {
          assert.ok(explanation.includes(index), JSON.stringify(query) + " " + index + "\n" + explanation);
        }
        assert.doesNotMatch(explanation, /SCAN (?:match|associated_match|match_event|raw)\b/);
        if (query.sortBy === "amount_cents") assert.ok(explanation.includes("ledger_conflicts_entry_history_idx"), explanation);
      }
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("paginates every association and amount sort with deterministic ties and null values last", () => {
    const sortBase = Date.now() + 3_600_000;
    const f = fixture(true, sortBase - 60_000);
    try {
      f.activate();
      const linked = ["a-linked", "b-linked", "c-linked"].map((id, index) => {
        const entry = f.entry({ id, amount: (index + 1) * 1000 });
        return { entry, order: f.order("sort-" + id) };
      });
      f.entry({ id: "a-unlinked", amount: 1500 });
      f.entry({ id: "z-unlinked", amount: 2500 });
      f.entry({ id: "conflict-copy", amount: 50_000 });
      f.entry({ id: "conflict-raw", amount: 60_000 });
      f.record({ id: "conflict-raw", amount: 70_000 });
      const matches = linked.map(({ entry, order }, index) => f.settle(order.orderId, entry.ledgerEntryId, sortBase + (index === 2 ? 1 : 0)).paymentMatch!);
      f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: matches[0]!.paymentMatchId,
        actorId: "admin", reason: "处理时间包含撤销", now: sortBase + 2 });
      f.activate(ENVIRONMENT, "2026000000000002");
      f.entry({ id: "conflict-copy", amount: 40_000 });
      f.entry({ id: "b-linked", amount: 2000 });
      const expected = {
        associated_at: ["a-linked", "b-linked", "c-linked"],
        handled_at: ["b-linked", "c-linked", "a-linked"],
        event_sequence: ["b-linked", "c-linked", "a-linked"],
        amount_cents: ["a-linked", "a-unlinked", "b-linked", "z-unlinked", "c-linked"],
      } as const;
      const before = financialSnapshot(f.connection);
      f.connection.exec("PRAGMA query_only = ON");
      for (const sortBy of ["associated_at", "handled_at", "event_sequence", "amount_cents"] as const) {
        for (const sortOrder of ["asc", "desc"] as const) {
          const actual: string[] = [];
          let cursor: AdminLedgerQuery["cursor"] = null;
          do {
            const page = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, sortBy, sortOrder, limit: 1, cursor });
            actual.push(...page.items.map(item => item.external_event_id)); cursor = page.next_cursor;
            assert.ok(actual.length <= 7);
            if (page.items[0]!.external_event_id.startsWith("conflict")) assert.equal(page.items[0]!.amount_cents, null);
          } while (cursor);
          const valued = [...expected[sortBy]];
          if (sortOrder === "desc") valued.reverse();
          // Reversing the direction also reverses the association-time tie.
          const absent = sortBy === "amount_cents" ? ["conflict-copy", "conflict-raw"] : ["a-unlinked", "conflict-copy", "conflict-raw", "z-unlinked"];
          if (sortOrder === "desc") absent.reverse();
          assert.deepEqual(actual, [...valued, ...absent], sortBy + " " + sortOrder);
        }
      }
      const unlinked = readAdminLedgerDetail(f.owner, ENVIRONMENT, readAdminLedgerPage(f.owner, { environment: ENVIRONMENT, q: "a-unlinked" }).items[0]!.ledger_entry_id)!;
      assert.equal(unlinked.last_associated_at, null);
      assert.equal(unlinked.last_handled_at, null);
      assert.deepEqual(financialSnapshot(f.connection), before);
    } finally { f.close(); }
  });

  it("rejects invalid query bounds before querying the database", () => {
    const unavailable: AdminLedgerDatabase = { read() { throw new Error("must validate first"); } };
    const queries: Partial<AdminLedgerQuery>[] = [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { direction: "unknown" as never }, { state: "ALL" as never },
      { environment: "unknown" as never }, { sortOrder: "unknown" as never },
      { sortBy: "unknown" as never }, { associationStatus: "REVERSED" as never }, { hasReversals: "true" as never },
      { associatedFrom: "2026-10-20" }, { associatedTo: "2026-10-20" },
      { associatedFrom: "2026-02-29", associatedTo: "2026-03-01" },
      { associatedFrom: "2026-10-21", associatedTo: "2026-10-20" },
      { sortBy: "associated_at", cursor: { occurred_at_ms: 0, external_event_id: "id" } },
      { cursor: { sort_value: null, external_event_id: "id" } },
      { sortBy: "associated_at", cursor: { sort_value: -1, external_event_id: "id" } },
      { occurredFrom: "2026-10-20" }, { occurredTo: "2026-10-20" },
      { occurredFrom: "2026-02-29", occurredTo: "2026-03-01" },
      { occurredFrom: "2026-10-21", occurredTo: "2026-10-20" },
      { minAmountCents: -1 }, { maxAmountCents: 1.5 }, { maxAmountCents: 1_000_000_000_000 },
      { minAmountCents: 5, maxAmountCents: 4 }, { q: "a".repeat(101) }, { q: "\0" },
      { cursor: { occurred_at_ms: -1, external_event_id: "id" } },
      { cursor: { occurred_at_ms: 0, external_event_id: "x".repeat(257) } },
      { cursor: { occurred_at_ms: 0, external_event_id: "\ud800" } },
    ];
    for (const invalid of queries) assert.throws(() => readAdminLedgerPage(unavailable, { environment: ENVIRONMENT, ...invalid }), ListQueryError);
  });

  it("adds only query indexes when upgrading an existing schema-34 ledger", () => {
    const f = fixture(false);
    try {
      f.activate();
      const entry = f.entry({ id: "before-index-upgrade" });
      const order = f.order("before-index-upgrade");
      f.settle(order.orderId, entry.ledgerEntryId);
      const before = financialSnapshot(f.connection);
      const beforeSchema = databaseSchema(f.connection);
      const beforePage = readAdminLedgerPage(f.owner, { environment: ENVIRONMENT });
      f.owner.write(db => db.exec(migrations.find(migration => migration.version === 35)!.sql));
      assert.deepEqual(financialSnapshot(f.connection), before);
      assert.deepEqual(readAdminLedgerPage(f.owner, { environment: ENVIRONMENT }), beforePage);
      const afterSchema = databaseSchema(f.connection);
      assert.deepEqual(afterSchema.filter(object => beforeSchema.some(previous => previous.name === object.name)), beforeSchema);
      assert.deepEqual(afterSchema.filter(object => !beforeSchema.some(previous => previous.name === object.name)).map(object => [object.type, object.name]), [
        ["index", "ledger_conflicts_entry_history_idx"],
        ["index", "ledger_entries_external_group_idx"],
        ["index", "ledger_entries_provider_occurrence_list_idx"],
        ["index", "payment_matches_ledger_history_idx"],
      ]);
      assert.deepEqual(f.connection.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { f.close(); }
  });
});

function databaseSchema(connection: DatabaseSync) {
  return connection.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").all();
}

function financialSnapshot(connection: DatabaseSync) {
  return Object.fromEntries([
    "ledger_entries", "provider_raw_events", "provider_raw_pages", "ledger_conflicts",
    "payment_orders", "payment_matches", "financial_operations", "ledger_transactions", "ledger_postings",
  ].map(table => [table, connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]));
}
