/** Archived order slots and provider identities still belong to their original account. */
export function archivedAccountHistorySql(accountId: "?" | "OLD.account_id" | "account.account_id"): string {
  return `(EXISTS (SELECT 1 FROM archived_amount_slot_anchors WHERE alipay_account_id = ${accountId})
    OR EXISTS (SELECT 1 FROM archived_ledger_keys AS archived
      JOIN alipay_account_generations AS generation USING(provider_account_key)
      WHERE generation.account_id = ${accountId}))`;
}
