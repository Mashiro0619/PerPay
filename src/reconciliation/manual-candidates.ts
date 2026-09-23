import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { listSearch } from "../database/list-query.ts";
import {
  ListQueryError,
  normalizeKeyword,
  type ListPosition,
} from "../shared/list-query.ts";

export type ManualCandidateKind = "orders" | "ledger-entries";
export interface ManualCandidateQuery {
  readonly contextId: string | null;
  readonly q: string;
  readonly view: "recommended" | "all";
  readonly limit: number;
  readonly position: ListPosition | null;
}
export interface ManualRecommendation {
  readonly amountMatch: boolean;
  readonly timeWindowOverlap: boolean;
  readonly timeDistanceMilliseconds: number;
}
export interface ManualCandidatePage<T> {
  readonly items: readonly {
    readonly record: T;
    readonly recommendation: ManualRecommendation | null;
  }[];
  readonly nextPosition: ListPosition | null;
}
interface CandidateRow {
  id: string;
  record_time: number | bigint;
  amount_match: number | bigint;
  overlaps: number | bigint;
  distance: number | bigint;
  priority: number | bigint;
  sort_distance: number | bigint;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function numericKey(value: string | undefined): number {
  if (
    !value ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ListQueryError("候选分页游标无效");
  return Number(value);
}
function keywordAmount(q: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(q)) return null;
  const [whole, fraction = ""] = q.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 999_999_999_999
    ? cents
    : null;
}
/** Read-only discovery, not automatic matching. Eligibility is rechecked by settleManually's transaction. */
export function readManualCandidates(
  connection: DatabaseSync,
  kind: ManualCandidateKind,
  query: ManualCandidateQuery,
) {
  const q = normalizeKeyword(query.q);
  if (
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100 ||
    !["recommended", "all"].includes(query.view) ||
    (query.contextId !== null && !uuid.test(query.contextId)) ||
    (query.contextId === null &&
      (kind === "ledger-entries" || query.view === "recommended"))
  ) {
    throw new ListQueryError("人工关联候选查询无效");
  }
  const paired = query.contextId !== null;
  const orders = kind === "orders";
  if (paired) {
    const source = orders ? "ledger_entries" : "payment_orders";
    const key = orders ? "ledger_entry_id" : "order_id";
    if (
      !connection
        .prepare("SELECT 1 FROM " + source + " WHERE " + key + " = ?")
        .get(query.contextId!)
    )
      return null;
  }
  const id = orders ? "o.order_id" : "l.ledger_entry_id";
  const time = orders ? "o.created_at" : "l.occurred_at";
  const predicates = [
    "o.payment_status = 'UNPAID'",
    "o.payment_basis = 'NONE'",
  ];
  const parameters: SQLInputValue[] = [];
  let from = "payment_orders o";
  if (paired) {
    from =
      "payment_orders o JOIN ledger_entries l ON " +
      (orders ? "l.ledger_entry_id = ?" : "o.order_id = ?");
    parameters.push(query.contextId!);
    predicates.push(
      "l.direction = 'CREDIT'",
      "l.currency = o.currency",
      "l.state IN ('UNALLOCATED', 'CANDIDATE', 'CONFLICT')",
      "NOT EXISTS (SELECT 1 FROM payment_matches m WHERE m.ledger_entry_id = l.ledger_entry_id AND m.status = 'SETTLED')",
      "EXISTS (SELECT 1 FROM collection_profile_provider_accounts p WHERE p.profile_id = o.collection_profile_id AND p.provider_account_key = l.provider_account_key)",
    );
    if (query.view === "recommended")
      predicates.push("l.amount_cents = o.payable_amount_cents");
  }
  const search = listSearch(
    orders
      ? ["o.order_id", "o.merchant_order_no", "o.product_name"]
      : [
          "l.ledger_entry_id",
          "l.external_event_id",
          "l.alipay_order_no",
          "l.merchant_order_no",
          "l.other_account",
        ],
    q,
  );
  if (search.where) {
    const amount = keywordAmount(q);
    predicates.push(
      "(" +
        search.where +
        (amount === null
          ? ""
          : " OR " +
            (orders ? "o.payable_amount_cents" : "l.amount_cents") +
            " = ?") +
        ")",
    );
    parameters.push(...search.parameters);
    if (amount !== null) parameters.push(amount);
  }
  // Exactly the order/slot intersection used by automatic amount inference, including timestamp precision.
  const start = "max(o.eligible_from, s.occupied_from)";
  const end = "min(o.expires_at, coalesce(s.released_at, o.expires_at))";
  const validWindow = start + " < " + end;
  const overlap =
    "l.occurred_at + l.occurred_at_precision_ms > " +
    start +
    " AND l.occurred_at < " +
    end;
  const overlaps = paired
    ? "EXISTS (SELECT 1 FROM amount_slots s WHERE s.order_id = o.order_id AND " +
      validWindow +
      " AND " +
      overlap +
      ")"
    : "0";
  const distance = paired
    ? "coalesce((SELECT min(CASE WHEN " +
      overlap +
      " THEN 0 WHEN l.occurred_at + l.occurred_at_precision_ms <= " +
      start +
      " THEN " +
      start +
      " - (l.occurred_at + l.occurred_at_precision_ms) ELSE l.occurred_at - " +
      end +
      " END) FROM amount_slots s WHERE s.order_id = o.order_id AND " +
      validWindow +
      "), abs(l.occurred_at - o.created_at))"
    : "0";
  let seek = "";
  if (query.position) {
    const { value, keys } = query.position;
    const priority = numericKey(keys[0]);
    const recordTime = numericKey(keys[1]);
    if (
      keys.length !== 3 ||
      priority > 1 ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      !uuid.test(keys[2] ?? "") ||
      (query.view === "all" && (priority !== 0 || value !== 0))
    )
      throw new ListQueryError("候选分页游标无效");
    seek =
      "WHERE (priority > ? OR (priority = ? AND sort_distance > ?) OR (priority = ? AND sort_distance = ? AND (record_time < ? OR (record_time = ? AND id < ?))))";
    parameters.push(
      priority,
      priority,
      value,
      priority,
      value,
      recordTime,
      recordTime,
      keys[2]!,
    );
  }
  parameters.push(query.limit + 1);
  const rows = connection
    .prepare(
      "WITH facts AS (SELECT " +
        id +
        " AS id, " +
        time +
        " AS record_time, " +
        (paired ? "(o.payable_amount_cents = l.amount_cents)" : "0") +
        " AS amount_match, " +
        overlaps +
        " AS overlaps, " +
        distance +
        " AS distance FROM " +
        from +
        " WHERE " +
        predicates.join(" AND ") +
        "), ranked AS (SELECT *, " +
        (query.view === "recommended"
          ? "CASE WHEN overlaps THEN 0 ELSE 1 END AS priority, distance AS sort_distance"
          : "0 AS priority, 0 AS sort_distance") +
        " FROM facts) SELECT * FROM ranked " +
        seek +
        " ORDER BY priority, sort_distance, record_time DESC, id DESC LIMIT ?",
    )
    .all(...parameters) as unknown as CandidateRow[];
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  return {
    selections: selected.map((row) => ({
      id: row.id,
      recommendation: paired
        ? {
            amountMatch: Boolean(row.amount_match),
            timeWindowOverlap: Boolean(row.overlaps),
            timeDistanceMilliseconds: Number(row.distance),
          }
        : null,
    })),
    nextPosition:
      rows.length > query.limit && last
        ? {
            value: Number(last.sort_distance),
            keys: [String(last.priority), String(last.record_time), last.id],
          }
        : null,
  };
}
