import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import {
  requestFingerprint,
  responseFingerprint,
  type AccountLogPageInput,
  type IngestSegment,
  type RawPageEvidence,
} from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";

const WINDOW = { start: "2026-08-14 00:00:00", end: "2026-08-14 01:00:00" } as const;
const STARTED_AT = 1_800_000_000_000;
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;

describe("LedgerStore segment ingestion", () => {
  it("binds the primary namespace to its platform identity on first use", async () => {
    await withUnboundLedgerStore(async ({ database, store }) => {
      const binding = store.bindProviderIdentity(PROVIDER_IDENTITY, STARTED_AT);

      assert.deepEqual(binding, {
        ...PROVIDER_IDENTITY,
        identityFingerprintVersion: 1,
        identityFingerprint: binding.identityFingerprint,
        boundAt: STARTED_AT,
      });
      assert.equal(
        binding.identityFingerprint,
        "29622d2cc9d537f8b054f90cffef34d4ec6f6c884b3a53de10dcb12896fe4446",
      );
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_bindings",
        ).get() as { count: bigint }).count)),
        1,
      );
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("reuses an identical binding and ignores key rotation metadata", async () => {
    await withUnboundLedgerStore(async ({ database, store }) => {
      const firstIdentity = {
        ...PROVIDER_IDENTITY,
        applicationKeyFingerprint: "a".repeat(64),
        platformKeyFingerprint: "b".repeat(64),
      };
      const rotatedIdentity = {
        ...PROVIDER_IDENTITY,
        applicationKeyFingerprint: "c".repeat(64),
        platformKeyFingerprint: "d".repeat(64),
      };
      const first = store.bindProviderIdentity(firstIdentity, STARTED_AT);
      const repeated = store.bindProviderIdentity(rotatedIdentity, STARTED_AT + 1_000);

      assert.deepEqual(repeated, first);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_bindings",
        ).get() as { count: bigint }).count)),
        1,
      );
    });
  });

  it("rejects changing the provider endpoint for the bound namespace", async () => {
    await withUnboundLedgerStore(async ({ store }) => {
      store.bindProviderIdentity(PROVIDER_IDENTITY, STARTED_AT);
      assert.throws(
        () => store.bindProviderIdentity({
          ...PROVIDER_IDENTITY,
          endpoint: "https://openapi-sandbox.dl.alipaydev.com",
        }, STARTED_AT + 1_000),
        /does not match the existing account binding/,
      );
    });
  });

  it("rejects changing the external account ID for the bound namespace", async () => {
    await withUnboundLedgerStore(async ({ store }) => {
      store.bindProviderIdentity(PROVIDER_IDENTITY, STARTED_AT);
      assert.throws(
        () => store.bindProviderIdentity({
          ...PROVIDER_IDENTITY,
          externalAccountId: "2026000000000001",
        }, STARTED_AT + 1_000),
        /does not match the existing account binding/,
      );
    });
  });

  it("keeps provider bindings immutable and detects fingerprint damage", async () => {
    await withUnboundLedgerStore(async ({ database, store }) => {
      store.bindProviderIdentity(PROVIDER_IDENTITY, STARTED_AT);
      assert.throws(
        () => database.write((connection) => connection.prepare(
          "UPDATE provider_account_bindings SET external_account_id = 'changed'",
        ).run()),
        /immutable/,
      );
      assert.throws(
        () => database.write((connection) => connection.prepare(
          "DELETE FROM provider_account_bindings",
        ).run()),
        /cannot be deleted/,
      );

      const updateTrigger = database.read((connection) => connection.prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'provider_account_bindings_no_update'`,
      ).get() as { sql: string });
      database.write((connection) => {
        connection.exec("DROP TRIGGER provider_account_bindings_no_update");
        connection.prepare(
          `UPDATE provider_account_bindings
              SET identity_fingerprint =
                CASE substr(identity_fingerprint, 1, 1)
                  WHEN '0' THEN '1' || substr(identity_fingerprint, 2)
                  ELSE '0' || substr(identity_fingerprint, 2)
                END`,
        ).run();
        connection.exec(updateTrigger.sql);
      });

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.equal(integrity.foreignKeyViolations, 0);
      assert.equal(integrity.domainViolations, 1);
      assert.equal(integrity.ok, false);
    });
  });

  it("rejects ingest startup until the provider account is bound", async () => {
    await withUnboundLedgerStore(async ({ database, store }) => {
      assert.throws(
        () => store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT }),
        /must be bound before ledger ingestion/,
      );
      assert.equal(store.getCursor(), null);
      assert.deepEqual(databaseCounts(database), {
        pages: 0,
        events: 0,
        entries: 0,
        observations: 0,
        segments: 0,
      });
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM ingest_runs",
        ).get() as { count: bigint }).count)),
        0,
      );
    });
  });

  it("splits an oversized root and atomically completes the run after every leaf", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 2, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      const probeBody = Buffer.from([0, 1, 2, 255]);
      const split = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: root.ingestSegmentId,
        page: page(1, 3, true, [
          detail("probe-1", "1.00", "CREDIT", "2026-08-14 00:01:00"),
          detail("probe-2", "2.00", "CREDIT", "2026-08-14 00:02:00"),
        ], 2),
        evidence: evidence(probeBody),
        now: STARTED_AT + 1_000,
      });

      assert.equal(split.kind, "split");
      assert.deepEqual(
        split.children.map((segment) => [segment.windowStart, segment.windowEnd]),
        [
          ["2026-08-14 00:00:00", "2026-08-14 00:30:00"],
          ["2026-08-14 00:30:00", "2026-08-14 01:00:00"],
        ],
      );
      assert.equal(store.listLedgerEntries().length, 0, "probe details must not enter the ledger");
      assert.equal(split.cursor.complete, false);
      assert.equal(split.cursor.nextPageNo, 1);
      assert.equal(split.run.status, "RUNNING");
      assert.deepEqual(Array.from(store.getRawPageBody(split.page.rawPageId) ?? []), Array.from(probeBody));

      const leftResult = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: split.children[0].ingestSegmentId,
        page: page(1, 2, false, [
          detail("event-credit", "10.01", "CREDIT", "2026-08-14 00:01:00", "merchant-credit"),
          detail("event-debit", "2.50", "DEBIT", "2026-08-14 00:30:00"),
        ], 2),
        evidence: evidence('{"leaf":"left"}'),
        now: STARTED_AT + 2_000,
      });
      assert.equal(leftResult.kind, "accepted");
      assert.equal(leftResult.rootCompleted, false);
      assert.deepEqual(leftResult.normalized.map((result) => result.kind), ["created", "created"]);
      assert.equal(leftResult.run.status, "RUNNING");

      const right = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      assert.equal(right.ingestSegmentId, split.children[1].ingestSegmentId);
      const detailWithUnknownOrderField = detail(
        "event-credit-2",
        "3.00",
        "CREDIT",
        "2026-08-14 00:31:00",
      );
      const rightResult = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: right.ingestSegmentId,
        page: page(1, 2, false, [
          detail("event-debit", "2.50", "DEBIT", "2026-08-14 00:30:00"),
          {
            ...detailWithUnknownOrderField,
            raw: {
              ...(detailWithUnknownOrderField.raw as Record<string, unknown>),
              out_biz_no: "unknown-order-value",
            },
          },
        ], 2),
        evidence: evidence('{"leaf":"right"}'),
        now: STARTED_AT + 3_000,
      });

      assert.equal(rightResult.kind, "accepted");
      assert.equal(rightResult.rootCompleted, true);
      assert.deepEqual(rightResult.normalized.map((result) => result.kind), ["duplicate", "created"]);
      assert.equal(rightResult.run.status, "COMPLETED");
      assert.equal(rightResult.cursor.complete, true);
      assert.equal(rightResult.cursor.nextPageNo, null);
      assert.equal(rightResult.cursor.lastCompletedAt, STARTED_AT + 3_000);
      assert.equal(store.getNextPendingSegment(run.ingestRunId), null);
      assert.equal(store.getLedgerEntry("primary", "event-credit")?.merchantOrderNo, "merchant-credit");
      assert.equal(store.getLedgerEntry("primary", "event-credit-2")?.merchantOrderNo, null);
      assert.deepEqual(
        store.listLedgerEntries().map((entry) => [entry.externalEventId, entry.amountCents, entry.direction]),
        [
          ["event-credit-2", 300, "CREDIT"],
          ["event-debit", 250, "DEBIT"],
          ["event-credit", 1_001, "CREDIT"],
        ],
      );
      assert.deepEqual(databaseCounts(database), {
        pages: 3,
        events: 4,
        entries: 3,
        observations: 3,
        segments: 3,
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("recursively splits by whole seconds and preserves a one-second shared boundary", async () => {
    await withLedgerStore(async ({ store }) => {
      const window = { start: "2026-08-14 00:00:00", end: "2026-08-14 00:00:04" };
      const run = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT });
      let now = STARTED_AT;
      while (true) {
        const segment = store.getNextPendingSegment(run.ingestRunId);
        if (!segment) break;
        now += 1_000;
        if (spanMilliseconds(segment) > 1_000) {
          const result = store.recordSegmentPage({
            ingestRunId: run.ingestRunId,
            ingestSegmentId: segment.ingestSegmentId,
            page: page(1, 2, true, [
              detail(`probe-${segment.ingestSegmentId}`, "1.00", "CREDIT", segment.windowStart),
            ]),
            evidence: evidence(`{"probe":"${segment.ingestSegmentId}"}`),
            now,
          });
          assert.equal(result.kind, "split");
        } else {
          const result = store.recordSegmentPage({
            ingestRunId: run.ingestRunId,
            ingestSegmentId: segment.ingestSegmentId,
            page: page(1, 0, false, []),
            evidence: evidence(`{"leaf":"${segment.ingestSegmentId}"}`),
            now,
          });
          assert.equal(result.kind, "accepted");
        }
      }

      const segments = store.listIngestSegments(run.ingestRunId);
      assert.equal(segments.length, 7);
      assert.equal(segments.filter((segment) => segment.state === "SPLIT").length, 3);
      assert.deepEqual(
        segments
          .filter((segment) => segment.state === "COMPLETE")
          .map((segment) => [segment.windowStart, segment.windowEnd]),
        [
          ["2026-08-14 00:00:00", "2026-08-14 00:00:01"],
          ["2026-08-14 00:00:01", "2026-08-14 00:00:02"],
          ["2026-08-14 00:00:02", "2026-08-14 00:00:03"],
          ["2026-08-14 00:00:03", "2026-08-14 00:00:04"],
        ],
      );
      assert.equal(store.getRun(run.ingestRunId)?.status, "COMPLETED");
      assert.equal(store.getCursor()?.complete, true);
    });
  });

  it("resumes the same running segment tree after a page budget boundary", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const window = { start: "2026-08-14 00:00:00", end: "2026-08-14 00:00:04" };
      const run = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: root.ingestSegmentId,
        page: page(1, 2, true, [detail("probe", "1.00", "CREDIT", window.start)]),
        evidence: evidence('{"probe":true}'),
        now: STARTED_AT + 1_000,
      });

      const resumed = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT + 2_000 });
      assert.equal(resumed.ingestRunId, run.ingestRunId);
      const firstLeaf = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: firstLeaf.ingestSegmentId,
        page: page(1, 0, false, []),
        evidence: evidence('{"leaf":1}'),
        now: STARTED_AT + 3_000,
      });
      assert.equal(store.getRun(run.ingestRunId)?.status, "RUNNING");
      assert.equal(store.getCursor()?.nextPageNo, 1);

      const resumedAgain = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT + 4_000 });
      assert.equal(resumedAgain.ingestRunId, run.ingestRunId);
      const secondLeaf = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: secondLeaf.ingestSegmentId,
        page: page(1, 0, false, []),
        evidence: evidence('{"leaf":2}'),
        now: STARTED_AT + 5_000,
      });

      assert.equal(store.getRun(run.ingestRunId)?.status, "COMPLETED");
      assert.deepEqual(
        database.read((connection) =>
          (connection.prepare("SELECT DISTINCT page_no FROM provider_raw_pages").all() as Array<{ page_no: bigint }>).map(
            (row) => Number(row.page_no),
          ),
        ),
        [1],
      );
    });
  });

  it("fails a one-second dense segment without advancing the root cursor", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const window = { start: "2026-08-14 00:00:00", end: "2026-08-14 00:00:01" };
      const run = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      const result = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: root.ingestSegmentId,
        page: page(1, 2, true, [detail("dense", "1.00", "CREDIT", window.start)]),
        evidence: evidence('{"dense":true}'),
        now: STARTED_AT + 1_000,
      });

      assert.equal(result.kind, "density_exceeded");
      assert.equal(result.run.status, "FAILED");
      assert.equal(result.run.failureCode, "pagination_density_exceeded");
      assert.equal(result.segment.state, "PENDING");
      assert.equal(result.cursor.complete, false);
      assert.equal(result.cursor.nextPageNo, 1);
      assert.equal(result.cursor.windowEnd, window.end);
      assert.equal(store.listLedgerEntries().length, 0);
      assert.deepEqual(
        database.read((connection) => {
          const row = connection.prepare(
            "SELECT error_code, page_no FROM ingest_errors WHERE ingest_run_id = ?",
          ).get(run.ingestRunId) as { error_code: string; page_no: bigint };
          return { errorCode: row.error_code, pageNo: Number(row.page_no) };
        }),
        { errorCode: "pagination_density_exceeded", pageNo: 1 },
      );
      const retry = store.startIngestRun({ ...window, pageSize: 1, now: STARTED_AT + 2_000 });
      assert.notEqual(retry.ingestRunId, run.ingestRunId);
      assert.equal(store.getNextPendingSegment(retry.ingestRunId)?.state, "PENDING");
    });
  });

  it("rolls back the leaf, cursor, and run together when final completion aborts", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      database.write((connection) => connection.exec(`
        CREATE TRIGGER test_abort_ingest_completion
        BEFORE UPDATE OF status ON ingest_runs
        WHEN NEW.status = 'COMPLETED'
        BEGIN
          SELECT RAISE(ABORT, 'injected final completion failure');
        END;
      `));
      assert.throws(
        () => store.recordSegmentPage({
          ingestRunId: run.ingestRunId,
          ingestSegmentId: root.ingestSegmentId,
          page: page(1, 1, false, [
            detail("atomic-event", "1.00", "CREDIT", "2026-08-14 00:01:00"),
          ]),
          evidence: evidence('{"atomic":true}'),
          now: STARTED_AT + 1_000,
        }),
        /injected final completion failure/,
      );
      database.write((connection) => connection.exec("DROP TRIGGER test_abort_ingest_completion"));

      assert.equal(store.getRun(run.ingestRunId)?.status, "RUNNING");
      assert.equal(store.getRootSegment(run.ingestRunId)?.state, "PENDING");
      assert.equal(store.getCursor()?.complete, false);
      assert.equal(store.listLedgerEntries().length, 0);
      assert.deepEqual(databaseCounts(database), {
        pages: 0,
        events: 0,
        entries: 0,
        observations: 0,
        segments: 1,
      });

      const retry = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: root.ingestSegmentId,
        page: page(1, 1, false, [
          detail("atomic-event", "1.00", "CREDIT", "2026-08-14 00:01:00"),
        ]),
        evidence: evidence('{"atomic":true}'),
        now: STARTED_AT + 2_000,
      });
      assert.equal(retry.kind, "accepted");
      assert.equal(retry.rootCompleted, true);
      assert.equal(retry.run.status, "COMPLETED");
    });
  });

  it("rejects offset pages and inconsistent leaf metadata before persistence", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      assert.throws(
        () => store.recordSegmentPage({
          ingestRunId: run.ingestRunId,
          ingestSegmentId: root.ingestSegmentId,
          page: page(2, 2, false, [detail("page-two", "1.00", "CREDIT", WINDOW.start)]),
          evidence: evidence('{"page":2}'),
          now: STARTED_AT + 1_000,
        }),
        /only accepts provider page one/,
      );
      assert.throws(
        () => store.recordSegmentPage({
          ingestRunId: run.ingestRunId,
          ingestSegmentId: root.ingestSegmentId,
          page: page(1, 2, false, [detail("incomplete", "1.00", "CREDIT", WINDOW.start)]),
          evidence: evidence('{"incomplete":true}'),
          now: STARTED_AT + 2_000,
        }),
        /must contain its complete result set/,
      );
      assert.throws(
        () => store.recordSegmentPage({
          ingestRunId: run.ingestRunId,
          ingestSegmentId: root.ingestSegmentId,
          page: page(1, 1, false, [
            detail("outside", "1.00", "CREDIT", "2026-08-14 01:00:01"),
          ]),
          evidence: evidence('{"outside":true}'),
          now: STARTED_AT + 3_000,
        }),
        /outside the ingest segment/,
      );
      assert.equal(databaseCounts(database).pages, 0);
      assert.equal(store.getCursor()?.nextPageNo, 1);
    });
  });

  it("reuses exact leaf evidence across runs and isolates changed variants", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const event = detail("overlap-event", "88.88", "CREDIT", "2026-08-14 00:10:00");
      const body = '{"event":"overlap-event","version":1}';
      const firstRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      const first = recordOnlyLeaf(
        store,
        firstRun.ingestRunId,
        page(1, 1, false, [event]),
        body,
        STARTED_AT + 1_000,
        evidence(body, "trace-1"),
      );
      assert.equal(first.observation, "inserted");

      const replayRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT + 2_000 });
      const replay = recordOnlyLeaf(
        store,
        replayRun.ingestRunId,
        page(1, 1, false, [event]),
        body,
        STARTED_AT + 3_000,
        evidence(body, "trace-2"),
      );
      assert.equal(replay.observation, "duplicate");
      assert.deepEqual(replay.normalized, []);
      assert.deepEqual(
        database.read((connection) => (connection.prepare(
          `SELECT trace_id, headers_json
             FROM ingest_run_page_observations
            ORDER BY observed_at`,
        ).all() as Array<{ trace_id: string; headers_json: string }>).map((row) => ({ ...row }))),
        [
          { trace_id: "trace-1", headers_json: '{"alipay-request-id":"trace-1"}' },
          { trace_id: "trace-2", headers_json: '{"alipay-request-id":"trace-2"}' },
        ],
      );

      const variantRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT + 4_000 });
      const variant = recordOnlyLeaf(
        store,
        variantRun.ingestRunId,
        page(1, 1, false, [event]),
        '{"event":"overlap-event","version":2}',
        STARTED_AT + 5_000,
      );
      assert.equal(variant.observation, "variant");
      assert.equal(store.listOpenConflicts()[0]?.conflictType, "RAW_PAGE_VARIANT");
      assert.deepEqual(databaseCounts(database), {
        pages: 2,
        events: 2,
        entries: 1,
        observations: 3,
        segments: 3,
      });
    });
  });

  it("isolates changed semantics and malformed leaf events", async () => {
    await withLedgerStore(async ({ store }) => {
      const firstRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      store.recordPage({
        ingestRunId: firstRun.ingestRunId,
        page: page(1, 1, false, [detail("same-id", "10.00", "CREDIT", "2026-08-14 00:01:00")]),
        evidence: evidence('{"amount":"10.00"}'),
        now: STARTED_AT + 1_000,
      });
      const secondRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT + 2_000 });
      const conflicting = store.recordPage({
        ingestRunId: secondRun.ingestRunId,
        page: page(1, 1, false, [detail("same-id", "11.00", "CREDIT", "2026-08-14 00:01:00")]),
        evidence: evidence('{"amount":"11.00"}'),
        now: STARTED_AT + 3_000,
      });
      assert.equal(conflicting.normalized[0]?.kind, "conflict");
      assert.equal(store.getLedgerEntry("primary", "same-id")?.amountCents, 1_000);
      assert.equal(store.getLedgerEntry("primary", "same-id")?.state, "CONFLICT");

      const malformedRun = store.startIngestRun({ ...WINDOW, pageSize: 2, now: STARTED_AT + 4_000 });
      const malformed = store.recordPage({
        ingestRunId: malformedRun.ingestRunId,
        page: page(1, 2, false, [
          detail(null, "1.00", "CREDIT", "2026-08-14 00:01:00"),
          detail("bad-amount", "1.001", "CREDIT", "2026-08-14 00:02:00"),
        ], 2),
        evidence: evidence('{"malformed":true}'),
        now: STARTED_AT + 5_000,
      });
      assert.deepEqual(malformed.normalized.map((item) => item.kind), ["isolated", "isolated"]);
      assert.equal(store.listOpenConflicts().some((item) => item.conflictType === "MISSING_EXTERNAL_ID"), true);
      assert.equal(store.listOpenConflicts().some((item) => item.conflictType === "INVALID_AMOUNT"), true);
    });
  });

  it("keeps raw probes immutable and records a terminal provider error", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      const root = requiredSegment(store.getNextPendingSegment(run.ingestRunId));
      const split = store.recordSegmentPage({
        ingestRunId: run.ingestRunId,
        ingestSegmentId: root.ingestSegmentId,
        page: page(1, 2, true, [detail("probe", "1.00", "CREDIT", WINDOW.start)]),
        evidence: evidence('{"probe":true}'),
        now: STARTED_AT + 1_000,
      });
      assert.throws(
        () => database.write((connection) => connection.prepare(
          "UPDATE provider_raw_pages SET raw_body = x'00' WHERE raw_page_id = ?",
        ).run(split.page.rawPageId)),
        /immutable/,
      );
      const failed = store.recordIngestError({
        ingestRunId: run.ingestRunId,
        pageNo: 1,
        errorKind: "authorization",
        errorCode: "remote_authorization_failed",
        retryable: false,
        evidence: {
          httpStatus: 403,
          headers: { "alipay-request-id": "denied-trace" },
          body: Buffer.from([0, 255, 1]),
          traceId: "denied-trace",
          signatureVerified: false,
        },
        details: { status: 403 },
        now: STARTED_AT + 2_000,
      });
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.failureCode, "remote_authorization_failed");
      assert.equal(store.getCursor()?.nextPageNo, 1);
    });
  });

  it("detects segment ownership damage during database integrity checks", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      store.recordPage({
        ingestRunId: run.ingestRunId,
        page: page(1, 1, false, [detail("integrity-event", "1.00", "CREDIT", "2026-08-14 00:01:00")]),
        evidence: evidence('{"integrity":true}'),
        now: STARTED_AT + 1_000,
      });
      const triggerSql = database.read((connection) => {
        const rows = connection.prepare(
          `SELECT name, sql FROM sqlite_schema
            WHERE type = 'trigger'
              AND name IN ('ingest_segments_identity_immutable', 'ingest_segments_terminal_immutable')`,
        ).all() as Array<{ name: string; sql: string }>;
        return rows;
      });
      database.write((connection) => {
        connection.exec("DROP TRIGGER ingest_segments_identity_immutable");
        connection.exec("DROP TRIGGER ingest_segments_terminal_immutable");
        connection.prepare("UPDATE ingest_segments SET window_end = '2026-08-14 00:59:59'").run();
        for (const trigger of triggerSql) connection.exec(trigger.sql);
      });
      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.equal(integrity.foreignKeyViolations, 0);
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
    });
  });

  it("detects provider raw pages that have no ingest observation", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      assert.equal(database.integrityCheck().ok, true);

      const rawBody = Buffer.from("{}", "utf8");
      database.write((connection) => {
        connection.prepare(
          `INSERT INTO provider_raw_pages(
             raw_page_id, ingest_run_id, provider_account_key, window_start,
             window_end, page_no, page_size, total_size, has_more,
             request_fingerprint, response_fingerprint, http_status,
             headers_json, raw_body, trace_id, signature_verified, received_at
           ) VALUES (?, ?, 'primary', ?, ?, 1, 1, 0, 0, ?, ?, 200, '{}', ?, NULL, 1, ?)`,
        ).run(
          "00000000-0000-4000-8000-000000000001",
          run.ingestRunId,
          WINDOW.start,
          WINDOW.end,
          requestFingerprint("primary", WINDOW.start, WINDOW.end, 1, 1),
          responseFingerprint(rawBody),
          rawBody,
          STARTED_AT + 1_000,
        );
      });

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.equal(integrity.foreignKeyViolations, 0);
      assert.equal(integrity.domainViolations, 1);
      assert.equal(integrity.ok, false);
    });
  });

  it("clamps ingest writes to durable logical time after a wall-clock rollback", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      const accepted = recordOnlyLeaf(
        store,
        run.ingestRunId,
        page(1, 1, false, [
          detail("clock-page", "1.00", "CREDIT", "2026-08-14 00:01:00"),
        ]),
        '{"clock":"page"}',
        STARTED_AT - 1_000,
      );
      assert.equal(accepted.run.completedAt, STARTED_AT);
      assert.equal(accepted.segment.completedAt, STARTED_AT);
      assert.equal(accepted.cursor.updatedAt, STARTED_AT);

      const failedRun = store.startIngestRun({
        ...WINDOW,
        pageSize: 1,
        now: STARTED_AT - 2_000,
      });
      assert.equal(failedRun.startedAt, STARTED_AT);
      const failed = store.recordIngestError({
        ingestRunId: failedRun.ingestRunId,
        pageNo: 1,
        errorKind: "transport",
        errorCode: "clock_rollback_failure",
        retryable: true,
        now: STARTED_AT - 3_000,
      });
      assert.equal(failed.completedAt, STARTED_AT);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT occurred_at FROM ingest_errors WHERE ingest_run_id = ?",
        ).get(failedRun.ingestRunId) as { occurred_at: bigint }).occurred_at)),
        STARTED_AT,
      );
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("detects changed raw, normalized, and error evidence fingerprints", async () => {
    await withLedgerStore(async ({ database, store }) => {
      const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT });
      store.recordPage({
        ingestRunId: run.ingestRunId,
        page: page(1, 1, false, [
          detail("fingerprint-event", "1.00", "CREDIT", "2026-08-14 00:01:00"),
        ]),
        evidence: evidence('{"fingerprint":"page"}'),
        now: STARTED_AT + 1_000,
      });
      const failedRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: STARTED_AT + 2_000 });
      store.recordIngestError({
        ingestRunId: failedRun.ingestRunId,
        pageNo: 1,
        errorKind: "transport",
        errorCode: "fingerprint_test_error",
        retryable: true,
        evidence: {
          httpStatus: 503,
          headers: { "alipay-request-id": "fingerprint-error" },
          body: '{"fingerprint":"error"}',
          traceId: "fingerprint-error",
          signatureVerified: false,
        },
        now: STARTED_AT + 3_000,
      });
      assert.equal(database.integrityCheck().ok, true);

      const triggerSql = database.read((connection) => connection.prepare(
        `SELECT name, sql
           FROM sqlite_schema
          WHERE type = 'trigger'
            AND name IN (
              'provider_raw_pages_no_update',
              'provider_raw_events_no_update',
              'ledger_entries_facts_immutable',
              'ingest_errors_no_update'
            )
          ORDER BY name`,
      ).all() as Array<{ name: string; sql: string }>);
      database.write((connection) => {
        for (const trigger of triggerSql) connection.exec(`DROP TRIGGER ${trigger.name}`);
        connection.prepare(
          `UPDATE provider_raw_pages
              SET raw_body = x'00',
                  request_fingerprint =
                    CASE substr(request_fingerprint, 1, 1)
                      WHEN '0' THEN '1' || substr(request_fingerprint, 2)
                      ELSE '0' || substr(request_fingerprint, 2)
                    END`,
        ).run();
        connection.prepare("UPDATE provider_raw_events SET raw_payload = x'00'").run();
        connection.prepare(
          `UPDATE ledger_entries
              SET semantic_fingerprint =
                CASE substr(semantic_fingerprint, 1, 1)
                  WHEN '0' THEN '1' || substr(semantic_fingerprint, 2)
                  ELSE '0' || substr(semantic_fingerprint, 2)
                END`,
        ).run();
        connection.prepare("UPDATE ingest_errors SET raw_body = x'00'").run();
        for (const trigger of triggerSql) connection.exec(trigger.sql);
      });

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.equal(integrity.foreignKeyViolations, 0);
      assert.equal(integrity.domainViolations, 5);
      assert.equal(integrity.ok, false);
    });
  });
});

function recordOnlyLeaf(
  store: LedgerStore,
  ingestRunId: string,
  value: AccountLogPageInput,
  body: string,
  now: number,
  rawEvidence: RawPageEvidence = evidence(body),
) {
  const segment = requiredSegment(store.getNextPendingSegment(ingestRunId));
  return store.recordSegmentPage({
    ingestRunId,
    ingestSegmentId: segment.ingestSegmentId,
    page: value,
    evidence: rawEvidence,
    now,
  });
}

function page(
  pageNo: number,
  totalSize: number,
  hasMore: boolean,
  details: readonly AccountLogDetail[],
  pageSize = 1,
): AccountLogPageInput {
  return { pageNo, pageSize, totalSize, hasMore, details };
}

function detail(
  accountLogId: string | null,
  amount: string,
  direction: string,
  occurredAt: string,
  merchantOrderNo: string | null = null,
): AccountLogDetail {
  return {
    raw: { account_log_id: accountLogId, amount, direction, occurred_at: occurredAt },
    accountLogId,
    occurredAt,
    amount,
    direction,
    alipayOrderNo: accountLogId === null ? null : `alipay-${accountLogId}`,
    merchantOrderNo,
    transMemo: null,
    otherAccount: null,
  };
}

function evidence(body: string | Uint8Array, traceId = "trace-1"): RawPageEvidence {
  return {
    httpStatus: 200,
    headers: { "alipay-request-id": traceId },
    body,
    traceId,
    signatureVerified: true,
  };
}

function requiredSegment(segment: IngestSegment | null): IngestSegment {
  assert.ok(segment, "expected a pending ingest segment");
  return segment;
}

function spanMilliseconds(segment: IngestSegment): number {
  return Date.parse(segment.windowEnd.replace(" ", "T") + "+08:00") -
    Date.parse(segment.windowStart.replace(" ", "T") + "+08:00");
}

function databaseCounts(database: AppDatabase) {
  return database.read((connection) => {
    const row = connection.prepare(
      `SELECT
         (SELECT COUNT(*) FROM provider_raw_pages) AS pages,
         (SELECT COUNT(*) FROM provider_raw_events) AS events,
         (SELECT COUNT(*) FROM ledger_entries) AS entries,
         (SELECT COUNT(*) FROM ingest_run_page_observations) AS observations,
         (SELECT COUNT(*) FROM ingest_segments) AS segments`,
    ).get() as Record<string, bigint | number>;
    return {
      pages: Number(row.pages),
      events: Number(row.events),
      entries: Number(row.entries),
      observations: Number(row.observations),
      segments: Number(row.segments),
    };
  });
}

type LedgerStoreTestOperation = (
  context: { readonly database: AppDatabase; readonly store: LedgerStore },
) => Promise<void>;

async function withLedgerStore(operation: LedgerStoreTestOperation, bindIdentity = true): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-store-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  try {
    const store = new LedgerStore(database);
    if (bindIdentity) store.bindProviderIdentity(PROVIDER_IDENTITY, STARTED_AT);
    await operation({ database, store });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withUnboundLedgerStore(operation: LedgerStoreTestOperation): Promise<void> {
  await withLedgerStore(operation, false);
}
