import { createdDateRange } from "../../../src/shared/created-dates";
import { normalizeKeyword, readListQuery, type ListDateFields } from "@/lib/list-query";
import { money } from "@/lib/format";

export const LEDGER_DATE_FIELDS: ListDateFields = { from: "occurred_from", to: "occurred_to" };
export const LEDGER_ASSOCIATED_DATE_FIELDS: ListDateFields = { from: "associated_from", to: "associated_to" };
export const LEDGER_SORT_FIELDS = ["occurred_at", "associated_at", "handled_at", "amount_cents", "event_sequence"] as const;
export const LEDGER_ASSOCIATION_STATES = ["UNMATCHED", "MATCHED", "MULTIPLE"] as const;
export const LEDGER_DIRECTIONS = ["CREDIT", "DEBIT"] as const;
export const LEDGER_STATES = ["UNALLOCATED", "CANDIDATE", "ALLOCATED", "CONFLICT", "ISOLATED", "IGNORED"] as const;
export const MAX_LEDGER_AMOUNT_CENTS = 999_999_999_999;

/** Old match bookmarks become transaction queries; match cursors are incompatible. */
export function migrateMatchListSearch(search: URLSearchParams): URLSearchParams | null {
  const legacy = search.get("tab") === "matches" ||
    (!search.has("tab") && (
      ["SETTLED", "REVERSED"].includes(search.get("status") ?? "") ||
      search.get("sort_by") === "created_at" || search.has("created_from") || search.has("created_to")
    ));
  if (!legacy) return null;
  const next = new URLSearchParams(search);
  next.set("tab", "transactions");
  if (search.get("status") === "REVERSED") next.set("has_reversals", "true");
  else next.set("association_status", "MATCHED");
  if (!search.has("sort_by") || search.get("sort_by") === "created_at") next.set("sort_by", "associated_at");
  for (const [oldKey, newKey] of [["created_from", "associated_from"], ["created_to", "associated_to"]] as const) {
    if (search.has(oldKey) && !search.has(newKey)) next.set(newKey, search.get(oldKey)!);
    next.delete(oldKey);
  }
  for (const key of ["status", "cursor", "page", "provider_account_key"]) next.delete(key);
  return next;
}

/** Decimal text is converted as integers, without floating-point rounding. */
export function parseLedgerAmount(value: string): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("请输入非负人民币金额，最多保留两位小数。");
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(MAX_LEDGER_AMOUNT_CENTS)) throw new Error("金额不能超过 " + money(MAX_LEDGER_AMOUNT_CENTS) + "。");
  return Number(cents);
}

function centsBoundary(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("金额筛选无效，请重新设置金额范围。");
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents > MAX_LEDGER_AMOUNT_CENTS) throw new Error("金额不能超过 " + money(MAX_LEDGER_AMOUNT_CENTS) + "。");
  return cents;
}

export function ledgerAmountInput(value: string | null): string {
  if (value === null) return "";
  try {
    const cents = centsBoundary(value)!;
    return Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
  } catch {
    return "";
  }
}

export function validateLedgerAmountRange(minimum: number | undefined, maximum: number | undefined) {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error("最低金额不能大于最高金额。");
  }
}

export function readLedgerFilters(search: URLSearchParams) {
  const list = readListQuery(search, LEDGER_SORT_FIELDS, "occurred_at", "desc", LEDGER_DATE_FIELDS);
  const q = normalizeKeyword(list.query.q);
  const direction = search.get("direction") || undefined;
  const state = search.get("state") || undefined;
  const association = search.get("association_status") || undefined;
  const hasReversals = search.get("has_reversals");
  if (direction && !LEDGER_DIRECTIONS.includes(direction as typeof LEDGER_DIRECTIONS[number])) throw new Error("收支方向无效，请重新选择筛选条件。");
  if (state && !LEDGER_STATES.includes(state as typeof LEDGER_STATES[number])) throw new Error("PerPay 处理状态无效，请重新选择筛选条件。");
  if (association && !LEDGER_ASSOCIATION_STATES.includes(association as typeof LEDGER_ASSOCIATION_STATES[number])) throw new Error("关联状态无效，请重新选择筛选条件。");
  if (hasReversals !== null && hasReversals !== "true" && hasReversals !== "false") throw new Error("撤销记录筛选无效，请重新选择筛选条件。");
  createdDateRange(list.query.createdFrom, list.query.createdTo);
  const associatedFrom = search.get("associated_from") ?? undefined;
  const associatedTo = search.get("associated_to") ?? undefined;
  createdDateRange(associatedFrom, associatedTo);
  const minimum = centsBoundary(search.get("min_amount_cents"));
  const maximum = centsBoundary(search.get("max_amount_cents"));
  validateLedgerAmountRange(minimum, maximum);
  return {
    ...(q ? { q } : {}),
    ...(direction ? { direction: direction as typeof LEDGER_DIRECTIONS[number] } : {}),
    ...(state ? { state: state as typeof LEDGER_STATES[number] } : {}),
    ...(association ? { association_status: association as typeof LEDGER_ASSOCIATION_STATES[number] } : {}),
    ...(hasReversals !== null ? { has_reversals: hasReversals === "true" } : {}),
    ...(list.query.createdFrom !== undefined ? { occurred_from: list.query.createdFrom } : {}),
    ...(list.query.createdTo !== undefined ? { occurred_to: list.query.createdTo } : {}),
    ...(associatedFrom !== undefined ? { associated_from: associatedFrom } : {}),
    ...(associatedTo !== undefined ? { associated_to: associatedTo } : {}),
    ...(minimum !== undefined ? { min_amount_cents: minimum } : {}),
    ...(maximum !== undefined ? { max_amount_cents: maximum } : {}),
    sort_by: list.query.sortBy,
    sort_order: list.query.sortOrder,
  };
}
