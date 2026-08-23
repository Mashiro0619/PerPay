import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { AlipayProviderError } from "../src/infrastructure/alipay/errors.ts";
import type {
  AccountLogDetail,
  AccountLogPage,
  AccountLogPageRequest,
  LedgerProvider,
} from "../src/infrastructure/alipay/index.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import {
  LedgerIngestService,
  normalLedgerOverlapMilliseconds,
} from "../src/ledger/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";

const NOW = Date.parse("2026-08-14T12:00:00+08:00");
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;

describe("LedgerIngestService", () => {
  it("scales normal overlap with the scan interval", () => {
    assert.equal(normalLedgerOverlapMilliseconds(5_000), 10_000);
    assert.equal(normalLedgerOverlapMilliseconds(60_000), 120_000);
    assert.equal(normalLedgerOverlapMilliseconds(3_600_000), 300_000);
  });

  it("does not query the provider when the durable account binding is missing", async () => {
    await withDatabase(async ({ database, store }) => {
      const provider = new ScriptedProvider([]);
      const result = await serviceFor(provider, store, { maxRequestsPerRun: 1 }).run("test-unbound");

      assert.equal(result.status, "FAILED");
      assert.equal(result.ingestRunId, null);
      assert.equal(result.errorCode, "scan_failed");
      assert.equal(provider.requests.length, 0);
      assert.equal(store.getCursor(), null);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM ingest_runs",
        ).get() as { count: bigint }).count)),
        0,
      );
    }, false);
  });

  it("preserves provider retry metadata for the scheduler", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        new AlipayProviderError({
          kind: "rate_limited",
          code: "remote_rate_limited",
          message: "provider rate limit reached",
          status: 429,
          retryAfterSeconds: 17,
        }),
      ]);
      const result = await serviceFor(provider, store, { maxRequestsPerRun: 1 }).run("test-retry-meta");

      assert.equal(result.status, "FAILED");
      assert.equal(result.errorCode, "remote_rate_limited");
      assert.equal(result.retryAfterSeconds, 17);
      assert.equal(result.retryable, true);
    });
  });

  it("resumes an incomplete window with its persisted overlap after the interval changes", async () => {
    await withDatabase(async ({ store }) => {
      const failedProvider = new ScriptedProvider([
        new AlipayProviderError({
          kind: "network",
          code: "transport_network",
          message: "provider request failed",
        }),
      ]);
      const failed = await serviceFor(failedProvider, store, {
        maxRequestsPerRun: 1,
        overlapMilliseconds: 300_000,
      }).run("old-interval-failure");
      assert.equal(failed.status, "FAILED");
      assert.equal(store.getCursor()?.complete, false);

      const resumedProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const resumed = await serviceFor(resumedProvider, store, {
        maxRequestsPerRun: 1,
        overlapMilliseconds: 10_000,
      }).run("new-interval-resume");
      assert.equal(resumed.status, "COMPLETED");
      assert.equal(store.getCursor()?.overlapMilliseconds, 300_000);

      const nextProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const next = await serviceFor(nextProvider, store, {
        maxRequestsPerRun: 1,
        overlapMilliseconds: 10_000,
        clock: () => NOW + 60_000,
      }).run("new-interval-applied");
      assert.equal(next.status, "COMPLETED");
      assert.equal(store.getCursor()?.overlapMilliseconds, 10_000);
    });
  });

  it("accepts a complete single-page window and atomically completes its durable run", async () => {
    await withDatabase(async ({ database, store }) => {
      const provider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("service-1", "1.01", "2026-08-14 11:01:00")]),
      ]);
      const service = serviceFor(provider, store, { maxRequestsPerRun: 10 });

      const result = await service.run("test-complete");
      assert.deepEqual(
        {
          status: result.status,
          pages: result.pages,
          details: result.details,
          createdEntries: result.createdEntries,
          errorCode: result.errorCode,
        },
        { status: "COMPLETED", pages: 1, details: 1, createdEntries: 1, errorCode: null },
      );
      assert.equal(provider.requests.length, 1);
      assert.equal(provider.requests[0]?.pageNo, 1);
      assert.equal(store.getCursor()?.complete, true);
      assert.equal(store.listLedgerEntries().length, 1);
      assert.equal(store.getRun(result.ingestRunId ?? "")?.status, "COMPLETED");
      assert.equal(
        database.read((connection) =>
          Number((connection.prepare("SELECT COUNT(*) AS count FROM ingest_errors").get() as { count: bigint }).count),
        ),
        0,
      );
    });
  });

  it("fails a changed page without counting its details and accepts it only after confirmation", async () => {
    await withDatabase(async ({ database, store }) => {
      const firstPage = providerPage(
        1,
        1,
        1,
        false,
        [detail("stable-service-event", "1.01", "2026-08-14 11:01:00")],
      );
      const first = await serviceFor(
        new ScriptedProvider([{
          ...firstPage,
          rawResponse: { ...firstPage.rawResponse, body: '{"view":"A"}' },
        }]),
        store,
        { maxRequestsPerRun: 1, overlapMilliseconds: 60 * 60 * 1_000 },
      ).run("variant-baseline");
      assert.equal(first.status, "COMPLETED");

      const changedPage = providerPage(
        1,
        1,
        1,
        false,
        [detail("changed-service-event", "2.02", "2026-08-14 11:02:00")],
      );
      const changedResponse = {
        ...changedPage,
        rawResponse: { ...changedPage.rawResponse, body: '{"view":"B"}' },
      };
      const rejected = await serviceFor(
        new ScriptedProvider([changedResponse]),
        store,
        { maxRequestsPerRun: 1, overlapMilliseconds: 60 * 60 * 1_000 },
      ).run("variant-rejected");
      assert.deepEqual(
        {
          status: rejected.status,
          pages: rejected.pages,
          details: rejected.details,
          createdEntries: rejected.createdEntries,
          conflicts: rejected.conflicts,
          errorCode: rejected.errorCode,
        },
        {
          status: "FAILED",
          pages: 1,
          details: 0,
          createdEntries: 0,
          conflicts: 0,
          errorCode: "pagination_variant",
        },
      );
      assert.equal(store.getLedgerEntry("primary", "changed-service-event"), null);
      assert.equal(store.getCursor()?.complete, false);
      assert.equal(store.getCursor()?.nextPageNo, 1);
      assert.deepEqual(
        database.read((connection) => {
          const run = connection.prepare(
            `SELECT status, pages_received, details_received, failure_code
               FROM ingest_runs
              WHERE ingest_run_id = ?`,
          ).get(rejected.ingestRunId) as {
            status: string;
            pages_received: bigint;
            details_received: bigint;
            failure_code: string;
          };
          const errorCount = Number((connection.prepare(
            "SELECT COUNT(*) AS count FROM ingest_errors WHERE ingest_run_id = ?",
          ).get(rejected.ingestRunId) as { count: bigint }).count);
          return {
            status: run.status,
            pages: Number(run.pages_received),
            details: Number(run.details_received),
            failureCode: run.failure_code,
            errorCount,
          };
        }),
        {
          status: "FAILED",
          pages: 0,
          details: 0,
          failureCode: "pagination_variant",
          errorCount: 1,
        },
      );
      assert.equal(database.integrityCheck().ok, true);

      const confirmed = await serviceFor(
        new ScriptedProvider([changedResponse]),
        store,
        { maxRequestsPerRun: 1, overlapMilliseconds: 60 * 60 * 1_000 },
      ).run("variant-confirmed");
      assert.equal(confirmed.status, "COMPLETED");
      assert.equal(confirmed.details, 1);
      assert.equal(confirmed.createdEntries, 1);
      assert.equal(store.getLedgerEntry("primary", "changed-service-event")?.amountCents, 202);
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("splits an oversized mutable result into complete single-page time windows", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        providerPage(1, 2, 4, true, [
          detail("A", "1.00", "2026-08-14 11:10:00"),
          detail("B", "2.00", "2026-08-14 11:20:00"),
        ]),
        providerPage(1, 2, 2, false, [
          detail("X", "3.00", "2026-08-14 11:05:00"),
          detail("A", "1.00", "2026-08-14 11:10:00"),
        ]),
        providerPage(1, 2, 2, false, [
          detail("C", "4.00", "2026-08-14 11:40:00"),
          detail("D", "5.00", "2026-08-14 11:50:00"),
        ]),
      ]);
      const result = await serviceFor(provider, store, {
        maxRequestsPerRun: 10,
        pageSize: 2,
      }).run("test-adaptive-split");

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.pages, 3);
      assert.deepEqual(provider.requests.map((request) => request.pageNo), [1, 1, 1]);
      assert.deepEqual(
        provider.requests.map((request) => [request.startTime, request.endTime]),
        [
          ["2026-08-14 11:00:00", "2026-08-14 12:00:00"],
          ["2026-08-14 11:00:00", "2026-08-14 11:30:00"],
          ["2026-08-14 11:30:00", "2026-08-14 12:00:00"],
        ],
      );
      assert.deepEqual(
        store.listLedgerEntries().map((entry) => entry.externalEventId).sort(),
        ["A", "C", "D", "X"],
      );
    });
  });

  it("resumes pending time segments instead of a numbered page after request budget exhaustion", async () => {
    await withDatabase(async ({ store }) => {
      const firstProvider = new ScriptedProvider([
        providerPage(1, 1, 2, true, [detail("partial-probe", "1.00", "2026-08-14 11:01:00")]),
      ]);
      const first = await serviceFor(firstProvider, store, { maxRequestsPerRun: 1 }).run("test-partial");
      assert.equal(first.status, "PARTIAL");
      assert.equal(first.errorCode, "request_budget_exhausted");
      assert.equal(store.getCursor()?.nextPageNo, 1);
      assert.equal(store.getRun(first.ingestRunId ?? "")?.status, "RUNNING");

      const secondProvider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("partial-1", "1.00", "2026-08-14 11:01:00")]),
        providerPage(1, 1, 1, false, [detail("partial-2", "2.00", "2026-08-14 11:45:00")]),
      ]);
      const resumed = await serviceFor(secondProvider, store, { maxRequestsPerRun: 2 }).run("test-resume");
      assert.equal(secondProvider.requests[0]?.pageNo, 1);
      assert.equal(resumed.ingestRunId, first.ingestRunId);
      assert.equal(resumed.status, "COMPLETED");
      assert.equal(store.getCursor()?.complete, true);
      assert.equal(store.listLedgerEntries().length, 2);
    });
  });

  it("resumes the same pending segment tree after the database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-restart-"));
    const databasePath = join(directory, "database.sqlite3");
    let firstRunId: string | null = null;
    let database = await AppDatabase.open(databasePath);
    try {
      const store = new LedgerStore(database);
      store.bindProviderIdentity(PROVIDER_IDENTITY, NOW);
      const first = await serviceFor(
        new ScriptedProvider([
          providerPage(1, 1, 2, true, [
            detail("restart-probe", "1.00", "2026-08-14 11:01:00"),
          ]),
        ]),
        store,
        { maxRequestsPerRun: 1 },
      ).run("test-before-restart");
      assert.equal(first.status, "PARTIAL");
      firstRunId = first.ingestRunId;
    } finally {
      database.close();
    }

    database = await AppDatabase.open(databasePath);
    try {
      const store = new LedgerStore(database);
      store.bindProviderIdentity(PROVIDER_IDENTITY, NOW);
      const provider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("restart-left", "1.00", "2026-08-14 11:10:00")]),
        providerPage(1, 1, 1, false, [detail("restart-right", "2.00", "2026-08-14 11:40:00")]),
      ]);
      const resumed = await serviceFor(provider, store, { maxRequestsPerRun: 2 }).run("test-after-restart");
      assert.equal(resumed.ingestRunId, firstRunId);
      assert.equal(resumed.status, "COMPLETED");
      assert.deepEqual(provider.requests.map((request) => request.pageNo), [1, 1]);
      assert.deepEqual(
        store.listLedgerEntries().map((entry) => entry.externalEventId).sort(),
        ["restart-left", "restart-right"],
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates a split-boundary event when both inclusive child windows return it", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        providerPage(1, 2, 3, true, [
          detail("left", "1.00", "2026-08-14 11:10:00"),
          detail("boundary", "2.00", "2026-08-14 11:30:00"),
        ]),
        providerPage(1, 2, 2, false, [
          detail("left", "1.00", "2026-08-14 11:10:00"),
          detail("boundary", "2.00", "2026-08-14 11:30:00"),
        ]),
        providerPage(1, 2, 2, false, [
          detail("boundary", "2.00", "2026-08-14 11:30:00"),
          detail("right", "3.00", "2026-08-14 11:50:00"),
        ]),
      ]);
      const result = await serviceFor(provider, store, {
        maxRequestsPerRun: 10,
        pageSize: 2,
      }).run("test-boundary-overlap");

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.duplicateEntries, 1);
      assert.deepEqual(
        store.listLedgerEntries().map((entry) => entry.externalEventId).sort(),
        ["boundary", "left", "right"],
      );
    });
  });

  it("fails without advancing the root watermark when one second still exceeds the page limit", async () => {
    await withDatabase(async ({ database, store }) => {
      const provider = new DenseProvider();
      const result = await serviceFor(provider, store, {
        maxRequestsPerRun: 100,
      }).run("test-density-limit");

      assert.equal(result.status, "FAILED");
      assert.equal(result.errorCode, "pagination_density_exceeded");
      assert.equal(store.getCursor()?.complete, false);
      assert.equal(store.getCursor()?.nextPageNo, 1);
      assert.equal(store.getRun(result.ingestRunId ?? "")?.status, "FAILED");
      assert.equal(provider.requests.every((request) => request.pageNo === 1), true);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM ingest_errors WHERE error_code = 'pagination_density_exceeded'",
        ).get() as { count: bigint }).count)),
        1,
      );
    });
  });

  it("retains evidence and rewinds when a signed page contains an out-of-window event", async () => {
    await withDatabase(async ({ database, store }) => {
      const provider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("outside", "1.00", "2026-08-14 10:59:59")]),
      ]);
      const result = await serviceFor(provider, store, { maxRequestsPerRun: 10 }).run("test-outside");

      assert.equal(result.status, "FAILED");
      assert.equal(result.errorCode, "pagination_invalid");
      assert.equal(store.getCursor()?.complete, false);
      assert.equal(store.listLedgerEntries().length, 0);
      assert.deepEqual(
        database.read((connection) => {
          const row = connection.prepare(
            "SELECT http_status, signature_verified, CAST(raw_body AS TEXT) AS body FROM ingest_errors",
          ).get() as { http_status: bigint; signature_verified: bigint; body: string };
          return [Number(row.http_status), Number(row.signature_verified), row.body];
        }),
        [200, 1, '{"page":1,"total":1}'],
      );
    });
  });

  it("rolls back the final leaf and cursor when run completion fails inside the transaction", async () => {
    await withDatabase(async ({ database, store }) => {
      database.write((connection) => {
        connection.exec(`
          CREATE TRIGGER test_abort_ingest_completion
          BEFORE UPDATE OF status ON ingest_runs
          WHEN NEW.status = 'COMPLETED'
          BEGIN
            SELECT RAISE(ABORT, 'injected completion failure');
          END;
        `);
      });
      const provider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("atomic", "1.00", "2026-08-14 11:01:00")]),
      ]);
      const result = await serviceFor(provider, store, { maxRequestsPerRun: 10 }).run("test-atomic");

      assert.equal(result.status, "FAILED");
      assert.equal(store.getCursor()?.complete, false);
      assert.equal(store.listLedgerEntries().length, 0);
      assert.equal(store.getRun(result.ingestRunId ?? "")?.status, "FAILED");
    });
  });

  it("coalesces concurrent triggers into one provider request", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new DeferredProvider();
      const service = serviceFor(provider, store, { maxRequestsPerRun: 10 });
      const first = service.run("first-trigger");
      const second = service.run("second-trigger");
      assert.equal(first, second);
      await provider.started;
      assert.equal(provider.requests.length, 1);
      provider.resolve(providerPage(
        1,
        1,
        1,
        false,
        [detail("coalesced", "1.00", "2026-08-14 11:01:00")],
      ));
      assert.equal((await first).status, "COMPLETED");
      assert.equal(provider.requests.length, 1);
    });
  });

  it("records a permission failure and resumes the same window from page one", async () => {
    await withDatabase(async ({ database, store }) => {
      const denied = new AlipayProviderError({
        kind: "authorization",
        code: "remote_authorization_failed",
        message: "denied",
        status: 403,
        traceId: "permission-trace",
        rawBody: '{"code":"denied"}',
        responseHeaders: { "alipay-trace-id": "permission-trace" },
      });
      const result = await serviceFor(new ScriptedProvider([denied]), store, {
        maxRequestsPerRun: 10,
      }).run("permission-test");
      assert.equal(result.status, "FAILED");
      assert.equal(result.errorCode, "remote_authorization_failed");
      assert.equal(store.getCursor()?.nextPageNo, 1);
      assert.deepEqual(
        database.read((connection) => {
          const row = connection.prepare(
            "SELECT error_kind, error_code, http_status, signature_verified FROM ingest_errors",
          ).get() as {
            error_kind: string;
            error_code: string;
            http_status: bigint;
            signature_verified: bigint | null;
          };
          return [
            row.error_kind,
            row.error_code,
            Number(row.http_status),
            row.signature_verified,
          ];
        }),
        ["authorization", "remote_authorization_failed", 403, null],
      );
    });
  });

  it("fails and rewinds even when remote error evidence exceeds the storage contract", async () => {
    await withDatabase(async ({ database, store }) => {
      const oversized = new AlipayProviderError({
        kind: "transient",
        code: "remote_server_error",
        message: "oversized failure",
        status: 500,
        rawBody: Buffer.alloc(2 * 1024 * 1024 + 1, 65),
        responseHeaders: {},
      });
      const result = await serviceFor(new ScriptedProvider([oversized]), store, {
        maxRequestsPerRun: 10,
      }).run("oversized-error-test");
      assert.equal(result.status, "FAILED");
      assert.equal(store.getCursor()?.nextPageNo, 1);
      const stored = database.read((connection) => connection.prepare(
        "SELECT raw_body, details_json FROM ingest_errors",
      ).get() as { raw_body: Uint8Array | null; details_json: string });
      assert.equal(stored.raw_body, null);
      assert.equal((JSON.parse(stored.details_json) as { evidence_omitted: boolean }).evidence_omitted, true);
      assert.equal(store.getRun(result.ingestRunId ?? "")?.status, "FAILED");
    });
  });

  it("aborts an in-flight request during shutdown and durably rewinds it", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new DeferredProvider();
      const service = serviceFor(provider, store, { maxRequestsPerRun: 10 });
      const running = service.run("shutdown-test");
      await provider.started;
      service.stop();
      const result = await running;
      assert.equal(result.status, "FAILED");
      assert.equal(result.errorCode, "scan_aborted");
      assert.equal(store.getCursor()?.nextPageNo, 1);
      await service.waitForIdle();
      assert.equal(service.inFlight, false);
    });
  });

  it("catches up after downtime with bounded windows instead of one unbounded query", async () => {
    await withDatabase(async ({ store }) => {
      const firstProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(firstProvider, store, { maxRequestsPerRun: 10 }).run("initial-window");

      const secondProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(secondProvider, store, {
        maxRequestsPerRun: 10,
        clock: () => NOW + 3 * 24 * 60 * 60 * 1_000,
      }).run("bounded-catch-up");
      assert.equal(secondProvider.requests[0]?.startTime, "2026-08-14 11:55:00");
      assert.equal(secondProvider.requests[0]?.endTime, "2026-08-14 13:00:00");
    });
  });

  it("periodically recovers a transaction that became visible after the fast window passed", async () => {
    await withDatabase(async ({ store }) => {
      const firstProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(firstProvider, store, {
        maxRequestsPerRun: 1,
        overlapMilliseconds: 10_000,
      }).run("fast-window-baseline");

      for (let seconds = 5; seconds <= 55; seconds += 5) {
        const provider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
        const ordinary = await serviceFor(provider, store, {
          maxRequestsPerRun: 1,
          overlapMilliseconds: 10_000,
          clock: () => NOW + seconds * 1_000,
        }).run(`fast-window-${seconds}`);
        assert.equal(ordinary.status, "COMPLETED");
      }

      const delayedProvider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("delayed-visible", "1.01", "2026-08-14 11:59:30")]),
      ]);
      const recovered = await serviceFor(delayedProvider, store, {
        maxRequestsPerRun: 1,
        overlapMilliseconds: 10_000,
        clock: () => NOW + 65_000,
      }).run("periodic-compensation");
      assert.equal(recovered.status, "COMPLETED");
      assert.equal(recovered.createdEntries, 1);
      assert.equal(delayedProvider.requests[0]?.startTime, "2026-08-14 11:50:55");
    });
  });

  it("uses the latest observed event for one compensating rewind, then advances", async () => {
    await withDatabase(async ({ store }) => {
      const firstProvider = new ScriptedProvider([
        providerPage(1, 1, 1, false, [detail("late-event", "1.01", "2026-08-14 11:59:00")]),
      ]);
      await serviceFor(firstProvider, store, { maxRequestsPerRun: 1 }).run("rewind-baseline");

      const secondProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(secondProvider, store, {
        maxRequestsPerRun: 1,
        clock: () => NOW + 30_000,
      }).run("rewind-compensation");
      assert.deepEqual(
        [secondProvider.requests[0]?.startTime, secondProvider.requests[0]?.endTime],
        ["2026-08-14 11:54:00", "2026-08-14 12:00:30"],
      );

      const thirdProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(thirdProvider, store, {
        maxRequestsPerRun: 1,
        clock: () => NOW + 45_000,
      }).run("rewind-forward");
      assert.deepEqual(
        [thirdProvider.requests[0]?.startTime, thirdProvider.requests[0]?.endTime],
        ["2026-08-14 11:55:30", "2026-08-14 12:00:45"],
      );
    });
  });

  it("persists compensation due times and lets wider sweeps consume covered layers", async () => {
    await withDatabase(async ({ store }) => {
      const baseline = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      await serviceFor(baseline, store, { maxRequestsPerRun: 1 }).run("compensation-baseline");

      const fast = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const tenMinute = await serviceFor(fast, store, {
        maxRequestsPerRun: 1,
        clock: () => NOW + 60_000,
      }).run("compensation-10m");
      assert.equal(tenMinute.status, "COMPLETED");
      assert.equal(store.getRun(tenMinute.ingestRunId ?? "")?.scanKind, "COMPENSATION_10M");
      assert.equal(store.getCompensationState()?.next10mAt, NOW + 120_000);

      const hourlyCatchUpProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const hourlyCatchUp = await serviceFor(hourlyCatchUpProvider, store, {
        maxRequestsPerRun: 1,
        clock: () => NOW + 60 * 60 * 1_000,
      }).run("compensation-1h-catch-up");
      assert.equal(hourlyCatchUp.status, "COMPLETED");
      assert.equal(store.getRun(hourlyCatchUp.ingestRunId ?? "")?.scanKind, "NORMAL");

      const hourlyProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const hourly = await serviceFor(hourlyProvider, store, {
        maxRequestsPerRun: 1,
        clock: () => NOW + 60 * 60 * 1_000,
      }).run("compensation-1h");
      assert.equal(hourly.status, "COMPLETED");
      assert.equal(store.getRun(hourly.ingestRunId ?? "")?.scanKind, "COMPENSATION_1H");
      assert.equal(store.getCompensationState()?.next1hAt, NOW + 2 * 60 * 60 * 1_000);
      assert.equal(store.getCompensationState()?.next10mAt, NOW + 61 * 60 * 1_000);

      const dailyCatchUpProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const dailyCatchUp = await serviceFor(dailyCatchUpProvider, store, {
        maxRequestsPerRun: 1,
        windowMilliseconds: 24 * 60 * 60 * 1_000,
        clock: () => NOW + 24 * 60 * 60 * 1_000,
      }).run("compensation-1d-catch-up");
      assert.equal(dailyCatchUp.status, "COMPLETED");
      assert.equal(store.getRun(dailyCatchUp.ingestRunId ?? "")?.scanKind, "NORMAL");

      const dailyProvider = new ScriptedProvider([providerPage(1, 1, 0, false, [])]);
      const daily = await serviceFor(dailyProvider, store, {
        maxRequestsPerRun: 1,
        windowMilliseconds: 24 * 60 * 60 * 1_000,
        clock: () => NOW + 24 * 60 * 60 * 1_000,
      }).run("compensation-1d");
      assert.equal(daily.status, "COMPLETED");
      assert.equal(store.getRun(daily.ingestRunId ?? "")?.scanKind, "COMPENSATION_1D");
      assert.deepEqual(store.getCompensationState(), {
        providerAccountKey: "primary",
        next10mAt: NOW + (24 * 60 + 1) * 60 * 1_000,
        next1hAt: NOW + 25 * 60 * 60 * 1_000,
        next1dAt: NOW + 2 * 24 * 60 * 60 * 1_000,
        updatedAt: NOW + 24 * 60 * 60 * 1_000,
      });
    });
  });

  it("does not advance a due compensation layer when its provider scan fails", async () => {
    await withDatabase(async ({ store }) => {
      await serviceFor(
        new ScriptedProvider([providerPage(1, 1, 0, false, [])]),
        store,
        { maxRequestsPerRun: 1 },
      ).run("compensation-failure-baseline");
      const before = store.getCompensationState();
      assert.ok(before);

      const failed = await serviceFor(
        new ScriptedProvider([
          new AlipayProviderError({
            kind: "network",
            code: "transport_network",
            message: "provider request failed",
          }),
        ]),
        store,
        { maxRequestsPerRun: 1, clock: () => NOW + 60_000 },
      ).run("compensation-failure");

      assert.equal(failed.status, "FAILED");
      assert.equal(store.getRun(failed.ingestRunId ?? "")?.scanKind, "COMPENSATION_10M");
      assert.deepEqual(store.getCompensationState(), before);
    });
  });
});

describe("LedgerIngestScheduler", () => {
  it("starts immediately, reports sanitized health, coalesces triggers, and stops cleanly", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new DeferredProvider();
      const service = serviceFor(provider, store, { maxRequestsPerRun: 10 });
      const scheduler = new LedgerIngestScheduler({
        service,
        intervalMilliseconds: 60_000,
        clock: () => NOW,
      });
      scheduler.start();
      const sameScan = scheduler.trigger("manual-while-starting");
      await provider.started;
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(scheduler.health(), {
        state: "running",
        inFlight: true,
        lastAttemptAt: NOW,
        lastSuccessAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
      });
      provider.resolve(providerPage(1, 1, 0, false, []));
      assert.equal((await sameScan).status, "COMPLETED");
      assert.equal(scheduler.health().state, "healthy");
      assert.equal(scheduler.health().lastSuccessAt, NOW);
      await scheduler.stop();
      assert.equal(scheduler.health().state, "stopped");
    });
  });

  it("honors Retry-After and uses exponential backoff for transient scans", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        new AlipayProviderError({
          kind: "rate_limited",
          code: "remote_rate_limited",
          message: "provider rate limit reached",
          status: 429,
          retryAfterSeconds: 17,
        }),
        new AlipayProviderError({
          kind: "network",
          code: "transport_network",
          message: "provider request failed",
        }),
      ]);
      const timers: Array<{ readonly delay: number; cleared: boolean }> = [];
      const scheduler = new LedgerIngestScheduler({
        service: serviceFor(provider, store, { maxRequestsPerRun: 1 }),
        intervalMilliseconds: 5_000,
        clock: () => NOW,
        setTimeout: (callback, delay) => {
          const timer = { delay, cleared: false };
          timers.push(timer);
          return { unref: () => undefined, callback } as unknown as NodeJS.Timeout;
        },
        clearTimeout: () => {
          const timer = timers.at(-1);
          if (timer) timer.cleared = true;
        },
      });
      scheduler.start();
      await waitFor(() => timers.length === 1);
      assert.equal(timers[0]?.delay, 17_000);

      await scheduler.trigger("manual-after-rate-limit");
      await waitFor(() => timers.length === 2);
      assert.equal(timers[1]?.delay, 10_000);
      await scheduler.stop();
    });
  });

  it("never schedules a transient retry before the configured interval", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        new AlipayProviderError({
          kind: "rate_limited",
          code: "remote_rate_limited",
          message: "provider rate limit reached",
          status: 429,
          retryAfterSeconds: 1,
        }),
      ]);
      const timers: Array<{ readonly delay: number; cleared: boolean }> = [];
      const scheduler = new LedgerIngestScheduler({
        service: serviceFor(provider, store, { maxRequestsPerRun: 1 }),
        intervalMilliseconds: 5_000,
        clock: () => NOW,
        setTimeout: (callback, delay) => {
          const timer = { delay, cleared: false };
          timers.push(timer);
          return { unref: () => undefined, callback } as unknown as NodeJS.Timeout;
        },
        clearTimeout: () => {
          const timer = timers.at(-1);
          if (timer) timer.cleared = true;
        },
      });

      scheduler.start();
      await waitFor(() => timers.length === 1);
      assert.equal(timers[0]?.delay, 5_000);
      await scheduler.stop();
    });
  });

  it("uses a long cooldown for non-retryable provider failures", async () => {
    await withDatabase(async ({ store }) => {
      const provider = new ScriptedProvider([
        new AlipayProviderError({
          kind: "authorization",
          code: "remote_authorization_failed",
          message: "provider rejected the application permission",
          status: 403,
        }),
      ]);
      const timers: Array<{ readonly delay: number; cleared: boolean }> = [];
      const scheduler = new LedgerIngestScheduler({
        service: serviceFor(provider, store, { maxRequestsPerRun: 1 }),
        intervalMilliseconds: 5_000,
        clock: () => NOW,
        setTimeout: (callback, delay) => {
          const timer = { delay, cleared: false };
          timers.push(timer);
          return { unref: () => undefined, callback } as unknown as NodeJS.Timeout;
        },
        clearTimeout: () => {
          const timer = timers.at(-1);
          if (timer) timer.cleared = true;
        },
      });

      scheduler.start();
      await waitFor(() => timers.length === 1);
      assert.equal(timers[0]?.delay, 15 * 60 * 1_000);
      await scheduler.stop();
    });
  });
});

class ScriptedProvider implements LedgerProvider {
  readonly requests: AccountLogPageRequest[] = [];
  readonly #responses: Array<AccountLogPage | Error>;

  constructor(responses: readonly (AccountLogPage | Error)[]) {
    this.#responses = [...responses];
  }

  async queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    this.requests.push(input);
    const response = this.#responses.shift();
    if (!response) throw new Error("test provider has no scripted response");
    if (response instanceof Error) throw response;
    return response;
  }
}

class DenseProvider implements LedgerProvider {
  readonly requests: AccountLogPageRequest[] = [];

  async queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    this.requests.push(input);
    return providerPage(1, input.pageSize, input.pageSize + 1, true, [
      detail(`dense-${this.requests.length}`, "1.00", input.startTime),
    ]);
  }
}

class DeferredProvider implements LedgerProvider {
  readonly requests: AccountLogPageRequest[] = [];
  readonly started: Promise<void>;
  #markStarted!: () => void;
  #resolve!: (page: AccountLogPage) => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    this.requests.push(input);
    this.#markStarted();
    return new Promise<AccountLogPage>((resolve, reject) => {
      this.#resolve = resolve;
      const abort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  resolve(page: AccountLogPage): void {
    this.#resolve(page);
  }
}

function serviceFor(
  provider: LedgerProvider,
  store: LedgerStore,
  options: {
    readonly maxRequestsPerRun: number;
    readonly pageSize?: number;
    readonly overlapMilliseconds?: number;
    readonly windowMilliseconds?: number;
    readonly clock?: () => number;
  },
): LedgerIngestService {
  return new LedgerIngestService({
    provider,
    store,
    pageSize: options.pageSize ?? 1,
    overlapMilliseconds: options.overlapMilliseconds ?? 5 * 60 * 1000,
    windowMilliseconds: options.windowMilliseconds ?? 60 * 60 * 1000,
    safetyLagMilliseconds: 0,
    maxRequestsPerRun: options.maxRequestsPerRun,
    clock: options.clock ?? (() => NOW),
  });
}

function providerPage(
  pageNo: number,
  pageSize: number,
  totalSize: number,
  hasMore: boolean,
  details: readonly AccountLogDetail[],
): AccountLogPage {
  return {
    pageNo,
    pageSize,
    totalSize,
    details,
    hasMore,
    traceId: `trace-${pageNo}`,
    rawResponse: {
      status: 200,
      headers: { "alipay-request-id": `trace-${pageNo}` },
      body: JSON.stringify({ page: pageNo, total: totalSize }),
      traceId: `trace-${pageNo}`,
      signatureVerified: true,
    },
  };
}

function detail(
  accountLogId: string,
  amount: string,
  occurredAt: string,
): AccountLogDetail {
  return {
    raw: { account_log_id: accountLogId, amount, direction: "CREDIT", occurred_at: occurredAt },
    accountLogId,
    occurredAt,
    amount,
    direction: "CREDIT",
    alipayOrderNo: `alipay-${accountLogId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
}

async function withDatabase(
  operation: (context: { readonly database: AppDatabase; readonly store: LedgerStore }) => Promise<void>,
  bindIdentity = true,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-service-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  try {
    const store = new LedgerStore(database);
    if (bindIdentity) store.bindProviderIdentity(PROVIDER_IDENTITY, NOW);
    await operation({ database, store });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, "condition was not met before the test timeout");
}
