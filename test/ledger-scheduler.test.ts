import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import type { LedgerIngestService, LedgerScanResult } from "../src/ledger/service.ts";

const START = 2_000_000_000_000;

describe("adaptive ledger scheduler", () => {
  it("shortens the idle wait without postponing it on repeated order notifications", async () => {
    await withScheduler(async ({ scheduler, timers, calls, interval }) => {
      assert.equal(calls.length, 1);
      assert.equal(timers.nextAt, START + 30_000);
      await timers.advance(1_000);
      interval.value = 5_000;
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 6_000);
      await timers.advance(1_000);
      for (let i = 0; i < 100; i += 1) scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 6_000);
      assert.equal(timers.size, 1);
      assert.equal(calls.length, 1);
      await timers.advance(4_000);
      assert.deepEqual(calls.map((call) => call.at), [START, START + 6_000]);
      assert.equal(timers.nextAt, START + 11_000);
      await timers.advance(5_000);
      assert.equal(calls.length, 3);
    });
  });

  it("keeps a sooner existing deadline when an order arrives near an idle tick", async () => {
    await withScheduler(async ({ scheduler, timers, interval, calls }) => {
      await timers.advance(29_000);
      interval.value = 5_000;
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 30_000);
      await timers.advance(1_000);
      assert.equal(calls.length, 2);
      assert.equal(timers.nextAt, START + 35_000);
    });
  });

  it("returns to the normal interval measured from completion, without resetting on notifications", async () => {
    await withScheduler(async ({ scheduler, timers, interval, calls }) => {
      interval.value = 5_000;
      scheduler.refreshSchedule();
      await timers.advance(5_000);
      interval.value = 30_000;
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 35_000);
      await timers.advance(10_000);
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 35_000);
      assert.equal(calls.length, 2);
      await timers.advance(20_000);
      assert.equal(calls.length, 3);
    });
  });

  it("rechecks expiry or tail completion at the timer even without a notification", async () => {
    await withScheduler(async ({ scheduler, timers, interval, calls }) => {
      interval.value = 5_000;
      scheduler.refreshSchedule();
      interval.value = 30_000;
      await timers.advance(5_000);
      assert.equal(calls.length, 1);
      assert.equal(timers.nextAt, START + 30_000);
      await timers.advance(25_000);
      assert.equal(calls.length, 2);
    });
  });

  it("coalesces orders during an in-flight scan and waits from its eventual completion", async () => {
    let complete!: (result: LedgerScanResult) => void;
    const pending = new Promise<LedgerScanResult>((resolve) => { complete = resolve; });
    await withScheduler(async ({ scheduler, timers, interval, calls }) => {
      interval.value = 5_000;
      scheduler.refreshSchedule();
      scheduler.refreshSchedule();
      assert.equal(timers.size, 0);
      assert.equal(calls.length, 1);
      const sameScan = scheduler.trigger("manual-overlap");
      await timers.advance(7_000);
      assert.equal(calls.length, 1);
      complete(result());
      await sameScan;
      assert.equal(timers.nextAt, START + 12_000);
      await timers.advance(5_000);
      assert.equal(calls.length, 2);
    }, [() => pending]);
  });

  for (const [name, outcome, delay] of [
    ["Retry-After", result({ status: "FAILED", retryable: true, retryAfterSeconds: 90 }), 90_000],
    ["non-retryable cooldown", result({ status: "FAILED", errorCode: "forbidden" }), 900_000],
    ["durable cooldown", result({ status: "FAILED", retryable: true, cooldownActive: true, retryAfterSeconds: 12 }), 12_000],
    ["pagination variant retry", result({ status: "FAILED", retryable: true, errorCode: "pagination_variant", retryAfterSeconds: 7 }), 7_000],
    ["unexpected failure", new Error("scan failed outside provider handling"), 30_000],
  ] as const) {
    it("keeps the " + name + " deadline when orders arrive", async () => {
      await withScheduler(async ({ scheduler, timers, interval, calls }) => {
        assert.equal(timers.nextAt, START + delay);
        await timers.advance(1_000);
        interval.value = 5_000;
        for (let i = 0; i < 10; i += 1) scheduler.refreshSchedule();
        assert.equal(timers.nextAt, START + delay);
        assert.equal(calls.length, 1);
        await timers.advance(delay - 1_001);
        assert.equal(calls.length, 1);
        await timers.advance(1);
        assert.equal(calls.length, 2);
        assert.equal(timers.nextAt, START + delay + 5_000);
      }, [outcome]);
    });
  }

  it("retains the failure count across activity changes and backs off subsequent failures", async () => {
    const failure = result({ status: "FAILED", retryable: true, errorCode: "transport_network" });
    await withScheduler(async ({ scheduler, timers, interval }) => {
      interval.value = 5_000;
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 30_000);
      await timers.advance(30_000);
      assert.equal(scheduler.health().consecutiveFailures, 2);
      assert.equal(timers.nextAt, START + 40_000);
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 40_000);
    }, [failure, failure]);
  });

  it("does not replace an immediate compensation continuation with an active wait", async () => {
    await withScheduler(async ({ scheduler, timers, interval, calls }) => {
      assert.equal(timers.nextAt, START);
      interval.value = 5_000;
      scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START);
      await timers.advance(0);
      assert.equal(calls.length, 2);
      assert.equal(timers.nextAt, START + 5_000);
    }, [result({ status: "PARTIAL" })]);
  });

  it("keeps fixed cadence when both intervals match and cancels all timers on shutdown", async () => {
    await withScheduler(async ({ scheduler, timers, calls }) => {
      for (let i = 0; i < 10; i += 1) scheduler.refreshSchedule();
      assert.equal(timers.nextAt, START + 30_000);
      await timers.advance(30_000);
      assert.equal(calls.length, 2);
      await scheduler.stop();
      assert.equal(timers.size, 0);
      scheduler.refreshSchedule();
      await timers.advance(60_000);
      assert.equal(calls.length, 2);
    });
  });
});

class ManualTimers {
  now = START;
  readonly #timers = new Map<NodeJS.Timeout, { readonly at: number; readonly callback: () => void }>();

  readonly setTimeout = (callback: () => void, delay: number): NodeJS.Timeout => {
    assert.ok(Number.isSafeInteger(delay) && delay >= 0);
    const timer = { unref() {} } as NodeJS.Timeout;
    this.#timers.set(timer, { at: this.now + delay, callback });
    return timer;
  };

  readonly clearTimeout = (timer: NodeJS.Timeout): void => { this.#timers.delete(timer); };

  get nextAt(): number | null {
    return this.#timers.size === 0 ? null : Math.min(...[...this.#timers.values()].map((timer) => timer.at));
  }

  get size(): number { return this.#timers.size; }

  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    let iterations = 0;
    while (true) {
      const next = [...this.#timers].sort(([, left], [, right]) => left.at - right.at)[0];
      if (!next || next[1].at > target) break;
      assert.ok(iterations++ < 100, "scheduler must not create a busy loop");
      this.now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

type Outcome = LedgerScanResult | Error | (() => Promise<LedgerScanResult>);

async function withScheduler(
  operation: (context: {
    readonly scheduler: LedgerIngestScheduler;
    readonly timers: ManualTimers;
    readonly calls: Array<{ readonly at: number; readonly reason: string }>;
    readonly interval: { value: number };
  }) => Promise<void>,
  outcomes: readonly Outcome[] = [],
): Promise<void> {
  const timers = new ManualTimers();
  const calls: Array<{ at: number; reason: string }> = [];
  const interval = { value: 30_000 };
  const pending = [...outcomes];
  const service = {
    async run(reason: string) {
      calls.push({ at: timers.now, reason });
      const outcome = pending.shift() ?? result();
      if (outcome instanceof Error) throw outcome;
      return typeof outcome === "function" ? outcome() : outcome;
    },
    stop() {},
    async waitForIdle() {},
  } as unknown as LedgerIngestService;
  const scheduler = new LedgerIngestScheduler({
    service,
    intervalMilliseconds: 30_000,
    getIntervalMilliseconds: () => interval.value,
    clock: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  scheduler.start();
  await flush();
  try {
    await operation({ scheduler, timers, calls, interval });
  } finally {
    await scheduler.stop();
    assert.equal(timers.size, 0);
  }
}

function result(overrides: Partial<LedgerScanResult> = {}): LedgerScanResult {
  return {
    status: "COMPLETED", reason: "test", ingestRunId: null, pages: 0, details: 0,
    createdEntries: 0, duplicateEntries: 0, isolatedDetails: 0, conflicts: 0,
    errorCode: null, retryAfterSeconds: null, retryable: false,
    normalCompleted: true, cooldownActive: false, ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
