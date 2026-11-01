// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { ActivityRecorder } from "../src/audit/activity.ts";
import { createApp } from "../src/http/app.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import type { AuditMetadata } from "../src/shared/audit.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

async function fixture() {
  const root = realpathSync(tmpdir()), directory = mkdtempSync(join(root, "perpay-audit-capture-"));
  let now = Date.now();
  const services = await createConfiguredHttpServices({ directory, apiSecret: Buffer.alloc(32, 7).toString("base64url"),
    collectionCodePayload: "https://qr.alipay.com/capture-test", identityClock: () => now,
    environment: { PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1/32" } });
  now = Date.now();
  const orders = new OrderService(services.database, () => services.settings.instanceSnapshot(), () => now, services.sites, "default");
  orders.initialize();
  const activity = new ActivityRecorder({ database: services.database, clock: () => now });
  const app = createApp({ ...services, orders, activity, clock: () => now, startedAt: new Date(now) });
  const network = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" } } };
  const origin = services.config.publicOrigin;
  async function login() {
    const response = await app.request("/api/admin/v1/session/login", { method: "POST", headers: {
      origin, "content-type": "application/json", "user-agent": "Original login client", "x-forwarded-for": "198.51.100.10", "x-request-id": "same-external-id",
    }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) }, network);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { csrf_token: string } };
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    return { cookie, origin, "content-type": "application/json", "x-csrf-token": body.data.csrf_token,
      "user-agent": "Later request client", "x-forwarded-for": "203.0.113.20", "x-request-id": "same-external-id" };
  }
  return { ...services, orders, activity, app, network, origin, login, advance(milliseconds: number) { now += milliseconds; },
    activities() { return services.database.read(db => db.prepare("SELECT * FROM activity_events ORDER BY sequence").all()); },
    close() {
      activity.stop(); services.database.close();
      const target = realpathSync(directory); assert.equal(dirname(target), root); assert.ok(basename(target).startsWith("perpay-audit-capture-"));
      rmSync(target, { recursive: true, force: true });
    } };
}

describe("HTTP activity capture at the real application boundary", () => {
  it("captures this request's trusted source, uses internal associations, and aggregates only successful reads", async () => {
    const test = await fixture();
    try {
      const headers = await test.login();
      for (let index = 0; index < 2; index++) assert.equal((await test.app.request("/api/admin/v1/session", { headers }, test.network)).status, 200);
      test.activity.flush();
      const events = test.activities();
      const login = events.find(event => event.route === "/api/admin/v1/session/login")!;
      const reads = events.filter(event => event.route === "/api/admin/v1/session");
      assert.equal(reads.length, 1); assert.equal(Number(reads[0]!.event_count), 2); assert.equal(Number(reads[0]!.is_aggregate), 1);
      assert.equal(reads[0]!.source_address, "203.0.113.20"); assert.equal(reads[0]!.user_agent, "Later request client");
      assert.equal(reads[0]!.actor_type, "ADMIN"); assert.equal(reads[0]!.request_id, null);
      assert.notEqual(reads[0]!.activity_id, login.activity_id);
      const core = test.database.read(db => db.prepare(`SELECT context.* FROM audit_event_context context
        JOIN audit_events event USING(event_id) WHERE event.action = 'admin.login' ORDER BY event.sequence DESC LIMIT 1`).get())!;
      assert.equal(core.activity_id, login.activity_id); assert.notEqual(core.activity_id, "same-external-id");
      assert.equal(core.source_address, "198.51.100.10"); assert.equal(core.user_agent, "Original login client");
    } finally { test.close(); }
  });

  it("records rejected requests without storing credentials, query strings, or checkout capabilities", async () => {
    const test = await fixture();
    try {
      const capability = "pct1_" + "A".repeat(43), marker = "never-persist-this-value";
      assert.equal((await test.app.request(`/api/public/v1/checkouts/${capability}?query=${marker}`, {
        headers: { authorization: `Bearer ${marker}`, cookie: `unknown=${marker}`, "x-forwarded-for": "198.51.100.21" },
      }, test.network)).status, 404);
      assert.equal((await test.app.request("/api/admin/v1/session/login", { method: "POST", headers: {
        origin: test.origin, "content-type": "application/json", "x-forwarded-for": "198.51.100.22",
      }, body: JSON.stringify({ password: marker }) }, test.network)).status, 401);
      test.activity.flush();
      const events = test.activities();
      assert.equal(events.length, 2); assert.ok(events.every(event => event.outcome === "FAILURE" && Number(event.is_aggregate) === 0));
      assert.ok(events.every(event => event.actor_type === "ANONYMOUS"));
      assert.equal(events[0]!.route, "/api/public/v1/checkouts/:token");
      const stored = JSON.stringify(events, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value);
      assert.ok(!stored.includes(capability)); assert.ok(!stored.includes(marker));
      assert.match(String(events[1]!.details_json), /invalid_credentials/);
    } finally { test.close(); }
  });

  it("excludes static assets and keeps malformed trusted forwarding nullable", async () => {
    const test = await fixture();
    try {
      assert.equal((await test.app.request("/admin/theme.js", {}, test.network)).status, 200);
      assert.equal((await test.app.request("/api/admin/v1/session/login", { method: "POST", headers: {
        origin: test.origin, "content-type": "application/json", "x-forwarded-for": "not an address",
      }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) }, test.network)).status, 400);
      test.activity.flush();
      const events = test.activities(); assert.equal(events.length, 1);
      assert.equal(events[0]!.source_address, null); assert.match(String(events[0]!.details_json), /forwarded_header_invalid/);
    } finally { test.close(); }
  });

  it("promotes a read that expires an order to an individual event and preserves its verified website", async () => {
    const test = await fixture();
    try {
      const site = test.sites.get("default")!;
      test.sites.update("default", { revision: site.revision, configuration: { ...site.configuration,
        policy: { ...site.configuration.policy, orders: { ...site.configuration.policy.orders, order_ttl_seconds: 60 } } } }, { actorId: "admin" });
      const order = test.orders.create(createOrderRequestSchema.parse({ idempotency_key: "capture-expiry", merchant_order_no: "capture-expiry",
        amount_cents: 1900, product_name: "Capture test" })).order;
      const headers = await test.login(); test.advance(60_001);
      assert.equal((await test.app.request(`/api/admin/v1/orders/${order.orderId}`, { headers }, test.network)).status, 200);
      test.activity.flush();
      const captured = test.activities().find(event => event.route === "/api/admin/v1/orders/:orderId")!;
      assert.equal(Number(captured.is_aggregate), 0); assert.equal(captured.site_id, "default"); assert.equal(captured.subject_id, order.orderId);
      const core = test.database.read(db => db.prepare(`SELECT event.actor_type, context.source_address, context.activity_id FROM audit_events event
        JOIN audit_event_context context USING(event_id) WHERE event.action = 'orders.checkout_expired' AND event.subject_id = ?`).get(order.orderId))!;
      assert.equal(core.actor_type, "SYSTEM"); assert.equal(core.source_address, "203.0.113.20"); assert.equal(core.activity_id, captured.activity_id);
    } finally { test.close(); }
  });

  it("keeps completed responses intact when activity persistence fails and reports the live gap", async () => {
    const test = await fixture();
    try {
      const headers = await test.login(); test.activity.flush();
      test.database.write(db => db.exec("CREATE TEMP TRIGGER reject_capture BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END;"));
      assert.equal((await test.app.request("/api/admin/v1/session", { headers }, test.network)).status, 200);
      assert.doesNotThrow(() => test.activity.flush());
      const response = await test.app.request("/api/admin/v1/audit-events/meta", { headers }, test.network);
      assert.equal(response.status, 200);
      const metadata = await response.json() as { data: AuditMetadata };
      assert.equal(metadata.data.capture.state, "degraded"); assert.ok(metadata.data.capture.write_failures > 0);
      test.database.write(db => db.exec("DROP TRIGGER reject_capture"));
      test.activity.flush(); assert.ok(test.activities().some(event => event.route === "/api/admin/v1/session"));
    } finally { test.close(); }
  });
});
