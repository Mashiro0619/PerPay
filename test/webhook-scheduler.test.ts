import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WebhookScheduler,
  type WebhookCountStore,
  type WebhookProcessor,
  type WebhookRunResult,
  type WebhookSchedulerHealth,
} from "../src/notifications/scheduler.ts";
import type { WebhookProcessResult } from "../src/notifications/service.ts";

describe("WebhookScheduler", () => {
  it("coalesces concurrent triggers and reports the in-flight run", async () => {
    const entered = deferred<void>();
    const release = deferred<WebhookProcessResult>();
    let processCalls = 0;
    const processor: WebhookProcessor = {
      async processOne() {
        processCalls += 1;
        entered.resolve();
        return release.promise;
      },
    };
    const scheduler = createScheduler({
      processor,
      counts: { pending: 2, dead: 0 },
      clock: sequenceClock(10_000, 10_001),
    });

    const first = scheduler.trigger("manual:first");
    await entered.promise;
    const second = scheduler.trigger("manual:coalesced");
    assert.equal(first, second);
    assert.deepEqual(scheduler.health(), {
      enabled: true,
      state: "running",
      inFlight: true,
      lastAttemptAt: 10_000,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingDeliveries: 2,
      deadLetters: 0,
    });

    release.resolve(noWork());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult, secondResult);
    assert.deepEqual(firstResult, {
      reason: "manual:first",
      processed: 0,
      acknowledged: 0,
      failed: 0,
      pending: true,
    });
    assert.equal(processCalls, 1);
    assert.deepEqual(scheduler.health(), {
      enabled: true,
      state: "healthy",
      inFlight: false,
      lastAttemptAt: 10_000,
      lastSuccessAt: 10_001,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingDeliveries: 2,
      deadLetters: 0,
    });
    await scheduler.stop();
  });

  it("degrades on delivery failures and clears the streak after a successful run", async () => {
    const results = [failedDelivery(), acknowledgedDelivery()];
    let index = 0;
    const scheduler = createScheduler({
      processor: {
        async processOne() {
          return results[index++] ?? noWork();
        },
      },
      maximumDeliveriesPerRun: 1,
      clock: sequenceClock(20_000, 20_001, 20_002),
    });

    assert.deepEqual(await scheduler.trigger("first"), {
      reason: "first",
      processed: 1,
      acknowledged: 0,
      failed: 1,
      pending: false,
    });
    assert.deepEqual(scheduler.health(), {
      enabled: true,
      state: "degraded",
      inFlight: false,
      lastAttemptAt: 20_000,
      lastSuccessAt: null,
      lastErrorCode: "webhook_delivery_failed",
      consecutiveFailures: 1,
      pendingDeliveries: 0,
      deadLetters: 0,
    });

    assert.deepEqual(await scheduler.trigger("recovered"), {
      reason: "recovered",
      processed: 1,
      acknowledged: 1,
      failed: 0,
      pending: false,
    });
    assert.deepEqual(scheduler.health(), {
      enabled: true,
      state: "healthy",
      inFlight: false,
      lastAttemptAt: 20_001,
      lastSuccessAt: 20_002,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingDeliveries: 0,
      deadLetters: 0,
    });
    await scheduler.stop();
  });

  it("does not hide a failed delivery during an empty retry-wait run", async () => {
    const results = [failedDelivery(), noWork(), acknowledgedDelivery()];
    let index = 0;
    const mutableCounts = { pending: 1, dead: 0 };
    const scheduler = createScheduler({
      processor: {
        async processOne() {
          return results[index++] ?? noWork();
        },
      },
      counts: mutableCounts,
      maximumDeliveriesPerRun: 1,
      clock: sequenceClock(25_000, 25_001, 25_002, 25_003),
    });

    await scheduler.trigger("failed_attempt");
    const empty = await scheduler.trigger("not_due_yet");
    assert.equal(empty.processed, 0);
    assert.equal(scheduler.health().state, "degraded");
    assert.equal(scheduler.health().lastErrorCode, "webhook_delivery_failed");
    assert.equal(scheduler.health().consecutiveFailures, 1);

    mutableCounts.pending = 0;
    await scheduler.trigger("retry_acknowledged");
    assert.equal(scheduler.health().state, "healthy");
    assert.equal(scheduler.health().lastErrorCode, null);
    assert.equal(scheduler.health().consecutiveFailures, 0);
    await scheduler.stop();
  });

  it("keeps unresolved dead letters degraded without increasing the streak every poll", async () => {
    const mutableCounts = { pending: 0, dead: 1 };
    const scheduler = createScheduler({
      processor: { async processOne() { return noWork(); } },
      counts: mutableCounts,
      clock: sequenceClock(26_000, 26_001, 26_002, 26_003),
    });

    await scheduler.trigger("dead_letter_poll");
    assert.equal(scheduler.health().state, "degraded");
    assert.equal(scheduler.health().lastErrorCode, "webhook_delivery_failed");
    assert.equal(scheduler.health().consecutiveFailures, 1);
    await scheduler.trigger("dead_letter_poll_again");
    assert.equal(scheduler.health().consecutiveFailures, 1);

    mutableCounts.dead = 0;
    await scheduler.trigger("dead_letter_resolved");
    assert.equal(scheduler.health().state, "healthy");
    await scheduler.stop();
  });

  it("records processor exceptions and notifies the unexpected-error observer", async () => {
    const failure = new Error("processor failed");
    const observed: unknown[] = [];
    const scheduler = createScheduler({
      processor: {
        async processOne() {
          throw failure;
        },
      },
      clock: sequenceClock(30_000),
      onUnexpectedError: (error) => observed.push(error),
    });

    await assert.rejects(
      scheduler.trigger("forced_failure"),
      (error: unknown) => error === failure,
    );
    assert.deepEqual(observed, [failure]);
    assert.deepEqual(scheduler.health(), {
      enabled: true,
      state: "degraded",
      inFlight: false,
      lastAttemptAt: 30_000,
      lastSuccessAt: null,
      lastErrorCode: "webhook_scheduler_failed",
      consecutiveFailures: 1,
      pendingDeliveries: 0,
      deadLetters: 0,
    });
    await scheduler.stop();
  });

  it("aborts and drains the current run before entering the terminal stopped state", async () => {
    const entered = deferred<AbortSignal>();
    const processor: WebhookProcessor = {
      async processOne(signal) {
        if (!signal) throw new Error("scheduler did not supply an abort signal");
        entered.resolve(signal);
        if (signal.aborted) return noWork();
        return new Promise<WebhookProcessResult>((resolve) => {
          signal.addEventListener("abort", () => resolve(noWork()), { once: true });
        });
      },
    };
    const scheduler = createScheduler({
      processor,
      clock: sequenceClock(40_000, 40_001),
    });

    const running = scheduler.trigger("long_running");
    const signal = await entered.promise;
    const stopped = scheduler.stop();
    assert.equal(signal.aborted, true);
    await stopped;
    assert.deepEqual(await running, {
      reason: "long_running",
      processed: 0,
      acknowledged: 0,
      failed: 0,
      pending: false,
    });
    assert.equal(scheduler.health().state, "stopped");
    assert.equal(scheduler.health().inFlight, false);
    await assert.rejects(scheduler.start(), /webhook scheduler is stopped/);
    await assert.rejects(scheduler.trigger("after_stop"), /webhook scheduler is stopped/);
    await scheduler.stop();
  });

  it("isolates result and error observer failures from state and promise outcomes", async () => {
    const observedHealth: WebhookSchedulerHealth[] = [];
    const successful = createScheduler({
      processor: { async processOne() { return noWork(); } },
      clock: sequenceClock(50_000, 50_001),
      onResult: (_result, health) => {
        observedHealth.push(health);
        throw new Error("result observer failed");
      },
    });

    assert.deepEqual(await successful.trigger("observer_success"), {
      reason: "observer_success",
      processed: 0,
      acknowledged: 0,
      failed: 0,
      pending: false,
    });
    assert.equal(successful.health().state, "healthy");
    assert.equal(observedHealth.length, 1);
    assert.equal(observedHealth[0]?.inFlight, true);
    await successful.stop();

    const processorFailure = new Error("processor failed");
    const failed = createScheduler({
      processor: { async processOne() { throw processorFailure; } },
      clock: sequenceClock(51_000),
      onUnexpectedError: () => {
        throw new Error("error observer failed");
      },
    });
    await assert.rejects(
      failed.trigger("observer_failure"),
      (error: unknown) => error === processorFailure,
    );
    assert.equal(failed.health().state, "degraded");
    assert.equal(failed.health().lastErrorCode, "webhook_scheduler_failed");
    await failed.stop();
  });
});

function createScheduler(input: {
  readonly processor: WebhookProcessor;
  readonly counts?: { readonly pending: number; readonly dead: number } | undefined;
  readonly maximumDeliveriesPerRun?: number | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onResult?: ((result: WebhookRunResult, health: WebhookSchedulerHealth) => void) | undefined;
  readonly onUnexpectedError?: ((error: unknown) => void) | undefined;
}): WebhookScheduler {
  const counts = input.counts ?? { pending: 0, dead: 0 };
  const store: WebhookCountStore = { counts: () => counts };
  return new WebhookScheduler({
    service: input.processor,
    store,
    intervalMilliseconds: 60_000,
    maximumDeliveriesPerRun: input.maximumDeliveriesPerRun ?? 8,
    clock: input.clock,
    onResult: input.onResult,
    onUnexpectedError: input.onUnexpectedError,
  });
}

function noWork(): WebhookProcessResult {
  return {
    processed: false,
    deliveryId: null,
    status: null,
    outcome: null,
    errorCode: null,
  };
}

function acknowledgedDelivery(): WebhookProcessResult {
  return {
    processed: true,
    deliveryId: "11111111-1111-4111-8111-111111111111",
    status: "ACKNOWLEDGED",
    outcome: "ACKNOWLEDGED",
    errorCode: null,
  };
}

function failedDelivery(): WebhookProcessResult {
  return {
    processed: true,
    deliveryId: "22222222-2222-4222-8222-222222222222",
    status: "RETRY_WAIT",
    outcome: "RETRYABLE_FAILURE",
    errorCode: "transport_timeout",
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

function sequenceClock(...values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("webhook scheduler test clock exhausted");
    index += 1;
    return value;
  };
}
