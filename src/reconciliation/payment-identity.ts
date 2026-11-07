import type { DatabaseSync } from "node:sqlite";

/**
 * The same payment can have several immutable source copies after an account's
 * application changes. Match the grouped ledger identity, not just one copy.
 * Unmapped sources retain their own provider key; historical schemas have no
 * account generations. Production and sandbox bindings remain separate.
 * All expressions below are internal SQL aliases, never request parameters.
 */
export function settledPaymentIdentitySql(
  connection: DatabaseSync,
  entryAlias: "entry" | "l" | "ledger_entries",
  excludeMatchId?: "payment_match.payment_match_id",
): string {
  const hasAccounts = connection.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alipay_account_generations'",
  ).get() !== undefined;
  const sources = hasAccounts ? `
    SELECT ${entryAlias}.provider_account_key
    UNION
    SELECT sibling.provider_account_key
      FROM alipay_account_generations AS original
      JOIN alipay_account_generations AS sibling ON sibling.account_id = original.account_id
      JOIN provider_account_bindings AS original_binding ON original_binding.provider_account_key = original.provider_account_key
      JOIN provider_account_bindings AS sibling_binding ON sibling_binding.provider_account_key = sibling.provider_account_key
     WHERE original.provider_account_key = ${entryAlias}.provider_account_key
       AND sibling_binding.provider_endpoint = original_binding.provider_endpoint
  ` : `SELECT ${entryAlias}.provider_account_key`;
  return `EXISTS (
    SELECT 1 FROM ledger_entries AS identity_entry
      JOIN payment_matches AS identity_match ON identity_match.ledger_entry_id = identity_entry.ledger_entry_id
     WHERE identity_entry.provider_account_key IN (${sources})
       AND identity_entry.external_event_id = ${entryAlias}.external_event_id
       AND identity_match.status = 'SETTLED'
       ${excludeMatchId ? `AND identity_match.payment_match_id != ${excludeMatchId}` : ""}
  )`;
}

export function hasSettledPaymentIdentity(connection: DatabaseSync, ledgerEntryId: string): boolean {
  return connection.prepare(`SELECT 1 FROM ledger_entries AS entry
    WHERE entry.ledger_entry_id = ? AND ${settledPaymentIdentitySql(connection, "entry")}`)
    .get(ledgerEntryId) !== undefined;
}
