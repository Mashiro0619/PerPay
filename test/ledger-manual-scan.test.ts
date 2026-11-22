import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AppDatabase } from "../src/database/database.ts";
import { AlipayProviderError } from "../src/infrastructure/alipay/errors.ts";
import { LedgerManualScanner } from "../src/runtime/ledger-manual-scan.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import { LedgerIngestService, type LedgerScanResult } from "../src/ledger/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ledgerScanGate, type LedgerScanGate } from "../src/ledger/scan-gate.ts";

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
  it("runs immediately without waiting for the minimum interval, coalesces in-flight clicks, and retains the result", async () => {
    let finishSecond!: (value: LedgerScanResult) => void;
    let now = START, saved: LedgerScanGate | null = null;
    const timers = new Map<NodeJS.Timeout, { at: number; run: () => void }>();
    const calls: Array<{ at: number; reason: string }> = [];
    const scheduler = new LedgerIngestScheduler({
      service: {
        run(reason: string) {
          calls.push({ at: now, reason });
          if (calls.length === 1) return Promise.resolve(result());
          return new Promise<LedgerScanResult>(resolve => { finishSecond = resolve; });
        },
        stop() {},
        async waitForIdle() {},
      } as unknown as LedgerIngestService,
      intervalMilliseconds: 30_000, minimumIntervalMilliseconds: 5000, clock: () => now,
      gate: { read: () => saved, write(value) { saved = value; } },
      setTimeout(run, delay) { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + delay, run }); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
    });
    const manual = new LedgerManualScanner(() => now);
    scheduler.start(); await setImmediate();
    try {
      now = START + 1000;
      const accepted = manual.request(scheduler, () => true);
      assert.equal(accepted.state, "RUNNING");
      assert.equal(accepted.next_attempt_at, null);
      assert.equal(accepted.started_at, new Date(START + 1000).toISOString());
      assert.equal(manual.request(scheduler, () => true).id, accepted.id, "duplicate clicks while running must coalesce");
      assert.deepEqual(calls, [
        { at: START, reason: "startup" },
        { at: START + 1000, reason: "admin_manual" },
      ]);
      finishSecond(result({ ingestRunId: "run-manual" }));
      await setImmediate();
      assert.equal(accepted.state, "RUNNING", "accepted snapshot must not mutate later");
      assert.equal(manual.get()?.state, "COMPLETED");
      assert.equal(manual.get()?.outcome, "COMPLETED");
      assert.equal(manual.get()?.ingest_run_id, "run-manual");
      // A subsequent manual scan can be triggered immediately once finished.
      now = START + 1500;
      const again = manual.request(scheduler, () => true);
      assert.notEqual(again.id, accepted.id);
      assert.equal(again.state, "RUNNING");
      finishSecond(result({ ingestRunId: "run-manual-2" }));
      await setImmediate();
      assert.equal(manual.get()?.ingest_run_id, "run-manual-2");
    } finally { await scheduler.stop(); }
  });

  for (const [name, initial, deadline] of [
    ["provider Retry-After", result({ status: "FAILED", retryable: true, retryAfterSeconds: 90 }), 90_000],
    ["nonretryable cooldown", result({ status: "FAILED", errorCode: "forbidden" }), 900_000],
    ["automatic failure backoff", result({ status: "FAILED", retryable: true, errorCode: "transport_timeout" }), 30_000],
  ] as const) it("bypasses " + name + " immediately and clears persisted protection on success while keeping automatic scans backed off", async () => {
    const f = fixture(initial); f.scheduler.start(); await setImmediate();
    try {
      // Automatic/checkout trigger still respects the persisted failure backoff.
      await f.advance(1000);
      assert.equal(f.scheduler.nextScanAt(), START + deadline);
      void f.scheduler.trigger("checkout_check");
      await setImmediate();
      assert.equal(f.calls.length, 1, "public checkout checks must stay backed off");

      // Admin manual scan runs immediately without waiting for the backoff deadline.
      const accepted = f.manual.request(f.scheduler, () => true);
      assert.equal(accepted.state, "RUNNING");
      assert.equal(accepted.next_attempt_at, null);
      await setImmediate();
      assert.equal(f.calls.length, 2);
      assert.equal(f.manual.get()?.state, "COMPLETED");
      // Persisted protection is cleared on success so normal cadence resumes immediately.
      assert.equal(f.scheduler.health().state, "healthy");
      assert.equal(f.scheduler.nextScanAt(), START + 1000 + 30_000);
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
      f.manual.request(f.scheduler, () => true); await setImmediate();
      assert.equal(f.manual.get()?.state, "COMPLETED");
      f.manual.invalidate();
      assert.equal(f.manual.get(), null);
    } finally { await f.scheduler.stop(); }
  });

  it("bypasses persisted SQLite cooldown and scan gate after prolonged timeouts and restores normal scanning on success", async (context) => {
    const dir = mkdtempSync(join(tmpdir(), "perpay-manual-scan-recovery-"));
    const database = await AppDatabase.open(join(dir, "perpay.sqlite3"));
    context.after(() => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const store = new LedgerStore(database);
    const providerAccountKey = "primary";
    let now = START;
    store.bindProviderIdentity({
      providerAccountKey,
      providerKind: "alipay",
      endpoint: "https://openapi.alipay.com",
      externalAccountId: "2026000000000001",
    }, now);
    let ipRestored = false;
    let providerCalls = 0;

    const service = new LedgerIngestService({
      store,
      providerAccountKey,
      pageSize: 20,
      clock: () => now,
      scanIntervalMilliseconds: 60_000,
      safetyLagMilliseconds: 10_000,
      initialWindowStartMilliseconds: now - 60_000,
      provider: {
        async queryPage() {
          providerCalls += 1;
          if (!ipRestored) {
            throw new AlipayProviderError({
              kind: "timeout",
              code: "transport_timeout",
              message: "connect ETIMEDOUT",
            });
          }
          return {
            pageNo: 1,
            pageSize: 20,
            totalSize: 0,
            hasMore: false,
            details: [],
            traceId: "trace-manual-recovery",
            rawResponse: {
              status: 200,
              headers: { "alipay-request-id": "trace-manual-recovery" },
              body: JSON.stringify({ page: 1, total: 0 }),
              traceId: "trace-manual-recovery",
              signatureVerified: true,
            },
          };
        },
      },
    });

    const gate = ledgerScanGate(database, providerAccountKey);
    const timers = new Map<NodeJS.Timeout, { at: number; run: () => void }>();
    const scheduler = new LedgerIngestScheduler({
      service,
      gate,
      providerAccountKey,
      intervalMilliseconds: 60_000,
      minimumIntervalMilliseconds: 8_000,
      clock: () => now,
      setTimeout(run, delay) { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + delay, run }); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
    });

    const manual = new LedgerManualScanner(() => now);
    // Start while IP is blocked -> fails with transport_timeout and persists cooldown + scan gate
    scheduler.start();
    await setImmediate();
    await setImmediate();
    try {
      assert.equal(providerCalls, 1);
      assert.equal(scheduler.health().state, "degraded");
      const persistedSchedule = store.getIngestScheduleState(providerAccountKey);
      assert.ok(persistedSchedule !== null && persistedSchedule.cooldownUntil > now);
      assert.ok((gate.read()?.protectedUntil ?? 0) > now);

      // Push durable cooldown hours ahead to simulate days of IP outage
      database.write((connection) => {
        connection.prepare(
          "UPDATE ledger_ingest_schedule_state SET consecutive_failures = 12, cooldown_until = ? WHERE provider_account_key = ?",
        ).run(now + 6 * 3600_000, providerAccountKey);
      });
      gate.write({ completedAt: now, protectedUntil: now + 6 * 3600_000, continuation: false });

      // Public checkout check still respects the 6h persisted backoff
      void scheduler.trigger("checkout_check");
      await setImmediate();
      assert.equal(providerCalls, 1, "checkout check must stay backed off during 6h cooldown");

      // Operator restores IP and clicks manual scan -> runs immediately!
      ipRestored = true;
      now += 1_000;
      const accepted = manual.request(scheduler, () => true);
      assert.equal(accepted.state, "RUNNING");
      await setImmediate();
      await setImmediate();

      assert.equal(providerCalls, 2);
      assert.equal(manual.get()?.state, "COMPLETED");
      assert.equal(store.getIngestScheduleState(providerAccountKey), null, "durable schedule backoff must be cleared");
      assert.equal(gate.read()?.protectedUntil, 0, "persisted scan gate protection must be cleared");
      assert.equal(scheduler.health().consecutiveFailures, 0);
      assert.equal(scheduler.nextScanAt(), now, "continuation must run immediately instead of waiting for old 6h backoff");

      // Fire immediate continuation timer to finish catching up to safe tail
      const continuationTimer = [...timers.entries()][0];
      assert.ok(continuationTimer);
      timers.delete(continuationTimer[0]);
      continuationTimer[1].run();
      await setImmediate();
      await setImmediate();

      assert.equal(providerCalls, 3);
      assert.equal(scheduler.health().state, "healthy");
      assert.equal(scheduler.nextScanAt(), now + 60_000, "normal scan cadence must resume immediately");
    } finally {
      await scheduler.stop();
    }
  });
});
