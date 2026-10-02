import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import {
  listCreatedDates,
  listKeyset,
  listSearch,
} from "../database/list-query.ts";
import { createdDateRange } from "../shared/created-dates.ts";
import {
  normalizeListQuery,
  ORDER_SORT_FIELDS,
  ListQueryError,
} from "../shared/list-query.ts";

export const orderExportSchema = z
  .object({
    q: z.string().optional(),
    sort_by: z.enum(ORDER_SORT_FIELDS).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
    payment_status: z.enum(["UNPAID", "CONFIRMED", "DISPUTED"]).optional(),
    checkout_status: z.enum(["OPEN", "CLOSED", "EXPIRED"]).optional(),
    created_from: z.string(),
    created_to: z.string(),
  })
  .strict();
export type OrderExportInput = z.infer<typeof orderExportSchema>;
export const MAX_EXPORT_ORDERS = 10_000;
export function csvCell(value: string): string {
  // Spreadsheet programs may interpret formulas even after leading whitespace.
  const safe = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(value)
    ? "'" + value
    : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
function amount(value: unknown): string {
  if (value === null) return "";
  const cents = BigInt(value as bigint | number);
  return (
    (cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0")
  );
}
function timestamp(value: unknown): string {
  return value === null
    ? ""
    : new Date(Number(value) + 8 * 3_600_000)
        .toISOString()
        .replace("T", " ")
        .replace(".000Z", " +08:00")
        .replace(/Z$/, " +08:00");
}
/** A single SELECT is one SQLite read snapshot, including historical confirmations.
 * Never use adminPage here: it performs an expiry sweep and changes financial records.
 */
export function exportOrders(
  database: AppDatabase,
  input: OrderExportInput,
  now: number,
): string {
  const query = normalizeListQuery(
    {
      q: input.q ?? "",
      sortBy: input.sort_by ?? "created_at",
      sortOrder: input.sort_order ?? "desc",
      createdFrom: input.created_from,
      createdTo: input.created_to,
    },
    ORDER_SORT_FIELDS,
    "created_at",
    "desc",
  );
  const range = createdDateRange(query.createdFrom, query.createdTo)!;
  if (range.days > 366)
    throw new ListQueryError("导出创建日期跨度最多 366 天，请缩小范围");
  const search = listSearch(
    ["orders.order_id", "orders.merchant_order_no", "orders.product_name"],
    query.q,
  );
  const dates = listCreatedDates(
    "orders.created_at",
    query.createdFrom,
    query.createdTo,
  );
  const sort = listKeyset(
    "orders." + query.sortBy,
    ["orders.order_id"],
    query.sortOrder,
    null,
    query.sortBy === "received_amount_cents",
  );
  const where = [search.where, dates.where].filter(Boolean);
  const parameters: Array<string | number> = [
    ...search.parameters,
    ...dates.parameters,
  ];
  if (input.payment_status) {
    where.push("orders.payment_status = ?");
    parameters.push(input.payment_status);
  }
  const checkout =
    "CASE WHEN orders.checkout_status = 'OPEN' AND orders.expires_at <= ? THEN 'EXPIRED' ELSE orders.checkout_status END";
  if (input.checkout_status) {
    where.push(checkout + " = ?");
    parameters.push(now, input.checkout_status);
  }
  const rows = database.read((db) =>
    db
      .prepare(
        `SELECT orders.merchant_order_no, orders.order_id, orders.product_name,
      orders.requested_amount_cents, orders.payable_amount_cents, orders.received_amount_cents,
      orders.currency, orders.payment_status, ${checkout} AS checkout_status, orders.created_at,
      (SELECT MAX(e.occurred_at) FROM order_events e WHERE e.order_id = orders.order_id AND e.event_type = 'PAYMENT_CONFIRMED') AS confirmed_at
    FROM payment_orders AS orders WHERE ${where.join(" AND ")} ORDER BY ${sort.orderBy} LIMIT ?`,
      )
      .all(now, ...parameters, MAX_EXPORT_ORDERS + 1),
  );
  if (rows.length > MAX_EXPORT_ORDERS)
    throw new ListQueryError("导出结果超过 10,000 条，请缩小筛选范围");
  const header = [
    "商户订单号",
    "内部订单号",
    "商品",
    "原始金额",
    "应付金额",
    "实收金额",
    "币种",
    "付款状态",
    "收银台状态",
    "创建时间",
    "付款确认时间",
  ];
  const payment: Record<string, string> = {
    UNPAID: "待付款",
    CONFIRMED: "收款已确认",
    DISPUTED: "需核对",
  };
  const lifecycle: Record<string, string> = {
    OPEN: "开放中",
    CLOSED: "已关闭",
    EXPIRED: "已过期",
  };
  return (
    "\uFEFF" +
    [
      header,
      ...rows.map((row) => [
        String(row.merchant_order_no),
        String(row.order_id),
        String(row.product_name),
        amount(row.requested_amount_cents),
        amount(row.payable_amount_cents),
        amount(row.received_amount_cents),
        String(row.currency),
        payment[String(row.payment_status)]!,
        lifecycle[String(row.checkout_status)]!,
        timestamp(row.created_at),
        timestamp(row.confirmed_at),
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n") +
    "\r\n"
  );
}
