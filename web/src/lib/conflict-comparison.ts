import type { LedgerConflictDetail } from "../api/client";
import { money } from "./format";
import { detailTimestamp } from "./detail-summary";

// Display-only comparisons follow ledger normalization; they never determine money state.
export function comparisonAmount(value: string | null | undefined): number | null {
  const match = /^[+-]?(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 999_999_999_999 ? cents : null;
}
export function comparisonDirection(value: string | null | undefined): "CREDIT" | "DEBIT" | null {
  const raw = value?.trim().toUpperCase();
  if (raw && ["CREDIT", "IN", "INCOME", "RECEIVE", "RECEIVED", "收入", "收款", "转入"].includes(raw)) return "CREDIT";
  if (raw && ["DEBIT", "OUT", "EXPENSE", "PAY", "PAID", "支出", "付款", "转出"].includes(raw)) return "DEBIT";
  return null;
}
export function comparisonTime(value: string | null | undefined): { milliseconds: number; precision: number } | null {
  const raw = value?.trim() ?? "";
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(raw);
  let milliseconds: number; let fraction: string | undefined;
  if (local) {
    const [, year, month, day, hour, minute, second, part] = local;
    const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number((part ?? "").padEnd(3, "0"))));
    if (Number(year) < 2000 || calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    milliseconds = calendar.getTime() - 8 * 60 * 60 * 1000; fraction = part;
  } else if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(raw)?.[1];
    if (fraction !== undefined && fraction.length > 3) return null;
    milliseconds = Date.parse(raw);
  } else return null;
  const precision = fraction === undefined ? 1000 : 10 ** (3 - fraction.length);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? { milliseconds, precision } : null;
}
export function conflictComparison(detail: LedgerConflictDetail) {
  const incoming = detail.incoming_event; const existing = detail.existing_ledger_entry;
  const direction = comparisonDirection(incoming?.direction_text);
  const time = comparisonTime(incoming?.occurred_at_text);
  const precisionText = (precision: number) => precision === 1000 ? "1 秒" : precision + " 毫秒";
  return [
    { name: "交易金额", incoming: incoming?.amount_text, existing: existing ? money(existing.amount_cents) : null, differs: existing ? comparisonAmount(incoming?.amount_text) !== existing.amount_cents : detail.conflict.conflict_type === "INVALID_AMOUNT" },
    { name: "收支方向", incoming: direction === "CREDIT" ? "收入" : direction === "DEBIT" ? "支出" : incoming?.direction_text, existing: existing ? existing.direction === "CREDIT" ? "收入" : "支出" : null, differs: existing ? direction !== existing.direction : detail.conflict.conflict_type === "INVALID_DIRECTION" },
    { name: "交易时间", incoming: incoming?.occurred_at_text, existing: existing ? detailTimestamp(existing.occurred_at) : null, differs: existing ? time?.milliseconds !== Date.parse(existing.occurred_at) : detail.conflict.conflict_type === "INVALID_TIMESTAMP" },
    ...(time && existing ? [{ name: "时间精度", incoming: precisionText(time.precision), existing: precisionText(existing.occurred_at_precision_milliseconds), differs: time.precision !== existing.occurred_at_precision_milliseconds }] : []),
    { name: "外部流水号", incoming: incoming?.external_event_id, existing: existing?.external_event_id, differs: existing ? incoming?.external_event_id !== existing.external_event_id : detail.conflict.conflict_type === "MISSING_EXTERNAL_ID" },
    { name: "支付宝订单号", incoming: incoming?.alipay_order_no, existing: existing?.alipay_order_no, differs: !!existing && incoming?.alipay_order_no !== existing.alipay_order_no },
    { name: "商户订单号", incoming: incoming?.merchant_order_no, existing: existing?.merchant_order_no, differs: !!existing && incoming?.merchant_order_no !== existing.merchant_order_no },
    { name: "交易对方", incoming: incoming?.other_account, existing: existing?.other_account, differs: !!existing && incoming?.other_account !== existing.other_account },
    { name: "交易备注", incoming: incoming?.trans_memo, existing: existing?.trans_memo, differs: !!existing && incoming?.trans_memo !== existing.trans_memo },
  ].filter(row => row.incoming || row.existing || row.differs);
}
