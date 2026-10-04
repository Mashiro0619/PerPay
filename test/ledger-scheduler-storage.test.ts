import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import type { LedgerIngestService, LedgerScanResult } from "../src/ledger/service.ts";
import type { LedgerScanGate } from "../src/ledger/scan-gate.ts";

const START = 2_000_000_000_000;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const completed = (overrides: Partial<LedgerScanResult> = {}): LedgerScanResult => ({
  status: "COMPLETED", reason: "test", ingestRunId: null, pages: 1, details: 0,
  createdEntries: 0, duplicateEntries: 0, isolatedDetails: 0, conflicts: 0,
  errorCode: null, retryAfterSeconds: null, retryable: false,
  normalCompleted: true, cooldownActive: false, ...overrides,
});

class Clock {
  now = START;
  readonly timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
  set = (callback: () => void, delay: number): NodeJS.Timeout => {
    assert.ok(Number.isFinite(delay) && delay >= 0);
    const timer = { unref() {} } as NodeJS.Timeout;
    this.timers.set(timer, { at: this.now + delay, callback });
    return timer;
  };
  clear = (timer: NodeJS.Timeout) => { this.timers.delete(timer); };
  get nextAt(): number | null {
    return this.timers.size ? Math.min(...[...this.timers.values()].map(t => t.at)) : null;
  }
  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (let count = 0; ; count++) {
      assert.ok(count < 200, "storage recovery must not spin");
      const first = [...this.timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!first || first[1].at > target) break;
      this.now = first[1].at;
      this.timers.delete(first[0]);
      first[1].callback(); // A synchronous exception here must fail the test.
      await flush();
    }
    this.now = target;
    await flush();
  }
}

function fixture(outcomes: LedgerScanResult[] = [], minimumIntervalMilliseconds = 5000) {
  const clock = new Clock();
  const state = {
    readFails: false, writeFails: false, observerThrows: false, reads: 0, writes: 0,
    calls: [] as number[], saved: null as LedgerScanGate | null, errors: [] as unknown[],
  };
  const pending = [...outcomes];
  const service = {
    async run() { state.calls.push(clock.now); return pending.shift() ?? completed(); },
    stop() {}, async waitForIdle() {},
  } as unknown as LedgerIngestService;
  const scheduler = new LedgerIngestScheduler({
    service, intervalMilliseconds: 8000, minimumIntervalMilliseconds,
    clock: () => clock.now, setTimeout: clock.set, clearTimeout: clock.clear,
    gate: {
      read() { state.reads++; if (state.readFails) throw new Error("gate read unavailable"); return state.saved; },
      write(value) { state.writes++; if (state.writeFails) throw new Error("gate write unavailable"); state.saved = value; },
    },
    onUnexpectedError(error) { state.errors.push(error); if (state.observerThrows) throw new Error("observer failed"); },
  });
  return { scheduler, clock, state };
}

describe("ledger scheduler storage recovery", () => {
  it("contains startup read errors and waits for the recovered durable deadline", async () => {
    const { scheduler, clock, state } = fixture();
    state.readFails = true;
    state.observerThrows = true;
    try {
      assert.doesNotThrow(() => scheduler.start());
      await flush();
      assert.equal(clock.nextAt, START + 5000);
      const reads = state.reads;
      for (let index = 0; index < 10; index++) await assert.rejects(scheduler.trigger("checkout"));
      assert.equal(state.reads, reads);
      assert.equal(clock.nextAt, START + 5000);
      state.saved = { completedAt: START, protectedUntil: START + 60000, continuation: false };
      state.readFails = false;
      await clock.advance(5000);
      assert.equal(clock.nextAt, START + 60000);
      assert.deepEqual(state.calls, []);
      await clock.advance(55000);
      assert.deepEqual(state.calls, [START + 60000]);
    } finally { state.readFails = false; await scheduler.stop(); }
  });

  it("contains automatic-tick read errors and keeps exactly one recovery timer", async () => {
    const { scheduler, clock, state } = fixture();
    try {
      scheduler.start(); await flush();
      state.readFails = true;
      await clock.advance(8000);
      assert.equal(scheduler.health().lastErrorCode, "scan_schedule_unavailable");
      assert.equal(clock.nextAt, START + 13000);
      assert.equal(clock.timers.size, 1);
      await clock.advance(10000);
      assert.deepEqual(state.calls, [START]);
      assert.equal(clock.timers.size, 1);
      state.readFails = false;
      await clock.advance(5000);
      assert.deepEqual(state.calls, [START, START + 23000]);
      assert.equal(scheduler.health().state, "healthy");
    } finally { state.readFails = false; await scheduler.stop(); }
  });

  it("rejects a queued checkout on read failure instead of leaving its promise pending", async () => {
    const { scheduler, clock, state } = fixture();
    try {
      scheduler.start(); await flush(); await clock.advance(4000);
      const check = scheduler.trigger("checkout").then(() => "resolved", error => (error as Error).message);
      state.readFails = true;
      await clock.advance(1000);
      assert.equal(await check, "gate read unavailable");
      assert.equal(clock.nextAt, START + 10000);
      state.readFails = false;
      await clock.advance(5000);
      assert.deepEqual(state.calls, [START, START + 10000]);
    } finally { state.readFails = false; await scheduler.stop(); }
  });

  it("retains the completion anchor and restores the original normal deadline after a write failure", async () => {
    const { scheduler, clock, state } = fixture();
    state.writeFails = true;
    try {
      scheduler.start(); await flush();
      assert.equal(state.writes, 1, "do not immediately retry the same failed write from catch");
      assert.equal(clock.nextAt, START + 5000);
      state.writeFails = false;
      await clock.advance(5000);
      assert.equal(state.saved?.completedAt, START);
      assert.equal(scheduler.health().state, "healthy");
      assert.equal(scheduler.health().lastErrorCode, null);
      assert.equal(clock.nextAt, START + 8000);
      assert.deepEqual(state.calls, [START]);
      await clock.advance(3000);
      assert.deepEqual(state.calls, [START, START + 8000]);
    } finally { state.writeFails = false; await scheduler.stop(); }
  });

  it("keeps waiting callers bounded and resumes automatically after repeated write failures", async () => {
    const { scheduler, clock, state } = fixture();
    try {
      scheduler.start(); await flush(); await clock.advance(4000);
      const check = scheduler.trigger("checkout").then(() => "resolved", error => (error as Error).message);
      state.writeFails = true;
      await clock.advance(1000);
      assert.equal(await check, "gate write unavailable");
      assert.equal(clock.nextAt, START + 10000);
      await clock.advance(10000);
      assert.deepEqual(state.calls, [START, START + 5000]);
      assert.equal(clock.timers.size, 1);
      state.writeFails = false;
      await clock.advance(5000);
      assert.deepEqual(state.calls, [START, START + 5000, START + 20000]);
      assert.equal(scheduler.health().state, "healthy");
    } finally { state.writeFails = false; await scheduler.stop(); }
  });

  it("does not lose or extend a real provider retry deadline while persisting it later", async () => {
    const { scheduler, clock, state } = fixture([completed({status:"FAILED",errorCode:"rate_limited",retryable:true,retryAfterSeconds:60,normalCompleted:false})]);
    state.writeFails = true;
    try {
      scheduler.start(); await flush();
      state.writeFails = false;
      await clock.advance(5000);
      assert.equal(state.saved?.protectedUntil, START + 60000);
      assert.equal(scheduler.health().lastErrorCode, "rate_limited");
      const manual = scheduler.trigger("checkout");
      assert.equal(clock.nextAt, START + 60000);
      await clock.advance(54999);
      assert.deepEqual(state.calls, [START]);
      await clock.advance(1); await manual;
      assert.deepEqual(state.calls, [START, START + 60000]);
    } finally { state.writeFails = false; await scheduler.stop(); }
  });

  it("restores a partial continuation without adding a new minimum interval from recovery time", async () => {
    const { scheduler, clock, state } = fixture([completed({status:"PARTIAL",normalCompleted:false})], 8000);
    state.writeFails = true;
    try {
      scheduler.start(); await flush();
      state.writeFails = false;
      await clock.advance(5000);
      assert.deepEqual(state.calls, [START, START + 5000]);
      assert.equal(clock.nextAt, START + 13000);
    } finally { state.writeFails = false; await scheduler.stop(); }
  });

  it("does not restart after stop and reports an unflushed deadline until a final flush succeeds", async () => {
    const { scheduler, clock, state } = fixture([completed({status:"FAILED",errorCode:"rate_limited",retryable:true,retryAfterSeconds:60,normalCompleted:false})]);
    state.writeFails = true;
    scheduler.start(); await flush();
    await assert.rejects(scheduler.stop(), /gate write unavailable/);
    assert.equal(clock.timers.size, 0);
    await clock.advance(20000);
    assert.deepEqual(state.calls, [START]);
    state.writeFails = false;
    await scheduler.stop();
    assert.equal(state.saved?.completedAt, START);
    assert.equal(state.saved?.protectedUntil, START + 60000);
    assert.equal(clock.timers.size, 0);
  });
});
