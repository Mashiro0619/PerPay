// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { createPreviewDemo, DEMO_QR_TEXT } from "../scripts/preview-demo.ts";
import { renderCollectionCodeSvg } from "../src/http/web/collection-code.ts";

const day = 86_400_000;
const midnight = Math.floor((Date.now() + 8 * 3_600_000) / day) * day - 8 * 3_600_000;

describe("isolated documentation preview", () => {
  it("seeds coherent data, blocks writes, preserves authentication and never uses fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchAttempts = 0;
    globalThis.fetch = async () => {
      fetchAttempts++;
      throw new Error("External fetch is forbidden in the demo");
    };
    let demo: Awaited<ReturnType<typeof createPreviewDemo>> | undefined;
    try {
      demo = await createPreviewDemo({ now: midnight - day + 14 * 3_600_000 });
      const { app, stats } = demo;
      assert.equal(demo.password, "123456");
      assert.ok(stats.orders.created > 478);
      assert.ok(stats.orders.confirmed > 411);
      assert.ok(stats.orders.closed > 0);
      assert.ok(stats.orders.expired > 0);
      assert.ok(stats.pending.orders >= 4);
      assert.ok(stats.notifications.failed > 1);
      assert.ok(stats.notifications.pending > 1);
      assert.equal(stats.daily.filter(row => row.orders_created > 0).length, 30);
      assert.equal(stats.daily.reduce((sum, row) => sum + row.confirmed_amount_cents, 0), stats.confirmations.amount_cents);
      assert.equal(stats.daily.reduce((sum, row) => sum + row.orders_created, 0), stats.orders.created);
      assert.equal(demo.database.integrityCheck().ok, true);
      assert.ok(Number(demo.database.read(db => db.prepare("SELECT count(DISTINCT api_client_id) AS total FROM payment_orders").get()?.total)) >= 6);
      const scenarioOrderIds = new Set([
        ...Object.values(demo.scenarios.lifecycle),
        ...Object.values(demo.scenarios.financial.orders),
        ...Object.values(demo.scenarios.notifications.orders),
      ]);
      const historyOrders = demo.database.read(connection => connection.prepare("SELECT order_id, product_name FROM payment_orders").all())
        .filter(order => !scenarioOrderIds.has(String(order.order_id)));
      const names = new Set(historyOrders.map(order => String(order.product_name)));
      assert.equal(names.size, 8, "Ordinary business history must retain all eight product categories");
      for (const name of names) assert.doesNotMatch(name, /演示|示例|联调|DEMO-/iu);
      const payers = demo.database.read(connection => connection.prepare("SELECT DISTINCT other_account FROM ledger_entries WHERE other_account IS NOT NULL").all());
      assert.ok(payers.length >= 8, "Receipt history must include varied payer identities");
      for (const payer of payers) {
        assert.ok(String(payer.other_account).trim().length > 0);
        assert.doesNotMatch(String(payer.other_account), /演示|示例|付款人\s*\d|DEMO-/iu);
      }
      assert.equal((await app.request("/api/admin/v1/orders")).status, 401);
      const blockedRequests = [
        ["POST", "/api/v1/orders"],
        ["PUT", "/api/admin/v1/settings/provider"],
        ["POST", "/api/admin/v1/sites"],
        ["POST", "/api/admin/v1/settings/provider/verify"],
        ["POST", "/api/admin/v1/sessions/00000000-0000-4000-8000-000000000001/revoke"],
        ["POST", "/api/admin/v1/sessions/revoke-others"],
        ["POST", "/api/admin/v1/sessions/revoke-all"],
        ["POST", "/api/admin/v1/webhooks/deliveries/example/actions/replay"],
        ["PUT", "/api/admin/v1/orders/" + demo.featured + "/refund-mark"],
        ["DELETE", "/api/admin/v1/session"],
      ] as const;
      for (const [method, path] of blockedRequests) {
        const response = await app.request(path, { method });
        assert.equal(response.status, 403);
        const error = (await response.json() as { error: { code: string; message: string } }).error;
        assert.equal(error.code, "demo_read_only");
        assert.equal(error.message, "当前操作不可用。");
      }
      const login = await app.request(demo.origin + "/api/admin/v1/session/login", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: demo.origin },
        body: JSON.stringify({ password: demo.password }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { data: { csrf_token: string } };
      const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      assert.equal((await app.request("/api/admin/v1/orders", { headers: { cookie } })).status, 200);
      const canonical = await app.request("/admin");
      assert.equal(canonical.status, 308);
      assert.equal(canonical.headers.get("location"), "/admin/");
      const adminHtml=await (await app.request("/admin/")).text();
      assert.match(adminHtml,/data-perpay-demo="readonly"/);
      const analytics=await app.request("/api/admin/v1/system/analytics?range=30",{headers:{cookie}});
      assert.equal((await analytics.json() as {data:{orders:{created:number}}}).data.orders.created, stats.orders.created);
      assert.match(analytics.headers.get("x-perpay-demo")!,/health=simulated/);
      const firstHtml=await (await app.request("/checkout/"+demo.checkout)).text();
      const firstTime=Number(firstHtml.match(/&quot;serverTime&quot;:(\d+)/)?.[1]);
      assert.ok(firstTime>=demo.capturedAt && firstTime<demo.capturedAt+60000);
      await new Promise(resolve=>setTimeout(resolve,25));
      const nextHtml=await (await app.request("/checkout/"+demo.checkout)).text();
      const nextTime=Number(nextHtml.match(/&quot;serverTime&quot;:(\d+)/)?.[1]);
      assert.ok(nextTime>firstTime,"demo clock must keep advancing after seeding");
      const headers = { cookie, Origin: demo.origin, "Content-Type": "application/json", "x-csrf-token": loginBody.data.csrf_token };
      const before = demo.database.read(connection => connection.prepare("SELECT * FROM payment_orders").all());
      const sessions = await app.request("/api/admin/v1/sessions", { headers });
      assert.equal(sessions.status, 200);
      const activeSessions = (await sessions.json() as { data: { session_id: string; is_current: boolean }[] }).data;
      assert.equal(activeSessions.length, 1);
      assert.equal(activeSessions[0]!.is_current, true);
      // Valid session + CSRF must not bypass the demo's read-only wrapper.
      for (const [method, path] of blockedRequests) {
        const response = await app.request(demo.origin + path, { method, headers, body: "{}" });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "demo_read_only");
      }
      assert.deepEqual(demo.database.read(connection => connection.prepare("SELECT * FROM payment_orders").all()), before);
      assert.equal((await app.request("/api/admin/v1/session", { headers })).status, 200,
        "blocked session operations must preserve the demo login");
      const sites = (await (await app.request("/api/admin/v1/sites", { headers })).json() as { data: { client_id: string }[] }).data;
      assert.equal(sites.length, Object.keys(demo.scenarios.sites).length);
      const clientId = demo.scenarios.sites.store;
      const base = "/api/admin/v1/sites/" + clientId;
      const overview = await (await app.request("/api/admin/v1/sites/overview?range=30", { headers })).json() as { data: { confirmed_count: number; confirmed_amount_cents: number }[] };
      assert.equal(overview.data.reduce((sum, site) => sum + site.confirmed_count, 0), stats.confirmations.count);
      assert.equal(overview.data.reduce((sum, site) => sum + site.confirmed_amount_cents, 0), stats.confirmations.amount_cents);
      const own = await (await app.request(base + "/orders", { headers })).json() as { data: { api_client_id: string; order_id: string }[] };
      assert.ok(own.data.length > 0);
      assert.ok(own.data.every(order => order.api_client_id === clientId));
      assert.equal((await app.request("/api/admin/v1/sites/" + demo.scenarios.sites.subscriptions + "/orders/" + own.data[0]!.order_id, { headers })).status, 404);
      const date = new Date(demo.capturedAt + 8 * 3600000).toISOString().slice(0, 10);
      const csv = await app.request(base + "/orders/export", { method: "POST", headers, body: JSON.stringify({ created_from: date, created_to: date }) });
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-type")!, /text\/csv/);
      assert.equal((await app.request(base + "/test-payments", { method: "POST", headers, body: "{}" })).status, 403);
      assert.equal((await app.request("/admin/sites/" + clientId + "/orders", { headers })).status, 200);
      // An unavailable update is honest: no fabricated successful online version check.
      assert.equal((await app.request("/api/admin/v1/system/update", { headers: { cookie } })).status, 503);
      const qr = await app.request("/api/public/v1/checkouts/" + demo.checkout + "/qr.svg");
      assert.equal(qr.status, 200);
      assert.equal(await qr.text(), renderCollectionCodeSvg(DEMO_QR_TEXT));
      assert.notEqual((await app.request("/api/public/v1/checkouts/not-a-token/qr.svg")).status, 200);
      const logout = await app.request(demo.origin + "/api/admin/v1/session/logout", { method: "POST", headers, body: "{}" });
      assert.equal(logout.status, 204);
      assert.equal((await app.request("/api/admin/v1/orders", { headers: { cookie } })).status, 401);
      // Catch even swallowed network failures, not just propagated exceptions.
      assert.equal(fetchAttempts, 0, "demo requests must not attempt external fetches");
    } finally {
      globalThis.fetch = originalFetch;
      demo?.dispose();
    }
    assert.ok(demo);
    assert.equal(existsSync(demo.directory), false);
    demo.dispose(); // Closing twice is safe.
  });

  it("also seeds safely just after Beijing midnight without running the order clock backwards", async () => {
    const checks: string[] = [];
    const checkedAt = new Date().toISOString();
    const expected = { status: "update_available" as const, current_version: "1.0.0-alpha.2", latest_version: "1.0.0",
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v1.0.0", published_at: checkedAt, checked_at: checkedAt };
    const demo = await createPreviewDemo({ now: midnight - day + 60_000, updateChecker: {
      check: async channel => { checks.push(channel ?? "prerelease"); return expected; },
    } });
    try {
      assert.equal(demo.password, "123456");
      const login = await demo.app.request(demo.origin + "/api/admin/v1/session/login", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: demo.origin },
        body: JSON.stringify({ password: "123456" }),
      });
      assert.equal(login.status, 200);
      assert.ok(demo.stats.orders.created > 478);
      assert.ok(demo.stats.pending.orders >= 4);
      assert.equal(demo.database.integrityCheck().ok, true);
      const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const updated = await demo.app.request("/api/admin/v1/system/update?channel=stable", { headers: { cookie } });
      assert.equal(updated.status, 200);
      assert.deepEqual((await updated.json() as { data: unknown }).data, expected);
      assert.deepEqual(checks, ["stable"], "an explicitly supplied update checker serves the read-only metadata request");
    } finally { demo.dispose(); }
  });

  it("rejects invalid ports and clocks before allocating a database", async () => {
    for (const port of [0, 80, 65536, NaN]) await assert.rejects(createPreviewDemo({ port }));
    await assert.rejects(createPreviewDemo({ now: NaN }));
  });
});
