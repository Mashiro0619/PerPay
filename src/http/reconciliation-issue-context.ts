import type { AppDatabase } from "../database/database.ts";
import { adminOrderIdentities, type OrderIdentitySummary } from "./admin-order-summary.ts";

export interface ReconciliationLedgerEntrySummary {
  readonly ledger_entry_id: string;
  readonly external_event_id: string;
  readonly occurred_at: string;
  readonly amount_cents: number;
  readonly direction: "CREDIT" | "DEBIT";
  readonly currency: "CNY";
  readonly provider_order_no: string | null;
  readonly merchant_order_no: string | null;
  readonly memo: string | null;
  readonly other_account: string | null;
}

export interface ReconciliationRawEventSummary {
  readonly raw_event_id: string;
  readonly external_event_id: string | null;
  readonly occurred_at_text: string | null;
  readonly amount_text: string | null;
  readonly direction_text: string | null;
  readonly alipay_order_no: string | null;
  readonly merchant_order_no: string | null;
  readonly memo: string | null;
  readonly other_account: string | null;
}

export interface ReconciliationIssueContext {
  readonly order_summary: OrderIdentitySummary | null;
  readonly ledger_entry_summary: ReconciliationLedgerEntrySummary | null;
  readonly raw_event_summary: ReconciliationRawEventSummary | null;
}

export interface ReconciliationIssueContextLookups {
  readonly orders: ReadonlyMap<string, OrderIdentitySummary>;
  readonly ledgerEntries: ReadonlyMap<string, ReconciliationLedgerEntrySummary>;
  readonly rawEvents: ReadonlyMap<string, ReconciliationRawEventSummary>;
  readonly settledOrderIds: ReadonlyMap<string, string>;
}

interface LedgerEntrySummaryRow {
  ledger_entry_id: string;
  external_event_id: string;
  occurred_at: bigint | number;
  amount_cents: bigint | number;
  direction: "CREDIT" | "DEBIT";
  currency: "CNY";
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  trans_memo: string | null;
  other_account: string | null;
}

interface RawEventSummaryRow {
  raw_event_id: string;
  external_event_id: string | null;
  occurred_at_text: string | null;
  amount_text: string | null;
  direction_text: string | null;
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  trans_memo: string | null;
  other_account: string | null;
}

function uniqueIds(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/** Batches the small related-record summaries needed by reconciliation lists. */
export function loadReconciliationIssueContexts(
  database: AppDatabase,
  input: {
    readonly orderIds?: readonly (string | null | undefined)[];
    readonly ledgerEntryIds?: readonly (string | null | undefined)[];
    readonly rawEventIds?: readonly (string | null | undefined)[];
  },
): ReconciliationIssueContextLookups {
  const ledgerEntryIds = uniqueIds(input.ledgerEntryIds ?? []);
  const rawEventIds = uniqueIds(input.rawEventIds ?? []);
  const { ledgerEntries, rawEvents, settledOrderIds } = database.read((connection) => {
    const ledgerEntries = new Map<string, ReconciliationLedgerEntrySummary>();
    if (ledgerEntryIds.length) {
      const rows = connection.prepare(
        `SELECT ledger_entry_id, external_event_id, occurred_at, amount_cents, direction,
                currency, alipay_order_no, merchant_order_no, trans_memo, other_account
           FROM ledger_entries
          WHERE ledger_entry_id IN (${placeholders(ledgerEntryIds.length)})`,
      ).all(...ledgerEntryIds) as unknown as LedgerEntrySummaryRow[];
      for (const row of rows) {
        ledgerEntries.set(row.ledger_entry_id, {
          ledger_entry_id: row.ledger_entry_id,
          external_event_id: row.external_event_id,
          occurred_at: new Date(Number(row.occurred_at)).toISOString(),
          amount_cents: Number(row.amount_cents),
          direction: row.direction,
          currency: row.currency,
          provider_order_no: row.alipay_order_no,
          merchant_order_no: row.merchant_order_no,
          memo: row.trans_memo,
          other_account: row.other_account,
        });
      }
    }

    const rawEvents = new Map<string, ReconciliationRawEventSummary>();
    if (rawEventIds.length) {
      const rows = connection.prepare(
        `SELECT raw_event_id, external_event_id, occurred_at_text, amount_text, direction_text,
                alipay_order_no, merchant_order_no, trans_memo, other_account
           FROM provider_raw_events
          WHERE raw_event_id IN (${placeholders(rawEventIds.length)})`,
      ).all(...rawEventIds) as unknown as RawEventSummaryRow[];
      for (const row of rows) {
        rawEvents.set(row.raw_event_id, {
          raw_event_id: row.raw_event_id,
          external_event_id: row.external_event_id,
          occurred_at_text: row.occurred_at_text,
          amount_text: row.amount_text,
          direction_text: row.direction_text,
          alipay_order_no: row.alipay_order_no,
          merchant_order_no: row.merchant_order_no,
          memo: row.trans_memo,
          other_account: row.other_account,
        });
      }
    }

    const settledOrderIds = new Map<string, string>();
    if (ledgerEntryIds.length) {
      const rows = connection.prepare(
        `SELECT ledger_entry_id, MIN(order_id) AS order_id
           FROM payment_matches
          WHERE status = 'SETTLED'
            AND ledger_entry_id IN (${placeholders(ledgerEntryIds.length)})
          GROUP BY ledger_entry_id
         HAVING COUNT(DISTINCT order_id) = 1`,
      ).all(...ledgerEntryIds) as unknown as Array<{ ledger_entry_id: string; order_id: string }>;
      for (const row of rows) settledOrderIds.set(row.ledger_entry_id, row.order_id);
    }

    return { ledgerEntries, rawEvents, settledOrderIds };
  });

  const orderIds = new Set(uniqueIds(input.orderIds ?? []));
  for (const orderId of settledOrderIds.values()) orderIds.add(orderId);
  const orders = adminOrderIdentities(database, [...orderIds]);
  return { orders, ledgerEntries, rawEvents, settledOrderIds };
}

export function reconciliationIssueContext(
  lookups: ReconciliationIssueContextLookups,
  input: {
    readonly orderId?: string | null;
    readonly ledgerEntryId?: string | null;
    readonly rawEventId?: string | null;
  },
): ReconciliationIssueContext {
  const ledgerEntry = input.ledgerEntryId ? lookups.ledgerEntries.get(input.ledgerEntryId) ?? null : null;
  const orderId = input.orderId ?? (input.ledgerEntryId ? lookups.settledOrderIds.get(input.ledgerEntryId) ?? null : null);
  return {
    order_summary: orderId ? lookups.orders.get(orderId) ?? null : null,
    ledger_entry_summary: ledgerEntry,
    raw_event_summary: input.rawEventId ? lookups.rawEvents.get(input.rawEventId) ?? null : null,
  };
}
