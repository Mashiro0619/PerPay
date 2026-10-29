import type { InstanceSettingsView } from "../src/settings/service.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

async function fixture() {
  const f = await createSitePaymentFixture();
  const app = createApp({ ...f, startedAt: new Date() });
  const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
  const headers = { cookie: "perpay_session=" + session.sessionToken + "; perpay_csrf=" + session.csrfToken, "x-csrf-token": session.csrfToken, origin: f.config.publicOrigin, "content-type": "application/json" };
  return { ...f, app, session, headers };
}
function apiHeaders(clientId: string, secret: string, target: string) {
  const signed = signApiRequest({ clientId, secret: Buffer.from(secret, "base64url"), method: "GET", target, body: Buffer.alloc(0), timestamp: String(Math.floor(Date.now() / 1000)), nonce: randomBytes(32).toString("base64url") });
  return { "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature };
}
describe("business website HTTP boundaries", () => {
  it("returns only instance configuration without consulting the legacy website view", async t => {
    const f = await fixture();
    try {
      t.mock.method(f.settings, "view", () => { throw new Error("legacy view must not be read"); });
      t.mock.method(f.settings, "snapshot", () => { throw new Error("legacy snapshot must not be read"); });
      const response = await f.app.request("/api/admin/v1/settings", { headers: f.headers });
      assert.equal(response.status, 200);
      const { data } = await response.json() as { data: InstanceSettingsView };
      assert.equal(data.site_mode, true);
      assert.ok(data.collection); assert.ok(data.provider);
      assert.equal("notifications" in data, false);
      assert.deepEqual(Object.keys(data.collection), ["code_payload"]);
      assert.deepEqual(Object.keys(data.secrets).sort(), ["provider_private_key", "provider_public_key"]);
      assert.deepEqual(Object.keys(data.display).sort(), ["dashboard_chart_type", "system_name"]);
      assert.equal("scan_interval_seconds" in data.provider, false);
      const before = f.sites.get("default");
      const saved = await f.app.request("/api/admin/v1/settings/display", { method: "PUT", headers: f.headers,
        body: JSON.stringify({ revision: data.revision, system_name: "实例后台", dashboard_chart_type: "BAR" }) });
      assert.equal(saved.status, 200);
      const result = (await saved.json() as { data: InstanceSettingsView }).data;
      assert.equal(result.payment_revision, data.payment_revision);
      assert.equal(result.revision, data.revision + 1);
      assert.deepEqual(f.sites.get("default"), before);
      const mixed = await f.app.request("/api/admin/v1/settings/display", { method: "PUT", headers: f.headers,
        body: JSON.stringify({ revision: result.revision, dashboard_chart_type: "AREA", checkout_show_product_name: false }) });
      assert.equal(mixed.status, 422);
      let revision = result.revision;
      const changes: Array<[string, object]> = [
        ["collection-policy", { ...data.collection_policy, scan_interval_seconds: 30, maximum_success_age_seconds: 60 }],
        ["advanced", data.advanced],
        ["backup", data.backup],
      ];
      for (const [section, fields] of changes) {
        const updated = await f.app.request("/api/admin/v1/settings/" + section, { method: "PUT", headers: f.headers, body: JSON.stringify({ ...fields, revision }) });
        assert.equal(updated.status, 200, section);
        const value = (await updated.json() as { data: { revision: number; site_mode: boolean; notifications?: unknown; secrets: object } }).data;
        assert.equal(value.site_mode, true);
        assert.equal(value.notifications, undefined);
        assert.deepEqual(Object.keys(value.secrets).sort(), ["provider_private_key", "provider_public_key"]);
        revision = value.revision;
      }
      assert.deepEqual(f.sites.get("default"), before);
    } finally { f.close(); }
  });
  it("requires admin authentication and CSRF for creating a website", async () => {
    const f = await fixture();
    try {
      const body = JSON.stringify({ operation_id: randomUUID(), configuration: { name: "HTTP", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: f.sites.defaults().policy } });
      assert.equal((await f.app.request("/api/admin/v1/sites", { method: "POST", body, headers: { "content-type": "application/json" } })).status, 401);
      const missing = { ...f.headers }; delete (missing as Record<string, string>)["x-csrf-token"];
      assert.equal((await f.app.request("/api/admin/v1/sites", { method: "POST", body, headers: missing })).status, 403);
      const response = await f.app.request("/api/admin/v1/sites", { method: "POST", body, headers: f.headers });
      assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
      const created = await response.json() as { data: { client_id: string } }; assert.ok(created.data.client_id.startsWith("site_"));
      const replay = await f.app.request("/api/admin/v1/sites", { method: "POST", body, headers: f.headers });
      assert.equal((await replay.json() as { data: { client_id: string } }).data.client_id, created.data.client_id);
    } finally { f.close(); }
  });
  it("scopes signed order queries and does not let A authenticate as B", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A"), b = f.createSite("B");
      const ka = f.sites.rotateSecret(a.clientId, "api_secret", 0, { actorId: "admin" });
      const kb = f.sites.rotateSecret(b.clientId, "api_secret", 0, { actorId: "admin" });
      const request = createOrderRequestSchema.parse({ merchant_order_no: "same", idempotency_key: "same", amount_cents: 10000, product_name: "HTTP" });
      const oa = f.orders.forSite(a.clientId).create(request).order;
      const ob = f.orders.forSite(b.clientId).create(request).order;
      const aPath = "/api/v1/orders/" + oa.orderId, bPath = "/api/v1/orders/" + ob.orderId;
      assert.equal((await f.app.request(aPath, { headers: apiHeaders(a.clientId, ka.secret, aPath) })).status, 200);
      assert.equal((await f.app.request(bPath, { headers: apiHeaders(a.clientId, ka.secret, bPath) })).status, 404);
      assert.equal((await f.app.request(bPath, { headers: apiHeaders(b.clientId, ka.secret, bPath) })).status, 401);
      assert.equal((await f.app.request(bPath, { headers: apiHeaders(b.clientId, kb.secret, bPath) })).status, 200);
      const target = "/api/v1/orders/by-merchant-no/same";
      const result = await f.app.request(target, { headers: apiHeaders(b.clientId, kb.secret, target) });
      assert.equal((await result.json() as { data: { order_id: string } }).data.order_id, ob.orderId);
      const adminTarget = "/api/admin/v1/orders/by-merchant-no/same";
      assert.equal((await f.app.request(adminTarget, { headers: f.headers })).status, 422);
      for (const [site, order] of [[a, oa], [b, ob]] as const) {
        const lookup = await f.app.request(adminTarget + "?api_client_id=" + site.clientId, { headers: f.headers });
        assert.equal(lookup.status, 200);
        assert.equal((await lookup.json() as { data: { order_id: string } }).data.order_id, order.orderId);
      }
    } finally { f.close(); }
  });
  it("returns only the authenticated website's readiness, not instance diagnostics", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A"); const key = f.sites.rotateSecret(a.clientId, "api_secret", 0, { actorId: "admin" });
      const target = "/api/v1/system/status";
      const response = await f.app.request(target, { headers: apiHeaders(a.clientId, key.secret, target) });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Record<string, unknown> };
      assert.deepEqual(Object.keys(body.data).sort(), ["accepting_orders", "client_id", "code", "notifications_enabled", "status"]);
      assert.equal(body.data.client_id, a.clientId);
    } finally { f.close(); }
  });
  it("rejects stale site updates, invalidates deleted credentials and blocks demo writes", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A"); const key = f.sites.rotateSecret(a.clientId, "api_secret", 0, { actorId: "admin" });
      const path = "/api/admin/v1/sites/" + a.clientId;
      const stale = await f.app.request(path, { method: "PUT", headers: f.headers, body: JSON.stringify({ revision: 0, configuration: a.configuration }) });
      assert.equal(stale.status, 409);
      const demo = createApp({ ...f, startedAt: new Date(), demoMode: true });
      assert.equal((await demo.request(path, { method: "DELETE", headers: f.headers, body: JSON.stringify({ revision: 1 }) })).status, 403);
      assert.equal((await f.app.request(path, { method: "DELETE", headers: f.headers, body: JSON.stringify({ revision: 1 }) })).status, 204);
      const target = "/api/v1/system/status";
      assert.equal((await f.app.request(target, { headers: apiHeaders(a.clientId, key.secret, target) })).status, 401);
    } finally { f.close(); }
  });
});

it("filters admin orders and exports by website and binds pagination to that filter", async () => {
  const f = await fixture();
  try {
    const a = f.createSite("网站 A"), b = f.createSite("网站 B");
    const make = (id: string, no: string) => f.orders.forSite(id).create(createOrderRequestSchema.parse({ merchant_order_no: no, idempotency_key: no, amount_cents: 500, product_name: no })).order;
    const aa = make(a.clientId, "a-one"), ab = make(a.clientId, "a-two"), bb = make(b.clientId, "b-one");
    const path = "/api/admin/v1/orders?limit=1&api_client_id=" + a.clientId;
    const first = await f.app.request(path, { headers: f.headers });
    assert.equal(first.status, 200);
    const page = await first.json() as { data: { order_id: string }[]; page: { next_cursor: string } };
    assert.equal(page.data.length, 1); assert.ok(page.page.next_cursor);
    const next = await f.app.request(path + "&cursor=" + encodeURIComponent(page.page.next_cursor), { headers: f.headers });
    const nextPage = await next.json() as { data: { order_id: string }[] };
    assert.deepEqual(new Set([...page.data, ...nextPage.data].map(row => row.order_id)), new Set([aa.orderId, ab.orderId]));
    assert.equal((await f.app.request("/api/admin/v1/orders?limit=1&api_client_id=" + b.clientId + "&cursor=" + encodeURIComponent(page.page.next_cursor), { headers: f.headers })).status, 422);
    assert.equal((await f.app.request(path + "&api_client_id=" + b.clientId, { headers: f.headers })).status, 422);
    const day = new Date(f.now() + 8 * 3600000).toISOString().slice(0, 10);
    const exported = await f.app.request("/api/admin/v1/orders/export", { method: "POST", headers: f.headers, body: JSON.stringify({ api_client_id: a.clientId, created_from: day, created_to: day }) });
    assert.equal(exported.status, 200);
    const csv = await exported.text();
    assert.ok(csv.includes(aa.orderId) && csv.includes(ab.orderId));
    assert.ok(csv.includes(a.clientId) && csv.includes("网站 A"));
    assert.ok(!csv.includes(bb.orderId) && !csv.includes(b.clientId));
  } finally { f.close(); }
});

it("retires global business settings without changing website credentials or revisions", async () => {
  const f = await fixture();
  try {
    const before = f.sites.get("default")!;
    for (const [method, path, body] of [
      ["PUT", "/api/admin/v1/settings/notifications", {}],
      ["POST", "/api/admin/v1/settings/api-key/actions/rotate", { revision: 0 }],
      ["POST", "/api/admin/v1/settings/notification-key/actions/rotate", { revision: 0 }],
      ["POST", "/api/admin/v1/settings/secrets/api_secret/actions/reveal", {}],
      ["POST", "/api/admin/v1/settings/secrets/webhook_secret/actions/reveal", {}],
    ] as const) {
      const response = await f.app.request(path, { method, headers: f.headers, body: JSON.stringify(body) });
      assert.equal(response.status, 410, path);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "site_settings_moved");
    }
    assert.deepEqual(f.sites.get("default"), before);
  } finally { f.close(); }
});

it("keeps website analytics scoped and leaves shared conflicts unallocated", async () => {
  const f = await fixture();
  try {
    const a = f.createSite("A"), b = f.createSite("B");
    for (const clientId of [a.clientId, a.clientId, b.clientId]) {
      f.orders.forSite(clientId).create(createOrderRequestSchema.parse({ merchant_order_no: randomUUID(), idempotency_key: randomUUID(), amount_cents: 100, product_name: "统计" }));
    }
    const get = async (suffix: string) => {
      const response = await f.app.request("/api/admin/v1/system/analytics?range=7" + suffix, { headers: f.headers });
      assert.equal(response.status, 200);
      return (await response.json() as { data: { orders: { created: number }; pending: { orders: number; conflicts: number | null }; daily: { orders_created: number }[] } }).data;
    };
    const global = await get(""); const aa = await get("&api_client_id=" + a.clientId); const bb = await get("&api_client_id=" + b.clientId);
    assert.equal(global.orders.created, 3); assert.equal(aa.orders.created, 2); assert.equal(bb.orders.created, 1);
    assert.equal(aa.pending.orders, 2); assert.equal(bb.pending.orders, 1);
    assert.equal(aa.pending.conflicts, null); assert.equal(global.pending.conflicts, 0);
    assert.equal(aa.daily.reduce((sum, day) => sum + day.orders_created, 0), 2);
    assert.equal((await f.app.request("/api/admin/v1/system/analytics?api_client_id=" + a.clientId + "&api_client_id=" + b.clientId, { headers: f.headers })).status, 422);
  } finally { f.close(); }
});

it("returns precise website and template field errors without writing invalid drafts", async () => {
  const f = await fixture();
  try {
    const site = f.createSite("表单校验");
    for (const [field, value] of [["name", ""], ["notification_origin", "http://unsafe.example"], ["return_origin", "http://unsafe.example"], ["policy.orders.pending_order_limit", 0], ["policy.display.checkout_name", ""], ["policy.display.checkout_help_url", "javascript:alert(1)"]] as const) {
      const configuration = structuredClone(site.configuration);
      const keys = field.split("."); let target: any = configuration;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)!] = value;
      const response = await f.app.request("/api/admin/v1/sites/" + site.clientId, { method: "PUT", headers: f.headers, body: JSON.stringify({ revision: site.revision, configuration }) });
      assert.equal(response.status, 422);
      const body = await response.json() as { error: { fields: Record<string, string> } };
      assert.ok(body.error.fields["configuration." + field]);
      assert.deepEqual(f.sites.get(site.clientId), site);
    }
    const defaults = f.sites.defaults();
    const response = await f.app.request("/api/admin/v1/settings/site-defaults", { method: "PUT", headers: f.headers, body: JSON.stringify({ ...defaults, policy: { ...defaults.policy, display: { ...defaults.policy.display, checkout_help_url: "javascript:bad" } } }) });
    assert.equal(response.status, 422);
    assert.ok((await response.json() as { error: { fields: Record<string, string> } }).error.fields["policy.display.checkout_help_url"]);
    assert.deepEqual(f.sites.defaults(), defaults);
  } finally { f.close(); }
});
