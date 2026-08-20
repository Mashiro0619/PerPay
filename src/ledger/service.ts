import { createHash } from "node:crypto";

import {
  AlipayProviderError,
  type AccountLogPage,
  type AccountLogPageRequest,
  type LedgerProvider,
} from "../infrastructure/alipay/index.ts";
import {
  LEDGER_CURSOR_DEFAULT_OVERLAP_MILLISECONDS,
  parseOccurredAt,
  type IngestRun,
  type IngestSegment,
  type LedgerCursor,
} from "./model.ts";
import { LedgerStore } from "./store.ts";

const DEFAULT_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const DEFAULT_SAFETY_LAG_MILLISECONDS = 10 * 1000;
const DEFAULT_MAX_REQUESTS_PER_RUN = 1_000;

export interface LedgerIngestServiceOptions {
  readonly provider: LedgerProvider;
  readonly store: LedgerStore;
  readonly providerAccountKey?: string;
  readonly pageSize: number;
  readonly overlapMilliseconds?: number;
  readonly windowMilliseconds?: number;
  readonly safetyLagMilliseconds?: number;
  readonly maxRequestsPerRun?: number;
  readonly initialWindowStartMilliseconds?: number;
  readonly clock?: () => number;
}

export interface LedgerScanResult {
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";
  readonly reason: string;
  readonly ingestRunId: string | null;
  readonly pages: number;
  readonly details: number;
  readonly createdEntries: number;
  readonly duplicateEntries: number;
  readonly isolatedDetails: number;
  readonly conflicts: number;
  readonly errorCode: string | null;
}

/**
 * Durable segment-at-a-time scanner. Every request reads page one; oversized
 * windows are split into complete time slices, and failures leave the active
 * window incomplete so a later run can rebuild or resume it without offsets.
 */
export class LedgerIngestService {
  readonly #provider: LedgerProvider;
  readonly #store: LedgerStore;
  readonly #providerAccountKey: string | undefined;
  readonly #pageSize: number;
  readonly #overlapMilliseconds: number;
  readonly #windowMilliseconds: number;
  readonly #safetyLagMilliseconds: number;
  readonly #maxRequestsPerRun: number;
  readonly #initialWindowStartMilliseconds: number | undefined;
  readonly #clock: () => number;
  #inFlight: Promise<LedgerScanResult> | null = null;
  #abortController: AbortController | null = null;

  constructor(options: LedgerIngestServiceOptions) {
    this.#provider = options.provider;
    this.#store = options.store;
    this.#providerAccountKey = options.providerAccountKey;
    this.#pageSize = options.pageSize;
    this.#overlapMilliseconds = options.overlapMilliseconds ?? LEDGER_CURSOR_DEFAULT_OVERLAP_MILLISECONDS;
    this.#windowMilliseconds = options.windowMilliseconds ?? DEFAULT_WINDOW_MILLISECONDS;
    this.#safetyLagMilliseconds = options.safetyLagMilliseconds ?? DEFAULT_SAFETY_LAG_MILLISECONDS;
    this.#maxRequestsPerRun = options.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN;
    this.#initialWindowStartMilliseconds = options.initialWindowStartMilliseconds;
    this.#clock = options.clock ?? (() => Date.now());
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 2_000) {
      throw new RangeError("ledger scanner page size is invalid");
    }
    if (!Number.isSafeInteger(this.#overlapMilliseconds) || this.#overlapMilliseconds < 0) {
      throw new RangeError("ledger scanner overlap is invalid");
    }
    if (!Number.isSafeInteger(this.#windowMilliseconds) || this.#windowMilliseconds < 60_000) {
      throw new RangeError("ledger scanner window is invalid");
    }
    if (!Number.isSafeInteger(this.#safetyLagMilliseconds) || this.#safetyLagMilliseconds < 0) {
      throw new RangeError("ledger scanner safety lag is invalid");
    }
    if (
      !Number.isSafeInteger(this.#maxRequestsPerRun) ||
      this.#maxRequestsPerRun < 1 ||
      this.#maxRequestsPerRun > 100_000
    ) {
      throw new RangeError("ledger scanner request budget is invalid");
    }
    if (
      this.#initialWindowStartMilliseconds !== undefined &&
      (!Number.isSafeInteger(this.#initialWindowStartMilliseconds) ||
        this.#initialWindowStartMilliseconds < 0)
    ) {
      throw new RangeError("ledger scanner initial window start is invalid");
    }
  }

  /** Repeated scheduler ticks share one provider scan rather than overlap. */
  run(reason = "scheduled"): Promise<LedgerScanResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reason)) {
      return Promise.reject(new RangeError("ledger scan reason is invalid"));
    }
    if (this.#inFlight) return this.#inFlight;
    this.#abortController = new AbortController();
    this.#inFlight = this.#run(reason, this.#abortController.signal).finally(() => {
      this.#inFlight = null;
      this.#abortController = null;
    });
    return this.#inFlight;
  }

  stop(): void {
    this.#abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.#inFlight;
  }

  get inFlight(): boolean {
    return this.#inFlight !== null;
  }

  cursor(): LedgerCursor | null {
    return this.#store.getCursor(this.#providerAccountKey);
  }

  async #run(reason: string, signal: AbortSignal): Promise<LedgerScanResult> {
    const now = safeNow(this.#clock());
    const cursor = this.#store.getCursor(this.#providerAccountKey);
    const window = chooseWindow(
      cursor,
      now,
      this.#windowMilliseconds,
      this.#safetyLagMilliseconds,
      this.#initialWindowStartMilliseconds,
    );
    if (window === null) {
      return emptyResult("SKIPPED", reason);
    }

    let run: IngestRun;
    try {
      run = this.#store.startIngestRun({
        start: window.start,
        end: window.end,
        ...(this.#providerAccountKey === undefined
          ? {}
          : { providerAccountKey: this.#providerAccountKey }),
        pageSize: this.#pageSize,
        overlapMilliseconds: this.#overlapMilliseconds,
        now,
      });
    } catch (error) {
      return {
        ...emptyResult("FAILED", reason),
        errorCode: errorCode(error),
      };
    }

    let pages = 0;
    let details = 0;
    let createdEntries = 0;
    let duplicateEntries = 0;
    let isolatedDetails = 0;
    let conflicts = 0;
    let activeSegment: IngestSegment | null = null;

    try {
      while (pages < this.#maxRequestsPerRun) {
        if (signal.aborted) throw abortError();
        activeSegment = this.#store.getNextPendingSegment(run.ingestRunId);
        if (activeSegment === null) {
          throw new Error("running ledger ingest has no pending segment");
        }
        const request: AccountLogPageRequest = {
          startTime: activeSegment.windowStart,
          endTime: activeSegment.windowEnd,
          pageNo: 1,
          pageSize: run.pageSize,
          signal,
        };
        const page = await this.#provider.queryPage(request);
        pages += 1;
        validateSegmentPage(page, activeSegment, run.pageSize);
        const recorded = this.#store.recordSegmentPage({
          ingestRunId: run.ingestRunId,
          ingestSegmentId: activeSegment.ingestSegmentId,
          page,
          now: safeNow(this.#clock()),
        });
        if (recorded.kind === "variant") {
          return {
            status: "FAILED",
            reason,
            ingestRunId: run.ingestRunId,
            pages,
            details,
            createdEntries,
            duplicateEntries,
            isolatedDetails,
            conflicts,
            errorCode: "pagination_variant",
          };
        }
        if (recorded.kind === "density_exceeded") {
          return {
            status: "FAILED",
            reason,
            ingestRunId: run.ingestRunId,
            pages,
            details,
            createdEntries,
            duplicateEntries,
            isolatedDetails,
            conflicts,
            errorCode: "pagination_density_exceeded",
          };
        }
        if (recorded.kind === "split") continue;

        details += page.details.length;
        for (const result of recorded.normalized) {
          if (result.kind === "created") createdEntries += 1;
          else if (result.kind === "duplicate") duplicateEntries += 1;
          else if (result.kind === "isolated") isolatedDetails += 1;
          else conflicts += 1;
        }
        if (recorded.rootCompleted) {
          return {
            status: "COMPLETED",
            reason,
            ingestRunId: run.ingestRunId,
            pages,
            details,
            createdEntries,
            duplicateEntries,
            isolatedDetails,
            conflicts,
            errorCode: null,
          };
        }
      }

      return {
        status: "PARTIAL",
        reason,
        ingestRunId: run.ingestRunId,
        pages,
        details,
        createdEntries,
        duplicateEntries,
        isolatedDetails,
        conflicts,
        errorCode: "request_budget_exhausted",
      };
    } catch (error) {
      const aborted = signal.aborted;
      const providerError = error instanceof AlipayProviderError ? error : null;
      const code = aborted ? "scan_aborted" : providerError?.code ?? errorCode(error);
      try {
        const evidence =
          providerError?.status === null ||
          providerError?.status === undefined ||
          providerError.rawBody === null
            ? undefined
            : {
                httpStatus: providerError.status,
                headers: providerError.responseHeaders ?? {},
                body: providerError.rawBody,
                traceId: providerError.traceId,
                signatureVerified: providerError.signatureVerified,
              };
        const errorDetails = {
          reason,
          pages,
          details,
          ingest_segment_id: activeSegment?.ingestSegmentId ?? null,
          segment_start: activeSegment?.windowStart ?? null,
          segment_end: activeSegment?.windowEnd ?? null,
          trace_id: boundedDiagnostic(providerError?.traceId ?? null, 256),
          status: providerError?.status ?? null,
          ...responseDigest(providerError?.rawBody ?? null),
        };
        const errorInput = {
          ingestRunId: run.ingestRunId,
          pageNo: 1,
          errorKind: aborted ? "aborted" : providerError?.kind ?? "internal",
          errorCode: code,
          retryable: aborted || providerError?.retryable !== false,
          details: errorDetails,
          now: safeNow(this.#clock()),
        } as const;
        try {
          this.#store.recordIngestError({
            ...errorInput,
            ...(evidence === undefined ? {} : { evidence }),
          });
        } catch (persistenceError) {
          if (evidence === undefined) throw persistenceError;
          this.#store.recordIngestError({
            ...errorInput,
            details: {
              ...errorDetails,
              evidence_omitted: true,
              evidence_error: persistenceError instanceof Error
                ? persistenceError.name
                : "unknown_error",
            },
          });
        }
      } catch {
        // Preserve the original scan failure; the store's startup integrity
        // checks will surface a failure to persist the diagnostic itself.
      }
      return {
        status: "FAILED",
        reason,
        ingestRunId: run.ingestRunId,
        pages,
        details,
        createdEntries,
        duplicateEntries,
        isolatedDetails,
        conflicts,
        errorCode: code,
      };
    }
  }
}

interface ScanWindow {
  readonly start: string;
  readonly end: string;
}

function chooseWindow(
  cursor: LedgerCursor | null,
  now: number,
  windowMilliseconds: number,
  safetyLagMilliseconds: number,
  initialWindowStartMilliseconds?: number,
): ScanWindow | null {
  const endMilliseconds = now - safetyLagMilliseconds;
  if (!Number.isSafeInteger(endMilliseconds) || endMilliseconds <= 0) return null;
  if (cursor && !cursor.complete) {
    return { start: cursor.windowStart, end: cursor.windowEnd };
  }
  const previousEnd = cursor ? parseShanghai(cursor.windowEnd) : null;
  if (previousEnd !== null && !Number.isSafeInteger(previousEnd)) {
    throw new Error("durable ledger cursor contains an invalid window end");
  }
  const anchor = previousEnd === null ? null : Math.min(previousEnd, endMilliseconds);
  const boundedEndMilliseconds = anchor === null
    ? endMilliseconds
    : Math.min(endMilliseconds, anchor + windowMilliseconds);
  const boundedEnd = formatShanghai(boundedEndMilliseconds);
  const startMilliseconds = anchor === null
    ? Math.max(
        boundedEndMilliseconds - windowMilliseconds,
        initialWindowStartMilliseconds ?? 0,
      )
    : anchor - cursor!.overlapMilliseconds;
  const start = formatShanghai(Math.max(0, startMilliseconds));
  if (start >= boundedEnd) return null;
  return { start, end: boundedEnd };
}

function validateSegmentPage(
  page: AccountLogPage,
  segment: IngestSegment,
  pageSize: number,
): void {
  if (!page || typeof page !== "object" || !Array.isArray(page.details)) {
    throw segmentPageError(page, "provider returned an invalid segment page");
  }
  if (
    page.pageNo !== 1 ||
    page.pageSize !== pageSize ||
    !Number.isSafeInteger(page.totalSize) ||
    page.totalSize < 0 ||
    typeof page.hasMore !== "boolean"
  ) {
    throw segmentPageError(page, "provider returned invalid segment page metadata");
  }
  const expectedDetailCount = Math.min(pageSize, page.totalSize);
  const expectedHasMore = page.totalSize > pageSize;
  if (page.details.length !== expectedDetailCount || page.hasMore !== expectedHasMore) {
    throw segmentPageError(page, "provider returned an inconsistent single-page segment");
  }
  const raw = page.rawResponse as unknown as Record<string, unknown> | null;
  if (
    !raw ||
    raw.signatureVerified !== true ||
    typeof raw.status !== "number" ||
    !Number.isInteger(raw.status) ||
    raw.status < 200 ||
    raw.status >= 300 ||
    typeof raw.body !== "string" ||
    !raw.headers ||
    typeof raw.headers !== "object" ||
    Array.isArray(raw.headers) ||
    typeof raw.traceId !== "string" ||
    raw.traceId !== page.traceId
  ) {
    throw segmentPageError(page, "provider returned a segment without verified evidence");
  }

  const eventIds = new Set<string>();
  const segmentStart = parseOccurredAt(segment.windowStart);
  const segmentEnd = parseOccurredAt(segment.windowEnd);
  for (const detail of page.details) {
    if (detail.accountLogId !== null) {
      if (eventIds.has(detail.accountLogId)) {
        throw segmentPageError(page, "provider repeated an account-log identifier within a segment");
      }
      eventIds.add(detail.accountLogId);
    }
    if (detail.occurredAt === null) continue;
    let occurredAt: number;
    try {
      occurredAt = parseOccurredAt(detail.occurredAt);
    } catch {
      continue;
    }
    if (occurredAt < segmentStart || occurredAt > segmentEnd) {
      throw segmentPageError(page, "provider returned an event outside the requested segment");
    }
  }
}

function segmentPageError(page: AccountLogPage | null | undefined, message: string): AlipayProviderError {
  const raw = page && typeof page === "object"
    ? page.rawResponse as unknown as Record<string, unknown> | null
    : null;
  const status = raw && typeof raw.status === "number" && Number.isInteger(raw.status)
    ? raw.status
    : undefined;
  const traceId = page && typeof page.traceId === "string" && page.traceId.length > 0
    ? page.traceId
    : undefined;
  const rawBody = raw && (typeof raw.body === "string" || raw.body instanceof Uint8Array)
    ? raw.body
    : undefined;
  const responseHeaders = raw && raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
    ? raw.headers as Readonly<Record<string, string | readonly string[]>>
    : undefined;
  const signatureVerified = raw?.signatureVerified === true
    ? true
    : raw?.signatureVerified === false ? false : null;
  return new AlipayProviderError({
    kind: "transient",
    code: "pagination_invalid",
    message,
    signatureVerified,
    ...(status === undefined ? {} : { status }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(rawBody === undefined ? {} : { rawBody }),
    ...(responseHeaders === undefined ? {} : { responseHeaders }),
  });
}

function formatShanghai(milliseconds: number): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(milliseconds));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function parseShanghai(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) -
    8 * 60 * 60 * 1000;
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("ledger scanner clock is invalid");
  return value;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "scan_aborted";
  return "scan_failed";
}

function abortError(): Error {
  const error = new Error("ledger scan was aborted");
  error.name = "AbortError";
  return error;
}

function boundedDiagnostic(value: string | null, maximum: number): string | null {
  if (value === null || value.length < 1 || value.length > maximum || value.includes("\0")) {
    return null;
  }
  return value;
}

function responseDigest(body: string | Uint8Array | null): Record<string, unknown> {
  if (body === null) return {};
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return {
    response_body_bytes: bytes.byteLength,
    response_body_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function emptyResult(status: LedgerScanResult["status"], reason: string): LedgerScanResult {
  return {
    status,
    reason,
    ingestRunId: null,
    pages: 0,
    details: 0,
    createdEntries: 0,
    duplicateEntries: 0,
    isolatedDetails: 0,
    conflicts: 0,
    errorCode: null,
  };
}
