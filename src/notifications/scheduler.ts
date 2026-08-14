import {
  type WebhookProcessResult,
} from "./service.ts";

export type WebhookSchedulerState = "idle" | "running" | "healthy" | "degraded" | "stopped";

export interface WebhookSchedulerHealth {
  readonly enabled: boolean;
  readonly state: WebhookSchedulerState;
  readonly inFlight: boolean;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
  readonly pendingDeliveries: number;
  readonly deadLetters: number;
}

export interface WebhookSchedulerOptions {
  readonly service: WebhookProcessor;
  readonly store: WebhookCountStore;
  readonly intervalMilliseconds?: number | undefined;
  readonly maximumDeliveriesPerRun?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onResult?: ((result: WebhookRunResult, health: WebhookSchedulerHealth) => void) | undefined;
  readonly onUnexpectedError?: ((error: unknown) => void) | undefined;
}

export interface WebhookProcessor {
  processOne(signal?: AbortSignal): Promise<WebhookProcessResult>;
}

export interface WebhookCountStore {
  counts(): { readonly pending: number; readonly dead: number };
}

export interface WebhookRunResult {
  readonly reason: string;
  readonly processed: number;
  readonly acknowledged: number;
  readonly failed: number;
  readonly pending: boolean;
}

export class WebhookScheduler {
  readonly #service: WebhookProcessor;
  readonly #store: WebhookCountStore;
  readonly #intervalMilliseconds: number;
  readonly #maximumDeliveriesPerRun: number;
  readonly #clock: () => number;
  readonly #onResult: WebhookSchedulerOptions["onResult"];
  readonly #onUnexpectedError: WebhookSchedulerOptions["onUnexpectedError"];
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<WebhookRunResult> | null = null;
  #started = false;
  #stopped = false;
  #state: WebhookSchedulerState = "idle";
  #lastAttemptAt: number | null = null;
  #lastSuccessAt: number | null = null;
  #lastErrorCode: string | null = null;
  #consecutiveFailures = 0;
  #abortController: AbortController | null = null;

  constructor(options: WebhookSchedulerOptions) {
    this.#service = options.service;
    this.#store = options.store;
    this.#intervalMilliseconds = options.intervalMilliseconds ?? 1_000;
    this.#maximumDeliveriesPerRun = options.maximumDeliveriesPerRun ?? 32;
    this.#clock = options.clock ?? (() => Date.now());
    this.#onResult = options.onResult;
    this.#onUnexpectedError = options.onUnexpectedError;
    if (!Number.isSafeInteger(this.#intervalMilliseconds) || this.#intervalMilliseconds < 250 || this.#intervalMilliseconds > 3_600_000) {
      throw new RangeError("webhook interval is invalid");
    }
    if (!Number.isSafeInteger(this.#maximumDeliveriesPerRun) || this.#maximumDeliveriesPerRun < 1 || this.#maximumDeliveriesPerRun > 1_000) {
      throw new RangeError("webhook run budget is invalid");
    }
  }

  start(): Promise<WebhookRunResult> {
    if (this.#stopped) return Promise.reject(new Error("webhook scheduler is stopped"));
    if (!this.#started) {
      this.#started = true;
      this.#timer = setInterval(() => {
        void this.trigger("scheduled").catch(() => undefined);
      }, this.#intervalMilliseconds);
      this.#timer.unref();
    }
    return this.trigger("startup");
  }

  trigger(reason = "manual"): Promise<WebhookRunResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reason)) {
      return Promise.reject(new RangeError("webhook reason is invalid"));
    }
    if (this.#stopped) return Promise.reject(new Error("webhook scheduler is stopped"));
    if (this.#current) return this.#current;
    const previousErrorCode = this.#lastErrorCode;
    const previousConsecutiveFailures = this.#consecutiveFailures;
    this.#lastAttemptAt = safeNow(this.#clock());
    this.#state = "running";
    this.#abortController = new AbortController();
    const operation = this.#run(reason, this.#abortController.signal)
      .then((result) => {
        const counts = this.#store.counts();
        if (result.failed > 0) {
          this.#state = "degraded";
          this.#lastErrorCode = "webhook_delivery_failed";
          this.#consecutiveFailures = previousConsecutiveFailures + 1;
        } else if (counts.dead > 0) {
          this.#state = "degraded";
          this.#lastErrorCode = "webhook_delivery_failed";
          this.#consecutiveFailures = Math.max(1, previousConsecutiveFailures);
        } else if (
          result.processed === 0 &&
          counts.pending > 0 &&
          previousErrorCode !== null
        ) {
          this.#state = "degraded";
          this.#lastErrorCode = previousErrorCode;
          this.#consecutiveFailures = previousConsecutiveFailures;
        } else {
          this.#state = "healthy";
          this.#lastSuccessAt = safeNow(this.#clock());
          this.#lastErrorCode = null;
          this.#consecutiveFailures = 0;
        }
        notify(this.#onResult, result, this.health());
        return result;
      })
      .catch((error) => {
        this.#state = "degraded";
        this.#lastErrorCode = "webhook_scheduler_failed";
        this.#consecutiveFailures += 1;
        notify(this.#onUnexpectedError, error);
        throw error;
      })
      .finally(() => {
        this.#current = null;
        this.#abortController = null;
      });
    this.#current = operation;
    return operation;
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#current;
      return;
    }
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#abortController?.abort();
    try {
      await this.#current;
    } catch {
      // The terminal health state and attempt evidence retain the failure.
    }
    this.#state = "stopped";
  }

  health(): WebhookSchedulerHealth {
    const counts = this.#storeCounts();
    return Object.freeze({
      enabled: true,
      state: this.#state,
      inFlight: this.#current !== null,
      lastAttemptAt: this.#lastAttemptAt,
      lastSuccessAt: this.#lastSuccessAt,
      lastErrorCode: this.#lastErrorCode,
      consecutiveFailures: this.#consecutiveFailures,
      pendingDeliveries: counts.pending,
      deadLetters: counts.dead,
    });
  }

  #storeCounts(): { readonly pending: number; readonly dead: number } {
    return this.#storeCountsFromDatabase();
  }

  #storeCountsFromDatabase(): { readonly pending: number; readonly dead: number } {
    // The store intentionally exposes only bounded operational counts here;
    // this read is cheap and does not participate in a business transaction.
    return this.#store.counts();
  }

  async #run(reason: string, signal: AbortSignal): Promise<WebhookRunResult> {
    let processed = 0;
    let acknowledged = 0;
    let failed = 0;
    for (let index = 0; index < this.#maximumDeliveriesPerRun; index += 1) {
      const result = await this.#service.processOne(signal);
      if (!result.processed) break;
      processed += 1;
      if (result.outcome === "ACKNOWLEDGED") acknowledged += 1;
      if (result.outcome !== "ACKNOWLEDGED") failed += 1;
      if (signal.aborted) break;
      await yieldToEventLoop();
    }
    const counts = this.#store.counts();
    return Object.freeze({
      reason,
      processed,
      acknowledged,
      failed,
      pending: counts.pending > 0,
    });
  }
}

function notify<T extends readonly unknown[]>(observer: ((...args: T) => void) | undefined, ...args: T): void {
  try {
    observer?.(...args);
  } catch {
    // Observers must not change delivery state or reject scheduler promises.
  }
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("webhook scheduler clock is invalid");
  return value;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
