import { createHash } from "node:crypto";

import type { AccountLogDetail, AccountLogPage } from "../infrastructure/alipay/types.ts";

export const LEDGER_PROVIDER_ACCOUNT_KEY = "primary" as const;
export const LEDGER_PROVIDER_KIND = "alipay" as const;
export const LEDGER_PROVIDER_IDENTITY_FINGERPRINT_VERSION = 1 as const;
export const LEDGER_CURSOR_DEFAULT_OVERLAP_MILLISECONDS = 5 * 60 * 1000;
export const LEDGER_CURSOR_MAX_OVERLAP_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const LEDGER_MAX_PAGE_SIZE = 2_000;
export const LEDGER_MAX_RAW_PAGE_BYTES = 2 * 1024 * 1024;
export const LEDGER_MAX_RAW_EVENT_BYTES = 512 * 1024;

export type LedgerDirection = "CREDIT" | "DEBIT";
export type LedgerEntryState =
  | "UNALLOCATED"
  | "CANDIDATE"
  | "ALLOCATED"
  | "CONFLICT"
  | "ISOLATED"
  | "IGNORED";
export type IngestRunStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
export type IngestSegmentState = "PENDING" | "SPLIT" | "COMPLETE";
export type SegmentObservationKind = "OVERSIZED_PROBE" | "ACCEPTED_LEAF";
export type LedgerConflictType =
  | "RAW_PAGE_VARIANT"
  | "DUPLICATE_EXTERNAL_ID"
  | "MISSING_EXTERNAL_ID"
  | "INVALID_AMOUNT"
  | "INVALID_TIMESTAMP"
  | "INVALID_DIRECTION"
  | "INVALID_SHAPE";

export interface ProviderIdentityInput {
  readonly providerAccountKey?: string;
  readonly providerKind: typeof LEDGER_PROVIDER_KIND;
  readonly endpoint: string;
  readonly externalAccountId: string;
}

export interface ProviderIdentity {
  readonly providerAccountKey: typeof LEDGER_PROVIDER_ACCOUNT_KEY;
  readonly providerKind: typeof LEDGER_PROVIDER_KIND;
  readonly endpoint: string;
  readonly externalAccountId: string;
  readonly identityFingerprintVersion: typeof LEDGER_PROVIDER_IDENTITY_FINGERPRINT_VERSION;
  readonly identityFingerprint: string;
}

export interface ProviderIdentityBinding extends ProviderIdentity {
  readonly boundAt: number;
}

export interface LedgerWindow {
  readonly start: string;
  readonly end: string;
}

export interface LedgerCursor {
  readonly providerAccountKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly nextPageNo: number | null;
  readonly pageSize: number;
  readonly expectedTotalSize: number | null;
  readonly overlapMilliseconds: number;
  readonly complete: boolean;
  readonly lastEventOccurredAt: number | null;
  readonly lastCompletedAt: number | null;
  readonly updatedAt: number;
  readonly version: number;
}

export interface StartIngestRunInput extends LedgerWindow {
  readonly providerAccountKey?: string;
  readonly pageSize: number;
  readonly overlapMilliseconds?: number;
  readonly now?: number;
}

export interface IngestRun {
  readonly ingestRunId: string;
  readonly providerAccountKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly pageSize: number;
  readonly status: IngestRunStatus;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly pagesReceived: number;
  readonly detailsReceived: number;
  readonly failureCode: string | null;
}

export interface IngestSegment {
  readonly ingestSegmentId: string;
  readonly ingestRunId: string;
  readonly parentSegmentId: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly depth: number;
  readonly state: IngestSegmentState;
  readonly splitAt: string | null;
  readonly acceptedRawPageId: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export interface RawPageEvidence {
  readonly httpStatus: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** Exact response bytes. A string is encoded as UTF-8 without normalization. */
  readonly body: string | Uint8Array;
  readonly traceId: string | null;
  readonly signatureVerified: boolean;
}

export interface RawErrorEvidence extends Omit<RawPageEvidence, "signatureVerified"> {
  /** Null means the response was retained but signature verification was not attempted. */
  readonly signatureVerified: boolean | null;
}

export interface RecordLedgerPageInput {
  readonly ingestRunId: string;
  readonly page: AccountLogPage | AccountLogPageInput;
  readonly evidence?: RawPageEvidence;
  readonly now?: number;
}

export interface RecordSegmentPageInput extends RecordLedgerPageInput {
  readonly ingestSegmentId: string;
}

export interface AccountLogPageInput {
  readonly pageNo: number;
  readonly pageSize: number;
  readonly totalSize: number;
  readonly hasMore: boolean;
  readonly details: readonly AccountLogDetail[];
}

export interface RawPageRecord {
  readonly rawPageId: string;
  readonly ingestRunId: string;
  readonly providerAccountKey: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly pageNo: number;
  readonly pageSize: number;
  readonly totalSize: number;
  readonly hasMore: boolean;
  readonly requestFingerprint: string;
  readonly responseFingerprint: string;
  readonly httpStatus: number;
  readonly signatureVerified: boolean;
  readonly traceId: string | null;
  readonly receivedAt: number;
}

export interface RawEventRecord {
  readonly rawEventId: string;
  readonly rawPageId: string;
  readonly providerAccountKey: string;
  readonly ordinal: number;
  readonly externalEventId: string | null;
  readonly payloadFingerprint: string;
  readonly observedAt: number;
}

export interface LedgerEntry {
  readonly ledgerEntryId: string;
  readonly providerAccountKey: string;
  readonly rawEventId: string;
  readonly externalEventId: string;
  readonly semanticFingerprint: string;
  readonly occurredAt: number;
  readonly occurredAtPrecisionMilliseconds: 1 | 10 | 100 | 1_000;
  readonly amountCents: number;
  readonly direction: LedgerDirection;
  readonly currency: "CNY";
  readonly alipayOrderNo: string | null;
  readonly merchantOrderNo: string | null;
  readonly transMemo: string | null;
  readonly otherAccount: string | null;
  readonly state: LedgerEntryState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LedgerConflict {
  readonly conflictId: string;
  readonly providerAccountKey: string;
  readonly conflictType: LedgerConflictType;
  readonly rawPageId: string | null;
  readonly rawEventId: string | null;
  readonly existingLedgerEntryId: string | null;
  readonly externalEventId: string | null;
  readonly existingSemanticFingerprint: string | null;
  readonly incomingSemanticFingerprint: string | null;
  readonly details: Record<string, unknown>;
  readonly status: "OPEN" | "RESOLVED" | "IGNORED";
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly conflictFingerprint: string;
}

export type RecordPageResult =
  | {
      readonly kind: "inserted";
      readonly page: RawPageRecord;
      readonly normalized: readonly PageNormalizationResult[];
      readonly cursor: LedgerCursor;
    }
  | {
      readonly kind: "duplicate";
      readonly page: RawPageRecord;
      readonly normalized: readonly PageNormalizationResult[];
      readonly cursor: LedgerCursor;
    }
  | {
      readonly kind: "variant";
      readonly page: RawPageRecord;
      readonly normalized: readonly PageNormalizationResult[];
      readonly cursor: LedgerCursor;
    };

export type RecordSegmentPageResult =
  | {
      readonly kind: "split";
      readonly observation: "inserted" | "duplicate" | "variant";
      readonly page: RawPageRecord;
      readonly segment: IngestSegment;
      readonly children: readonly [IngestSegment, IngestSegment];
      readonly normalized: readonly [];
      readonly cursor: LedgerCursor;
      readonly run: IngestRun;
    }
  | {
      readonly kind: "density_exceeded";
      readonly observation: "inserted" | "duplicate" | "variant";
      readonly page: RawPageRecord;
      readonly segment: IngestSegment;
      readonly children: readonly [];
      readonly normalized: readonly [];
      readonly cursor: LedgerCursor;
      readonly run: IngestRun;
    }
  | {
      readonly kind: "accepted";
      readonly observation: "inserted" | "duplicate" | "variant";
      readonly page: RawPageRecord;
      readonly segment: IngestSegment;
      readonly children: readonly [];
      readonly normalized: readonly PageNormalizationResult[];
      readonly cursor: LedgerCursor;
      readonly run: IngestRun;
      readonly rootCompleted: boolean;
    };

export type PageNormalizationResult =
  | { readonly kind: "created"; readonly entry: LedgerEntry; readonly rawEventId: string }
  | { readonly kind: "duplicate"; readonly entry: LedgerEntry; readonly rawEventId: string }
  | { readonly kind: "conflict"; readonly conflict: LedgerConflict; readonly rawEventId: string }
  | { readonly kind: "isolated"; readonly conflict: LedgerConflict; readonly rawEventId: string };

export interface IngestErrorInput {
  readonly ingestRunId: string;
  readonly pageNo?: number;
  readonly errorKind: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly evidence?: RawErrorEvidence;
  readonly details?: Record<string, unknown>;
  readonly now?: number;
}

export interface CompleteIngestRunInput {
  readonly ingestRunId: string;
  readonly status?: "COMPLETED" | "PARTIAL";
  readonly now?: number;
}

export interface LedgerListFilter {
  readonly providerAccountKey?: string;
  readonly state?: LedgerEntryState;
  readonly direction?: LedgerDirection;
  readonly amountCents?: number;
  readonly occurredFrom?: number;
  readonly occurredUntil?: number;
  readonly limit?: number;
}

export function normalizeProviderAccountKey(value: string | undefined): string {
  const account = value ?? LEDGER_PROVIDER_ACCOUNT_KEY;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account)) {
    throw new RangeError("provider account key is invalid");
  }
  return account;
}

/** Canonical, secret-independent identity used to bind the logical ledger namespace. */
export function normalizeProviderIdentity(input: ProviderIdentityInput): ProviderIdentity {
  const providerAccountKey = normalizeProviderAccountKey(input.providerAccountKey);
  if (providerAccountKey !== LEDGER_PROVIDER_ACCOUNT_KEY) {
    throw new RangeError("provider identity can only bind the primary account");
  }
  if (input.providerKind !== LEDGER_PROVIDER_KIND) {
    throw new RangeError("provider identity kind is invalid");
  }
  const endpoint = normalizeIdentityEndpoint(input.endpoint);
  const externalAccountId = normalizeExternalAccountId(input.externalAccountId);
  const identityFingerprint = sha256(JSON.stringify({
    schema: "perpay:provider-identity:v1",
    provider_account_key: providerAccountKey,
    provider_kind: input.providerKind,
    endpoint,
    external_account_id: externalAccountId,
  }));
  return {
    providerAccountKey,
    providerKind: input.providerKind,
    endpoint,
    externalAccountId,
    identityFingerprintVersion: LEDGER_PROVIDER_IDENTITY_FINGERPRINT_VERSION,
    identityFingerprint,
  };
}

export function providerIdentityFingerprint(input: ProviderIdentityInput): string {
  return normalizeProviderIdentity(input).identityFingerprint;
}

export function validateWindow(window: LedgerWindow): void {
  if (!isProviderTimestamp(window.start) || !isProviderTimestamp(window.end)) {
    throw new RangeError("ledger window is invalid");
  }
  if (window.start >= window.end) {
    throw new RangeError("ledger window start must be earlier than its end");
  }
}

export function splitLedgerWindow(window: LedgerWindow): {
  readonly splitAt: string;
  readonly left: LedgerWindow;
  readonly right: LedgerWindow;
} | null {
  validateWindow(window);
  const start = parseOccurredAt(window.start);
  const end = parseOccurredAt(window.end);
  if (end - start <= 1_000) return null;
  const midpoint = Math.floor((start + end) / 2_000) * 1_000;
  if (midpoint <= start || midpoint >= end) return null;
  const splitAt = formatProviderTimestamp(midpoint);
  return {
    splitAt,
    left: { start: window.start, end: splitAt },
    right: { start: splitAt, end: window.end },
  };
}

/**
 * Returns a provider-formatted lower bound for a compensating overlap scan.
 * Provider account-log timestamps without an explicit offset use China
 * Standard Time, matching `parseOccurredAt` above. The returned bound never
 * precedes Unix epoch and is deterministic across host time zones.
 */
export function rewindProviderWindowStart(
  windowStart: string,
  overlapMilliseconds: number,
  lastEventOccurredAt: number | null = null,
): string {
  validateOverlapMilliseconds(overlapMilliseconds);
  const start = parseOccurredAt(windowStart);
  const pivot = lastEventOccurredAt ?? start;
  if (!Number.isSafeInteger(pivot) || pivot < 0) throw new RangeError("ledger overlap pivot is invalid");
  const rewound = Math.max(0, pivot - overlapMilliseconds);
  const local = new Date(rewound + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

export function validatePageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > LEDGER_MAX_PAGE_SIZE) {
    throw new RangeError("ledger page size is invalid");
  }
}

export function validateOverlapMilliseconds(overlap: number): void {
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap > LEDGER_CURSOR_MAX_OVERLAP_MILLISECONDS) {
    throw new RangeError("ledger overlap is invalid");
  }
}

export function requestFingerprint(
  providerAccountKey: string,
  windowStart: string,
  windowEnd: string,
  pageNo: number,
  pageSize: number,
): string {
  return sha256(
    JSON.stringify([
      "perpay:ledger-request:v1",
      providerAccountKey,
      windowStart,
      windowEnd,
      pageNo,
      pageSize,
    ]),
  );
}

export function responseFingerprint(body: string | Uint8Array): string {
  return sha256(toBytes(body));
}

export function payloadFingerprint(payload: string | Uint8Array): string {
  return sha256(toBytes(payload));
}

export function conflictFingerprint(parts: readonly unknown[]): string {
  return sha256(JSON.stringify(["perpay:ledger-conflict:v1", ...parts]));
}

export interface SemanticFingerprintFacts {
  readonly externalEventId: string;
  readonly occurredAt: number;
  readonly amountCents: number;
  readonly direction: LedgerDirection;
  readonly currency?: "CNY";
  readonly alipayOrderNo: string | null;
  readonly merchantOrderNo: string | null;
  readonly transMemo: string | null;
  readonly otherAccount: string | null;
}

/**
 * The v4 ledger did not persist timestamp precision. Keep its identity
 * algorithm available solely for validating and backing up those databases.
 */
export function legacySemanticFingerprintV1(input: SemanticFingerprintFacts): string {
  return sha256(
    JSON.stringify([
      "perpay:ledger-semantic:v1",
      input.externalEventId,
      input.occurredAt,
      input.amountCents,
      input.direction,
      input.currency ?? "CNY",
      input.alipayOrderNo,
      input.merchantOrderNo,
      input.transMemo,
      input.otherAccount,
    ]),
  );
}

export function semanticFingerprint(input: SemanticFingerprintFacts & {
  readonly occurredAtPrecisionMilliseconds: 1 | 10 | 100 | 1_000;
}): string {
  return sha256(
    JSON.stringify([
      "perpay:ledger-semantic:v2",
      input.externalEventId,
      input.occurredAt,
      input.occurredAtPrecisionMilliseconds,
      input.amountCents,
      input.direction,
      input.currency ?? "CNY",
      input.alipayOrderNo,
      input.merchantOrderNo,
      input.transMemo,
      input.otherAccount,
    ]),
  );
}

export function parseAmountCents(value: string | null): number {
  if (value === null) throw new LedgerNormalizationError("INVALID_AMOUNT", "amount is missing");
  const text = value.trim();
  const match = /^[+-]?(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match) throw new LedgerNormalizationError("INVALID_AMOUNT", "amount is not a supported CNY decimal");
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = whole * 100 + Number(fraction || 0);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 999_999_999_999) {
    throw new LedgerNormalizationError("INVALID_AMOUNT", "amount is outside the supported range");
  }
  return cents;
}

function isProviderTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  try {
    parseOccurredAt(value);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedOccurredAt {
  readonly milliseconds: number;
  readonly precisionMilliseconds: 1 | 10 | 100 | 1_000;
}

export function parseOccurredAtWithPrecision(value: string | null): ParsedOccurredAt {
  if (value === null || value.trim().length === 0) {
    throw new LedgerNormalizationError("INVALID_TIMESTAMP", "occurred time is missing");
  }
  const trimmed = value.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(
    trimmed,
  );
  let milliseconds: number;
  let precisionMilliseconds: ParsedOccurredAt["precisionMilliseconds"];
  if (local) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] =
      local;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const fraction = Number((fractionText ?? "").padEnd(3, "0"));
    const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, fraction));
    if (
      year < 2000 ||
      month < 1 ||
      month > 12 ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day
    ) {
      throw new LedgerNormalizationError("INVALID_TIMESTAMP", "occurred time is invalid");
    }
    // Account-log timestamps without an offset are documented in China Standard Time.
    milliseconds = calendar.getTime() - 8 * 60 * 60 * 1000;
    precisionMilliseconds = precisionFromFraction(fractionText);
  } else if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(trimmed)?.[1];
    if (fraction !== undefined && (fraction.length < 1 || fraction.length > 3)) {
      throw new LedgerNormalizationError(
        "INVALID_TIMESTAMP",
        "occurred time precision exceeds milliseconds",
      );
    }
    milliseconds = Date.parse(trimmed);
    precisionMilliseconds = precisionFromFraction(fraction);
  } else {
    milliseconds = Number.NaN;
    precisionMilliseconds = 1_000;
  }
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    !Number.isSafeInteger(milliseconds + precisionMilliseconds)
  ) {
    throw new LedgerNormalizationError("INVALID_TIMESTAMP", "occurred time is invalid");
  }
  return Object.freeze({ milliseconds, precisionMilliseconds });
}

export function parseOccurredAt(value: string | null): number {
  return parseOccurredAtWithPrecision(value).milliseconds;
}

function precisionFromFraction(
  fraction: string | undefined,
): ParsedOccurredAt["precisionMilliseconds"] {
  if (fraction === undefined) return 1_000;
  if (fraction.length === 1) return 100;
  if (fraction.length === 2) return 10;
  return 1;
}

function formatProviderTimestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) {
    throw new RangeError("provider timestamp is invalid");
  }
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

export function parseDirection(value: string | null): LedgerDirection {
  if (value === null) throw new LedgerNormalizationError("INVALID_DIRECTION", "direction is missing");
  const normalized = value.trim().toUpperCase();
  if (["CREDIT", "IN", "INCOME", "RECEIVE", "RECEIVED", "收入", "收款", "转入"].includes(normalized)) {
    return "CREDIT";
  }
  if (["DEBIT", "OUT", "EXPENSE", "PAY", "PAID", "支出", "付款", "转出"].includes(normalized)) {
    return "DEBIT";
  }
  throw new LedgerNormalizationError("INVALID_DIRECTION", "direction is invalid");
}

export class LedgerNormalizationError extends Error {
  readonly code: Exclude<LedgerConflictType, "RAW_PAGE_VARIANT" | "DUPLICATE_EXTERNAL_ID">;

  constructor(code: Exclude<LedgerConflictType, "RAW_PAGE_VARIANT" | "DUPLICATE_EXTERNAL_ID">, message: string) {
    super(message);
    this.name = "LedgerNormalizationError";
    this.code = code;
  }
}

export function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : new Uint8Array(value);
}

function normalizeIdentityEndpoint(value: string): string {
  if (value !== value.trim() || value.length < 1 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RangeError("provider identity endpoint is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new RangeError("provider identity endpoint is invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new RangeError("provider identity endpoint must be an HTTPS origin");
  }
  return endpoint.origin;
}

function normalizeExternalAccountId(value: string): string {
  if (
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RangeError("provider external account ID is invalid");
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
