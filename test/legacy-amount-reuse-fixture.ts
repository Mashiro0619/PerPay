import assert from "node:assert/strict";

import type { AppDatabase } from "../src/database/database.ts";
import { OrderStore, type CreateStoredOrderInput, type StoredOrderAggregate } from "../src/database/order-store.ts";
import { orderEventDetailsFingerprint } from "../src/orders/model.ts";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const tables = ["payment_orders", "checkout_sessions", "amount_slots", "order_events"] as const;

/** Seeds a pre-cooldown history without weakening production allocation or matching rules. */
export function createLegacyAmountReuseOrder(
  database: AppDatabase,
  input: CreateStoredOrderInput,
  now: number,
  payableAmountCents: number,
  allowLegacyReuse = true,
): StoredOrderAggregate {
  const legacy = new OrderStore({
    read: (operation) => database.read(operation),
    write(operation) {
      return database.write((connection) => {
        connection.exec("SAVEPOINT legacy_order_template");
        const output = operation(connection);
        const created = output as ReturnType<OrderStore["createOrder"]>;
        assert.equal(created.kind, "created");
        if (created.kind !== "created") assert.fail("expected a template order");
        const rows = tables.map((table) => ({
          table,
          row: connection.prepare("SELECT * FROM " + table + " WHERE order_id = ?")
            .get(created.aggregate.order.orderId) as Row,
        }));
        connection.exec("ROLLBACK TO legacy_order_template; RELEASE legacy_order_template");
        const latest = connection.prepare("SELECT max(generation) AS value FROM amount_slots WHERE payable_amount_cents = ?")
          .get(payableAmountCents) as { value: bigint | null };
        const generation = Number(latest.value ?? 0n) + 1;
        const guard = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'amount_slots_cooldown_guard'")
          .get() as { sql: string };
        // Only this isolated fixture bypasses the new cooldown: an upgraded database can
        // already contain these overlapping legacy generations, which must remain safe.
        if (allowLegacyReuse) connection.exec("DROP TRIGGER amount_slots_cooldown_guard");
        connection.prepare("UPDATE order_clock SET last_now_ms = max(last_now_ms, ?) WHERE singleton_key = 1").run(created.aggregate.order.createdAt);
        for (const { table, row } of rows) {
          assert.ok(row);
          if (table === "payment_orders" || table === "amount_slots") row.payable_amount_cents = payableAmountCents;
          if (table === "amount_slots") row.generation = generation;
          if (table === "order_events") {
            row.details_json = JSON.stringify({ amount_offset_cents: payableAmountCents - input.request.amount_cents, slot_generation: generation });
            row.details_fingerprint = orderEventDetailsFingerprint(row.details_json);
          }
          const columns = Object.keys(row);
          assert.ok(columns.every((name) => /^[a-z_]+$/.test(name)));
          connection.prepare("INSERT INTO " + table + " (" + columns.join(",") + ") VALUES (" + columns.map(() => "?").join(",") + ")")
            .run(...columns.map((name) => row[name]!));
        }
        if (allowLegacyReuse) connection.exec(guard.sql);
        return output;
      });
    },
  }, () => now);
  const result = legacy.createOrder(input);
  if (result.kind !== "created") assert.fail("legacy seed did not create an order");
  const aggregate = new OrderStore(database, () => now).orderById(input.apiClientId, result.aggregate.order.orderId);
  assert.ok(aggregate);
  return aggregate;
}
