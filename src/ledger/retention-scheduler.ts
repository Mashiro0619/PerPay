import { INGEST_RETENTION_INTERVAL_MILLISECONDS, type IngestRetentionResult } from "./retention.ts";

export class LedgerRetentionScheduler {
  readonly #prune: () => IngestRetentionResult;
  readonly #onPruned: (result: IngestRetentionResult) => void;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor(options: {
    prune: () => IngestRetentionResult;
    onPruned: (result: IngestRetentionResult) => void;
    onError: (error: unknown) => void;
  }) {
    this.#prune = options.prune;
    this.#onPruned = options.onPruned;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(5_000);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      let nextDelay = INGEST_RETENTION_INTERVAL_MILLISECONDS;
      try {
        const result = this.#prune();
        if (result.deletedRuns > 0) this.#onPruned(result);
        if (result.hasMore) nextDelay = 250;
      } catch (error) {
        this.#onError(error);
      } finally {
        if (this.#started) this.#schedule(nextDelay);
      }
    }, delay);
    this.#timer.unref();
  }
}
