import { queryClient } from "@/api/client";
import type { QueryKey } from "@tanstack/react-query";

const reconciliationDetails = new Set([
  "administrator-ledger-detail", "order", "ledger", "ledger-candidates",
  "match", "exception", "candidate", "conflict",
]);

export function isReconciliationDetailQuery(query: { queryKey: QueryKey }): boolean {
  return reconciliationDetails.has(String(query.queryKey[0]));
}

/** Evidence uses separate IDs. Refresh mounted detail reads together and mark
 * cached references stale, including references first revealed by this refresh. */
export function refreshReconciliationDetails(): Promise<void> {
  return queryClient.invalidateQueries({ predicate: isReconciliationDetailQuery });
}

/** A completed record action invalidates its projections without reloading settings or service diagnostics. */
export function refreshOrderRecords(orderId: string): Promise<void> {
  return queryClient.invalidateQueries({ predicate: query => {
    const domain = String(query.queryKey[0]);
    return domain === "orders" || (domain === "order" && query.queryKey.includes(orderId));
  } });
}

export function refreshNotificationRecords(orderId: string, deliveryId: string): Promise<void> {
  return queryClient.invalidateQueries({ predicate: query => {
    const domain = String(query.queryKey[0]);
    return ["notifications", "orders", "work-items"].includes(domain)
      || (["order", "order-notifications"].includes(domain) && query.queryKey.includes(orderId))
      || (["notification", "notification-attempts"].includes(domain) && query.queryKey.includes(deliveryId));
  } });
}

const financialProjections = new Set([
  "orders", "order", "work-items", "reconciliation", "analytics", "site-overview",
  "administrator-ledger", "administrator-ledger-detail", "ledger", "ledger-candidates",
  "match", "exception", "candidate", "conflict", "manual-candidates",
  "order-notifications", "notifications", "notification",
]);

export function refreshFinancialRecords(): Promise<void> {
  return queryClient.invalidateQueries({ predicate: query => financialProjections.has(String(query.queryKey[0])) });
}
