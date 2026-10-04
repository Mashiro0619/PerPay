import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { LedgerIngestScheduler } from "../ledger/scheduler.ts";
import type { CheckoutVerification } from "../shared/checkout-verification.ts";
interface Entry {
  value: CheckoutVerification;
  scheduler: Pick<LedgerIngestScheduler, "trigger" | "health" | "nextRunAt">;
  finishedAt: number | null;
}
/** Bounded, ephemeral, order-scoped progress. Never used as payment evidence. */
export class CheckoutVerifier {
  readonly #entries = new Map<string, Entry>();
  private readonly clock: () => number;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }
  get(orderId: string): CheckoutVerification | undefined {
    const entry = this.#entries.get(orderId);
    if (!entry) return undefined;
    if (entry.finishedAt !== null && this.clock() - entry.finishedAt > 300000) {
      this.#entries.delete(orderId);
      return undefined;
    }
    const value = { ...entry.value };
    if (value.state === "WAITING") {
      if (entry.scheduler.health().inFlight) value.state = "SCANNING";
      value.retry_after_seconds = Math.max(
        1,
        Math.ceil(
          ((entry.scheduler.nextRunAt() ?? this.clock()) - this.clock()) / 1000,
        ),
      );
    }
    return value;
  }
  request(
    orderId: string,
    scheduler: Entry["scheduler"],
    reconcile: () => Promise<void>,
    stillCurrent: () => boolean,
  ): CheckoutVerification {
    const existing = this.#entries.get(orderId);
    if (
      existing &&
      (existing.finishedAt === null ||
        this.clock() - Date.parse(existing.value.requested_at) < 5000)
    )
      return this.get(orderId)!;
    for (const [id, entry] of this.#entries)
      if (entry.finishedAt !== null && this.clock() - entry.finishedAt > 300000)
        this.#entries.delete(id);
    if (!existing && this.#entries.size >= 256) {
      // The cache limit must not reject new work while it only retains old results.
      // Never evict an unfinished scan/reconciliation: its per-order coalescing matters.
      let oldestOrderId: string | undefined;
      let oldestFinishedAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.#entries) {
        if (entry.finishedAt !== null && entry.finishedAt < oldestFinishedAt) {
          oldestOrderId = id;
          oldestFinishedAt = entry.finishedAt;
        }
      }
      if (oldestOrderId === undefined)
        throw new Error("checkout verification capacity exceeded");
      this.#entries.delete(oldestOrderId);
    }
    const entry: Entry = {
      value: {
        id: randomUUID(),
        state: "WAITING",
        requested_at: new Date(this.clock()).toISOString(),
        retry_after_seconds: 1,
      },
      scheduler,
      finishedAt: null,
    };
    this.#entries.set(orderId, entry);
    void this.#run(entry, reconcile, stillCurrent);
    return this.get(orderId)!;
  }
  async #run(
    entry: Entry,
    reconcile: () => Promise<void>,
    stillCurrent: () => boolean,
  ): Promise<void> {
    try {
      let complete = false;
      for (let round = 0; round < 32; round++) {
        if (!stillCurrent()) throw new Error("runtime changed");
        const result = await entry.scheduler.trigger("checkout_check");
        if (!stillCurrent()) throw new Error("runtime changed");
        if (
          result.status === "COMPLETED" ||
          (result.status === "PARTIAL" && result.normalCompleted)
        ) {
          complete = true;
          break;
        }
        if (result.status !== "PARTIAL")
          throw new Error("scan did not complete");
        // Let the existing continuation timer own subsequent pages; never spin on a settled promise.
        await setImmediate();
      }
      if (!complete) throw new Error("scan is still catching up");
      entry.value.state = "RECONCILING";
      await reconcile();
      if (!stillCurrent()) throw new Error("runtime changed");
      entry.value.state = "COMPLETED";
    } catch {
      entry.value.state = "FAILED";
    } finally {
      entry.finishedAt = this.clock();
      entry.value.retry_after_seconds = 0;
    }
  }
}
