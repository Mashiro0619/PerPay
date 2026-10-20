import { createdDateRange } from "../../../src/shared/created-dates";
import { normalizeKeyword, readListQuery, type ListDateFields } from "@/lib/list-query";
import { money } from "@/lib/format";

export const LEDGER_DATE_FIELDS: ListDateFields = { from: "occurred_from", to: "occurred_to" };
export const LEDGER_SORT_FIELDS = ["occurred_at"] as const;
export const LEDGER_DIRECTIONS = ["CREDIT", "DEBIT"] as const;
export const LEDGER_STATES = ["UNALLOCATED", "CANDIDATE", "ALLOCATED", "CONFLICT", "ISOLATED", "IGNORED"] as const;
export const MAX_LEDGER_AMOUNT_CENTS = 999_999_999_999;

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
  if (!/^\d+$/.test(value)) throw new Error("金额筛选参数须为非负整数分。");
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
  if (direction && !LEDGER_DIRECTIONS.includes(direction as typeof LEDGER_DIRECTIONS[number])) throw new Error("收支方向无效，请重新选择筛选条件。");
  if (state && !LEDGER_STATES.includes(state as typeof LEDGER_STATES[number])) throw new Error("流水处理状态无效，请重新选择筛选条件。");
  createdDateRange(list.query.createdFrom, list.query.createdTo);
  const minimum = centsBoundary(search.get("min_amount_cents"));
  const maximum = centsBoundary(search.get("max_amount_cents"));
  validateLedgerAmountRange(minimum, maximum);
  return {
    ...(q ? { q } : {}),
    ...(direction ? { direction: direction as typeof LEDGER_DIRECTIONS[number] } : {}),
    ...(state ? { state: state as typeof LEDGER_STATES[number] } : {}),
    ...(list.query.createdFrom !== undefined ? { occurred_from: list.query.createdFrom } : {}),
    ...(list.query.createdTo !== undefined ? { occurred_to: list.query.createdTo } : {}),
    ...(minimum !== undefined ? { min_amount_cents: minimum } : {}),
    ...(maximum !== undefined ? { max_amount_cents: maximum } : {}),
    sort_by: "occurred_at" as const,
    sort_order: list.query.sortOrder,
  };
}
