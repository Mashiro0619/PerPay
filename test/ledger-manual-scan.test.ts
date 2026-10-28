import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { LedgerManualScanner } from "../src/runtime/ledger-manual-scan.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import type { LedgerIngestService, LedgerScanResult } from "../src/ledger/service.ts";
import type { LedgerScanGate } from "../src/ledger/scan-gate.ts";

const START = 2_000_000_000_000;
const result = (overrides: Partial<LedgerScanResult> = {}): LedgerScanResult => ({
  status: "COMPLETED", reason: "test", ingestRunId: "run-1", pages: 1, details: 0,
  createdEntries: 0, duplicateEntries: 0, isolatedDetails: 0, conflicts: 0,
  errorCode: null, retryAfterSeconds: null, retryable: false,
  normalCompleted: true, cooldownActive: false, ...overrides,
});
function fixture(first = result()) {
  let now = START, saved: LedgerScanGate | null = null, readFails = false;
  const timers = new Map<NodeJS.Timeout, { at: number; run: () => void }>();
  const calls: number[] = [];
  const scheduler = new LedgerIngestScheduler({
    service: { async run() { calls.push(now); return calls.length === 1 ? first : result(); }, stop() {}, async waitForIdle() {} } as unknown as LedgerIngestService,
    intervalMilliseconds: 30_000, minimumIntervalMilliseconds: 5000, clock: () => now,
    gate: { read() { if (readFails) throw Error("private storage error"); return saved; }, write(value) { saved = value; } },
    setTimeout(run, delay) { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + delay, run }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const manual = new LedgerManualScanner(() => now);
  return { scheduler, manual, calls, timers, failStorage() { readFails = true; }, recoverStorage() { readFails = false; },
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      for (let count = 0; count < 100; count++) {
        const first = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
        if (!first || first[1].at > target) break;
        now = first[1].at; timers.delete(first[0]); first[1].run(); await setImmediate();
      }
      now = target; await setImmediate();
    },
  };
}

describe("administrator manual ledger scan", () => {
  it("advances a normal wait to the permitted minimum, coalesces clicks and retains a fast result", async () => {
    const f = fixture(); f.scheduler.start(); await setImmediate();
    try {
      await f.advance(1000);
      const accepted = f.manual.request(f.scheduler, () => true);
      assert.equal(accepted.state, "WAITING");
      assert.equal(accepted.next_attempt_at, new Date(START + 5000).toISOString());
      assert.equal(f.manual.request(f.scheduler, () => true).id, accepted.id);
      assert.equal(f.timers.size, 1);
      await f.advance(3999); assert.equal(f.calls.length, 1);
      await f.advance(1); assert.deepEqual(f.calls, [START, START + 5000]);
      assert.equal(accepted.state, "WAITING", "accepted snapshot must not mutate later");
      assert.equal(f.manual.get()?.state, "COMPLETED");
      assert.equal(f.manual.get()?.outcome, "COMPLETED");
      assert.equal(f.manual.get()?.ingest_run_id, "run-1");
      assert.equal(f.manual.get()?.started_at, new Date(START + 5000).toISOString());
      await f.advance(1000); assert.equal(f.manual.get()?.id, accepted.id);
    } finally { await f.scheduler.stop(); }
  });

  for (const [name, initial, deadline] of [
    ["provider Retry-After", result({ status: "FAILED", retryable: true, retryAfterSeconds: 90 }), 90_000],
    ["nonretryable cooldown", result({ status: "FAILED", errorCode: "forbidden" }), 900_000],
    ["automatic failure backoff", result({ status: "FAILED", retryable: true, errorCode: "transport_network" }), 30_000],
  ] as const) it("preserves " + name, async () => {
    const f = fixture(initial); f.scheduler.start(); await setImmediate();
    try {
      await f.advance(1000);
      const accepted = f.manual.request(f.scheduler, () => true);
      assert.equal(accepted.next_attempt_at, new Date(START + deadline).toISOString());
      for (let i = 0; i < 10; i++) assert.equal(f.manual.request(f.scheduler, () => true).id, accepted.id);
      await f.advance(deadline - 1001); assert.equal(f.calls.length, 1);
      await f.advance(1); assert.equal(f.calls.length, 2);
      assert.equal(f.manual.get()?.state, "COMPLETED");
    } finally { await f.scheduler.stop(); }
  });

  it("records storage failures without provider calls or exposing raw errors", async () => {
    const f = fixture(); f.scheduler.start(); await setImmediate();
    try {
      await f.advance(1000); f.failStorage();
      f.manual.request(f.scheduler, () => true); await setImmediate();
      assert.equal(f.manual.get()?.state, "FAILED");
      assert.equal(f.manual.get()?.error_code, "scan_schedule_unavailable");
      assert.equal(f.manual.get()?.started_at, null);
      assert.equal(f.calls.length, 1);
      assert.equal(f.scheduler.nextScanAt(), null);
    } finally { f.recoverStorage(); await f.scheduler.stop(); }
  });

  for (const status of ["COMPLETED", "PARTIAL", "FAILED", "SKIPPED"] as const) {
    it("retains actual " + status + " outcome and coalesces a running scan", async () => {
      let finish!: (value: LedgerScanResult) => void;
      let calls = 0;
      const pending = new Promise<LedgerScanResult>(resolve => { finish = resolve; });
      const scheduler = { trigger(reason: string) { assert.equal(reason, "admin_manual"); calls++; return pending; },
        health: () => ({ inFlight: true, lastAttemptAt: START, lastErrorCode: null }), nextScanAt: () => null } as unknown as LedgerIngestScheduler;
      const manual = new LedgerManualScanner(() => START + 1000);
      const accepted = manual.request(scheduler, () => true);
      assert.equal(accepted.state, "RUNNING");
      assert.equal(manual.request(scheduler, () => true).id, accepted.id);
      assert.equal(calls, 1);
      finish(result({ status, errorCode: status === "FAILED" ? "provider_rate_limited" : null })); await setImmediate();
      assert.equal(manual.get()?.state, status === "FAILED" ? "FAILED" : "COMPLETED");
      assert.equal(manual.get()?.outcome, status);
      assert.equal(manual.get()?.next_attempt_at, null);
    });
  }

  it("invalidates an old runtime immediately and ignores its late completion", async () => {
    let finish!: (value: LedgerScanResult) => void, current = true;
    const old = { trigger: () => new Promise<LedgerScanResult>(resolve => { finish = resolve; }),
      health: () => ({ inFlight: true, lastAttemptAt: START, lastErrorCode: null }), nextScanAt: () => null } as unknown as LedgerIngestScheduler;
    const manual = new LedgerManualScanner(() => START + 1000);
    const accepted = manual.request(old, () => current);
    current = false; manual.invalidate();
    assert.equal(manual.get()?.state, "FAILED");
    assert.equal(manual.get()?.error_code, "runtime_changed");
    const newer = manual.request({ ...old, trigger: async () => result({ ingestRunId: "new-account" }) } as unknown as LedgerIngestScheduler, () => true);
    finish(result()); await setImmediate();
    assert.notEqual(newer.id, accepted.id);
    assert.equal(manual.get()?.ingest_run_id, "new-account");
  });

  it("clears a previous completed scan when its runtime is replaced", async () => {
    const f = fixture(); f.scheduler.start(); await setImmediate();
    try {
      f.manual.request(f.scheduler, () => true); await f.advance(5000);
      assert.equal(f.manual.get()?.state, "COMPLETED");
      f.manual.invalidate();
      assert.equal(f.manual.get(), null);
    } finally { await f.scheduler.stop(); }
  });
});
