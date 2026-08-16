import { MAX_RECONCILIATION_BATCH_SIZE } from "./model.ts";
import {
  ReconciliationStore,
  type ReconciliationSweepCursor,
} from "./store.ts";

export type ReconciliationSchedulerState =
  | "idle"
  | "running"
  | "healthy"
  | "degraded"
  | "stopped";

export interface ReconciliationRunResult {
  readonly reason: string;
  readonly processedEntries: number;
  readonly processedOrders: number;
  readonly autoSettled: number;
  readonly failures: number;
  readonly continuationPending: boolean;
}

export interface ReconciliationSchedulerHealth {
  readonly state: ReconciliationSchedulerState;
  readonly inFlight: boolean;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
  readonly pendingOrders: number;
  readonly continuationPending: boolean;
}

export interface ReconciliationSchedulerOptions {
  readonly store: ReconciliationStore;
  readonly intervalMilliseconds?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly maximumEntriesPerRun?: number | undefined;
  readonly orderRetryBaseMilliseconds?: number | undefined;
  readonly maximumOrderRetryAttempts?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onResult?: (
    result: ReconciliationRunResult,
    health: ReconciliationSchedulerHealth,
  ) => void;
  readonly onEntryError?: ((error: unknown, ledgerEntryId: string) => void) | undefined;
  readonly onOrderError?: ((error: unknown, orderId: string) => void) | undefined;
  readonly onAutoSettled?: ((count: number) => void) | undefined;
}

const DEFAULT_INTERVAL_MILLISECONDS = 60_000;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAXIMUM_ENTRIES_PER_RUN = 1_024;
const DEFAULT_ORDER_RETRY_BASE_MILLISECONDS = 1_000;
const DEFAULT_MAXIMUM_ORDER_RETRY_ATTEMPTS = 3;
const MAXIMUM_ORDER_RETRY_DELAY_MILLISECONDS = 60_000;
const IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Coalesces startup, order, ingest, and periodic reconciliation triggers into
 * one bounded worker. A stable ledger cursor prevents old unmatched entries
 * from starving later entries during long-term compensation sweeps.
 */
export class ReconciliationScheduler {
  readonly #store: ReconciliationStore;
  readonly #intervalMilliseconds: number;
  readonly #batchSize: number;
  readonly #maximumEntriesPerRun: number;
  readonly #orderRetryBaseMilliseconds: number;
  readonly #maximumOrderRetryAttempts: number;
  readonly #clock: () => number;
  readonly #onResult: ReconciliationSchedulerOptions["onResult"];
  readonly #onEntryError: ReconciliationSchedulerOptions["onEntryError"];
  readonly #onOrderError: ReconciliationSchedulerOptions["onOrderError"];
  readonly #onAutoSettled: ReconciliationSchedulerOptions["onAutoSettled"];
  readonly #pendingOrders = new Map<string, number>();
  readonly #scheduledOrderRetries = new Map<
    string,
    { readonly retryNumber: number; readonly timer: NodeJS.Timeout }
  >();
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<ReconciliationRunResult> | null = null;
  #sweepRequested = false;
  #cursor: ReconciliationSweepCursor | null = null;
  #started = false;
  #stopped = false;
  #state: ReconciliationSchedulerState = "idle";
  #lastAttemptAt: number | null = null;
  #lastSuccessAt: number | null = null;
  #lastErrorCode: string | null = null;
  #consecutiveFailures = 0;

  constructor(options: ReconciliationSchedulerOptions) {
    this.#store = options.store;
    this.#intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#maximumEntriesPerRun = options.maximumEntriesPerRun ?? DEFAULT_MAXIMUM_ENTRIES_PER_RUN;
    this.#orderRetryBaseMilliseconds =
      options.orderRetryBaseMilliseconds ?? DEFAULT_ORDER_RETRY_BASE_MILLISECONDS;
    this.#maximumOrderRetryAttempts =
      options.maximumOrderRetryAttempts ?? DEFAULT_MAXIMUM_ORDER_RETRY_ATTEMPTS;
    this.#clock = options.clock ?? (() => Date.now());
    this.#onResult = options.onResult;
    this.#onEntryError = options.onEntryError;
    this.#onOrderError = options.onOrderError;
    this.#onAutoSettled = options.onAutoSettled;
    if (
      !Number.isSafeInteger(this.#intervalMilliseconds) ||
      this.#intervalMilliseconds < 1_000 ||
      this.#intervalMilliseconds > 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError("reconciliation interval is invalid");
    }
    if (
      !Number.isSafeInteger(this.#batchSize) ||
      this.#batchSize < 1 ||
      this.#batchSize > MAX_RECONCILIATION_BATCH_SIZE
    ) {
      throw new RangeError("reconciliation batch size is invalid");
    }
    if (
      !Number.isSafeInteger(this.#maximumEntriesPerRun) ||
      this.#maximumEntriesPerRun < this.#batchSize ||
      this.#maximumEntriesPerRun > 100_000
    ) {
      throw new RangeError("reconciliation run budget is invalid");
    }
    if (
      !Number.isSafeInteger(this.#orderRetryBaseMilliseconds) ||
      this.#orderRetryBaseMilliseconds < 1 ||
      this.#orderRetryBaseMilliseconds > MAXIMUM_ORDER_RETRY_DELAY_MILLISECONDS
    ) {
      throw new RangeError("reconciliation order retry delay is invalid");
    }
    if (
      !Number.isSafeInteger(this.#maximumOrderRetryAttempts) ||
      this.#maximumOrderRetryAttempts < 0 ||
      this.#maximumOrderRetryAttempts > 10
    ) {
      throw new RangeError("reconciliation order retry limit is invalid");
    }
  }

  start(): Promise<ReconciliationRunResult> {
    if (this.#stopped) return Promise.reject(new Error("reconciliation scheduler is stopped"));
    if (!this.#started) {
      this.#started = true;
      this.#timer = setInterval(() => {
        void this.triggerSweep("scheduled").catch(() => undefined);
      }, this.#intervalMilliseconds);
      this.#timer.unref();
    }
    return this.triggerSweep("startup");
  }

  triggerSweep(reason = "manual"): Promise<ReconciliationRunResult> {
    validateReason(reason);
    if (this.#stopped) return Promise.reject(new Error("reconciliation scheduler is stopped"));
    this.#sweepRequested = true;
    return this.#ensureRun(reason);
  }

  triggerOrder(orderId: string): Promise<ReconciliationRunResult> {
    if (!IDENTIFIER_PATTERN.test(orderId)) {
      return Promise.reject(new RangeError("reconciliation order ID is invalid"));
    }
    if (this.#stopped) return Promise.reject(new Error("reconciliation scheduler is stopped"));
    const scheduled = this.#scheduledOrderRetries.get(orderId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.#scheduledOrderRetries.delete(orderId);
    }
    if (!this.#pendingOrders.has(orderId)) {
      this.#pendingOrders.set(orderId, scheduled?.retryNumber ?? 0);
    }
    return this.#ensureRun("order_created");
  }

  health(): ReconciliationSchedulerHealth {
    return Object.freeze({
      state: this.#state,
      inFlight: this.#inFlight !== null,
      lastAttemptAt: this.#lastAttemptAt,
      lastSuccessAt: this.#lastSuccessAt,
      lastErrorCode: this.#lastErrorCode,
      consecutiveFailures: this.#consecutiveFailures,
      pendingOrders: this.#pendingOrders.size + this.#scheduledOrderRetries.size,
      continuationPending:
        this.#sweepRequested ||
        this.#cursor !== null ||
        this.#pendingOrders.size > 0 ||
        this.#scheduledOrderRetries.size > 0,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#inFlight;
      return;
    }
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const retry of this.#scheduledOrderRetries.values()) clearTimeout(retry.timer);
    this.#scheduledOrderRetries.clear();
    this.#pendingOrders.clear();
    this.#sweepRequested = false;
    await this.#inFlight;
    this.#state = "stopped";
  }

  #ensureRun(reason: string): Promise<ReconciliationRunResult> {
    if (this.#inFlight) return this.#inFlight;
    const operation = Promise.resolve().then(() => this.#run(reason));
    this.#inFlight = operation.finally(() => {
      this.#inFlight = null;
      if (!this.#stopped && (this.#sweepRequested || this.#pendingOrders.size > 0)) {
        queueMicrotask(() => {
          if (!this.#stopped) void this.#ensureRun("coalesced");
        });
      }
    });
    return this.#inFlight;
  }

  async #run(reason: string): Promise<ReconciliationRunResult> {
    this.#lastAttemptAt = safeNow(this.#clock());
    this.#state = "running";
    let processedEntries = 0;
    let processedOrders = 0;
    let autoSettled = 0;
    let failures = 0;
    let runErrorCode: string | null = null;

    const orders = [...this.#pendingOrders].sort(([left], [right]) => left.localeCompare(right));
    for (const [orderId, previousFailures] of orders) {
      this.#pendingOrders.delete(orderId);
      try {
        const result = this.#store.reconcileOrder(orderId, this.#batchSize);
        const settled = result.results.filter((item) => item.kind === "auto_settled").length;
        autoSettled += settled;
        if (settled > 0) notifyObserver(this.#onAutoSettled, settled);
        processedOrders += 1;
      } catch (error) {
        failures += 1;
        runErrorCode ??= "reconciliation_item_failed";
        this.#scheduleOrderRetry(orderId, previousFailures + 1);
        notifyObserver(this.#onOrderError, error, orderId);
      }
    }

    const runSweep = this.#sweepRequested;
    this.#sweepRequested = false;
    if (runSweep) {
      while (processedEntries < this.#maximumEntriesPerRun) {
        const limit = Math.min(
          this.#batchSize,
          this.#maximumEntriesPerRun - processedEntries,
        );
        let page;
        try {
          page = this.#store.pendingLedgerPage(this.#cursor, limit);
        } catch (error) {
          failures += 1;
          runErrorCode = "pending_page_failed";
          this.#sweepRequested = true;
          break;
        }
        for (const ledgerEntryId of page.ledgerEntryIds) {
          try {
            const result = this.#store.reconcileEntry(ledgerEntryId);
            if (result.kind === "auto_settled") {
              autoSettled += 1;
              notifyObserver(this.#onAutoSettled, 1);
            }
          } catch (error) {
            failures += 1;
            runErrorCode ??= "reconciliation_item_failed";
            notifyObserver(this.#onEntryError, error, ledgerEntryId);
          }
          processedEntries += 1;
        }
        if (!page.hasMore) {
          this.#cursor = null;
          break;
        }
        this.#cursor = page.nextCursor;
        if (processedEntries >= this.#maximumEntriesPerRun) {
          this.#sweepRequested = true;
          break;
        }
        await yieldToEventLoop();
      }
    }

    if (failures === 0) {
      this.#state = "healthy";
      this.#lastSuccessAt = safeNow(this.#clock());
      this.#lastErrorCode = null;
      this.#consecutiveFailures = 0;
    } else {
      this.#state = "degraded";
      this.#lastErrorCode = runErrorCode ?? "reconciliation_item_failed";
      this.#consecutiveFailures += 1;
    }
    const result = Object.freeze({
      reason,
      processedEntries,
      processedOrders,
      autoSettled,
      failures,
      continuationPending:
        this.#sweepRequested ||
        this.#pendingOrders.size > 0 ||
        this.#scheduledOrderRetries.size > 0,
    });
    notifyObserver(this.#onResult, result, this.health());
    return result;
  }

  #scheduleOrderRetry(orderId: string, retryNumber: number): void {
    if (this.#stopped || retryNumber > this.#maximumOrderRetryAttempts) return;
    const delay = Math.min(
      this.#orderRetryBaseMilliseconds * 2 ** (retryNumber - 1),
      MAXIMUM_ORDER_RETRY_DELAY_MILLISECONDS,
    );
    const timer = setTimeout(() => {
      const scheduled = this.#scheduledOrderRetries.get(orderId);
      if (!scheduled || scheduled.timer !== timer) return;
      this.#scheduledOrderRetries.delete(orderId);
      if (this.#stopped) return;
      this.#pendingOrders.set(orderId, retryNumber);
      void this.#ensureRun("order_retry").catch(() => undefined);
    }, delay);
    timer.unref();
    this.#scheduledOrderRetries.set(orderId, { retryNumber, timer });
  }
}

function notifyObserver<Arguments extends readonly unknown[]>(
  observer: ((...arguments_: Arguments) => void) | undefined,
  ...arguments_: Arguments
): void {
  try {
    observer?.(...arguments_);
  } catch {
    // Operational observers cannot change reconciliation state or create rejections.
  }
}

function validateReason(reason: string): void {
  if (!REASON_PATTERN.test(reason)) throw new RangeError("reconciliation reason is invalid");
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("reconciliation clock is invalid");
  }
  return value;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
