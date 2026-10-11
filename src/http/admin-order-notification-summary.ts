import type { AppDatabase } from "../database/database.ts";

export interface AdminOrderNotificationSummary {
  status:
    | "NOT_CONFIGURED"
    | "NO_EVENT"
    | "UNMATERIALIZED"
    | "PENDING"
    | "LEASED"
    | "RETRY_WAIT"
    | "ACKNOWLEDGED"
    | "DEAD_LETTER";
  total_events: number;
  acknowledged_events: number;
}

interface NotificationSummaryRow {
  order_id: string;
  status: AdminOrderNotificationSummary["status"];
  total_events: number | bigint;
  acknowledged_events: number | bigint;
}

/** Summarizes one page without reading payloads, attempts or signing secrets. */
export function adminOrderNotificationSummaries(
  database: AppDatabase,
  orderIds: readonly string[],
): Map<string, AdminOrderNotificationSummary> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return new Map();

  return database.read((connection) => {
    const placeholders = ids.map(() => "?").join(",");
    const rows = connection.prepare(
      `SELECT orders.order_id,
              CASE
                WHEN target.target_id IS NULL THEN 'NOT_CONFIGURED'
                WHEN COUNT(outbox.outbox_event_id) = 0 THEN 'NO_EVENT'
                WHEN MAX(delivery.status = 'DEAD_LETTER') = 1 THEN 'DEAD_LETTER'
                WHEN MAX(delivery.status = 'RETRY_WAIT') = 1 THEN 'RETRY_WAIT'
                WHEN MAX(delivery.status = 'LEASED') = 1 THEN 'LEASED'
                WHEN MAX(delivery.status = 'PENDING') = 1 THEN 'PENDING'
                WHEN SUM(CASE WHEN delivery.status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END)
                     = COUNT(outbox.outbox_event_id) THEN 'ACKNOWLEDGED'
                ELSE 'UNMATERIALIZED'
              END AS status,
              COUNT(outbox.outbox_event_id) AS total_events,
              SUM(CASE WHEN delivery.status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END)
                AS acknowledged_events
         FROM payment_orders AS orders
         LEFT JOIN webhook_targets AS target ON target.order_id = orders.order_id
         LEFT JOIN outbox_events AS outbox
           ON outbox.aggregate_id = orders.order_id
          AND target.target_id IS NOT NULL
         LEFT JOIN webhook_deliveries AS delivery
           ON delivery.outbox_event_id = outbox.outbox_event_id
          AND delivery.target_id = target.target_id
          AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries AS newer
             WHERE newer.outbox_event_id = delivery.outbox_event_id
               AND newer.target_id = delivery.target_id
               AND newer.generation > delivery.generation
          )
        WHERE orders.order_id IN (${placeholders})
        GROUP BY orders.order_id, target.target_id`,
    ).all(...ids) as unknown as NotificationSummaryRow[];

    return new Map(rows.map((row) => [row.order_id, {
      status: row.status,
      total_events: Number(row.total_events),
      acknowledged_events: Number(row.acknowledged_events),
    }]));
  });
}
