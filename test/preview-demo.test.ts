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
      assert.equal(stats.orders.created, 478);
      assert.equal(stats.orders.confirmed, 411);
      assert.ok(stats.orders.closed > 0);
      assert.ok(stats.orders.expired > 0);
      assert.equal(stats.pending.orders, 4);
      assert.equal(stats.notifications.failed, 1);
      assert.equal(stats.notifications.pending, 1);
      assert.equal(stats.daily.filter(row => row.orders_created > 0).length, 30);
      assert.equal(stats.daily.reduce((sum, row) => sum + row.confirmed_amount_cents, 0), stats.confirmations.amount_cents);
      assert.equal(stats.daily.reduce((sum, row) => sum + row.orders_created, 0), stats.orders.created);
      assert.equal(demo.database.integrityCheck().ok, true);
      const names = demo.database.read(connection => connection.prepare("SELECT DISTINCT product_name FROM payment_orders").all());
      assert.equal(names.length, 8);
      for (const row of names) assert.match(String(row.product_name), /^演示商品 [A-H] · /u);
      assert.equal((await app.request("/api/admin/v1/orders")).status, 401);
      const blockedRequests = [
        ["POST", "/api/v1/orders"],
        ["PUT", "/api/admin/v1/settings/provider"],
        ["POST", "/api/admin/v1/settings/provider/verify"],
        ["POST", "/api/admin/v1/webhooks/deliveries/example/actions/replay"],
        ["PUT", "/api/admin/v1/orders/" + demo.featured + "/refund-mark"],
        ["DELETE", "/api/admin/v1/session"],
      ] as const;
      for (const [method, path] of blockedRequests) {
        const response = await app.request(path, { method });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "demo_read_only");
      }
      const login = await app.request(demo.origin + "/api/admin/v1/session/login", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: demo.origin },
        body: JSON.stringify({ password: demo.password }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { data: { csrf_token: string } };
      const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      assert.equal((await app.request("/api/admin/v1/orders", { headers: { cookie } })).status, 200);
      const adminHtml=await (await app.request("/admin")).text();
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
      // Valid session + CSRF must not bypass the demo's read-only wrapper.
      for (const [method, path] of blockedRequests) {
        const response = await app.request(demo.origin + path, { method, headers, body: "{}" });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "demo_read_only");
      }
      assert.deepEqual(demo.database.read(connection => connection.prepare("SELECT * FROM payment_orders").all()), before);
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
    const demo = await createPreviewDemo({ now: midnight - day + 60_000 });
    try {
      assert.equal(demo.password, "123456");
      const login = await demo.app.request(demo.origin + "/api/admin/v1/session/login", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: demo.origin },
        body: JSON.stringify({ password: "123456" }),
      });
      assert.equal(login.status, 200);
      assert.equal(demo.stats.orders.created, 478);
      assert.equal(demo.stats.pending.orders, 4);
      assert.equal(demo.database.integrityCheck().ok, true);
    } finally { demo.dispose(); }
  });

  it("rejects invalid ports and clocks before allocating a database", async () => {
    for (const port of [0, 80, 65536, NaN]) await assert.rejects(createPreviewDemo({ port }));
    await assert.rejects(createPreviewDemo({ now: NaN }));
  });
});
