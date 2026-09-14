import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../src/database/database.ts";
import { financialExceptionDetailsFingerprint, financialExceptionFingerprint } from "../src/reconciliation/model.ts";

/** Reconstructs a legacy warning without resolving it or weakening production reconciliation. */
export function seedLegacyDebitException(database: AppDatabase, ledgerEntryId: string, exceptionType: "UNMATCHED_DEBIT" | "UNLINKED_REFUND", now = Date.now()): string {
  return database.write((connection) => {
    const entry = connection.prepare("SELECT provider_account_key FROM ledger_entries WHERE ledger_entry_id = ?").get(ledgerEntryId) as { provider_account_key: string };
    const id = randomUUID();
    const facts = { providerAccountKey: entry.provider_account_key, exceptionType, ledgerEntryId, orderId: null, candidateId: null, contextKey: "initial" };
    const details = JSON.stringify({ reason: "legacy_debit_warning", refund_classification: "not_inferred" });
    connection.prepare(`INSERT INTO financial_exceptions(exception_id, provider_account_key, exception_type, ledger_entry_id, order_id,
      candidate_id, context_key, details_json, exception_fingerprint, status, created_at, details_fingerprint)
      VALUES (?, ?, ?, ?, NULL, NULL, 'initial', ?, ?, 'OPEN', ?, ?)`)
      .run(id, facts.providerAccountKey, exceptionType, ledgerEntryId, details, financialExceptionFingerprint(facts), now, financialExceptionDetailsFingerprint(details));
    return id;
  });
}
