import type { DatabaseSync } from "node:sqlite";
import { AdminOperationError } from "../database/admin-operation-store.ts";
/** An administrator scope is an explicit operation boundary, not another identity. */
export function assertSiteOrder(db: DatabaseSync, clientId: string | undefined, orderId: string): void {
    if (!clientId)
        return;
    if (!db.prepare("SELECT 1 FROM payment_orders AS o JOIN sites AS s ON s.client_id = o.api_client_id WHERE o.order_id = ? AND o.api_client_id = ? AND s.deleted_at IS NULL").get(orderId, clientId)) {
        throw new AdminOperationError(404, "order_not_found", "当前网站下不存在该订单");
    }
}
export type SiteResource = "order" | "delivery" | "match" | "candidate" | "exception";
const resources = {
    order: ["payment_orders", "order_id"], delivery: ["webhook_targets t JOIN webhook_deliveries d ON d.target_id = t.target_id", "d.delivery_id"],
    match: ["payment_matches", "payment_match_id"], candidate: ["match_candidates", "candidate_id"], exception: ["financial_exceptions", "exception_id"],
} as const;
export function assertSiteResource(db: DatabaseSync, clientId: string | undefined, kind: SiteResource, id: string): string | null {
    if (!clientId)
        return null;
    const [table, column] = resources[kind];
    const row = db.prepare(`SELECT order_id FROM ${table} WHERE ${column} = ?`).get(id) as {
        order_id: string | null;
    } | undefined;
    if (!row?.order_id)
        throw new AdminOperationError(404, "order_not_found", "当前网站下不存在该记录");
    assertSiteOrder(db, clientId, row.order_id);
    return row.order_id;
}
/** Shared ledger evidence is not silently reassigned from a different website. */
export function assertSiteLedger(db: DatabaseSync, clientId: string | undefined, ledgerId: string): void {
    if (!clientId)
        return;
    const conflict = db.prepare("SELECT 1 FROM ledger_conflicts WHERE existing_ledger_entry_id = ? AND status = 'OPEN' LIMIT 1").get(ledgerId);
    const other = db.prepare(`SELECT 1 FROM (
    SELECT order_id FROM payment_matches WHERE ledger_entry_id = ?
    UNION SELECT order_id FROM match_candidates WHERE ledger_entry_id = ?
    UNION SELECT order_id FROM financial_exceptions WHERE ledger_entry_id = ? AND order_id IS NOT NULL
  ) AS evidence JOIN payment_orders AS o ON o.order_id = evidence.order_id WHERE o.api_client_id != ? LIMIT 1`).get(ledgerId, ledgerId, ledgerId, clientId);
    if (conflict || other)
        throw new AdminOperationError(409, "site_scope_conflict", "该流水涉及共享冲突或其他网站，请到一级共享账本处理。");
}
// Register the same controllers at explicit website paths; never dispatch internal HTTP.
export const SITE_ADMIN_ROUTES = [
    ["GET", "/system/analytics"], ["GET", "/work-items"], ["GET", "/work-items/summary"],
    ["POST", "/work-items/actions/ignore-all"], ["POST", "/work-items/:type/:resourceId/actions/restore"],
    ["GET", "/orders"], ["POST", "/orders/export"], ["POST", "/test-payments"],
    ["GET", "/orders/by-merchant-no/:merchantOrderNo"], ["GET", "/orders/:orderId"],
    ["GET", "/orders/:orderId/checkout"], ["GET", "/orders/:orderId/notifications/deliveries"], ["PUT", "/orders/:orderId/refund-mark"],
    ["GET", "/webhooks/deliveries"], ["GET", "/webhooks/deliveries/:deliveryId"],
    ["GET", "/webhooks/deliveries/:deliveryId/attempts"], ["POST", "/webhooks/deliveries/:deliveryId/actions/redeliver"],
    ["GET", "/reconciliation/candidates/:candidateId"], ["GET", "/reconciliation/matches/:paymentMatchId"],
    ["GET", "/reconciliation/exceptions/:exceptionId"], ["GET", "/reconciliation/ledger-entries/:ledgerEntryId"],
    ["GET", "/reconciliation/ledger-entries/:ledgerEntryId/candidates"],
    ["GET", "/reconciliation/settlements/manual/ledger-entries"],
    ["POST", "/reconciliation/settlements/manual"], ["POST", "/reconciliation/matches/:paymentMatchId/actions/reverse"],
] as const;
