import { randomUUID } from "node:crypto";
import type { LedgerIngestScheduler } from "../ledger/scheduler.ts";
import type { LedgerManualScanRequest } from "../shared/ledger-manual-scan.ts";

interface Entry {
  value: LedgerManualScanRequest;
  scheduler: Pick<LedgerIngestScheduler, "trigger" | "health" | "nextScanAt">;
  stillCurrent: () => boolean;
  previousAttemptAt: number | null;
}

/** One bounded request, using the existing scheduler and its durable protections. */
export class LedgerManualScanner {
  readonly #clock: () => number;
  #entry: Entry | null = null;

  constructor(clock: () => number = Date.now) { this.#clock = clock; }

  get(): LedgerManualScanRequest | null {
    const entry = this.#entry;
    if (!entry) return null;
    if (entry.value.finished_at === null) {
      if (!entry.stillCurrent()) this.#fail(entry, "runtime_changed");
      else this.#refresh(entry);
    }
    return { ...entry.value };
  }

  request(scheduler: Entry["scheduler"], stillCurrent: () => boolean): LedgerManualScanRequest {
    const current = this.get();
    if (current && current.finished_at === null) return current;
    const entry: Entry = {
      scheduler, stillCurrent, previousAttemptAt: scheduler.health().lastAttemptAt,
      value: { id: randomUUID(), state: "WAITING", requested_at: new Date(this.#clock()).toISOString(),
        started_at: null, finished_at: null, next_attempt_at: null, outcome: null, error_code: null, ingest_run_id: null },
    };
    this.#entry = entry;
    void this.#run(entry);
    return this.get()!;
  }

  invalidate(): void {
    if (!this.#entry) return;
    if (this.#entry.value.finished_at === null) this.#fail(this.#entry, "runtime_changed");
    else if (this.#entry.value.error_code !== "runtime_changed") this.#entry = null;
  }

  #refresh(entry: Entry): void {
    const health = entry.scheduler.health();
    entry.value = { ...entry.value,
      state: health.inFlight ? "RUNNING" : entry.value.state,
      started_at: entry.value.started_at ?? (health.inFlight ? iso(health.lastAttemptAt) : null),
      next_attempt_at: health.inFlight ? null : iso(entry.scheduler.nextScanAt()),
    };
  }

  #fail(entry: Entry, code: string): void {
    entry.value = { ...entry.value, state: "FAILED", finished_at: new Date(this.#clock()).toISOString(),
      next_attempt_at: null, outcome: "FAILED", error_code: code };
  }

  async #run(entry: Entry): Promise<void> {
    try {
      if (!entry.stillCurrent()) { this.#fail(entry, "runtime_changed"); return; }
      const operation = entry.scheduler.trigger("admin_manual");
      this.#refresh(entry);
      const result = await operation;
      if (entry.value.finished_at !== null) return;
      if (!entry.stillCurrent()) { this.#fail(entry, "runtime_changed"); return; }
      const attempt = entry.scheduler.health().lastAttemptAt;
      entry.value = { ...entry.value, state: result.status === "FAILED" ? "FAILED" : "COMPLETED",
        started_at: entry.value.started_at ?? (attempt !== entry.previousAttemptAt ? iso(attempt) : null),
        finished_at: new Date(this.#clock()).toISOString(), next_attempt_at: null,
        outcome: result.status, error_code: result.errorCode, ingest_run_id: result.ingestRunId };
    } catch {
      if (entry.value.finished_at !== null) return;
      this.#fail(entry, !entry.stillCurrent() ? "runtime_changed" :
        entry.scheduler.health().lastErrorCode === "scan_schedule_unavailable" ? "scan_schedule_unavailable" : "scan_failed");
    }
  }
}

function iso(value: number | null): string | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? new Date(value).toISOString() : null;
}
