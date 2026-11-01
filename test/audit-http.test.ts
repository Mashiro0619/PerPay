import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createApp } from "../src/http/app.ts";
import { mountAuditRoutes } from "../src/http/audit-routes.ts";
import { auditExportSchema, type RawAuditCaptureState } from "../src/audit/query.ts";
import { ActivityRecorder } from "../src/audit/activity.ts";
import { appendAuditEvent } from "../src/database/identity-store.ts";
import { beijingDate } from "../src/shared/created-dates.ts";
import type { AuditEventDetail, AuditEventPage, AuditMetadata } from "../src/shared/audit.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { AUDIT_TEST_NOW, auditQueryFixture } from "./audit-query-fixture.ts";

async function fixture(demoMode = false) {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "perpay-audit-http-"));
  const services = await createConfiguredHttpServices({ directory, apiSecret: null,
    collectionCodePayload: "https://qr.alipay.com/audit-test", environment: { PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1/32" } });
  const now = Date.now();
  const app = createApp({ ...services, clock: () => now, startedAt: new Date(now), demoMode });
  const network = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" } } };
  async function login() {
    const response = await app.request("/api/admin/v1/session/login", { method: "POST", headers: {
      origin: services.config.publicOrigin, "content-type": "application/json", "user-agent": "Audit HTTP test", "x-forwarded-for": "198.51.100.15",
    }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) }, network);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { csrf_token: string } };
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    return { cookie, headers: { cookie, origin: services.config.publicOrigin, "content-type": "application/json", "x-csrf-token": body.data.csrf_token, "user-agent": "Audit HTTP test", "x-forwarded-for": "198.51.100.15" } };
  }
  return { ...services, app, now, network, login, exportBody: { created_from: beijingDate(now), created_to: beijingDate(now) },
    close() {
      services.database.close();
      const target = realpathSync(directory);
      assert.equal(dirname(target), temporaryRoot);
      assert.ok(basename(target).startsWith("perpay-audit-http-"));
      rmSync(target, { recursive: true, force: true });
    } };
}

describe("administrator audit HTTP", () => {
  it("protects list, metadata and detail with the real administrator session and returns no-store projections", async () => {
    const test = await fixture();
    try {
      const seeded = test.database.write(db => appendAuditEvent(db, { occurredAt: test.now, actorType: "ADMIN", actorId: "admin", action: "settings.display_updated", outcome: "SUCCESS",
        context: { sourceAddress: "198.51.100.9", userAgent: "Recorded UA", changes: [{ field: "system_name", kind: "value", before: "旧", after: "新" }] } }));
      for (const path of ["/api/admin/v1/audit-events", "/api/admin/v1/audit-events/meta", `/api/admin/v1/audit-events/core/${seeded.eventId}`]) {
        assert.equal((await test.app.request(path, {}, test.network)).status, 401, path);
      }
      const session = await test.login();
      const listed = await test.app.request("/api/admin/v1/audit-events?limit=20", { headers: { cookie: session.cookie } }, test.network);
      assert.equal(listed.status, 200);
      assert.equal(listed.headers.get("cache-control"), "no-store");
      const body = await listed.json() as AuditEventPage;
      assert.ok(body.data.some(row => row.event_id === seeded.eventId));
      const detail = await test.app.request(`/api/admin/v1/audit-events/core/${seeded.eventId}`, { headers: { cookie: session.cookie } }, test.network);
      const payload = await detail.json() as { data: AuditEventDetail };
      assert.equal(detail.status, 200);
      assert.equal(payload.data.source_address, "198.51.100.9");
      assert.equal(payload.data.user_agent, "Recorded UA");
      assert.equal(payload.data.changes[0]?.after, "新");
      const metadata = await test.app.request("/api/admin/v1/audit-events/meta", { headers: { cookie: session.cookie } }, test.network);
      assert.equal(metadata.status, 200);
      assert.equal(((await metadata.json()) as { data: AuditMetadata }).data.retention.core, "indefinite");
      assert.equal((await test.app.request("/api/admin/v1/audit-events/meta?limit=1", { headers: { cookie: session.cookie } }, test.network)).status, 422);
      assert.equal((await test.app.request("/api/admin/v1/audit-events/invalid/missing", { headers: { cookie: session.cookie } }, test.network)).status, 404);
    } finally { test.close(); }
  });

  it("retains administrator IP policy and revocation checks for audit reads", async () => {
    const test = await fixture();
    try {
      const session = await test.login();
      const settings = test.settingsStore.instanceSnapshot();
      test.settingsStore.saveAdminAccess({ revision: settings.revision, enabled: true, cidrs: ["198.51.100.0/24"] }, { actorId: "admin" });
      assert.equal((await test.app.request("/api/admin/v1/audit-events", { headers: { cookie: session.cookie, "x-forwarded-for": "203.0.113.1" } }, test.network)).status, 403);
      assert.equal((await test.app.request("/api/admin/v1/audit-events", { headers: { cookie: session.cookie, "x-forwarded-for": "198.51.100.15" } }, test.network)).status, 200);
      const logout = await test.app.request("/api/admin/v1/session/logout", { method: "POST", headers: session.headers, body: "{}" }, test.network);
      assert.equal(logout.status, 204);
      assert.equal((await test.app.request("/api/admin/v1/audit-events", { headers: session.headers }, test.network)).status, 401);
    } finally { test.close(); }
  });

  it("requires same-origin, CSRF, bounded strict JSON and valid date filters for export", async () => {
    const test = await fixture();
    try {
      const session = await test.login();
      const path = "/api/admin/v1/audit-events/export";
      const body = JSON.stringify(test.exportBody);
      assert.equal((await test.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body }, test.network)).status, 401);
      const { "x-csrf-token": _csrf, ...withoutCsrf } = session.headers;
      assert.equal((await test.app.request(path, { method: "POST", headers: withoutCsrf, body }, test.network)).status, 403);
      assert.equal((await test.app.request(path, { method: "POST", headers: { ...session.headers, origin: "https://untrusted.example" }, body }, test.network)).status, 403);
      assert.equal((await test.app.request(path, { method: "POST", headers: { ...session.headers, "content-type": "text/plain" }, body }, test.network)).status, 415);
      assert.equal((await test.app.request(path, { method: "POST", headers: session.headers, body: '{"created_from":"2026-11-01","created_from":"2026-11-02","created_to":"2026-11-03"}' }, test.network)).status, 400);
      assert.equal((await test.app.request(path, { method: "POST", headers: session.headers, body: JSON.stringify({ ...test.exportBody, q: "x".repeat(17_000) }) }, test.network)).status, 413);
      assert.equal((await test.app.request(path, { method: "POST", headers: session.headers, body: JSON.stringify({ created_from: "2025-01-01", created_to: "2026-11-01" }) }, test.network)).status, 422);
      assert.equal((await test.app.request(path + "?q=ignored", { method: "POST", headers: session.headers, body }, test.network)).status, 422);
    } finally { test.close(); }
  });

  it("records completed CSV generation once, excludes its own audit event and suppresses CSV if core auditing fails", async () => {
    const test = await fixture();
    try {
      const source = test.database.write(db => appendAuditEvent(db, { occurredAt: test.now, actorType: "ADMIN", actorId: "admin", action: "audit.test_source", outcome: "SUCCESS" }));
      const session = await test.login();
      const exportInput = { ...test.exportBody, q: source.eventId };
      const response = await test.app.request("/api/admin/v1/audit-events/export", { method: "POST", headers: session.headers, body: JSON.stringify(exportInput) }, test.network);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /^text\/csv/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-disposition")!, /perpay-audit\.csv/);
      const csv = await response.text();
      assert.ok(csv.includes(source.eventId));
      assert.equal(csv.includes("audit.export_generated"), false);
      const exports = test.database.read(db => db.prepare("SELECT event_id,details_json FROM audit_events WHERE action = 'audit.export_generated'").all());
      assert.equal(exports.length, 1);
      const metadata = JSON.parse(String(exports[0]!.details_json)) as { row_count: number; filters: { q_fingerprint: string; q?: string } };
      assert.equal(metadata.row_count, 1);
      assert.equal(metadata.filters.q, undefined);
      assert.match(metadata.filters.q_fingerprint, /^[a-f0-9]{64}$/);
      test.database.write(db => db.exec("CREATE TEMP TRIGGER fail_audit_export BEFORE INSERT ON audit_events WHEN NEW.action = 'audit.export_generated' BEGIN SELECT RAISE(ABORT, 'injected export audit failure'); END"));
      const rejected = await test.app.request("/api/admin/v1/audit-events/export", { method: "POST", headers: session.headers, body: JSON.stringify(exportInput) }, test.network);
      assert.ok(rejected.status >= 500);
      assert.match(rejected.headers.get("content-type")!, /^application\/json/);
      assert.equal((await rejected.text()).includes(source.eventId), false);
      assert.equal(test.database.read(db => Number(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'audit.export_generated'").get()?.n)), 1);
    } finally { test.close(); }
  });

  it("allows generated CSV reads in the isolated demo while keeping the export audit hook", async () => {
    const test = await fixture(true);
    try {
      const session = await test.login();
      const response = await test.app.request("/api/admin/v1/audit-events/export", { method: "POST", headers: session.headers, body: JSON.stringify(test.exportBody) }, test.network);
      assert.equal(response.status, 200);
      assert.equal(test.database.read(db => Number(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'audit.export_generated'").get()?.n)), 1);
    } finally { test.close(); }
  });

  it("captures template routes and error codes without retaining checkout tokens, query strings, credentials or bodies", async () => {
    const test = await fixture();
    const recorder = new ActivityRecorder({ database: test.database, clock: () => test.now });
    try {
      const app = createApp({ config: test.config, database: test.database, identity: test.identity, settings: test.settings,
        orders: test.orders, sites: test.sites, startedAt: new Date(test.now), clock: () => test.now, activity: recorder });
      const headers = { "x-forwarded-for": "198.51.100.15", "user-agent": "Audit route observer", authorization: "Bearer DO_NOT_LOG_AUTHORIZATION" };
      const checkout = await app.request("/api/public/v1/checkouts/pct1_DO_NOT_LOG_CHECKOUT?secret=DO_NOT_LOG_QUERY", { headers }, test.network);
      assert.equal(checkout.status, 404);
      const login = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { ...headers, origin: test.config.publicOrigin, "content-type": "application/json", cookie: "unrelated=DO_NOT_LOG_COOKIE" },
        body: JSON.stringify({ password: "DO_NOT_LOG_PASSWORD_BODY" }) }, test.network);
      assert.equal(login.status, 401);
      recorder.flush();
      const rows = test.database.read(db => db.prepare("SELECT route,source_address,user_agent,http_status,details_json FROM activity_events ORDER BY sequence").all());
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.route, "/api/public/v1/checkouts/:token");
      assert.equal(rows[0]?.source_address, "198.51.100.15");
      assert.equal(rows[0]?.user_agent, "Audit route observer");
      assert.equal(Number(rows[0]?.http_status), 404);
      assert.equal(JSON.parse(String(rows[0]?.details_json)).error_code, "checkout_not_found");
      assert.equal(JSON.parse(String(rows[1]?.details_json)).error_code, "invalid_credentials");
      assert.equal(rows.some(row => Object.values(row).some(value => String(value).includes("DO_NOT_LOG"))), false);
    } finally { recorder.stop(); test.close(); }
  });

  it("reads current capture failures from the live hook rather than a persisted successful snapshot", async () => {
    const test = auditQueryFixture();
    try {
      let capture: RawAuditCaptureState = { state: "healthy", bufferedEvents: 0, droppedEvents: 0, writeFailures: 0, lastFlushAt: AUDIT_TEST_NOW, lastErrorCode: null, spoolLastImportAt: null, spoolFailures: 0, spoolGapCount: 0 };
      const app = new Hono();
      mountAuditRoutes(app, { database: test.database, adminSession: async (_context, next) => { await next(); }, exportGuard: async (_context, next) => { await next(); },
        readExportBody: async context => auditExportSchema.parse(await context.req.json()), onExportGenerated: () => {}, captureState: () => capture, clock: () => AUDIT_TEST_NOW });
      assert.equal(((await (await app.request("/api/admin/v1/audit-events/meta")).json()) as { data: AuditMetadata }).data.capture.state, "healthy");
      capture = { ...capture, state: "degraded", bufferedEvents: 4, writeFailures: 1, lastErrorCode: "activity_write_failed" };
      const response = await app.request("/api/admin/v1/audit-events/meta");
      const payload = await response.json() as { data: AuditMetadata };
      assert.equal(response.status, 200);
      assert.equal(payload.data.capture.state, "degraded");
      assert.equal(payload.data.capture.buffered_events, 4);
      assert.equal(payload.data.capture.write_failures, 1);
    } finally { test.close(); }
  });
});
