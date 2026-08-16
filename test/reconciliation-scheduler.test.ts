import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  ReconciliationScheduler,
  type ReconciliationStore,
  type ReconciliationSweepCursor,
} from "../src/reconciliation/index.ts";

describe("ReconciliationScheduler", () => {
  it("continues a bounded cursor sweep without starving later unmatched entries", async () => {
    const ids = Array.from({ length: 7 }, () => randomUUID()).sort();
    const processed: string[] = [];
    const fake = createFakeStore(ids, processed);
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 2,
      maximumEntriesPerRun: 2,
      clock: incrementingClock(2_000_000_000_000),
    });

    const first = await scheduler.start();
    assert.equal(first.processedEntries, 2);
    assert.equal(first.continuationPending, true);
    await waitUntil(() => processed.length === ids.length && !scheduler.health().inFlight);

    assert.deepEqual(processed, ids);
    assert.deepEqual(scheduler.health(), {
      state: "healthy",
      inFlight: false,
      lastAttemptAt: 2_000_000_000_006,
      lastSuccessAt: 2_000_000_000_007,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingOrders: 0,
      continuationPending: false,
    });
    await scheduler.stop();
    assert.equal(scheduler.health().state, "stopped");
  });

  it("coalesces order triggers and isolates one item failure", async () => {
    const entryIds = [randomUUID(), randomUUID()].sort();
    const processed: string[] = [];
    const failedId = entryIds[0];
    const orderIds = [randomUUID(), randomUUID()];
    const reconciledOrders: string[] = [];
    const entryErrors: string[] = [];
    const fake = createFakeStore(entryIds, processed, {
      failedId,
      reconciledOrders,
    });
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 2,
      maximumEntriesPerRun: 2,
      clock: incrementingClock(2_000_000_100_000),
      onEntryError: (_error, ledgerEntryId) => entryErrors.push(ledgerEntryId),
    });

    const firstOrderRun = scheduler.triggerOrder(orderIds[0]!);
    const secondOrderRun = scheduler.triggerOrder(orderIds[1]!);
    await Promise.all([firstOrderRun, secondOrderRun]);
    await waitUntil(() => reconciledOrders.length === 2 && !scheduler.health().inFlight);
    assert.deepEqual(reconciledOrders.sort(), [...orderIds].sort());

    const sweep = await scheduler.triggerSweep("ledger_scan");
    assert.equal(sweep.processedEntries, 2);
    assert.equal(sweep.failures, 1);
    assert.deepEqual(entryErrors, [failedId]);
    assert.deepEqual(processed, entryIds.filter((id) => id !== failedId));
    assert.equal(scheduler.health().state, "degraded");
    assert.equal(scheduler.health().consecutiveFailures, 1);
    await scheduler.stop();
  });

  it("counts automatic settlements and wakes delivery after store transactions return", async () => {
    const orderId = randomUUID();
    const ledgerEntryId = randomUUID();
    const orderSettlements = [autoSettledResult(orderId), autoSettledResult(orderId)];
    const wakeCounts: number[] = [];
    const fake = {
      pendingLedgerPage() {
        return {
          ledgerEntryIds: [ledgerEntryId],
          nextCursor: null,
          hasMore: false,
        };
      },
      reconcileEntry() {
        return autoSettledResult(orderId, ledgerEntryId);
      },
      reconcileOrder() {
        return { processed: 2, results: orderSettlements, hasMore: false } as const;
      },
    } as unknown as ReconciliationStore;
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 2,
      maximumEntriesPerRun: 2,
      clock: incrementingClock(2_000_000_125_000),
      onAutoSettled: (count) => wakeCounts.push(count),
    });

    const orderRun = await scheduler.triggerOrder(orderId);
    assert.equal(orderRun.autoSettled, 2);
    assert.deepEqual(wakeCounts, [2]);

    const sweep = await scheduler.triggerSweep("auto_settlement_test");
    assert.equal(sweep.autoSettled, 1);
    assert.deepEqual(wakeCounts, [2, 1]);
    await scheduler.stop();

    const observerFailure = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_126_000),
      onAutoSettled: () => {
        throw new Error("delivery wake failed");
      },
    });
    const unaffected = await observerFailure.triggerSweep("observer_failure");
    assert.equal(unaffected.autoSettled, 1);
    assert.equal(unaffected.failures, 0);
    await observerFailure.stop();
  });

  it("retries a transient targeted-order failure without waiting for the periodic sweep", async () => {
    const orderId = randomUUID();
    const reasons: string[] = [];
    const orderErrors: string[] = [];
    let attempts = 0;
    const fake = {
      ...createFakeStore([], []),
      reconcileOrder(reconciledOrderId: string) {
        assert.equal(reconciledOrderId, orderId);
        attempts += 1;
        if (attempts < 3) throw new Error("forced transient order failure");
        return { processed: 0, results: [], hasMore: false } as const;
      },
    } as unknown as ReconciliationStore;
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      orderRetryBaseMilliseconds: 1,
      maximumOrderRetryAttempts: 3,
      clock: incrementingClock(2_000_000_150_000),
      onOrderError: (_error, failedOrderId) => orderErrors.push(failedOrderId),
      onResult: (result) => reasons.push(result.reason),
    });

    const first = await scheduler.triggerOrder(orderId);
    assert.equal(first.failures, 1);
    assert.equal(first.continuationPending, true);
    assert.equal(scheduler.health().pendingOrders, 1);
    await waitUntilWithTimers(
      () => attempts === 3 && !scheduler.health().inFlight && scheduler.health().pendingOrders === 0,
    );

    assert.deepEqual(orderErrors, [orderId, orderId]);
    assert.deepEqual(reasons, ["order_created", "order_retry", "order_retry"]);
    assert.equal(scheduler.health().state, "healthy");
    assert.equal(scheduler.health().continuationPending, false);
    await scheduler.stop();
  });

  it("bounds targeted-order retries and cancels delayed work when stopped", async () => {
    const exhaustedOrderId = randomUUID();
    let exhaustedAttempts = 0;
    const alwaysFailing = {
      ...createFakeStore([], []),
      reconcileOrder() {
        exhaustedAttempts += 1;
        throw new Error("forced persistent order failure");
      },
    } as unknown as ReconciliationStore;
    const exhaustedScheduler = new ReconciliationScheduler({
      store: alwaysFailing,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      orderRetryBaseMilliseconds: 1,
      maximumOrderRetryAttempts: 2,
      clock: incrementingClock(2_000_000_175_000),
    });

    await exhaustedScheduler.triggerOrder(exhaustedOrderId);
    await waitUntilWithTimers(
      () => exhaustedAttempts === 3 &&
        !exhaustedScheduler.health().inFlight &&
        exhaustedScheduler.health().pendingOrders === 0,
    );
    assert.equal(exhaustedScheduler.health().state, "degraded");
    assert.equal(exhaustedScheduler.health().continuationPending, false);
    await exhaustedScheduler.stop();

    let cancelledAttempts = 0;
    const cancelledStore = {
      ...createFakeStore([], []),
      reconcileOrder() {
        cancelledAttempts += 1;
        throw new Error("forced cancelled order failure");
      },
    } as unknown as ReconciliationStore;
    const cancelledScheduler = new ReconciliationScheduler({
      store: cancelledStore,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      orderRetryBaseMilliseconds: 5,
      maximumOrderRetryAttempts: 2,
      clock: incrementingClock(2_000_000_180_000),
    });
    await cancelledScheduler.triggerOrder(randomUUID());
    assert.equal(cancelledScheduler.health().pendingOrders, 1);
    await cancelledScheduler.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.equal(cancelledAttempts, 1);
    assert.equal(cancelledScheduler.health().pendingOrders, 0);
  });

  it("retries an item that failed during an earlier compensation sweep", async () => {
    const ledgerEntryId = randomUUID();
    const processed: string[] = [];
    const entryErrors: string[] = [];
    const fake = createFakeStore([ledgerEntryId], processed, {
      failedId: ledgerEntryId,
      failuresBeforeSuccess: 1,
    });
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_200_000),
      onEntryError: (_error, failedLedgerEntryId) => entryErrors.push(failedLedgerEntryId),
    });

    const first = await scheduler.start();
    assert.equal(first.processedEntries, 1);
    assert.equal(first.failures, 1);
    assert.deepEqual(processed, []);
    assert.deepEqual(entryErrors, [ledgerEntryId]);
    assert.equal(scheduler.health().state, "degraded");

    const retry = await scheduler.triggerSweep("scheduled_retry");
    assert.equal(retry.processedEntries, 1);
    assert.equal(retry.failures, 0);
    assert.deepEqual(processed, [ledgerEntryId]);
    assert.deepEqual(entryErrors, [ledgerEntryId]);
    assert.equal(scheduler.health().state, "healthy");
    assert.equal(scheduler.health().consecutiveFailures, 0);
    await scheduler.stop();
  });

  it("lets each store operation obtain a fresh database time", async () => {
    const ledgerEntryId = randomUUID();
    const orderId = randomUUID();
    const suppliedTimes: Array<number | undefined> = [];
    const fake = {
      pendingLedgerPage() {
        return {
          ledgerEntryIds: [ledgerEntryId],
          nextCursor: null,
          hasMore: false,
        };
      },
      reconcileEntry(_ledgerEntryId: string, now?: number) {
        suppliedTimes.push(now);
        return { kind: "unmatched", ledgerEntryId, exceptionId: randomUUID() } as const;
      },
      reconcileOrder(_orderId: string, _limit: number, now?: number) {
        suppliedTimes.push(now);
        return { processed: 0, results: [], hasMore: false } as const;
      },
    } as unknown as ReconciliationStore;
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_300_000),
    });

    await scheduler.triggerOrder(orderId);
    await scheduler.triggerSweep("fresh_store_time");

    assert.deepEqual(suppliedTimes, [undefined, undefined]);
    await scheduler.stop();
  });

  it("reports the current run error code after a failed page is retried", async () => {
    const ledgerEntryId = randomUUID();
    const reportedCodes: Array<string | null> = [];
    let pageAttempts = 0;
    const fake = {
      pendingLedgerPage() {
        pageAttempts += 1;
        if (pageAttempts === 1) throw new Error("forced page failure");
        return {
          ledgerEntryIds: [ledgerEntryId],
          nextCursor: null,
          hasMore: false,
        };
      },
      reconcileEntry() {
        throw new Error("forced item failure");
      },
      reconcileOrder() {
        return { processed: 0, results: [], hasMore: false } as const;
      },
    } as unknown as ReconciliationStore;
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_400_000),
      onResult: (_result, health) => reportedCodes.push(health.lastErrorCode),
    });

    const first = await scheduler.start();
    assert.equal(first.failures, 1);
    await waitUntil(() => reportedCodes.length === 2 && !scheduler.health().inFlight);

    assert.deepEqual(reportedCodes, ["pending_page_failed", "reconciliation_item_failed"]);
    assert.equal(scheduler.health().lastErrorCode, "reconciliation_item_failed");
    await scheduler.stop();
  });

  it("isolates observer failures from reconciliation state and promises", async () => {
    const ledgerEntryId = randomUUID();
    const orderId = randomUUID();
    const fake = {
      pendingLedgerPage() {
        return {
          ledgerEntryIds: [ledgerEntryId],
          nextCursor: null,
          hasMore: false,
        };
      },
      reconcileEntry() {
        throw new Error("forced item failure");
      },
      reconcileOrder() {
        throw new Error("forced order failure");
      },
    } as unknown as ReconciliationStore;
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_500_000),
      onEntryError: () => {
        throw new Error("entry observer failed");
      },
      onOrderError: () => {
        throw new Error("order observer failed");
      },
      onResult: () => {
        throw new Error("result observer failed");
      },
    });

    const orderRun = await scheduler.triggerOrder(orderId);
    assert.equal(orderRun.failures, 1);
    const sweep = await scheduler.triggerSweep("observer_isolation");
    assert.equal(sweep.failures, 1);
    assert.equal(scheduler.health().state, "degraded");
    assert.equal(scheduler.health().consecutiveFailures, 2);
    await scheduler.stop();
  });

  it("reports an in-flight run consistently to result observers", async () => {
    const observedInFlight: boolean[] = [];
    const fake = createFakeStore([], []);
    const scheduler = new ReconciliationScheduler({
      store: fake,
      intervalMilliseconds: 60_000,
      batchSize: 1,
      maximumEntriesPerRun: 1,
      clock: incrementingClock(2_000_000_600_000),
      onResult: (_result, health) => observedInFlight.push(health.inFlight),
    });

    await scheduler.triggerSweep("observer_health");

    assert.deepEqual(observedInFlight, [true]);
    assert.equal(scheduler.health().inFlight, false);
    await scheduler.stop();
  });
});

function createFakeStore(
  ids: readonly string[],
  processed: string[],
  options: {
    readonly failedId?: string | undefined;
    readonly failuresBeforeSuccess?: number | undefined;
    readonly reconciledOrders?: string[] | undefined;
  } = {},
): ReconciliationStore {
  const occurrences = new Map(ids.map((id, index) => [id, 1_000 + index]));
  let failuresRemaining = options.failedId === undefined
    ? 0
    : options.failuresBeforeSuccess ?? Number.POSITIVE_INFINITY;
  return {
    pendingLedgerPage(cursor: ReconciliationSweepCursor | null, limit: number) {
      const start = cursor === null
        ? 0
        : ids.findIndex((id) => id === cursor.ledgerEntryId) + 1;
      const selected = ids.slice(start, start + limit);
      const last = selected.at(-1);
      return {
        ledgerEntryIds: selected,
        nextCursor: last
          ? { occurredAt: occurrences.get(last)!, ledgerEntryId: last }
          : null,
        hasMore: start + selected.length < ids.length,
      };
    },
    reconcileEntry(ledgerEntryId: string) {
      if (ledgerEntryId === options.failedId && failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("forced reconciliation failure");
      }
      processed.push(ledgerEntryId);
      return { kind: "unmatched", ledgerEntryId, exceptionId: randomUUID() } as const;
    },
    reconcileOrder(orderId: string) {
      options.reconciledOrders?.push(orderId);
      return { processed: 0, results: [], hasMore: false } as const;
    },
  } as unknown as ReconciliationStore;
}

function incrementingClock(initial: number): () => number {
  let current = initial;
  return () => current++;
}

function autoSettledResult(orderId: string, ledgerEntryId = randomUUID()) {
  return {
    kind: "auto_settled" as const,
    ledgerEntryId,
    candidateId: randomUUID(),
    paymentMatchId: randomUUID(),
    orderId,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

async function waitUntilWithTimers(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timer condition was not reached");
}
