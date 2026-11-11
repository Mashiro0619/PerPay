import type { DatabaseSync } from "node:sqlite";

/** Manual review may cross application generations of the same account and gateway. */
export function manualProviderAccountEligibilitySql(
  connection: DatabaseSync,
  order: "o" | "orders",
  entry: "l" | "entry",
): string {
  const hasGenerations = connection.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alipay_account_generations'",
  ).get() !== undefined;
  const sameAccount = hasGenerations ? ` OR EXISTS (
    SELECT 1 FROM alipay_account_generations AS original
      JOIN alipay_account_generations AS current ON current.account_id = original.account_id
      JOIN provider_account_bindings AS original_binding ON original_binding.provider_account_key = original.provider_account_key
      JOIN provider_account_bindings AS current_binding ON current_binding.provider_account_key = current.provider_account_key
     WHERE original.provider_account_key = profile_provider.provider_account_key
       AND current.provider_account_key = ${entry}.provider_account_key
       AND original_binding.provider_endpoint = current_binding.provider_endpoint
  )` : "";
  return `EXISTS (
    SELECT 1 FROM collection_profile_provider_accounts AS profile_provider
     WHERE profile_provider.profile_id = ${order}.collection_profile_id
       AND (profile_provider.provider_account_key = ${entry}.provider_account_key${sameAccount})
  )`;
}

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
