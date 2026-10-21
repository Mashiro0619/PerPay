import type { AdminLedgerSummary } from "../src/api/client";
import { ledger, order } from "./fixtures";
import { paymentMatch } from "./detail-fixtures";

export const groupedLedger: AdminLedgerSummary = {
  ...ledger,
  environment: "PRODUCTION",
  states: ["ALLOCATED"],
  source_record_count: 1,
  content_consistent: true,
  has_conflicts: false,
  active_match_count: 1,
  reversed_match_count: 0,
  last_associated_at: paymentMatch.created_at,
  last_handled_at: paymentMatch.resolved_at,
  active_match: {
    payment_match_id: paymentMatch.payment_match_id,
    ledger_entry_id: ledger.ledger_entry_id,
    order_id: order.order_id,
    merchant_order_no: order.merchant_order_no,
    product_name: order.product_name,
    api_client_id: order.api_client_id,
    site_name: order.site_name ?? null,
    evidence_type: paymentMatch.evidence_type,
    status: "SETTLED",
    created_at: paymentMatch.created_at,
    resolved_at: paymentMatch.resolved_at,
  },
};
