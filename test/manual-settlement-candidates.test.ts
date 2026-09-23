import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { OrderService } from "../src/orders/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import {
  withHttpFixture,
  login,
  postFinancial,
  type ReconciliationHttpFixture,
} from "./reconciliation-http-fixture.ts";
const root = "/api/admin/v1/reconciliation/settlements/manual/";
async function client(f: ReconciliationHttpFixture) {
  const auth = await login(f.app);
  const request = (path: string) =>
    f.app.request(root + path, { headers: { cookie: auth.cookie } });
  return {
    auth,
    request,
    async page(path: string) {
      const response = await request(path);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as {
        data: any[];
        page: { next_cursor: string | null };
      };
    },
  };
}
function financialSnapshot(f: ReconciliationHttpFixture) {
  return f.database.read((db) =>
    JSON.stringify(
      [
        "payment_orders",
        "ledger_entries",
        "match_candidates",
        "payment_matches",
        "financial_operations",
        "order_events",
      ].map((table) => db.prepare("SELECT * FROM " + table).all()),
      (_, value) => (typeof value === "bigint" ? String(value) : value),
    ),
  );
}
describe("read-only manual settlement candidate discovery", () => {
  it("searches complete order pages with exact money and literal Unicode without financial writes", async () => {
    await withHttpFixture(async (f) => {
      const orders = Array.from({ length: 12 }, (_, i) =>
        f.createOrder("pick-" + i, 1000 + i * 1000),
      );
      const special = f.services.orders.create(
        createOrderRequestSchema.parse({
          idempotency_key: "pick-special",
          merchant_order_no: "pick-special",
          product_name: "中文😀 100%_精确",
          amount_cents: 654321,
        }),
      ).order;
      const c = await client(f);
      const before = financialSnapshot(f);
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const p = await c.page(
          "orders?limit=2" + (cursor ? "&cursor=" + cursor : ""),
        );
        found.push(...p.data.map((x) => x.order.order_id));
        cursor = p.page.next_cursor;
        assert.ok(found.length < 30);
      } while (cursor);
      assert.equal(new Set(found).size, 13);
      for (const q of [
        special.orderId,
        "中文😀",
        "100%_",
        (special.payableAmountCents / 100).toFixed(2),
      ]) {
        const p = await c.page("orders?q=" + encodeURIComponent(q));
        assert.deepEqual(
          p.data.map((x) => x.order.order_id),
          [special.orderId],
        );
      }
      assert.equal((await c.page("orders?q=not-found")).data.length, 0);
      const first = await c.page("orders?limit=1");
      assert.ok(first.page.next_cursor);
      const tampered = await c.request(
        "orders?q=other&cursor=" + first.page.next_cursor,
      );
      assert.equal(tampered.status, 422);
      assert.equal(first.data[0].recommendation, null);
      assert.equal(financialSnapshot(f), before);
      const text = JSON.stringify(first);
      assert.ok(
        !/checkout_token|request_fingerprint|idempotency_key/.test(text),
      );
      assert.ok(orders.every((o) => found.includes(o.orderId)));
    });
  });
  it("ranks equal-amount overlapping windows before near and remote times, paging without duplicates", async () => {
    await withHttpFixture(async (f) => {
      const order = f.createOrder("recommend", 10000);
      const early = f.recordCredit("early", order.payableAmountCents, -110);
      const inside1 = f.recordCredit("inside-one", order.payableAmountCents, 1);
      const inside2 = f.recordCredit("inside-two", order.payableAmountCents, 1);
      const late = f.recordCredit("late", order.payableAmountCents, 600);
      const mismatch = f.recordCredit(
        "金额不同%_",
        order.payableAmountCents + 150,
        2,
      );
      f.recordDebit("debit", order.payableAmountCents, 2);
      const c = await client(f);
      const base = "ledger-entries?order_id=" + order.orderId;
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const p = await c.page(
          base + "&limit=1" + (cursor ? "&cursor=" + cursor : ""),
        );
        ids.push(...p.data.map((x) => x.ledger_entry.ledger_entry_id));
        cursor = p.page.next_cursor;
        assert.ok(ids.length < 10);
      } while (cursor);
      assert.deepEqual(
        ids,
        [inside1.ledgerEntryId, inside2.ledgerEntryId]
          .sort()
          .reverse()
          .concat([early.ledgerEntryId, late.ledgerEntryId]),
      );
      const recommended = await c.page(base);
      assert.equal(
        recommended.data[0].recommendation.time_window_overlap,
        true,
      );
      assert.equal(
        recommended.data[2].recommendation.time_window_overlap,
        false,
      );
      const all = await c.page(base + "&view=all");
      assert.equal(all.data.length, 5);
      assert.equal(
        all.data[0].ledger_entry.ledger_entry_id,
        late.ledgerEntryId,
      );
      for (const q of [
        "%_",
        mismatch.ledgerEntryId,
        (mismatch.amountCents / 100).toFixed(2),
      ])
        assert.deepEqual(
          (
            await c.page(base + "&view=all&q=" + encodeURIComponent(q))
          ).data.map((x) => x.ledger_entry.ledger_entry_id),
          [mismatch.ledgerEntryId],
        );
      const first = await c.page(base + "&limit=1");
      const token = first.page.next_cursor!;
      for (const path of [
        base + "&view=all&cursor=" + token,
        base + "&q=inside&cursor=" + token,
        "ledger-entries?order_id=" + randomUUID() + "&cursor=" + token,
        "orders?ledger_entry_id=" + inside1.ledgerEntryId + "&cursor=" + token,
      ])
        assert.equal((await c.request(path)).status, 422);
    });
  });
  it("uses the same reverse recommendation rules and keeps closed/expired unpaid orders eligible", async () => {
    await withHttpFixture(async (f) => {
      const closed = f.createOrder("closed-pick", 5000);
      f.closeOrder(closed.orderId);
      const expired = f.createOrder("expired-pick", 6000);
      const expiredReader = new OrderService(
        f.database,
        () => f.services.settings.snapshot(),
        () => expired.checkout.expiresAt + 1000,
      );
      assert.equal(
        expiredReader.adminGet(expired.orderId).checkout.status,
        "EXPIRED",
      );
      const entry = f.recordCredit(
        "past-checkout",
        closed.payableAmountCents,
        600,
      );
      const c = await client(f);
      const before = financialSnapshot(f);
      const rec = await c.page("orders?ledger_entry_id=" + entry.ledgerEntryId);
      assert.deepEqual(
        rec.data.map((x) => x.order.order_id),
        [closed.orderId],
      );
      assert.equal(rec.data[0].recommendation.time_window_overlap, false);
      const all = await c.page(
        "orders?ledger_entry_id=" + entry.ledgerEntryId + "&view=all",
      );
      assert.deepEqual(
        new Set(all.data.map((x) => x.order.checkout_status)),
        new Set(["CLOSED", "EXPIRED"]),
      );
      assert.equal(financialSnapshot(f), before);
      const saved = f.reconciliation.settleManually({
        orderId: closed.orderId,
        ledgerEntryId: entry.ledgerEntryId,
        reason: "人工核对已关闭订单",
        financialOperationId: randomUUID(),
        actorId: "admin",
        now: expired.checkout.expiresAt + 1000,
      });
      assert.equal(saved.orderId, closed.orderId);
    });
  });
  it("excludes settled entries, paid orders and incompatible historical provider accounts", async () => {
    await withHttpFixture(async (f) => {
      const paid = f.createSettlement("paid-pick", 8000);
      const local = f.createOrder("local-pick", 9000);
      const entry = f.recordCredit("local-credit", local.payableAmountCents, 1);
      const source = f.services.settings.snapshot();
      f.ledger.bindProviderIdentity({
        providerAccountKey: "another-account",
        providerKind: "alipay",
        endpoint: "https://openapi.alipay.com",
        externalAccountId: "different-account",
      });
      const otherService = new OrderService(f.database, () => ({
        ...source,
        activeProviderAccountKey: "another-account",
      }));
      const foreign = otherService.create(
        createOrderRequestSchema.parse({
          idempotency_key: "foreign-pick",
          merchant_order_no: "foreign-pick",
          product_name: "其他账户",
          amount_cents: 9000,
        }),
      ).order;
      const c = await client(f);
      assert.deepEqual(
        (
          await c.page(
            "orders?ledger_entry_id=" + entry.ledgerEntryId + "&view=all",
          )
        ).data.map((x) => x.order.order_id),
        [local.orderId],
      );
      assert.equal(
        (
          await c.page(
            "ledger-entries?order_id=" + foreign.orderId + "&view=all",
          )
        ).data.length,
        0,
      );
      assert.equal(
        (
          await c.page(
            "ledger-entries?order_id=" + paid.order.orderId + "&view=all",
          )
        ).data.length,
        0,
      );
      assert.ok(
        !(await c.page("orders")).data.some(
          (x) => x.order.order_id === paid.order.orderId,
        ),
      );
      const before = await c.page("ledger-entries?order_id=" + local.orderId);
      assert.equal(before.data.length, 1);
      const body = {
        order_id: local.orderId,
        ledger_entry_id: entry.ledgerEntryId,
        reason: "独立候选验收",
        financial_operation_id: randomUUID(),
      };
      assert.equal(
        (await postFinancial(f.app, root.slice(0, -1), c.auth, body)).status,
        200,
      );
      assert.equal(
        (await c.page("ledger-entries?order_id=" + local.orderId + "&view=all"))
          .data.length,
        0,
      );
      assert.equal(
        (
          await postFinancial(f.app, root.slice(0, -1), c.auth, {
            ...body,
            financial_operation_id: randomUUID(),
          })
        ).status,
        409,
      );
      assert.equal(
        (await postFinancial(f.app, root.slice(0, -1), c.auth, body)).status,
        200,
      );
    });
  });
  it("requires authentication and validates context, view, page size and cursor bindings", async () => {
    await withHttpFixture(async (f) => {
      assert.equal((await f.app.request(root + "orders")).status, 401);
      const c = await client(f);
      for (const path of [
        "orders?view=recommended",
        "orders?view=unknown",
        "orders?q=" + "😀".repeat(101),
        "orders?q=a&q=b",
        "orders?limit=101",
        "orders?limit=0",
        "orders?cursor=abc",
        "orders?sort_by=created_at",
        "ledger-entries",
        "ledger-entries?order_id=bad",
      ])
        assert.equal((await c.request(path)).status, 422, path);
      assert.equal(
        (await c.request("orders?ledger_entry_id=" + randomUUID())).status,
        404,
      );
      assert.equal(
        (await c.request("ledger-entries?order_id=" + randomUUID())).status,
        404,
      );
    });
  });
});
