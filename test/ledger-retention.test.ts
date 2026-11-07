import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { LedgerIngestService } from "../src/ledger/service.ts";
import { LedgerPageReconfirmationRequiredError, type IngestScanKind } from "../src/ledger/model.ts";
import { INGEST_RETENTION_BATCH_SIZE, INGEST_RETENTION_EVENT_BUDGET, INGEST_RETENTION_INTERVAL_MILLISECONDS } from "../src/ledger/retention.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.now();
const OLD = NOW - 10 * DAY;

describe("ingestion history retention", () => {
  it("reclaims old empty polls around payment evidence and continues monotonic ingestion", async () => {
    await fixture(async f => {
      for (let index = 0; index < 5; index++) f.poll();
      const evidence = f.poll({ payment: true });
      for (let index = 0; index < 5; index++) f.poll();
      const latest = f.poll({ now: NOW });
      const before = f.counts();

      const result = f.store.pruneIngestHistory(NOW);

      assert.equal(result.deletedRuns, 10);
      assert.equal(result.deletedPages, 10);
      assert.equal(result.deletedObservations, 10);
      assert.equal(f.store.getRun(evidence.runId)?.status, "COMPLETED");
      assert.equal(f.store.getRun(latest.runId)?.status, "COMPLETED");
      assert.equal(f.counts().events, 1);
      assert.equal(f.counts().entries, 1);
      assert.equal(f.counts().deleted, 10);
      assert.equal(f.counts().sequence, before.sequence);
      assert.equal(f.database.integrityCheck().ok, true);

      f.poll({ now: NOW + 1_000 });
      assert.equal(f.counts().sequence, before.sequence + 1);
      assert.equal(f.store.pruneIngestHistory(NOW).scannedRuns, 0);
      assert.equal(f.database.integrityCheck().ok, true);
      await f.database.backup(f.backupPath);
      const restored = await AppDatabase.open(f.backupPath);
      try { assert.equal(restored.integrityCheck().ok, true); }
      finally { restored.close(); }
    });
  });

  it("removes a complete shared-page history and keeps histories referenced by a recent run", async () => {
    await fixture(async f => {
      const sharedOld = f.poll({ window: 10 });
      f.poll({ window: 10 });
      const sharedRecent = f.poll({ window: 20 });
      f.poll({ window: 20, now: NOW });
      f.poll({ now: NOW + 1_000 });

      const result = f.store.pruneIngestHistory(NOW + 1_000);

      assert.equal(result.deletedRuns, 2);
      assert.equal(result.deletedPages, 1);
      assert.equal(result.deletedObservations, 2);
      assert.equal(f.store.getRun(sharedOld.runId), null);
      assert.ok(f.store.getRun(sharedRecent.runId));
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("retains variant conflicts, their preceding observations, errors and every lane's latest run", async () => {
    await fixture(async f => {
      f.poll();
      const original = f.poll({ window: 30, body: '{"version":"a"}' });
      const rejected = f.poll({ window: 30, body: '{"version":"b"}' });
      assert.equal(rejected.kind, "variant");
      const confirmed = f.poll({ window: 30, body: '{"version":"b"}' });
      assert.equal(confirmed.kind, "confirmed_variant");
      const compensation = f.poll({ scanKind: "COMPENSATION_10M" });
      const normal = f.poll();
      const before = f.counts();
      assert.equal(f.database.integrityCheck().ok, true);

      const result = f.store.pruneIngestHistory(NOW);

      assert.equal(result.deletedRuns, 1);
      for (const retained of [original, rejected, confirmed, compensation, normal]) {
        assert.ok(f.store.getRun(retained.runId));
      }
      assert.equal(f.counts().conflicts, before.conflicts);
      assert.equal(f.counts().errors, before.errors);
      assert.equal(f.counts().sequence, before.sequence);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("keeps a shared page owner while retiring old duplicates of the current cursor window", async () => {
    await fixture(async f => {
      const owner = f.poll({ window: 50 });
      const duplicate = f.poll({ window: 50 });
      const latest = f.poll({ window: 50, now: NOW });
      const result = f.store.pruneIngestHistory(NOW);
      assert.equal(result.deletedRuns, 1);
      assert.equal(result.deletedPages, 0);
      assert.equal(f.store.getRun(duplicate.runId), null);
      assert.ok(f.store.getRun(owner.runId));
      assert.ok(f.store.getRun(latest.runId));
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("drains an old backlog in bounded batches without waiting for the next hourly cycle", async () => {
    await fixture(async f => {
      for (let index = 0; index < INGEST_RETENTION_BATCH_SIZE + 1; index++) f.poll();
      f.poll({ now: NOW });
      const first = f.store.pruneIngestHistory(NOW);
      assert.equal(first.scannedRuns, INGEST_RETENTION_BATCH_SIZE);
      assert.equal(first.deletedRuns, INGEST_RETENTION_BATCH_SIZE);
      assert.equal(first.hasMore, true);
      const second = f.store.pruneIngestHistory(NOW);
      assert.equal(second.deletedRuns, 1);
      assert.equal(second.hasMore, false);
      assert.equal(f.counts().runs, 1);
      assert.equal(f.counts().deleted, INGEST_RETENTION_BATCH_SIZE + 1);
      assert.equal(f.database.integrityCheck().ok, true);
      assert.equal(f.store.pruneIngestHistory(NOW + INGEST_RETENTION_INTERVAL_MILLISECONDS).deletedRuns, 0);
    });
  });

  it("rolls back evidence, accounting and progress together when a deletion fails", async () => {
    await fixture(async f => {
      const old = f.poll();
      f.poll({ now: NOW });
      const before = f.counts();
      f.database.write(connection => connection.exec(`CREATE TRIGGER retention_test_abort
        BEFORE DELETE ON ingest_runs BEGIN SELECT RAISE(ABORT, 'retention interruption'); END;`));
      assert.throws(() => f.store.pruneIngestHistory(NOW), /retention interruption/);
      assert.deepEqual(f.counts(), before);
      assert.ok(f.store.getRun(old.runId));
      f.database.write(connection => connection.exec("DROP TRIGGER retention_test_abort"));
      assert.equal(f.database.integrityCheck().ok, true);
      assert.equal(f.store.pruneIngestHistory(NOW).deletedRuns, 1);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("retires a shared page history larger than a batch without pinning duplicate runs forever", async () => {
    await fixture(async f => {
      const total = INGEST_RETENTION_BATCH_SIZE * 2 + 3;
      const owner = f.poll({ window: 40 });
      for (let index = 1; index < total; index++) f.poll({ window: 40 });
      f.poll({ now: NOW });
      let deleted = 0;
      let result;
      do {
        result = f.store.pruneIngestHistory(NOW);
        deleted += result.deletedRuns;
        assert.ok(result.scannedRuns <= INGEST_RETENTION_BATCH_SIZE);
        assert.equal(f.database.integrityCheck().ok, true);
      } while (result.hasMore);
      assert.equal(deleted, total - 1);
      assert.ok(f.store.getRun(owner.runId));
      assert.equal(f.counts().runs, 2);
      const final = f.store.pruneIngestHistory(NOW + INGEST_RETENTION_INTERVAL_MILLISECONDS);
      assert.equal(final.deletedRuns, 1);
      assert.equal(final.deletedPages, 1);
      assert.equal(f.store.getRun(owner.runId), null);
      assert.equal(f.counts().runs, 1);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("keeps ordinary deletion blocked and detects deletion without retirement accounting", async () => {
    await fixture(async f => {
      const old = f.poll();
      f.poll({ now: NOW });
      assert.throws(() => f.database.write(connection => connection.prepare(
        "DELETE FROM ingest_run_page_observations WHERE ingest_run_id = ?",
      ).run(old.runId)), /only successful page observations/);
      f.database.write(connection => {
        const trigger = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'ingest_run_page_observations_retired'").get() as { sql: string };
        connection.exec("DROP TRIGGER ingest_run_page_observations_retired; UPDATE ledger_retention_state SET pruning = 1");
        connection.prepare("DELETE FROM ingest_run_page_observations WHERE ingest_run_id = ?").run(old.runId);
        connection.prepare("DELETE FROM ingest_segments WHERE ingest_run_id = ?").run(old.runId);
        connection.prepare("DELETE FROM provider_raw_pages WHERE ingest_run_id = ?").run(old.runId);
        connection.prepare("DELETE FROM ingest_runs WHERE ingest_run_id = ?").run(old.runId);
        connection.exec("UPDATE ledger_retention_state SET pruning = 0");
        connection.exec(trigger.sql);
      });
      const integrity = f.database.integrityCheck();
      assert.equal(integrity.ok, false);
      assert.ok(integrity.domainViolations > 0);
      assert.equal(integrity.schema, "ok");
    });
  });

  it("retires repeated nonempty observations across batches while preserving the first payment evidence", async () => {
    await fixture(async f => {
      const details = [paymentDetail("shared-payment")];
      const window = { start: OLD, end: OLD + 60_000, details };
      const source = f.poll(window);
      for (let index = 0; index < INGEST_RETENTION_BATCH_SIZE + 2; index++) f.poll(window);
      const latest = f.poll({ ...window, now: NOW });
      const entry = f.store.getLedgerEntry("primary", "shared-payment");
      const body = f.store.getRawPageBody(source.pageId);
      let deleted = 0;
      let result;
      do {
        result = f.store.pruneIngestHistory(NOW);
        deleted += result.deletedRuns;
        assert.equal(result.deletedPages, 0);
        assert.equal(result.deletedEvents, 0);
      } while (result.hasMore);
      assert.equal(deleted, INGEST_RETENTION_BATCH_SIZE + 2);
      assert.equal(f.counts().runs, 2);
      assert.equal(f.counts().events, 1);
      assert.ok(f.store.getRun(source.runId));
      assert.ok(f.store.getRun(latest.runId));
      assert.deepEqual(f.store.getLedgerEntry("primary", "shared-payment"), entry);
      assert.deepEqual(f.store.getRawPageBody(source.pageId), body);
      assert.equal(f.poll({ ...window, now: NOW + 1_000 }).kind, "duplicate");
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("reclaims duplicate raw events from overlapping windows and preserves payment identity through backup", async () => {
    await fixture(async f => {
      const details = [paymentDetail("overlap-payment")];
      const source = f.poll({ start: OLD, end: OLD + 60_000, details });
      for (let index = 1; index <= 20; index++) f.poll({ start: OLD, end: OLD + 60_000 + index * 1_000, details });
      const latest = f.poll({ start: OLD, end: OLD + 120_000, details, now: NOW });
      const entry = f.store.getLedgerEntry("primary", "overlap-payment");

      const result = f.store.pruneIngestHistory(NOW);

      assert.equal(result.deletedRuns, 20);
      assert.equal(result.deletedPages, 20);
      assert.equal(result.deletedEvents, 20);
      assert.equal(f.counts().events, 2);
      assert.equal(f.counts().entries, 1);
      assert.ok(f.store.getRun(source.runId));
      assert.ok(f.store.getRun(latest.runId));
      assert.deepEqual(f.store.getLedgerEntry("primary", "overlap-payment"), entry);
      assert.equal(f.poll({ start: OLD, end: OLD + 121_000, details, now: NOW + 1_000 }).normalized[0]?.kind, "duplicate");
      assert.equal(f.database.integrityCheck().ok, true);
      await f.database.backup(f.backupPath);
      const restored = await AppDatabase.open(f.backupPath);
      try {
        assert.deepEqual(new LedgerStore(restored).getLedgerEntry("primary", "overlap-payment"), entry);
        assert.equal(restored.integrityCheck().ok, true);
      } finally { restored.close(); }
    });
  });

  it("retains every raw event in a mixed page containing new and duplicate payments", async () => {
    await fixture(async f => {
      const first = paymentDetail("first-payment");
      const second = paymentDetail("second-payment");
      f.poll({ start: OLD, end: OLD + 60_000, details: [first] });
      const mixed = f.poll({ start: OLD, end: OLD + 61_000, details: [first, second] });
      const redundant = f.poll({ start: OLD, end: OLD + 62_000, details: [first, second] });
      f.poll({ now: NOW });
      const entries = f.store.listLedgerEntries();
      const body = f.store.getRawPageBody(mixed.pageId);
      const result = f.store.pruneIngestHistory(NOW);
      assert.equal(result.deletedRuns, 1);
      assert.equal(result.deletedEvents, 2);
      assert.equal(f.store.getRun(redundant.runId), null);
      assert.ok(f.store.getRun(mixed.runId));
      assert.equal(f.counts().events, 3);
      assert.deepEqual(f.store.listLedgerEntries(), entries);
      assert.deepEqual(f.store.getRawPageBody(mixed.pageId), body);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("preserves conflicting payment evidence while reclaiming independent duplicates", async () => {
    await fixture(async f => {
      f.poll({ start: OLD, end: OLD + 60_000, details: [paymentDetail("conflicted-payment")] });
      const conflict = f.poll({ start: OLD, end: OLD + 61_000, details: [paymentDetail("conflicted-payment", "2.00")] });
      const duplicate = f.poll({ start: OLD, end: OLD + 62_000, details: [paymentDetail("conflicted-payment")] });
      f.poll({ now: NOW });
      assert.equal(conflict.normalized[0]?.kind, "conflict");
      const entry = f.store.getLedgerEntry("primary", "conflicted-payment");
      const result = f.store.pruneIngestHistory(NOW);
      assert.equal(result.deletedEvents, 1);
      assert.equal(f.store.getRun(duplicate.runId), null);
      assert.ok(f.store.getRun(conflict.runId));
      assert.equal(f.counts().conflicts, 1);
      assert.deepEqual(f.store.getLedgerEntry("primary", "conflicted-payment"), entry);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("keeps an unreferenced event whose normalized facts differ from the known payment", async () => {
    await fixture(async f => {
      const details = [paymentDetail("changed-facts")];
      f.poll({ start: OLD, end: OLD + 60_000, details });
      const changed = f.poll({ start: OLD, end: OLD + 61_000, details });
      f.poll({ now: NOW });
      f.database.write(connection => {
        const trigger = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'provider_raw_events_no_update'").get() as { sql: string };
        connection.exec("DROP TRIGGER provider_raw_events_no_update");
        connection.prepare("UPDATE provider_raw_events SET amount_text = '9.00' WHERE raw_page_id = ?").run(changed.pageId);
        connection.exec(trigger.sql);
      });
      assert.equal(f.store.pruneIngestHistory(NOW).deletedEvents, 0);
      assert.ok(f.store.getRun(changed.runId));
      assert.equal(f.counts().events, 2);
    });
  });

  it("limits each batch by event volume and resumes pages beyond that budget", async () => {
    await fixture(async f => {
      const details = Array.from({ length: Math.floor(INGEST_RETENTION_EVENT_BUDGET * 0.75) }, (_, index) => paymentDetail(`large-page-${index}`));
      const window = { start: OLD, pageSize: 2_000, details };
      f.poll({ ...window, end: OLD + 60_000 });
      f.poll({ ...window, end: OLD + 61_000 });
      f.poll({ ...window, end: OLD + 62_000 });
      f.poll({ now: NOW });
      let deleted = 0;
      let result;
      do {
        result = f.store.pruneIngestHistory(NOW);
        assert.ok(result.deletedEvents <= INGEST_RETENTION_EVENT_BUDGET);
        assert.equal(result.scannedRuns, 1);
        deleted += result.deletedEvents;
      } while (result.hasMore);
      assert.equal(deleted, details.length * 2);
      assert.equal(f.counts().events, details.length);
      assert.equal(f.counts().entries, details.length);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("accepts an unchanged retired response and preserves first-seen behavior for an unknown window", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const replay = replayPaymentWindow(f.store, [retired.payment], NOW + 5_000);
      assert.equal(replay.kind, "accepted");
      assert.equal(replay.normalized[0]?.kind, "duplicate");
      assert.equal(f.counts().errors, 0);
      const fresh = replayPaymentWindow(f.store, [retired.payment, paymentDetail("new-window-payment")], NOW + 10_000, 63_000);
      assert.equal(fresh.kind, "accepted");
      assert.equal(fresh.normalized[1]?.kind, "created");
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("requires two consecutive signed responses when a retired window changes, including oscillation", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const changed = [retired.payment, paymentDetail("late-payment")];
      const original = f.store.getLedgerEntry("primary", retired.payment.accountLogId!);
      for (const [index, details] of [changed, [retired.payment], changed].entries()) {
        assert.throws(() => replayPaymentWindow(f.store, details, NOW + (index + 1) * 5_000), LedgerPageReconfirmationRequiredError);
        assert.equal(f.store.getLedgerEntry("primary", "late-payment"), null);
        assert.deepEqual(f.store.getLedgerEntry("primary", retired.payment.accountLogId!), original);
        assert.equal(f.database.integrityCheck().ok, true);
      }
      const accepted = replayPaymentWindow(f.store, changed, NOW + 20_000);
      assert.equal(accepted.kind, "accepted");
      assert.equal(accepted.normalized[1]?.kind, "created");
      assert.equal(f.counts().errors, 3);
      assert.deepEqual(f.store.getLedgerEntry("primary", retired.payment.accountLogId!), original);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("resumes a pending retired-window confirmation after restarting the database", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const changed = [retired.payment, paymentDetail("after-restart")];
      assert.throws(() => replayPaymentWindow(f.store, changed, NOW + 5_000), LedgerPageReconfirmationRequiredError);
      f.database.close();
      const reopened = await AppDatabase.open(f.databasePath);
      try {
        const store = new LedgerStore(reopened);
        assert.equal(store.getLedgerEntry("primary", "after-restart"), null);
        assert.equal(replayPaymentWindow(store, changed, NOW + 10_000).normalized[1]?.kind, "created");
        assert.equal(reopened.integrityCheck().ok, true);
      } finally { reopened.close(); }
    });
  });

  it("restores pending confirmation and signed retry evidence from a backup", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const changed = [retired.payment, paymentDetail("after-restore")];
      assert.throws(() => replayPaymentWindow(f.store, changed, NOW + 5_000), LedgerPageReconfirmationRequiredError);
      const savedError = f.database.read(connection => connection.prepare(`SELECT raw_body, signature_verified, error_code
        FROM ingest_errors WHERE error_code = 'pagination_reconfirmation_required'`).get()) as
        { raw_body: Uint8Array; signature_verified: bigint; error_code: string };
      assert.equal(Buffer.from(savedError.raw_body).toString(), JSON.stringify({ details: changed }));
      assert.equal(Number(savedError.signature_verified), 1);
      await f.database.backup(f.backupPath);
      const restored = await AppDatabase.open(f.backupPath);
      try {
        const store = new LedgerStore(restored);
        assert.equal(store.getLedgerEntry("primary", "after-restore"), null);
        assert.equal(replayPaymentWindow(store, changed, NOW + 10_000).normalized[1]?.kind, "created");
        assert.equal(restored.integrityCheck().ok, true);
      } finally { restored.close(); }
    });
  });

  it("rolls back a changed checkpoint if its retry evidence cannot be recorded", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const changed = [retired.payment, paymentDetail("after-rollback")];
      const checkpoint = () => f.database.read(connection => connection.prepare(
        "SELECT hex(response_fingerprint) AS fingerprint FROM ledger_request_checkpoints",
      ).get());
      const before = checkpoint();
      f.database.write(connection => connection.exec(`CREATE TRIGGER reconfirmation_test_abort
        BEFORE INSERT ON ingest_errors BEGIN SELECT RAISE(ABORT, 'retry evidence unavailable'); END;`));
      assert.throws(() => replayPaymentWindow(f.store, changed, NOW + 5_000), /retry evidence unavailable/);
      assert.deepEqual(checkpoint(), before);
      f.database.write(connection => connection.exec("DROP TRIGGER reconfirmation_test_abort"));
      assert.throws(() => replayPaymentWindow(f.store, changed, NOW + 10_000), LedgerPageReconfirmationRequiredError);
      assert.equal(f.store.getLedgerEntry("primary", "after-rollback"), null);
      assert.equal(replayPaymentWindow(f.store, changed, NOW + 15_000).normalized[1]?.kind, "created");
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("retries retired-window confirmation through the ingest service without duplicating diagnostics", async () => {
    await fixture(async f => {
      const retired = retirePaymentWindow(f);
      const details = [retired.payment, paymentDetail("service-confirmed")];
      let now = NOW + 5_000;
      let calls = 0;
      f.store.startIngestRun({ start: formatProviderTimestamp(OLD), end: formatProviderTimestamp(OLD + 61_000), pageSize: 100, now });
      const service = new LedgerIngestService({ store: f.store, pageSize: 100, clock: () => now,
        scanIntervalMilliseconds: 60_000, maxRequestsPerRun: 1,
        provider: { async queryPage() {
          calls++;
          return { pageNo: 1, pageSize: 100, totalSize: details.length, hasMore: false, details, traceId: "retired-request",
            rawResponse: { status: 200, headers: {}, body: JSON.stringify({ details }), traceId: "retired-request", signatureVerified: true } };
        } },
      });
      const pending = await service.run("retired-request-test");
      assert.equal(pending.errorCode, "pagination_reconfirmation_required");
      assert.equal(pending.retryable, true);
      assert.ok(pending.retryAfterSeconds !== null && pending.retryAfterSeconds > 0);
      assert.equal(f.counts().errors, 1);
      assert.equal(f.store.getLedgerEntry("primary", "service-confirmed"), null);
      now += pending.retryAfterSeconds * 1_000 + 1;
      const accepted = await service.run("retired-request-test");
      assert.equal(accepted.createdEntries, 1);
      assert.equal(calls, 2);
      assert.equal(f.counts().errors, 1);
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });
});

async function fixture(run: (value: ReturnType<typeof context>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-retention-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  try { await run(context(database, join(directory, "retained-backup.sqlite3"), join(directory, "database.sqlite3"))); }
  finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
}

function context(database: AppDatabase, backupPath: string, databasePath: string) {
  const store = new LedgerStore(database);
  store.bindProviderIdentity({ providerAccountKey: "primary", providerKind: "alipay",
    endpoint: "https://openapi.alipay.com", externalAccountId: "2026000000000000" }, OLD);
  let sequence = 0;
  let clock = OLD;
  return {
    database, store, backupPath, databasePath,
    poll(options: { now?: number; window?: number; start?: number; end?: number; pageSize?: number; details?: readonly AccountLogDetail[]; payment?: boolean; body?: string; scanKind?: IngestScanKind } = {}) {
      sequence++;
      clock = Math.max(clock + 1_000, options.now ?? OLD);
      const start = options.start ?? OLD + (options.window ?? sequence + 100) * 60_000;
      const details: readonly AccountLogDetail[] = options.details ?? (options.payment ? [{
        accountLogId: "retained-payment", occurredAt: formatProviderTimestamp(start + 1_000), amount: "1.00", direction: "CREDIT",
        alipayOrderNo: "alipay-retained-payment", merchantOrderNo: null, transMemo: null, otherAccount: null,
        raw: { account_log_id: "retained-payment", amount: "1.00", direction: "CREDIT", occurred_at: formatProviderTimestamp(start + 1_000) },
      }] : []);
      const pageSize = options.pageSize ?? 100;
      const run = store.startIngestRun({ start: formatProviderTimestamp(start), end: formatProviderTimestamp(options.end ?? start + 60_000),
        pageSize, now: clock, ...(options.scanKind ? { scanKind: options.scanKind } : {}) });
      const recorded = store.recordPage({ ingestRunId: run.ingestRunId, now: clock + 1,
        page: { pageNo: 1, pageSize, totalSize: details.length, hasMore: false, details },
        evidence: { body: options.body ?? JSON.stringify({ details }), headers: {}, httpStatus: 200, traceId: null, signatureVerified: true },
      });
      return { runId: run.ingestRunId, pageId: recorded.page.rawPageId, kind: recorded.kind, normalized: recorded.normalized };
    },
    counts() {
      return database.read(connection => {
        const row = connection.prepare(`SELECT
          (SELECT COUNT(*) FROM ingest_runs) AS runs,
          (SELECT COUNT(*) FROM provider_raw_pages) AS pages,
          (SELECT COUNT(*) FROM provider_raw_events) AS events,
          (SELECT COUNT(*) FROM ledger_entries) AS entries,
          (SELECT COUNT(*) FROM ingest_run_page_observations) AS observations,
          (SELECT COUNT(*) FROM ledger_conflicts) AS conflicts,
          (SELECT COUNT(*) FROM ingest_errors) AS errors,
          (SELECT COUNT(*) FROM ledger_request_checkpoints) AS checkpoints,
          (SELECT COALESCE(MAX(observation_sequence), 0) FROM ingest_run_page_observations) AS sequence,
          (SELECT deleted_observations FROM ledger_retention_state) AS deleted,
          (SELECT pruning FROM ledger_retention_state) AS pruning`).get() as Record<string, number | bigint>;
        return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)])) as
          Record<"runs" | "pages" | "events" | "entries" | "observations" | "conflicts" | "errors" | "checkpoints" | "sequence" | "deleted" | "pruning", number>;
      });
    },
  };
}

function formatProviderTimestamp(value: number): string {
  return new Date(value + 8 * 60 * 60 * 1_000).toISOString().slice(0, 19).replace("T", " ");
}

function paymentDetail(id: string, amount = "1.00"): AccountLogDetail {
  const occurredAt = formatProviderTimestamp(OLD + 10_000);
  return {
    accountLogId: id, occurredAt, amount, direction: "CREDIT", alipayOrderNo: `alipay-${id}`,
    merchantOrderNo: null, transMemo: null, otherAccount: null,
    raw: { account_log_id: id, occurred_at: occurredAt, amount, direction: "CREDIT" },
  };
}

function retirePaymentWindow(f: ReturnType<typeof context>) {
  const payment = paymentDetail("retired-window-payment");
  f.poll({ start: OLD, end: OLD + 60_000, details: [payment] });
  const retired = f.poll({ start: OLD, end: OLD + 61_000, details: [payment] });
  f.poll({ now: NOW });
  assert.equal(f.store.pruneIngestHistory(NOW).deletedPages, 1);
  assert.equal(f.store.getRawPageBody(retired.pageId), null);
  assert.equal(f.counts().checkpoints, 1);
  return { payment };
}

function replayPaymentWindow(store: LedgerStore, details: readonly AccountLogDetail[], now: number, endOffset = 61_000) {
  const run = store.startIngestRun({ start: formatProviderTimestamp(OLD), end: formatProviderTimestamp(OLD + endOffset), pageSize: 100, now });
  const segment = store.getNextPendingSegment(run.ingestRunId);
  assert.ok(segment);
  return store.recordSegmentPage({ ingestRunId: run.ingestRunId, ingestSegmentId: segment.ingestSegmentId, now: now + 1,
    page: { pageNo: 1, pageSize: 100, totalSize: details.length, hasMore: false, details },
    evidence: { body: JSON.stringify({ details }), headers: {}, httpStatus: 200, traceId: null, signatureVerified: true },
  });
}
