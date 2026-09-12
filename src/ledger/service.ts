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
  rewindProviderWindowStart,
  type IngestRun,
  type IngestScanKind,
  type IngestSegment,
  type LedgerCursor,
  type LedgerCompensationState,
} from "./model.ts";
import { LedgerStore } from "./store.ts";

const DEFAULT_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const DEFAULT_SAFETY_LAG_MILLISECONDS = 10 * 1000;
const DEFAULT_MAX_REQUESTS_PER_RUN = 1_000;
const MAX_NORMAL_OVERLAP_MILLISECONDS = 5 * 60 * 1000;
const MIN_NORMAL_OVERLAP_MILLISECONDS = 10 * 1000;
const COMPENSATION_10M_INTERVAL_MILLISECONDS = 60 * 1000;
const COMPENSATION_1H_INTERVAL_MILLISECONDS = 60 * 60 * 1000;
const COMPENSATION_1D_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
const COMPENSATION_10M_LOOKBACK_MILLISECONDS = 10 * 60 * 1000;
const COMPENSATION_1H_LOOKBACK_MILLISECONDS = 6 * 60 * 60 * 1000;
const COMPENSATION_1D_LOOKBACK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** Keeps ordinary scans bounded when a short poll interval is configured. */
export function normalLedgerOverlapMilliseconds(scanIntervalMilliseconds: number): number {
  if (!Number.isSafeInteger(scanIntervalMilliseconds) || scanIntervalMilliseconds < 1_000) {
    throw new RangeError("ledger scan interval is invalid");
  }
  return Math.min(
    MAX_NORMAL_OVERLAP_MILLISECONDS,
    Math.max(MIN_NORMAL_OVERLAP_MILLISECONDS, scanIntervalMilliseconds * 2),
  );
}

export interface LedgerIngestServiceOptions {
  readonly provider: LedgerProvider;
  readonly store: LedgerStore;
  readonly providerAccountKey?: string;
  readonly pageSize: number;
  readonly overlapMilliseconds?: number;
  readonly windowMilliseconds?: number;
  readonly safetyLagMilliseconds?: number;
  readonly scanIntervalMilliseconds?: number;
  /** Capture the current adaptive cadence once per run, including compensation and retries. */
  readonly getScanIntervalMilliseconds?: () => number;
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
  /** Provider-directed delay for a retry, when the scan failed transiently. */
  readonly retryAfterSeconds: number | null;
  /** Whether the failed scan should use the scheduler backoff policy. */
  readonly retryable: boolean;
  /** A normal tail completed even though durable compensation work remains. */
  readonly normalCompleted: boolean;
  /** Returned without contacting the provider because a durable cooldown remains active. */
  readonly cooldownActive: boolean;
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
  readonly #scanIntervalMilliseconds: number;
  readonly #getScanIntervalMilliseconds: (() => number) | undefined;
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
    this.#scanIntervalMilliseconds = options.scanIntervalMilliseconds ?? 10_000;
    this.#getScanIntervalMilliseconds = options.getScanIntervalMilliseconds;
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
      !Number.isSafeInteger(this.#scanIntervalMilliseconds) ||
      this.#scanIntervalMilliseconds < 1_000 ||
      this.#scanIntervalMilliseconds > 3_600_000
    ) {
      throw new RangeError("ledger scanner interval is invalid");
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
    const scheduleState = this.#store.getIngestScheduleState(this.#providerAccountKey);
    if (scheduleState !== null) {
      const scheduleNow = Math.max(now, scheduleState.updatedAt);
      if (scheduleState.cooldownUntil > scheduleNow) {
        return {
          ...emptyResult("FAILED", reason),
          errorCode: scheduleState.lastErrorCode,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((scheduleState.cooldownUntil - scheduleNow) / 1_000),
          ),
          retryable: scheduleState.retryable,
          cooldownActive: true,
        };
      }
    }
    const scanIntervalMilliseconds = this.#getScanIntervalMilliseconds?.() ?? this.#scanIntervalMilliseconds;
    if (!Number.isSafeInteger(scanIntervalMilliseconds) || scanIntervalMilliseconds < 1_000 || scanIntervalMilliseconds > 3_600_000) {
      throw new RangeError("ledger scanner interval is invalid");
    }
    const normalCursor = this.#store.getCursor(this.#providerAccountKey, "NORMAL");
    const compensationCursor = this.#store.getCursor(this.#providerAccountKey, "COMPENSATION");
    const compensationState = this.#store.getCompensationState(this.#providerAccountKey);
    const selected = chooseWindow(
      normalCursor,
      compensationCursor,
      now,
      this.#windowMilliseconds,
      this.#safetyLagMilliseconds,
      scanIntervalMilliseconds,
      this.#initialWindowStartMilliseconds,
      compensationState,
    );
    if (selected === null) {
      return emptyResult("SKIPPED", reason);
    }
    const { window, scanKind } = selected;
    const selectedCursor = scanKind === "NORMAL" ? normalCursor : compensationCursor;
    const effectiveOverlapMilliseconds = selectedCursor && !selectedCursor.complete
      ? selectedCursor.overlapMilliseconds
      : this.#overlapMilliseconds;

    let run: IngestRun;
    try {
      run = this.#store.startIngestRun({
        start: window.start,
        end: window.end,
        ...(this.#providerAccountKey === undefined
          ? {}
          : { providerAccountKey: this.#providerAccountKey }),
        pageSize: this.#pageSize,
        overlapMilliseconds: effectiveOverlapMilliseconds,
        scanKind,
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
      const requestBudget = run.scanKind === "NORMAL"
        ? this.#maxRequestsPerRun
        : Math.min(1, this.#maxRequestsPerRun);
      while (pages < requestBudget) {
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
          retryIntervalMilliseconds: scanIntervalMilliseconds,
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
            retryAfterSeconds: retryAfterSeconds(
              this.#store.getIngestScheduleState(this.#providerAccountKey),
              safeNow(this.#clock()),
            ),
            retryable: true,
            normalCompleted: false,
            cooldownActive: false,
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
            retryAfterSeconds: retryAfterSeconds(
              this.#store.getIngestScheduleState(this.#providerAccountKey),
              safeNow(this.#clock()),
            ),
            retryable: false,
            normalCompleted: false,
            cooldownActive: false,
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
          const completedAt = safeNow(this.#clock());
          const normalCursorAfter = this.#store.getCursor(this.#providerAccountKey, "NORMAL");
          const compensationPending = run.scanKind === "NORMAL" &&
            this.#store.getCursor(this.#providerAccountKey, "COMPENSATION")?.complete === false;
          const normalPending = run.scanKind !== "NORMAL" &&
            normalCursorAfter !== null &&
            normalCursorBehind(normalCursorAfter, completedAt, this.#safetyLagMilliseconds);
          const continuationPending = compensationPending || normalPending;
          return {
            status: continuationPending ? "PARTIAL" : "COMPLETED",
            reason,
            ingestRunId: run.ingestRunId,
            pages,
            details,
            createdEntries,
            duplicateEntries,
            isolatedDetails,
            conflicts,
            errorCode: compensationPending
              ? "compensation_continuation"
              : normalPending ? "normal_continuation" : null,
            retryAfterSeconds: null,
            retryable: false,
            normalCompleted: run.scanKind === "NORMAL",
            cooldownActive: false,
          };
        }
      }

      this.#store.markIngestBatchYield(run.ingestRunId, safeNow(this.#clock()));

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
        retryAfterSeconds: null,
        retryable: false,
        normalCompleted: false,
        cooldownActive: false,
      };
    } catch (error) {
      const aborted = signal.aborted;
      const providerError = error instanceof AlipayProviderError ? error : null;
      const code = aborted ? "scan_aborted" : providerError?.code ?? errorCode(error);
      const retryable = !aborted && providerError !== null && providerError.retryable;
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
          retryable,
          preserveRun: retryable || aborted,
          ...(aborted
            ? {}
            : {
                retrySchedule: {
                  intervalMilliseconds: scanIntervalMilliseconds,
                  retryAfterSeconds: providerError?.retryAfterSeconds ?? null,
                },
              }),
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
        retryAfterSeconds: retryAfterSeconds(
          this.#store.getIngestScheduleState(this.#providerAccountKey),
          safeNow(this.#clock()),
        ) ?? providerError?.retryAfterSeconds ?? null,
        retryable,
        normalCompleted: false,
        cooldownActive: false,
      };
    }
  }
}

interface ScanWindow {
  readonly start: string;
  readonly end: string;
}

interface SelectedScanWindow {
  readonly window: ScanWindow;
  readonly scanKind: IngestScanKind;
}

type CompensationScanKind = Exclude<IngestScanKind, "NORMAL">;

const COMPENSATION_KINDS: readonly {
  readonly kind: CompensationScanKind;
  readonly dueKey: "next10mAt" | "next1hAt" | "next1dAt";
  readonly lookbackMilliseconds: number;
}[] = [
  {
    kind: "COMPENSATION_1D",
    dueKey: "next1dAt",
    lookbackMilliseconds: COMPENSATION_1D_LOOKBACK_MILLISECONDS,
  },
  {
    kind: "COMPENSATION_1H",
    dueKey: "next1hAt",
    lookbackMilliseconds: COMPENSATION_1H_LOOKBACK_MILLISECONDS,
  },
  {
    kind: "COMPENSATION_10M",
    dueKey: "next10mAt",
    lookbackMilliseconds: COMPENSATION_10M_LOOKBACK_MILLISECONDS,
  },
];

function chooseWindow(
  normalCursor: LedgerCursor | null,
  compensationCursor: LedgerCursor | null,
  now: number,
  windowMilliseconds: number,
  safetyLagMilliseconds: number,
  scanIntervalMilliseconds: number,
  initialWindowStartMilliseconds?: number,
  compensationState: LedgerCompensationState | null = null,
): SelectedScanWindow | null {
  const endMilliseconds = now - safetyLagMilliseconds;
  if (!Number.isSafeInteger(endMilliseconds) || endMilliseconds <= 0) return null;
  if (normalCursor && !normalCursor.complete) {
    return {
      window: { start: normalCursor.windowStart, end: normalCursor.windowEnd },
      scanKind: "NORMAL",
    };
  }
  const previousEnd = normalCursor ? parseShanghai(normalCursor.windowEnd) : null;
  if (previousEnd !== null && !Number.isSafeInteger(previousEnd)) {
    throw new Error("durable ledger cursor contains an invalid window end");
  }
  const anchor = previousEnd === null ? null : Math.min(previousEnd, endMilliseconds);
  const boundedEndMilliseconds = anchor === null
    ? endMilliseconds
    : Math.min(endMilliseconds, anchor + windowMilliseconds);
  const boundedEnd = formatShanghai(boundedEndMilliseconds);
  const regularStartMilliseconds = anchor === null
    ? Math.max(
        boundedEndMilliseconds - windowMilliseconds,
        initialWindowStartMilliseconds ?? 0,
      )
    : anchor - normalCursor!.overlapMilliseconds;

  // A provider can expose a transaction after the time window in which it
  // occurred. Use the durable latest observed event only as an extra rewind
  // hint. Compensation scheduling below is independent of this field, so a
  // delayed event cannot be lost merely because no earlier event was seen.
  let startMilliseconds = regularStartMilliseconds;
  if (
    normalCursor &&
    normalCursor.scanKind === "NORMAL" &&
    normalCursor.lastEventOccurredAt !== null &&
    anchor !== null
  ) {
    const cursorStart = parseShanghai(normalCursor.windowStart);
    if (!Number.isSafeInteger(cursorStart)) {
      throw new Error("durable ledger cursor contains an invalid window start");
    }
    const rewound = parseShanghai(
      rewindProviderWindowStart(
        normalCursor.windowStart,
        normalCursor.overlapMilliseconds,
        normalCursor.lastEventOccurredAt,
      ),
    );
    if (
      Number.isSafeInteger(rewound) &&
      rewound > cursorStart &&
      rewound < regularStartMilliseconds
    ) {
      startMilliseconds = Math.min(startMilliseconds, rewound);
    }
  }
  const start = formatShanghai(Math.max(0, startMilliseconds));
  const normalAvailable = start < boundedEnd;

  if (compensationCursor && !compensationCursor.complete) {
    // A compensation batch yields after one provider request. Give a normal
    // tail that accumulated since the last normal completion first priority;
    // otherwise resume the durable compensation segment tree.
    const normalDue = previousEnd === null ||
      endMilliseconds - previousEnd >= scanIntervalMilliseconds;
    const normalGetsTurn = normalDue &&
      (normalCursor?.updatedAt ?? 0) <= compensationCursor.updatedAt;
    if (!normalGetsTurn) {
      return {
        window: { start: compensationCursor.windowStart, end: compensationCursor.windowEnd },
        scanKind: compensationCursor.scanKind,
      };
    }
  }

  // Do not start a long compensating sweep while a materially sized normal
  // window is still outstanding. A tiny overlap-sized tail is treated as
  // caught up so a due 10-minute sweep does not starve behind a fast poller.
  const normalGap = previousEnd === null ? Number.POSITIVE_INFINITY :
    Math.max(0, endMilliseconds - previousEnd);
  // One bounded normal window is the catch-up unit. Once the gap is within
  // that unit, a due compensation campaign may start; in-progress campaigns
  // still yield between requests so newly accumulated normal tails interleave.
  const normalTailOnly = normalGap <= windowMilliseconds;
  const canCompensate = normalCursor !== null && anchor !== null &&
    compensationCursor?.complete !== false &&
    (!normalAvailable || normalTailOnly);
  if (canCompensate) {
    const baseline = normalCursor.lastCompletedAt ?? 0;
    const state = compensationState ?? {
      providerAccountKey: normalCursor.providerAccountKey,
      next10mAt: baseline + COMPENSATION_10M_INTERVAL_MILLISECONDS,
      next1hAt: baseline + COMPENSATION_1H_INTERVAL_MILLISECONDS,
      next1dAt: baseline + COMPENSATION_1D_INTERVAL_MILLISECONDS,
      updatedAt: baseline,
    } satisfies LedgerCompensationState;
    const due = COMPENSATION_KINDS.find((candidate) =>
      now >= state[candidate.dueKey] && candidate.lookbackMilliseconds >= normalGap);
    if (due) {
      const start = formatShanghai(Math.max(
        initialWindowStartMilliseconds ?? 0,
        anchor - due.lookbackMilliseconds,
      ));
      if (start < boundedEnd) {
        return { window: { start, end: boundedEnd }, scanKind: due.kind };
      }
    }
  }
  if (!normalAvailable) return null;
  return { window: { start, end: boundedEnd }, scanKind: "NORMAL" };
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

function normalCursorBehind(
  cursor: LedgerCursor,
  now: number,
  safetyLagMilliseconds: number,
): boolean {
  const end = parseShanghai(cursor.windowEnd);
  if (!Number.isSafeInteger(end)) {
    throw new Error("durable ledger cursor contains an invalid window end");
  }
  return end < now - safetyLagMilliseconds;
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
    retryAfterSeconds: null,
    retryable: false,
    normalCompleted: false,
    cooldownActive: false,
  };
}

function retryAfterSeconds(
  state: ReturnType<LedgerStore["getIngestScheduleState"]>,
  now: number,
): number | null {
  if (state === null || state.cooldownUntil <= now) return null;
  return Math.max(1, Math.ceil((state.cooldownUntil - now) / 1_000));
}
