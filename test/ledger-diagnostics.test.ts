import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import { AlipayProviderError } from "../src/infrastructure/alipay/errors.ts";
import { LedgerIngestService } from "../src/ledger/service.ts";
import { readLedgerFailureDiagnostic, type LedgerDiagnostics } from "../src/ledger/diagnostics.ts";
import type { AccountLogDetail, AccountLogPage, AccountLogPageRequest } from "../src/infrastructure/alipay/types.ts";
import { createApp } from "../src/http/app.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const NOW = Date.parse("2026-08-14T12:00:00+08:00");
const identity = { providerAccountKey: "primary", providerKind: "alipay", endpoint: "https://openapi.alipay.com", externalAccountId: "2026000000000000" } as const;
function page(request: AccountLogPageRequest, details: AccountLogDetail[] = []): AccountLogPage {
  return { pageNo: 1, pageSize: request.pageSize, totalSize: details.length, hasMore: false, details, traceId: "diagnostic-test",
    rawResponse: { status: 200, headers: {}, body: '{"private_evidence":"never-expose"}', traceId: "diagnostic-test", signatureVerified: true } };
}
function detail(occurredAt: string): AccountLogDetail {
  return { raw: { private: "never-expose" }, accountLogId: "duplicate-id", occurredAt, amount: "1.00", direction: "CREDIT", alipayOrderNo: null, merchantOrderNo: null, transMemo: null, otherAccount: null };
}

describe("persisted ingestion diagnostics", () => {
  for (const failure of ["outside", "duplicate", "shape"] as const) {
    it(`retains controlled ${failure} reasons across restart and clears only after accepted progress`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-ingest-diagnostic-"));
      const path = join(directory, "db.sqlite3"); let database = await AppDatabase.open(path);
      try {
        let store = new LedgerStore(database); store.bindProviderIdentity(identity, NOW);
        let now = NOW; let bad = true;
        const windows: string[] = [];
        const provider = { queryPage: async (request: AccountLogPageRequest) => {
          windows.push(`${request.startTime}/${request.endTime}`);
          if (!bad) return page(request);
          if (failure === "shape") return { ...page(request), details: null } as unknown as AccountLogPage;
          return page(request, failure === "outside" ? [detail("2000-01-01 00:00:00")] : [detail(request.startTime), detail(request.startTime)]);
        } };
        let service = new LedgerIngestService({ provider, store, pageSize: 2, clock: () => now });
        for (let i = 1; i <= 3; i++) {
          const result = await service.run("diagnostic-test");
          assert.equal(result.errorCode, "pagination_invalid");
          const diagnostic = readLedgerFailureDiagnostic(database, "primary");
          assert.equal(diagnostic.consecutiveFailures, i);
          assert.ok(diagnostic.latestFailure?.ingest_segment_id);
          assert.equal(diagnostic.latestFailure?.scan_kind, "NORMAL");
          assert.match(diagnostic.latestFailure!.reason, failure === "outside" ? /超出/ : failure === "duplicate" ? /重复/ : /结构/);
          assert.doesNotMatch(JSON.stringify(diagnostic), /never-expose|private_evidence|headers_json|raw_body/);
          now += 20 * 60_000;
        }
        assert.equal(new Set(windows).size, 1);
        assert.equal(store.listLedgerEntries().length, 0);
        database.close(); database = await AppDatabase.open(path); store = new LedgerStore(database);
        assert.equal(readLedgerFailureDiagnostic(database, "primary").consecutiveFailures, 3);
        bad = false; service = new LedgerIngestService({ provider, store, pageSize: 2, clock: () => now });
        assert.equal((await service.run("recovered")).status, "COMPLETED");
        assert.equal(new Set(windows).size, 1);
        assert.deepEqual(readLedgerFailureDiagnostic(database, "primary"), { consecutiveFailures: 0, latestFailure: null });
        const evidence = database.read(c => c.prepare("SELECT count(*) AS count, sum(raw_body IS NOT NULL) AS bodies FROM ingest_errors").get()) as { count: bigint; bodies: bigint };
        assert.equal(Number(evidence.count), 3); assert.equal(Number(evidence.bodies), 3);
      } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }

  it("identifies compensation failures without claiming the normal lane stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-compensation-diagnostic-"));
    const database = await AppDatabase.open(join(directory, "db.sqlite3"));
    try {
      const store = new LedgerStore(database); store.bindProviderIdentity(identity, NOW);
      let now = NOW; let bad = false;
      const service = new LedgerIngestService({ store, pageSize: 2, clock: () => now,
        provider: { queryPage: async request => page(request, bad ? [detail("2000-01-01 00:00:00")] : []) } });
      assert.equal((await service.run("baseline")).status, "COMPLETED");
      now += 70_000; bad = true;
      assert.equal((await service.run("compensation-failed")).status, "FAILED");
      assert.equal(readLedgerFailureDiagnostic(database, "primary").latestFailure?.scan_kind, "COMPENSATION_10M");
      now += 20 * 60_000; bad = false;
      assert.equal((await service.run("normal-interleaved")).normalCompleted, true);
      assert.equal(readLedgerFailureDiagnostic(database, "primary").consecutiveFailures, 0);
      assert.equal(store.getCursor("primary", "COMPENSATION")?.complete, false);
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("exposes diagnostics only to administrators and never guesses the worker's retry time", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-diagnostic-http-"));
    const secret = Buffer.alloc(32, 7);
    const services = await createConfiguredHttpServices({ directory, apiSecret: secret.toString("base64url"), collectionCodePayload: "https://qr.alipay.com/diagnostic-test" });
    try {
      const snapshot = services.settings.snapshot(); const account = snapshot.activeProviderAccountKey!;
      const store = new LedgerStore(services.database);
      const now = Date.now();
      const run = store.startIngestRun({ providerAccountKey: account, start: "2026-08-14 11:00:00", end: "2026-08-14 12:00:00", pageSize: 2, now });
      const segment = store.getNextPendingSegment(run.ingestRunId)!;
      for (let i = 0; i < 3; i++) store.recordIngestError({ ingestRunId: run.ingestRunId, errorKind: "transient", errorCode: "pagination_invalid", retryable: true, preserveRun: true,
        retrySchedule: { intervalMilliseconds: 10_000 }, now: now + i,
        details: { ingest_segment_id: segment.ingestSegmentId, validation_reason: "event_outside_window", untrusted_text: "never-expose" } });
      let inFlight = false; let state: "degraded" | "stopped" = "degraded"; let transitioning = false;
      let planned: number | null = now + 50_000;
      const app = createApp({ ...services, ledger: store, startedAt: new Date(),
        runtimeStatus: () => ({ configured: true, transitioning, paymentRevision: snapshot.paymentRevision, activeProviderAccountKey: account, scanIntervalMilliseconds: 10_000, maximumSuccessAgeMilliseconds: 60_000 }),
        ledgerHealth: () => ({ enabled: true, state, inFlight, paymentRevision: snapshot.paymentRevision, lastAttemptAt: null, lastSuccessAt: null, lastErrorCode: null, consecutiveFailures: 0 }),
        ledgerNextRunAt: () => planned,
      });
      const login = await services.identity.login(HTTP_TEST_ADMIN_PASSWORD);
      const admin = () => app.request("/api/admin/v1/system/status", { headers: { cookie: `perpay_session=${login.sessionToken}` } });
      const diagnostics = async () => {
        const response = await admin(); assert.equal(response.status, 200);
        return (await response.json() as { data: { ledger: { diagnostics: LedgerDiagnostics } } }).data.ledger.diagnostics;
      };
      assert.equal((await app.request("/api/admin/v1/system/status")).status, 401);
      const initial = await diagnostics();
      assert.equal(initial.consecutive_failures, 3); assert.equal(initial.next_retry_at, new Date(planned).toISOString());
      assert.doesNotMatch(JSON.stringify(initial), /never-expose/);
      inFlight = true; assert.equal((await diagnostics()).next_retry_at, null);
      inFlight = false; state = "stopped"; assert.equal((await diagnostics()).next_retry_at, null);
      state = "degraded"; transitioning = true; assert.equal((await diagnostics()).next_retry_at, null);
      transitioning = false; planned = null; assert.equal((await diagnostics()).next_retry_at, null);
      const target = "/api/v1/system/status";
      const signed = signApiRequest({ secret, method: "GET", target, body: Buffer.alloc(0), clientId: "default", timestamp: String(Math.floor(Date.now() / 1000)), nonce: Buffer.alloc(32, 11).toString("base64url") });
      const merchant = await app.request(target, { headers: { "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature } });
      assert.equal(merchant.status, 200); assert.doesNotMatch(await merchant.text(), /diagnostics|event_outside_window|ingest_segment_id/);
      assert.doesNotMatch(await (await app.request("/healthz")).text(), /diagnostics|ingest_segment_id/);
      const connection = services.database.read(c => c); const prepare = connection.prepare.bind(connection);
      t.mock.method(connection, "prepare", (sql: string) => {
        if (sql.startsWith("SELECT consecutive_failures, last_error_code")) throw new Error("diagnostics unavailable");
        return prepare(sql);
      });
      assert.deepEqual(await diagnostics(), { available: false, consecutive_failures: null, latest_failure: null, in_flight: false, next_retry_at: null });
    } finally { services.database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("hides storage retry timers and reports the original provider deadline only after recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-diagnostic-storage-http-"));
    const services = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/diagnostic-storage" });
    let scheduler: LedgerIngestScheduler | undefined;
    let writeFails = true;
    let finishScan!: () => void;
    const pendingScan = new Promise<void>(resolve => { finishScan = resolve; });
    try {
      const ledger = new LedgerStore(services.database);
      const account = services.settings.snapshot().activeProviderAccountKey!;
      let now = Date.now(); const start = now; let providerCalls = 0;
      const timers = new Map<NodeJS.Timeout, { at: number; callback: () => void }>();
      const service = new LedgerIngestService({ store: ledger, providerAccountKey: account, pageSize: 2, clock: () => now,
        provider: { queryPage: async request => {
          providerCalls++;
          if (providerCalls === 1) throw new AlipayProviderError({ kind: "rate_limited", code: "remote_rate_limited", message: "controlled rate limit", retryAfterSeconds: 120 });
          await pendingScan;
          return page(request);
        } },
      });
      scheduler = new LedgerIngestScheduler({ service, intervalMilliseconds: 10_000, minimumIntervalMilliseconds: 5_000, clock: () => now,
        gate: { read: () => null, write: () => { if (writeFails) throw new Error("controlled storage failure"); } },
        setTimeout: (callback, delay) => { const timer = { unref() {} } as NodeJS.Timeout; timers.set(timer, { at: now + delay, callback }); return timer; },
        clearTimeout: timer => { timers.delete(timer); },
      });
      const tick = async (milliseconds: number) => {
        now += milliseconds;
        for (const [timer, task] of [...timers]) if (task.at <= now) { timers.delete(timer); task.callback(); }
        await new Promise<void>(resolve => setImmediate(resolve));
      };
      scheduler.start(); await assert.rejects(scheduler.trigger("join-startup"), /controlled storage failure/);
      const app = createApp({ ...services, ledger, startedAt: new Date(),
        ledgerHealth: () => ({ enabled: true, ...scheduler!.health() }),
        ledgerNextRunAt: () => scheduler!.nextScanAt(),
      });
      const auth = await services.identity.login(HTTP_TEST_ADMIN_PASSWORD);
      const diagnostics = async () => {
        const response = await app.request("/api/admin/v1/system/status", { headers: { cookie: "perpay_session=" + auth.sessionToken } });
        assert.equal(response.status, 200);
        return (await response.json() as { data: { ledger: { diagnostics: LedgerDiagnostics } } }).data.ledger.diagnostics;
      };
      assert.equal(scheduler.nextRunAt(), start + 5_000);
      assert.equal(ledger.getIngestScheduleState(account)?.cooldownUntil, start + 120_000);
      assert.equal((await diagnostics()).latest_failure?.error_code, "remote_rate_limited");
      assert.equal((await diagnostics()).next_retry_at, null);
      // Repeated storage retries remain hidden, without adding a provider request.
      await tick(5_000); assert.equal((await diagnostics()).next_retry_at, null);
      assert.equal(providerCalls, 1);
      writeFails = false; await tick(5_000);
      assert.equal(providerCalls, 1);
      assert.equal((await diagnostics()).next_retry_at, new Date(start + 120_000).toISOString());
      const manual = scheduler.trigger("checkout");
      await tick(109_999); assert.equal(providerCalls, 1);
      await tick(1); assert.equal(providerCalls, 2);
      assert.equal((await diagnostics()).in_flight, true);
      assert.equal((await diagnostics()).next_retry_at, null);
      finishScan(); await manual;
      assert.equal((await diagnostics()).consecutive_failures, 0);
      assert.equal(scheduler.nextScanAt(), start + 130_000);
      await scheduler.stop(); assert.equal((await diagnostics()).next_retry_at, null);
    } finally {
      writeFails = false; finishScan(); await scheduler?.stop();
      services.database.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("perpay-diagnostic-storage-http-"));
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
