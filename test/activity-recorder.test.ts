// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ActivityRecorder, ACTIVITY_RETENTION_MILLISECONDS } from "../src/audit/activity.ts";
import { ACTIVITY_SCHEMA_SQL } from "../src/audit/activity-schema.ts";
import { createAuditContext, currentAuditContext, runWithAuditContext } from "../src/audit/context.ts";
import { WebhookScheduler } from "../src/notifications/scheduler.ts";
import type { WebhookProcessResult } from "../src/notifications/service.ts";

function fixture(now = 180_007) {
  const connection = new DatabaseSync(":memory:");
  connection.exec(ACTIVITY_SCHEMA_SQL);
  const state = { now, fail: false };
  const database = {
    read<T>(operation: (db: DatabaseSync) => T): T { return operation(connection); },
    write<T>(operation: (db: DatabaseSync) => T): T {
      if (state.fail) throw new Error("storage unavailable");
      connection.exec("BEGIN");
      try { const result = operation(connection); connection.exec("COMMIT"); return result; }
      catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
  };
  return { connection, database, state };
}

describe("bounded operational activity recorder", () => {
  it("groups HTTP reads by route and actor/source dimensions instead of individual resources or website names", () => {
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    const input = { action: "http.request", sourceType: "HTTP" as const, actorType: "ADMIN" as const, actorId: "admin",
      siteId: "site-a", siteName: "旧名称", sourceAddress: "192.0.2.10", userAgent: "Browser/1", httpMethod: "GET",
      route: "/api/admin/v1/orders/:orderId", httpStatus: 200, aggregate: true, subjectType: "order", subjectId: "order-a" };
    try {
      recorder.record(input); recorder.flush();
      recorder.record({ ...input, subjectId: "order-b", siteName: "新名称" });
      recorder.flush();
      const group = connection.prepare("SELECT * FROM activity_events").get() as Record<string, unknown>;
      assert.equal(group.event_count, 2);
      assert.equal(group.subject_type, null); assert.equal(group.subject_id, null);
      assert.equal(group.route, input.route); assert.equal(group.http_method, "GET");
      const variants = [
        { actorId: "another-admin" }, { actorType: "API_CLIENT" as const }, { siteId: "site-b" }, { sourceAddress: "192.0.2.11" },
        { userAgent: "Browser/2" }, { httpStatus: 304 }, { httpMethod: "HEAD" }, { route: "/api/admin/v1/orders" }, { action: "http.other" },
      ];
      for (const variant of variants) recorder.record({ ...input, ...variant });
      recorder.flush();
      assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n, variants.length + 1);
    } finally { recorder.stop(); connection.close(); }
  });

  it("keeps independent provider subjects in empty background task groups", () => {
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    try {
      const input = { action: "ledger.scan", sourceType: "BACKGROUND" as const, aggregate: true, subjectType: "provider_account" };
      recorder.record({ ...input, subjectId: "account-a" });
      recorder.record({ ...input, subjectId: "account-b" });
      recorder.record({ ...input, subjectId: "account-a" });
      recorder.flush();
      const rows = connection.prepare("SELECT subject_type, subject_id, event_count FROM activity_events ORDER BY subject_id").all();
      assert.deepEqual(rows.map(row => ({ ...row })), [
        { subject_type: "provider_account", subject_id: "account-a", event_count: 2 },
        { subject_type: "provider_account", subject_id: "account-b", event_count: 1 },
      ]);
    } finally { recorder.stop(); connection.close(); }
  });

  it("maintains true first/last times for late arrivals before and after a flush without moving the sorting anchor", () => {
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    const record = (occurredAt: number) => recorder.record({ action: "http.request", sourceType: "HTTP", aggregate: true,
      httpMethod: "GET", route: "/api/admin/v1/orders", httpStatus: 200, occurredAt, durationMs: 10 });
    try {
      record(180_900); record(180_100); record(180_950); recorder.flush();
      const first = connection.prepare("SELECT * FROM activity_events").get() as Record<string, unknown>;
      assert.equal(first.occurred_at, 180_900); assert.equal(first.first_occurred_at, 180_100); assert.equal(first.last_occurred_at, 180_950);
      record(180_005); record(180_700); recorder.flush();
      const late = connection.prepare("SELECT * FROM activity_events").get() as Record<string, unknown>;
      assert.equal(late.sequence, first.sequence); assert.equal(late.event_id, first.event_id); assert.equal(late.activity_id, first.activity_id);
      assert.equal(late.occurred_at, 180_900); assert.equal(late.first_occurred_at, 180_005); assert.equal(late.last_occurred_at, 180_950);
      assert.equal(late.event_count, 5); assert.equal(late.duration_ms, 50);
      connection.prepare("UPDATE activity_events SET first_occurred_at = NULL").run();
      record(180_001); recorder.flush();
      assert.equal((connection.prepare("SELECT first_occurred_at FROM activity_events").get() as { first_occurred_at: number }).first_occurred_at, 180_001);
    } finally { recorder.stop(); connection.close(); }
  });

  it("merges successful reads by minute and actual source without reordering an existing row", () => {
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    try {
      const scope = createAuditContext({ actorType: "ADMIN", actorId: "admin", sourceAddress: "192.0.2.10", userAgent: "Browser/1", siteId: "site-a", requestId: "single-http-request" });
      runWithAuditContext(scope, () => recorder.record({ action: "orders.list", aggregate: true, durationMs: 12 }));
      recorder.flush();
      const first = connection.prepare("SELECT sequence, occurred_at FROM activity_events").get() as { sequence: number; occurred_at: number };
      state.now += 450;
      runWithAuditContext(scope, () => recorder.record({ action: "orders.list", aggregate: true, durationMs: 18 }));
      runWithAuditContext(createAuditContext({ actorType: "ADMIN", actorId: "admin", sourceAddress: "192.0.2.11", userAgent: "Browser/1", siteId: "site-a" }),
        () => recorder.record({ action: "orders.list", aggregate: true, durationMs: 5 }));
      recorder.flush();
      const rows = connection.prepare("SELECT * FROM activity_events ORDER BY sequence").all() as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.sequence, first.sequence);
      assert.equal(rows[0]!.occurred_at, 180_007);
      assert.equal(rows[0]!.last_occurred_at, 180_457);
      assert.equal(rows[0]!.event_count, 2);
      assert.equal(rows[0]!.duration_ms, 30);
      assert.equal(rows[0]!.is_aggregate, 1);
      assert.equal(rows[0]!.request_id, null);
      assert.notEqual(rows[0]!.activity_id, scope.activityId);
    } finally { recorder.stop(); connection.close(); }
  });

  it("flushes buffered reads within five seconds, even if a longer interval was requested", t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now, flushIntervalMilliseconds: 60_000 });
    try {
      recorder.start();
      recorder.record({ action: "system.status", aggregate: true });
      t.mock.timers.tick(4_999);
      assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n, 0);
      t.mock.timers.tick(1);
      assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n, 1);
    } finally { recorder.stop(); connection.close(); }
  });

  it("keeps failures and linked core events individual and strips secret material", () => {
    const { connection, database } = fixture();
    const recorder = new ActivityRecorder({ database });
    try {
      const scope = createAuditContext({ requestId: "caller-controlled-id", actorType: "ADMIN", actorId: "admin" });
      scope.coreEventIds.push("core-1");
      runWithAuditContext(scope, () => recorder.record({ action: "settings.update", aggregate: true, details: {
        password: "must-never-persist", nested: { api_secret: "must-never-persist", enabled: true }, field: "notifications_enabled",
      } }));
      recorder.record({ action: "api.authentication", outcome: "FAILURE", aggregate: true });
      recorder.record({ action: "api.authentication", outcome: "FAILURE", aggregate: true });
      recorder.flush();
      const rows = connection.prepare("SELECT * FROM activity_events ORDER BY sequence").all() as Record<string, unknown>[];
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => row.is_aggregate === 0));
      assert.notEqual(rows[0]!.activity_id, "caller-controlled-id");
      assert.equal(rows[0]!.core_event_ids_json, '["core-1"]');
      assert.doesNotMatch(String(rows[0]!.details_json), /must-never-persist|password|api_secret/);
      assert.match(String(rows[0]!.details_json), /enabled/);
    } finally { recorder.stop(); connection.close(); }
  });

  it("preserves a pending event across a failed write and reports bounded-buffer loss", t => {
    t.mock.method(console, "error", () => {});
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now, maxBufferedEvents: 1 });
    try {
      recorder.record({ action: "order.create" });
      state.fail = true;
      assert.doesNotThrow(() => recorder.flush());
      assert.doesNotThrow(() => recorder.record({ action: "order.cancel" }));
      assert.equal(recorder.status().droppedEvents, 1);
      assert.equal(recorder.status().writeFailures, 1);
      assert.equal(recorder.status().bufferedEvents, 1);
      state.fail = false;
      recorder.flush();
      assert.equal((connection.prepare("SELECT action FROM activity_events").get() as { action: string }).action, "order.create");
      assert.equal(recorder.status().bufferedEvents, 0);
      assert.equal(recorder.status().state, "degraded");
    } finally { state.fail = false; recorder.stop(); connection.close(); }
  });

  it("prunes at most one bounded batch and preserves permanent import receipts", () => {
    const { connection, database, state } = fixture(ACTIVITY_RETENTION_MILLISECONDS + 1_000_000);
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    try {
      const statement = connection.prepare("INSERT INTO activity_events(event_id, activity_id, occurred_at, last_occurred_at, source_type, actor_type, action, outcome) VALUES (?, ?, 1, 1, 'INTERNAL', 'SYSTEM', 'old.event', 'SUCCESS')");
      for (let index = 0; index < 600; index += 1) statement.run(`event-${index}`, `activity-${index}`);
      connection.prepare("INSERT INTO activity_external_receipts VALUES ('permanent', 'producer', 1, 1, 1, 'core-event')").run();
      recorder.prune();
      assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n, 100);
      recorder.prune();
      assert.equal((connection.prepare("SELECT COUNT(*) AS n FROM activity_events").get() as { n: number }).n, 0);
      assert.ok(connection.prepare("SELECT 1 FROM activity_external_receipts WHERE event_id = 'permanent'").get());
    } finally { recorder.stop(); connection.close(); }
  });

  it("detaches actual background work from an initiating HTTP identity and records an unhandled task error", async t => {
    t.mock.method(console, "error", () => {});
    const { connection, database } = fixture();
    const recorder = new ActivityRecorder({ database });
    const initiating = createAuditContext({ actorType: "ADMIN", actorId: "admin", requestId: "request-1", sourceAddress: "192.0.2.20", userAgent: "Browser/1" });
    const expected = new Error("provider failed");
    try {
      await runWithAuditContext(initiating, async () => {
        await assert.rejects(recorder.runTask("ledger.scan", {}, async () => {
          const scope = currentAuditContext()!;
          assert.equal(scope.actorType, "SYSTEM");
          assert.equal(scope.sourceAddress, null);
          assert.equal(scope.userAgent, null);
          assert.equal(scope.requestId, null);
          assert.notEqual(scope.activityId, initiating.activityId);
          throw expected;
        }), error => error === expected);
      });
      recorder.flush();
      const row = connection.prepare("SELECT actor_type, source_address, outcome FROM activity_events").get() as Record<string, unknown>;
      assert.deepEqual({ ...row }, { actor_type: "SYSTEM", source_address: null, outcome: "FAILURE" });
    } finally { recorder.stop(); connection.close(); }
  });

  it("records a coalesced webhook run once and isolates an unavailable activity store", async t => {
    t.mock.method(console, "error", () => {});
    const { connection, database, state } = fixture();
    const recorder = new ActivityRecorder({ database, clock: () => state.now });
    let resolve!: (result: WebhookProcessResult) => void;
    const pending = new Promise<WebhookProcessResult>(done => { resolve = done; });
    const scheduler = new WebhookScheduler({ activity: recorder, service: { processOne: () => pending }, store: { counts: () => ({ pending: 0, dead: 0 }) } });
    try {
      const first = scheduler.start(), second = scheduler.trigger("manual");
      assert.equal(first, second);
      state.fail = true;
      resolve({ processed: false, deliveryId: null, status: null, outcome: null, errorCode: null });
      await first;
      recorder.flush();
      assert.equal(scheduler.health().state, "healthy");
      state.fail = false;
      recorder.flush();
      const row = connection.prepare("SELECT action, event_count FROM activity_events").get() as Record<string, unknown>;
      assert.deepEqual({ ...row }, { action: "webhook.dispatch", event_count: 1 });
    } finally { await scheduler.stop(); state.fail = false; recorder.stop(); connection.close(); }
  });
});
