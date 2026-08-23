import { LedgerIngestService, type LedgerScanResult } from "./service.ts";

export type LedgerSchedulerState =
  | "idle"
  | "running"
  | "healthy"
  | "catching_up"
  | "degraded"
  | "stopped";

export interface LedgerSchedulerHealth {
  readonly state: LedgerSchedulerState;
  readonly inFlight: boolean;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
}

export interface LedgerIngestSchedulerOptions {
  readonly service: LedgerIngestService;
  readonly intervalMilliseconds: number;
  readonly clock?: () => number;
  /** Injectable only for deterministic scheduler tests. */
  readonly setTimeout?: (callback: () => void, delayMilliseconds: number) => NodeJS.Timeout;
  /** Injectable counterpart for the scheduler timer. */
  readonly clearTimeout?: (timer: NodeJS.Timeout) => void;
  readonly onResult?: (result: LedgerScanResult, health: LedgerSchedulerHealth) => void;
  readonly onUnexpectedError?: (error: unknown, health: LedgerSchedulerHealth) => void;
}

/** One timer and one in-flight promise own all automatic and manual scans. */
export class LedgerIngestScheduler {
  readonly #service: LedgerIngestService;
  readonly #intervalMilliseconds: number;
  readonly #clock: () => number;
  readonly #setTimeout: NonNullable<LedgerIngestSchedulerOptions["setTimeout"]>;
  readonly #clearTimeout: NonNullable<LedgerIngestSchedulerOptions["clearTimeout"]>;
  readonly #onResult: LedgerIngestSchedulerOptions["onResult"];
  readonly #onUnexpectedError: LedgerIngestSchedulerOptions["onUnexpectedError"];
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<LedgerScanResult> | null = null;
  #started = false;
  #stopped = false;
  #state: LedgerSchedulerState = "idle";
  #lastAttemptAt: number | null = null;
  #lastSuccessAt: number | null = null;
  #lastErrorCode: string | null = null;
  #consecutiveFailures = 0;

  // Keep the provider quiet after a failure. Transient failures use the
  // largest of the normal interval, exponential backoff, and the provider's
  // Retry-After hint. Non-retryable failures need a long cooldown so a bad
  // credential or permission cannot cause a request every few seconds.
  static readonly #maximumRetryDelayMilliseconds = 24 * 60 * 60 * 1_000;
  static readonly #nonRetryableDelayMilliseconds = 15 * 60 * 1_000;

  constructor(options: LedgerIngestSchedulerOptions) {
    if (
      !Number.isSafeInteger(options.intervalMilliseconds) ||
      options.intervalMilliseconds < 1_000 ||
      options.intervalMilliseconds > 3_600_000
    ) {
      throw new RangeError("ledger scan interval is invalid");
    }
    this.#service = options.service;
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#clock = options.clock ?? (() => Date.now());
    this.#setTimeout = options.setTimeout ?? ((callback, delayMilliseconds) =>
      setTimeout(callback, delayMilliseconds));
    this.#clearTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.#onResult = options.onResult;
    this.#onUnexpectedError = options.onUnexpectedError;
  }

  start(): void {
    if (this.#started) throw new Error("ledger scheduler is already started");
    if (this.#stopped) throw new Error("ledger scheduler cannot be restarted after stop");
    this.#started = true;
    void this.trigger("startup").catch(() => undefined);
  }

  trigger(reason = "manual"): Promise<LedgerScanResult> {
    if (!this.#started || this.#stopped) {
      return Promise.reject(new Error("ledger scheduler is not running"));
    }
    if (this.#current) return this.#current;
    // A manual trigger is an explicit operator action. Cancel a pending
    // automatic timer so it cannot race the requested scan.
    if (reason !== "scheduled" && this.#timer) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#lastAttemptAt = safeNow(this.#clock());
    this.#state = "running";
    const operation = this.#service.run(reason)
      .then((result) => {
        if (result.status === "COMPLETED" || result.status === "SKIPPED") {
          this.#state = "healthy";
          this.#lastSuccessAt = safeNow(this.#clock());
          this.#lastErrorCode = null;
          this.#consecutiveFailures = 0;
        } else if (result.status === "PARTIAL") {
          this.#state = "catching_up";
          this.#lastErrorCode = result.errorCode;
        } else {
          this.#state = "degraded";
          this.#lastErrorCode = result.errorCode;
          this.#consecutiveFailures += 1;
        }
        try {
          this.#onResult?.(result, this.health());
        } catch (error) {
          this.#notifyUnexpected(error);
        }
        this.#scheduleNext(result);
        return result;
      })
      .catch((error: unknown) => {
        this.#state = "degraded";
        this.#lastErrorCode = "scan_failed";
        this.#consecutiveFailures += 1;
        this.#notifyUnexpected(error);
        this.#scheduleNext(null);
        throw error;
      })
      .finally(() => {
        this.#current = null;
      });
    this.#current = operation;
    return operation;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#service.stop();
    try {
      await this.#current;
      await this.#service.waitForIdle();
    } catch {
      // Health and the configured error observer already retain the failure.
    }
    this.#state = "stopped";
  }

  health(): LedgerSchedulerHealth {
    return Object.freeze({
      state: this.#state,
      inFlight: this.#current !== null,
      lastAttemptAt: this.#lastAttemptAt,
      lastSuccessAt: this.#lastSuccessAt,
      lastErrorCode: this.#lastErrorCode,
      consecutiveFailures: this.#consecutiveFailures,
    });
  }

  #notifyUnexpected(error: unknown): void {
    try {
      this.#onUnexpectedError?.(error, this.health());
    } catch {
      // Operational observers cannot change scanner state or create rejections.
    }
  }

  #scheduleNext(result: LedgerScanResult | null): void {
    if (!this.#started || this.#stopped || this.#timer !== null) return;
    let delay = this.#intervalMilliseconds;
    if (result?.status === "FAILED") {
      if (!result.retryable) {
        delay = Math.max(this.#intervalMilliseconds, LedgerIngestScheduler.#nonRetryableDelayMilliseconds);
      } else {
        const exponential = Math.min(
          LedgerIngestScheduler.#maximumRetryDelayMilliseconds,
          this.#intervalMilliseconds * 2 ** Math.max(0, this.#consecutiveFailures - 1),
        );
        const retryAfter =
          result.retryAfterSeconds !== null &&
          Number.isFinite(result.retryAfterSeconds) &&
          result.retryAfterSeconds >= 0
            ? result.retryAfterSeconds * 1_000
            : 0;
        delay = Math.min(
          LedgerIngestScheduler.#maximumRetryDelayMilliseconds,
          Math.max(this.#intervalMilliseconds, exponential, retryAfter),
        );
      }
    }
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.trigger("scheduled").catch(() => undefined);
    }, delay);
    this.#timer.unref?.();
  }
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("ledger scheduler clock is invalid");
  }
  return value;
}
