import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { withHttpFixture, login } from "../test/reconciliation-http-fixture.ts";
const count = Number(process.argv[2] ?? 10000);
assert.ok(Number.isSafeInteger(count) && count >= 100 && count <= 20000);
await withHttpFixture(async (f) => {
  const order = f.createOrder("manual-benchmark", 9999);
  const entry = f.recordCredit("manual-benchmark", order.payableAmountCents, 1);
  // Only disposable read projections. Financial correctness uses complete-schema HTTP tests.
  // Triggers are restored before any measured query; no scheduler or real provider runs here.
  f.database.write((db) => {
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers)
      db.exec('DROP TRIGGER "' + trigger.name.replaceAll('"', '""') + '"');
    const clones = [
      "payment_orders",
      "amount_slots",
      "provider_raw_events",
      "ledger_entries",
    ].map((table) => {
      const original = db
        .prepare("SELECT * FROM " + table + " LIMIT 1")
        .get() as Record<string, SQLInputValue>;
      assert.ok(original, table);
      const columns = Object.keys(original);
      return {
        table,
        original,
        columns,
        insert: db.prepare(
          "INSERT INTO " +
            table +
            " (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map(() => "?").join(",") +
            ")",
        ),
      };
    });
    for (let i = 1; i < count; i++) {
      const oid = randomUUID(),
        lid = randomUUID(),
        rawId = randomUUID();
      const digest = createHash("sha256").update(oid).digest("hex");
      for (const item of clones) {
        const row = { ...item.original };
        if (item.table === "payment_orders")
          Object.assign(row, {
            order_id: oid,
            merchant_order_no: "manual-" + String(i).padStart(5, "0"),
            idempotency_key_digest: digest,
            product_name: "人工选择基准中文 " + i,
            checkout_status: "CLOSED",
            closed_at: f.baseTime + 120000,
          });
        if (item.table === "amount_slots")
          Object.assign(row, {
            slot_id: randomUUID(),
            order_id: oid,
            generation: i + 1,
            released_at: f.baseTime + 120000,
            release_reason: "CLOSED",
          });
        if (item.table === "provider_raw_events")
          Object.assign(row, {
            raw_event_id: rawId,
            ordinal: i + 1,
            external_event_id: "manual-ledger-" + i,
            payload_fingerprint: digest,
          });
        if (item.table === "ledger_entries")
          Object.assign(row, {
            ledger_entry_id: lid,
            raw_event_id: rawId,
            external_event_id: "manual-ledger-" + String(i).padStart(5, "0"),
            occurred_at: f.baseTime + i * 1000,
            semantic_fingerprint: digest,
            other_account: "基准交易方 " + i,
          });
        item.insert.run(...item.columns.map((k) => row[k]!));
      }
    }
    for (const trigger of triggers) db.exec(trigger.sql);
  });
  const auth = await login(f.app);
  const base = "/api/admin/v1/reconciliation/settlements/manual/";
  const samples = [];
  for (const query of [
    "orders?view=all&q=人工选择",
    "orders?ledger_entry_id=" + entry.ledgerEntryId,
    "orders?ledger_entry_id=" + entry.ledgerEntryId + "&view=all&q=100.00",
    "ledger-entries?order_id=" + order.orderId,
    "ledger-entries?order_id=" + order.orderId + "&view=all&q=manual-ledger",
    "ledger-entries?order_id=" + order.orderId + "&view=all&q=基准交易方",
  ]) {
    let cursor: string | null = null;
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      const response = await f.app.request(
        base + query + "&limit=10" + (cursor ? "&cursor=" + cursor : ""),
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as {
        data: unknown[];
        page: { next_cursor: string | null };
      };
      times.push(Number((performance.now() - started).toFixed(3)));
      assert.equal(body.data.length, 10);
      cursor = body.page.next_cursor;
      assert.ok(cursor);
    }
    samples.push({ query, firstMs: times[0], nextMs: times[1] });
  }
  console.log(
    JSON.stringify(
      {
        fixture:
          "disposable synthetic read projections, triggers restored before queries; not financial-write evidence",
        orders: count,
        ledgerEntries: count,
        samples,
      },
      null,
      2,
    ),
  );
});
