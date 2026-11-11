// SPDX-License-Identifier: MIT
// Fictional display identities for the disposable, read-only preview only.

// Source namespaces: ordinary/lifecycle, financial, notification, ledger-query cases.
export type PreviewIdentitySeries = 10 | 20 | 30 | 40;

const BEIJING_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
const PAYER_COUNT = 24;

function sequenceDigits(sequence: number, width: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("Preview identity sequence must be between 1 and 999999");
  }
  return String(sequence).padStart(width, "0");
}

function identityParts(now: number, series: PreviewIdentitySeries) {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Preview identity time is invalid");
  if (![10, 20, 30, 40].includes(series)) throw new RangeError("Preview identity series is invalid");
  const date = new Date(now + BEIJING_OFFSET).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("Preview identity time must have a four-digit year");
  const day = Math.floor((now + BEIJING_OFFSET) / DAY).toString(36).toUpperCase().padStart(3, "0");
  return { day, series: String(series) };
}

/** Compact Beijing day + source series + sequence; visibly synthetic and unique across fixture dates. */
export function previewOrderNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return "DEMO_ORDER_" + identity.series + "_" + identity.day + sequenceDigits(sequence, 6);
}

export function previewLedgerNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return "DEMO_LEDGER_" + identity.series + "_" + identity.day + sequenceDigits(sequence, 6);
}

export function previewTradeNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return "DEMO_TRADE_" + identity.series + "_" + identity.day + sequenceDigits(sequence, 6);
}

/** Numbered fictional people retain the preview's varied, recurring payer identities. */
export function previewPayer(sequence: number): string {
  sequenceDigits(sequence, 6);
  return "示例付款人 " + sequenceDigits((sequence - 1) % PAYER_COUNT + 1, 3);
}

export function previewProductName(value: string): string {
  return value.startsWith("示例商品·") ? value : "示例商品·" + value;
}

export function previewDescription(value: string): string {
  return value.trim() === "" || value.startsWith("示例") ? value : "示例说明：" + value;
}
