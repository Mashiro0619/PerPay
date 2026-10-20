// SPDX-License-Identifier: MIT
// Fictional display identities for the disposable, read-only preview only.

// Source namespaces: ordinary/lifecycle, financial, notification, ledger-query cases.
export type PreviewIdentitySeries = 10 | 20 | 30 | 40;

const BEIJING_OFFSET = 8 * 3_600_000;
const PAYERS = [
  "陈*安", "林*宁", "周*晴", "吴*帆", "王*涵", "赵*航",
  "许*言", "沈*然", "徐*悦", "宋*予", "唐*琳", "何*辰",
  "郑*昕", "苏*禾", "蒋*宇", "韩*彤", "程*远", "叶*瑶",
  "陆*文", "顾*嘉", "邓*晨", "梁*清", "方*妍", "谢*舟",
] as const;

function sequenceDigits(sequence: number, width: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("Preview identity sequence must be between 1 and 999999");
  }
  return String(sequence).padStart(width, "0");
}

function identityParts(now: number, series: PreviewIdentitySeries) {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Preview identity time is invalid");
  if (![10, 20, 30, 40].includes(series)) throw new RangeError("Preview identity series is invalid");
  const stamp = new Date(now + BEIJING_OFFSET).toISOString().slice(0, 19).replace(/\D/g, "");
  if (stamp.length !== 14) throw new RangeError("Preview identity time must have a four-digit year");
  return { stamp, series: String(series) };
}

/** Beijing creation time + source series + business sequence; always kept as a string. */
export function previewOrderNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return identity.stamp + identity.series + sequenceDigits(sequence, 6);
}

export function previewLedgerNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return identity.stamp + identity.series + sequenceDigits(sequence, 8);
}

export function previewTradeNumber(now: number, sequence: number, series: PreviewIdentitySeries = 10): string {
  const identity = identityParts(now, series);
  return identity.stamp.slice(0, 8) + "2200" + identity.series + identity.stamp.slice(8) + sequenceDigits(sequence, 8);
}

/** Masked, invented payer names repeat deterministically without referring to real accounts. */
export function previewPayer(sequence: number): string {
  sequenceDigits(sequence, 6);
  return PAYERS[(sequence - 1) % PAYERS.length]!;
}
