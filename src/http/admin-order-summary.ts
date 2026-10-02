import type { AppDatabase } from "../database/database.ts";
export interface OrderIdentitySummary {
  order_id: string;
  merchant_order_no: string;
  product_name: string;
  requested_amount_cents: number;
  payable_amount_cents: number;
  received_amount_cents: number | null;
  payment_confirmed_at: string | null;
}
/** One bounded batch; never loads secrets, capabilities, notes or complete event histories. */
export function adminOrderIdentities(
  database: AppDatabase,
  orderIds: readonly string[],
): Map<string, OrderIdentitySummary> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return new Map();
  return database.read((db) => {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT o.order_id, o.merchant_order_no, o.product_name,
      o.requested_amount_cents, o.payable_amount_cents, o.received_amount_cents,
      (SELECT MAX(e.occurred_at) FROM order_events e WHERE e.order_id=o.order_id AND e.event_type='PAYMENT_CONFIRMED') AS confirmed
      FROM payment_orders o WHERE o.order_id IN (${placeholders})`,
      )
      .all(...ids) as unknown as Array<
      Omit<OrderIdentitySummary, "payment_confirmed_at"> & {
        confirmed: number | null;
      }
    >;
    return new Map(
      rows.map(({ confirmed, ...row }) => [
        row.order_id,
        {
          ...row,
          requested_amount_cents: Number(row.requested_amount_cents),
          payable_amount_cents: Number(row.payable_amount_cents),
          received_amount_cents:
            row.received_amount_cents === null
              ? null
              : Number(row.received_amount_cents),
          payment_confirmed_at:
            confirmed === null
              ? null
              : new Date(Number(confirmed)).toISOString(),
        },
      ]),
    );
  });
}
