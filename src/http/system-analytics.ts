import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export interface SystemAnalytics {
  readonly range_days: AnalyticsRange;
  readonly from: string;
  readonly to: string;
  readonly orders: {
    readonly created: number;
    readonly unpaid: number;
    readonly confirmed: number;
    readonly disputed: number;
    readonly closed: number;
    readonly expired: number;
  };
  readonly confirmations: {
    readonly count: number;
    readonly amount_cents: number;
  };
  readonly notifications: {
    readonly acknowledged: number;
    readonly failed: number;
    readonly pending: number;
  };
  readonly pending: {
    readonly orders: number;
    readonly exceptions: number;
    readonly conflicts: number;
    readonly notifications: number;
  };
  readonly daily: readonly {
    readonly date: string;
    readonly orders_created: number;
    readonly confirmations: number;
    readonly confirmed_amount_cents: number;
    readonly notifications_acknowledged: number;
    readonly notifications_failed: number;
  }[];
}

interface CountRow {
  readonly count: number | bigint;
}

interface AmountRow extends CountRow {
  readonly amount_cents: number | bigint | null;
}

interface DailyRow {
  readonly date: string;
  readonly orders_created: number | bigint;
  readonly confirmations: number | bigint;
  readonly confirmed_amount_cents: number | bigint | null;
  readonly notifications_acknowledged: number | bigint;
  readonly notifications_failed: number | bigint;
}

function integer(value: number | bigint | null | undefined): number {
  const result = Number(value ?? 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function utcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function rangeDays(value: number): AnalyticsRange {
  if (value === 7 || value === 90) return value;
  return 30;
}

export function systemAnalytics(
  database: AppDatabase,
  requestedRange: number,
  now = Date.now(),
): SystemAnalytics {
  const days = rangeDays(requestedRange);
  const end = utcDayStart(now) + 86_400_000;
  const start = end - days * 86_400_000;
  return database.read((connection) => readAnalytics(connection, days, start, end));
}

function readAnalytics(
  connection: DatabaseSync,
  days: AnalyticsRange,
  start: number,
  end: number,
): SystemAnalytics {
  const orders = connection.prepare(`
    SELECT
      COUNT(*) AS created,
      SUM(CASE WHEN payment_status = 'UNPAID' THEN 1 ELSE 0 END) AS unpaid,
      SUM(CASE WHEN payment_status = 'CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN payment_status = 'DISPUTED' THEN 1 ELSE 0 END) AS disputed,
      SUM(CASE WHEN checkout_status = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN checkout_status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired
    FROM payment_orders
    WHERE created_at >= ? AND created_at < ?
  `).get(start, end) as Record<string, number | bigint | null>;

  const confirmations = connection.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(orders.received_amount_cents), 0) AS amount_cents
      FROM order_events AS events
      JOIN payment_orders AS orders ON orders.order_id = events.order_id
     WHERE events.event_type = 'PAYMENT_CONFIRMED'
       AND events.occurred_at >= ? AND events.occurred_at < ?
  `).get(start, end) as unknown as AmountRow;

  const notifications = connection.prepare(`
    SELECT
      SUM(CASE WHEN status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged,
      SUM(CASE WHEN status = 'DEAD_LETTER' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('PENDING', 'LEASED', 'RETRY_WAIT') THEN 1 ELSE 0 END) AS pending
      FROM webhook_deliveries
     WHERE created_at >= ? AND created_at < ?
  `).get(start, end) as Record<string, number | bigint | null>;

  const pending = connection.prepare(`
    SELECT
      (SELECT COUNT(*) FROM payment_orders
        WHERE checkout_status = 'OPEN' AND payment_status = 'UNPAID') AS orders,
      (SELECT COUNT(*) FROM financial_exceptions WHERE status = 'OPEN') AS exceptions,
      (SELECT COUNT(*) FROM ledger_conflicts WHERE status = 'OPEN') AS conflicts,
      (SELECT COUNT(*) FROM webhook_deliveries
        WHERE status IN ('PENDING', 'LEASED', 'RETRY_WAIT')) AS notifications
  `).get() as Record<string, number | bigint | null>;

  const dailyRows = connection.prepare(`
    WITH order_daily AS (
      SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS date,
             COUNT(*) AS orders_created
        FROM payment_orders
       WHERE created_at >= ? AND created_at < ?
       GROUP BY date
    ), confirmation_daily AS (
      SELECT strftime('%Y-%m-%d', events.occurred_at / 1000, 'unixepoch') AS date,
             COUNT(*) AS confirmations,
             COALESCE(SUM(orders.received_amount_cents), 0) AS confirmed_amount_cents
        FROM order_events AS events
        JOIN payment_orders AS orders ON orders.order_id = events.order_id
       WHERE events.event_type = 'PAYMENT_CONFIRMED'
         AND events.occurred_at >= ? AND events.occurred_at < ?
       GROUP BY date
    ), notification_daily AS (
      SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS date,
             SUM(CASE WHEN status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END) AS notifications_acknowledged,
             SUM(CASE WHEN status = 'DEAD_LETTER' THEN 1 ELSE 0 END) AS notifications_failed
        FROM webhook_deliveries
       WHERE created_at >= ? AND created_at < ?
       GROUP BY date
    )
    SELECT COALESCE(order_daily.date, confirmation_daily.date, notification_daily.date) AS date,
           COALESCE(order_daily.orders_created, 0) AS orders_created,
           COALESCE(confirmation_daily.confirmations, 0) AS confirmations,
           COALESCE(confirmation_daily.confirmed_amount_cents, 0) AS confirmed_amount_cents,
           COALESCE(notification_daily.notifications_acknowledged, 0) AS notifications_acknowledged,
           COALESCE(notification_daily.notifications_failed, 0) AS notifications_failed
      FROM order_daily
      FULL OUTER JOIN confirmation_daily ON confirmation_daily.date = order_daily.date
      FULL OUTER JOIN notification_daily
        ON notification_daily.date = COALESCE(order_daily.date, confirmation_daily.date)
     ORDER BY date
  `).all(start, end, start, end, start, end) as unknown as DailyRow[];

  const byDate = new Map(dailyRows.map((row) => [row.date, row]));
  const daily = Array.from({ length: days }, (_, index) => {
    const timestamp = start + index * 86_400_000;
    const date = dateKey(timestamp);
    const row = byDate.get(date);
    return {
      date,
      orders_created: integer(row?.orders_created),
      confirmations: integer(row?.confirmations),
      confirmed_amount_cents: integer(row?.confirmed_amount_cents),
      notifications_acknowledged: integer(row?.notifications_acknowledged),
      notifications_failed: integer(row?.notifications_failed),
    };
  });

  return {
    range_days: days,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    orders: {
      created: integer(orders.created),
      unpaid: integer(orders.unpaid),
      confirmed: integer(orders.confirmed),
      disputed: integer(orders.disputed),
      closed: integer(orders.closed),
      expired: integer(orders.expired),
    },
    confirmations: {
      count: integer(confirmations.count),
      amount_cents: integer(confirmations.amount_cents),
    },
    notifications: {
      acknowledged: integer(notifications.acknowledged),
      failed: integer(notifications.failed),
      pending: integer(notifications.pending),
    },
    pending: {
      orders: integer(pending.orders),
      exceptions: integer(pending.exceptions),
      conflicts: integer(pending.conflicts),
      notifications: integer(pending.notifications),
    },
    daily,
  };
}
