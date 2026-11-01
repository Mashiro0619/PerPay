import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AuditQueryError, exportAuditEvents, projectAuditCaptureState, queryAuditEvent, queryAuditEvents, queryAuditMetadata, readAuditPageQuery } from "../src/audit/query.ts";
import { ListQueryError } from "../src/shared/list-query.ts";
import { AUDIT_TEST_NOW as now, auditQueryFixture } from "./audit-query-fixture.ts";

const DAY = 86_400_000;
const query = (values: Record<string, string> = {}) => readAuditPageQuery(new URLSearchParams(values));

describe("unified audit queries", () => {
  it("orders both sources deterministically and holds both sequence watermarks across new and delayed events", () => {
    const test = auditQueryFixture();
    try {
      const firstCore = test.core();
      const secondCore = test.core();
      const firstActivity = test.activity();
      const secondActivity = test.activity();
      const first = queryAuditEvents(test.database, query({ limit: "2" }), now);
      assert.deepEqual(first.data.map(row => row.event_id), [secondCore.eventId, firstCore.eventId]);
      assert.equal(first.page.snapshot_at, new Date(now).toISOString());
      assert.ok(first.page.next_cursor);
      test.core({ occurredAt: now + 1 });
      test.activity({ occurredAt: now - 1 });
      const second = queryAuditEvents(test.database, query({ limit: "2", cursor: first.page.next_cursor }), now + 20);
      assert.deepEqual(second.data.map(row => row.event_id), [secondActivity.eventId, firstActivity.eventId]);
      assert.equal(second.page.snapshot_at, first.page.snapshot_at);
      assert.equal(second.page.next_cursor, null);
      assert.equal(new Set([...first.data, ...second.data].map(row => row.source + row.event_id)).size, 4);
      assert.equal(queryAuditEvents(test.database, query(), now + 20).data.length, 6);
    } finally { test.close(); }
  });

  it("does not move an open minute aggregate when its count and last occurrence advance", () => {
    const test = auditQueryFixture();
    try {
      const aggregate = test.activity({ occurredAt: now - 30_000, aggregate: true, durationMs: 11, route: "/api/admin/v1/orders" });
      const latest = test.core({ occurredAt: now });
      const first = queryAuditEvents(test.database, query({ limit: "1" }), now);
      assert.equal(first.data[0]?.event_id, latest.eventId);
      test.activity({ occurredAt: now - 10_000, aggregate: true, durationMs: 19, route: "/api/admin/v1/orders" });
      const second = queryAuditEvents(test.database, query({ limit: "1", cursor: first.page.next_cursor! }), now + 1);
      assert.equal(second.data[0]?.event_id, aggregate.eventId);
      assert.equal(second.data[0]?.occurred_at, new Date(now - 30_000).toISOString());
      assert.equal(second.data[0]?.first_occurred_at, new Date(now - 30_000).toISOString());
      assert.equal(second.data[0]?.last_occurred_at, new Date(now - 10_000).toISOString());
      assert.equal(second.data[0]?.event_count, 2);
      assert.equal(second.data[0]?.duration_ms, 30);
      assert.equal(second.page.next_cursor, null);
    } finally { test.close(); }
  });

  it("keeps snapshot pagination stable when a late request moves the true first occurrence earlier and exports the complete interval", () => {
    const test = auditQueryFixture();
    try {
      const aggregate = test.activity({ occurredAt: now - 20_000, aggregate: true, durationMs: 11, route: "/api/admin/v1/orders" });
      const older = test.core({ occurredAt: now - 35_000 });
      const latest = test.core();
      const first = queryAuditEvents(test.database, query({ limit: "1" }), now);
      assert.equal(first.data[0]?.event_id, latest.eventId);
      const before = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01", q: aggregate.eventId }, now);

      // This request started earlier in the same minute but completed after the page/export snapshot.
      test.activity({ occurredAt: now - 50_000, aggregate: true, durationMs: 40, route: "/api/admin/v1/orders" });
      test.activity({ occurredAt: now - 10_000, aggregate: true, durationMs: 19, route: "/api/admin/v1/orders" });
      test.core({ occurredAt: now - 5_000 });

      const second = queryAuditEvents(test.database, query({ limit: "1", cursor: first.page.next_cursor! }), now + 1);
      assert.equal(second.data[0]?.event_id, aggregate.eventId);
      assert.equal(second.data[0]?.occurred_at, new Date(now - 20_000).toISOString());
      assert.equal(second.data[0]?.first_occurred_at, new Date(now - 50_000).toISOString());
      assert.equal(second.data[0]?.last_occurred_at, new Date(now - 10_000).toISOString());
      assert.equal(second.data[0]?.event_count, 3);
      assert.equal(second.data[0]?.duration_ms, 70);
      assert.equal(second.page.snapshot_at, first.page.snapshot_at);
      const third = queryAuditEvents(test.database, query({ limit: "1", cursor: second.page.next_cursor! }), now + 2);
      assert.deepEqual(third.data.map(row => row.event_id), [older.eventId]);
      assert.equal(third.page.next_cursor, null);

      const detail = queryAuditEvent(test.database, "activity", aggregate.eventId, now);
      assert.equal(detail.occurred_at, second.data[0]?.occurred_at);
      assert.equal(detail.first_occurred_at, second.data[0]?.first_occurred_at);
      const after = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01", q: aggregate.eventId }, now);
      assert.equal(after.summary.row_count, 1);
      assert.ok(before.csv.includes('"2026-11-01 19:59:40.000 +08:00","2026-11-01 19:59:40.000 +08:00"'));
      assert.ok(after.csv.includes('"2026-11-01 19:59:10.000 +08:00","2026-11-01 19:59:50.000 +08:00"'));
      assert.equal(after.csv.includes('"2026-11-01 19:59:40.000 +08:00"'), false);
    } finally { test.close(); }
  });

  it("falls back to the ordering timestamp for legacy activity rows without a stored first occurrence", () => {
    const test = auditQueryFixture();
    try {
      test.connection.prepare("INSERT INTO activity_events(event_id,activity_id,occurred_at,last_occurred_at,source_type,actor_type,action,outcome) VALUES(?,?,?,?,'HTTP','ANONYMOUS','http.request','SUCCESS')")
        .run("legacy_activity", "legacy_group", now, now);
      const expected = new Date(now).toISOString();
      assert.equal(queryAuditEvents(test.database, query(), now).data[0]?.first_occurred_at, expected);
      assert.equal(queryAuditEvent(test.database, "activity", "legacy_activity", now).first_occurred_at, expected);
      const exported = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01" }, now);
      assert.ok(exported.csv.includes('"2026-11-01 20:00:00.000 +08:00","2026-11-01 20:00:00.000 +08:00"'));
    } finally { test.close(); }
  });

  it("classifies backup actions as maintenance even when emitted by a background producer", () => {
    const test = auditQueryFixture();
    try {
      const backup = test.activity({ action: "backup.cycle", sourceType: "BACKGROUND" });
      test.activity({ action: "ledger.scan", sourceType: "BACKGROUND" });
      const page = queryAuditEvents(test.database, query({ category: "maintenance" }), now);
      assert.deepEqual(page.data.map(row => row.event_id), [backup.eventId]);
      assert.equal(queryAuditMetadata(test.database, undefined, now).actions.find(row => row.action === "backup.cycle")?.category, "maintenance");
    } finally { test.close(); }
  });

  it("binds cursors to every filter and the page size, rejecting malformed input and SQL-looking values", () => {
    const test = auditQueryFixture();
    try {
      test.core(); test.core();
      const cursor = queryAuditEvents(test.database, query({ limit: "1" }), now).page.next_cursor!;
      for (const values of [{ cursor, q: "new", limit: "1" }, { cursor, limit: "2" }, { cursor: "invalid", limit: "1" }]) {
        assert.throws(() => query(values), ListQueryError);
      }
      for (const text of ["limit=0", "limit=101", "source=invalid", "outcome=DENIED", "actor_type=root", "category=unknown", "action='OR1=1", "created_from=2026-02-30&created_to=2026-03-01", "created_from=2026-11-01", "source_address=proxy", "q=a&q=b", "sort_order=asc"]) {
        assert.throws(() => readAuditPageQuery(new URLSearchParams(text)), ListQueryError, text);
      }
      assert.equal(queryAuditEvents(test.database, query({ q: "' OR 1=1 --" }), now).data.length, 0);
    } finally { test.close(); }
  });

  it("applies Shanghai date boundaries, normalized source IP, historical site and literal keyword filters", () => {
    const test = auditQueryFixture();
    try {
      const midnight = Date.UTC(2026, 9, 31, 16);
      test.core({ occurredAt: midnight - 1, requestId: "x-match" });
      const found = test.core({ occurredAt: midnight, requestId: "x_100%", context: { sourceAddress: "2001:db8::7", siteId: "site_retired", siteName: "旧商店" } });
      test.core({ occurredAt: midnight + DAY });
      test.activity({ occurredAt: midnight, siteId: "site_other", sourceAddress: "2001:db8::7" });
      const filtered = queryAuditEvents(test.database, query({ created_from: "2026-11-01", created_to: "2026-11-01", source_address: "2001:0db8:0:0:0:0:0:7", site_id: "site_retired", q: "100%" }), now);
      assert.deepEqual(filtered.data.map(row => row.event_id), [found.eventId]);
      assert.equal(queryAuditEvents(test.database, query({ q: "x_" }), now).data.length, 1);
      assert.equal(queryAuditEvents(test.database, query({ site_id: "unassociated" }), now).data.length, 2);
      assert.equal(queryAuditEvents(test.database, query({ source: "core", category: "configuration", actor_type: "ADMIN", outcome: "SUCCESS" }), now).data.length, 3);
    } finally { test.close(); }
  });

  it("keeps old core facts without inventing IP or changes and never exposes unknown legacy details", () => {
    const test = auditQueryFixture({ occurredAt: now - 100 * DAY, actorType: "ADMIN", actorId: "admin", action: "legacy.configuration_changed", outcome: "SUCCESS",
      subjectType: "website", subjectId: "site_legacy", remoteAddressHash: "a".repeat(64), details: { revision: 7, note: "PRIVATE BODY", raw_request: "PRIVATE CONTENT" } });
    try {
      const old = test.legacyEvent!;
      const detail = queryAuditEvent(test.database, "core", old.eventId, now);
      assert.equal(detail.first_occurred_at, detail.occurred_at);
      assert.equal(detail.context_recorded, false);
      assert.equal(detail.source_address, null);
      assert.equal(detail.user_agent, null);
      assert.deepEqual(detail.changes, []);
      assert.deepEqual(detail.details, { revision: 7 });
      assert.equal(detail.remote_address_hash, "a".repeat(64));
      assert.equal(detail.event_hash, old.eventHash);
      assert.equal(detail.site_id, "site_legacy");
      assert.equal(queryAuditEvents(test.database, query(), now).data.length, 1);
      assert.equal(test.connection.prepare("SELECT event_hash FROM audit_events WHERE event_id = ?").get(old.eventId)?.event_hash, old.eventHash);
    } finally { test.close(); }
  });

  it("preserves operational facts emitted by activity producers in detail and CSV while excluding unknown metadata", () => {
    const test = auditQueryFixture();
    try {
      // These shapes mirror the results emitted by the delivery, ledger, spool and backup producers.
      const samples = [
        { action: "webhook.delivery", details: { order_id: "order_retry", attempt_number: 4, status: "RETRY_WAIT", delivery_outcome: "RETRYABLE_FAILURE", error_code: "ack_shape_invalid" } },
        { action: "ledger.scan", details: { reason: "scheduled", status: "COMPLETED", ingest_run_id: "ingest_1", pages: 2, created_entries: 7, duplicate_entries: 3, isolated_details: 1, conflicts: 0, error_code: null } },
        { action: "activity.capture_gap", details: { error_code: "source_retention_gap", missing_events: 3, after_sequence: 7, through_sequence: 10, pruned_through_at: now - 30 * DAY } },
        { action: "backup.restore", details: { command: "backup.restore", exit_code: 0, rebuild_state: true, quarantine_unreadable: false, force_unreadable_lock: true } },
        { action: "backup.cycle", details: { backup_name: "perpay-backup.sqlite3", instance_id: "instance_1", schema_version: 39, backup_size_bytes: 4096, deleted_backups: 2, recovered_temporary_files: 1 } },
      ];
      for (const sample of samples) {
        const event = test.activity({ action: sample.action, sourceType: "BACKGROUND", details: { ...sample.details,
          provider_diagnostic: "UNKNOWN_METADATA", raw_request: "RAW_REQUEST", raw_response: "RAW_RESPONSE", api_token: "API_TOKEN", password: "PASSWORD" } });
        const detail = queryAuditEvent(test.database, "activity", event.eventId, now);
        assert.deepEqual(detail.details, sample.details, sample.action);
        const exported = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01", q: event.eventId }, now);
        assert.equal(exported.summary.row_count, 1);
        assert.ok(exported.csv.includes('"' + JSON.stringify(detail.details).replaceAll('"', '""') + '"'), sample.action);
        for (const privateValue of ["UNKNOWN_METADATA", "RAW_REQUEST", "RAW_RESPONSE", "API_TOKEN", "PASSWORD"]) {
          assert.equal(exported.csv.includes(privateValue), false, `${sample.action}: ${privateValue}`);
        }
      }
    } finally { test.close(); }
  });

  it("retains order versions, reversed operation IDs and session generations in core detail and CSV", () => {
    const test = auditQueryFixture();
    try {
      const samples = [
        { action: "orders.created", details: { order_id: "order_1", order_version: 1, requested_amount_cents: 100, payable_amount_cents: 100, checkout_status: "OPEN" } },
        { action: "financial.reverse_settlement", details: { financial_operation_id: "operation_reverse", operation_type: "REVERSE_SETTLEMENT", order_id: "order_1", ledger_entry_id: "ledger_1", reverses_operation_id: "operation_original", amount_cents: 100 } },
        { action: "admin.password_recover", details: { session_generation: 3, revoked_count: 2 } },
        { action: "backup.restore", details: { command: "backup.restore", exit_code: 0, rebuild_state: false, quarantine_unreadable: false, force_unreadable_lock: false, external_event_id: "external_1" } },
      ];
      for (const sample of samples) {
        const event = test.core({ action: sample.action, details: { ...sample.details, legacy_payload: "UNKNOWN_LEGACY", raw_request: "RAW_REQUEST", raw_response: "RAW_RESPONSE", provider_diagnostic: "SECRET_VALUE" } });
        const detail = queryAuditEvent(test.database, "core", event.eventId, now);
        assert.deepEqual(detail.details, sample.details, sample.action);
        const exported = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01", q: event.eventId }, now);
        assert.equal(exported.summary.row_count, 1);
        assert.ok(exported.csv.includes('"' + JSON.stringify(detail.details).replaceAll('"', '""') + '"'), sample.action);
        for (const privateValue of ["UNKNOWN_LEGACY", "RAW_REQUEST", "RAW_RESPONSE", "SECRET_VALUE"]) {
          assert.equal(exported.csv.includes(privateValue), false, `${sample.action}: ${privateValue}`);
        }
      }
    } finally { test.close(); }
  });

  it("reads protected changes and correlates requests using internal activity IDs instead of supplied request IDs", () => {
    const test = auditQueryFixture();
    try {
      const activityId = randomUUID();
      const unrelatedId = randomUUID();
      const core = test.core({ requestId: "client-reused-id", context: { activityId, sourceAddress: "127.0.0.1", userAgent: "test-device", changes: [
        { field: "system_name", kind: "value", before: "旧名称", after: "新名称" },
        { field: "private_key", kind: "value", before: "DO NOT RETURN", after: "NOR THIS" },
      ] } });
      test.core({ requestId: "client-reused-id", context: { activityId: unrelatedId } });
      const activity = test.activity({ activityId, requestId: "client-reused-id", coreEventIds: [core.eventId] });
      test.activity({ activityId: unrelatedId, requestId: "client-reused-id" });
      const detail = queryAuditEvent(test.database, "core", core.eventId, now);
      assert.equal(detail.source_address, "127.0.0.1");
      assert.equal(detail.user_agent, "test-device");
      assert.equal(detail.changes[0]?.after, "新名称");
      assert.equal(detail.changes[1]?.kind, "redacted_change");
      assert.equal(detail.changes[1]?.before, undefined);
      assert.equal(JSON.stringify(detail).includes("DO NOT RETURN"), false);
      assert.deepEqual(detail.related_events.map(row => row.event_id), [activity.eventId]);
      assert.equal(detail.related_activity_available, true);
      const reverse = queryAuditEvent(test.database, "activity", activity.eventId, now);
      assert.deepEqual(reverse.related_events.map(row => row.event_id), [core.eventId]);
    } finally { test.close(); }
  });

  it("enforces activity retention while retaining core context and historical website choices", () => {
    const test = auditQueryFixture();
    try {
      const activityId = randomUUID();
      const core = test.core({ occurredAt: now - 31 * DAY, context: { activityId, siteId: "deleted-shop", siteName: "已删除商店" } });
      const expired = test.activity({ occurredAt: now - 31 * DAY, activityId, siteId: "deleted-shop" });
      const current = test.activity({ occurredAt: now - 30 * DAY });
      assert.deepEqual(queryAuditEvents(test.database, query(), now).data.map(row => row.event_id), [current.eventId, core.eventId]);
      assert.throws(() => queryAuditEvent(test.database, "activity", expired.eventId, now), (error: unknown) => error instanceof AuditQueryError && error.status === 404);
      assert.equal(queryAuditEvent(test.database, "core", core.eventId, now).related_activity_available, false);
      const capture = projectAuditCaptureState({ state: "degraded", bufferedEvents: 2, droppedEvents: 3, writeFailures: 4, lastFlushAt: now - 1, lastErrorCode: "activity_write_failed", spoolLastImportAt: null, spoolFailures: 5, spoolGapCount: 6 });
      const meta = queryAuditMetadata(test.database, capture, now);
      assert.deepEqual(meta.retention, { activity_days: 30, core: "indefinite" });
      assert.deepEqual(meta.sites, [{ site_id: "deleted-shop", site_name: "已删除商店", deleted: true }]);
      assert.equal(meta.capture.dropped_events, 3);
      assert.equal(meta.capture.spool_gap_count, 6);
    } finally { test.close(); }
  });

  it("does not let an old cursor extend retention, and follows explicit imported core associations", () => {
    const test = auditQueryFixture();
    try {
      const core = test.core({ occurredAt: now + 1, context: { activityId: randomUUID() } });
      const expired = test.activity({ occurredAt: now - 31 * DAY });
      const activity = test.activity({ coreEventIds: [core.eventId, core.eventId], activityId: randomUUID() });
      assert.deepEqual(queryAuditEvent(test.database, "activity", activity.eventId, now).related_events.map(event => event.event_id), [core.eventId]);
      const first = queryAuditEvents(test.database, query({ limit: "1" }), now);
      const encoded = JSON.parse(Buffer.from(first.page.next_cursor!, "base64url").toString("utf8")) as unknown[];
      encoded[4] = 0;
      const forged = Buffer.from(JSON.stringify(encoded)).toString("base64url");
      const second = queryAuditEvents(test.database, query({ limit: "1", cursor: forged }), now);
      assert.deepEqual(second.data.map(event => event.event_id), [activity.eventId]);
      assert.equal(second.data.some(event => event.event_id === expired.eventId), false);
      assert.equal(second.page.next_cursor, null);
    } finally { test.close(); }
  });

  it("exports a safe, complete snapshot with BOM, formula escaping and no raw search in its audit summary", () => {
    const test = auditQueryFixture();
    try {
      const core = test.core({ actorId: "=1+1", context: { siteName: "商店,\"中文\"", changes: [{ field: "system_name", kind: "value", before: "旧", after: "新" }] }, details: { reason: "note", raw_request: "HIDDEN" } });
      test.activity({ userAgent: "@SUM(1,2)", durationMs: 12 });
      const result = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01" }, now);
      assert.ok(result.csv.startsWith("\uFEFF"));
      assert.ok(result.csv.includes('"\'=1+1"'));
      assert.ok(result.csv.includes('"\'@SUM(1,2)"'));
      assert.ok(result.csv.includes('"商店,""中文"""'));
      assert.ok(result.csv.endsWith("\r\n"));
      assert.equal(result.csv.split("\r\n").length, 4);
      assert.equal(result.csv.includes("HIDDEN"), false);
      assert.equal(result.summary.row_count, 2);
      const search = exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01", q: core.eventId }, now);
      assert.equal(search.summary.row_count, 1);
      assert.equal("q" in search.summary.filters, false);
      assert.match(search.summary.filters.q_fingerprint!, /^[a-f0-9]{64}$/);
      test.core({ action: "audit.export_generated" });
      assert.equal(result.csv.includes("audit.export_generated"), false);
    } finally { test.close(); }
  });

  it("rejects overlong dates and oversized exports without silently truncating", () => {
    const test = auditQueryFixture();
    try {
      assert.throws(() => exportAuditEvents(test.database, { created_from: "2025-01-01", created_to: "2026-11-01" }, now), /366/);
      const insert = test.connection.prepare("INSERT INTO activity_events(event_id,activity_id,occurred_at,last_occurred_at,source_type,actor_type,action,outcome) VALUES(?,?,?,?,'HTTP','ANONYMOUS','http.request','SUCCESS')");
      test.database.write(() => { for (let index = 0; index < 10_001; index++) insert.run("event-" + index, "activity-" + index, now, now); });
      assert.throws(() => exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01" }, now), /10,000/);
      test.connection.prepare("DELETE FROM activity_events WHERE event_id = 'event-10000'").run();
      assert.equal(exportAuditEvents(test.database, { created_from: "2026-11-01", created_to: "2026-11-01" }, now).summary.row_count, 10_000);
    } finally { test.close(); }
  });

  it("returns controlled unavailability on a legacy database without audit query tables", () => {
    const connection = new DatabaseSync(":memory:");
    try {
      const database = { read<T>(operation: (db: DatabaseSync) => T) { return operation(connection); } };
      assert.throws(() => queryAuditEvents(database, query(), now), (error: unknown) => error instanceof AuditQueryError && error.code === "audit_query_unavailable");
      assert.throws(() => queryAuditMetadata(database), AuditQueryError);
    } finally { connection.close(); }
  });
});
