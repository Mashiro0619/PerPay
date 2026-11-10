export function manualOrderEligibilitySql(order: "o" | "orders"): string {
  return `(
    ((${order}.payment_status = 'UNPAID' AND ${order}.payment_basis = 'NONE') OR
      (${order}.payment_status = 'DISPUTED' AND ${order}.payment_basis IN ('INFERRED', 'MANUAL')
        AND EXISTS (SELECT 1 FROM payment_matches AS previous
          WHERE previous.order_id = ${order}.order_id AND previous.status = 'REVERSED')))
    AND ${order}.refund_status = 'NONE'
    AND NOT EXISTS (SELECT 1 FROM payment_matches AS active
      WHERE active.order_id = ${order}.order_id AND active.status = 'SETTLED')
    AND NOT EXISTS (SELECT 1 FROM admin_refund_marks AS current
      JOIN admin_refund_mark_events AS mark ON mark.order_id = current.order_id AND mark.version = current.version
      WHERE current.order_id = ${order}.order_id AND mark.marked = 1)
  )`;
}
