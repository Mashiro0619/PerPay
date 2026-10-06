import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { login, withHttpFixture } from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";

it("identifies each notification's website in admin lists, details and embedded order history without rewriting evidence", async () => {
  await withHttpFixture(async f => {
    const sites = f.services.sites;
    const second = sites.create({ operation_id: randomUUID(), configuration: { name: "第二网站", accepting_orders: true,
      notifications_enabled: false, notification_origin: null, return_origin: null, policy: sites.defaults().policy } }, { actorId: "admin" });
    for (const clientId of ["default", second.clientId]) {
      configureTestSiteNotifications(sites, clientId, { enabled: true, allowed_origin: "https://shop.example.com" });
      const order = f.services.orders.forSite(clientId).create(createOrderRequestSchema.parse({
        merchant_order_no: "same-number", idempotency_key: "same-key", product_name: "同名商品", amount_cents: 1000,
        notify_url: "https://shop.example.com/notify",
      })).order;
      const entry = f.recordCredit("notice-" + clientId, order.payableAmountCents, 1);
      assert.equal(f.reconciliation.reconcileEntry(entry.ledgerEntryId).kind, "auto_settled");
    }
    assert.equal(f.webhooks.materialize(10, Date.now()), 2);
    const headers = { cookie: (await login(f.app)).cookie };
    const snapshot = () => f.database.read(db => Object.fromEntries(["webhook_targets", "webhook_deliveries", "outbox_events"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const before = snapshot();
    const response = await f.app.request("/api/admin/v1/webhooks/deliveries", { headers });
    assert.equal(response.status, 200);
    const { data } = await response.json() as { data: { delivery_id: string; event: { order_id: string }; order_summary: { api_client_id: string; site_name: string } }[] };
    assert.equal(new Set(data.map(item => item.order_summary.api_client_id)).size, 2);
    for (const item of data) {
      const expected = sites.get(item.order_summary.api_client_id)!;
      assert.equal(item.order_summary.site_name, expected.configuration.name);
      for (const path of ["/api/admin/v1/webhooks/deliveries/" + item.delivery_id, "/api/admin/v1/orders/" + item.event.order_id + "/notifications/deliveries"]) {
        const detailResponse = await f.app.request(path, { headers }); assert.equal(detailResponse.status, 200);
        const payload = await detailResponse.json() as { data: any };
        const detail = Array.isArray(payload.data) ? payload.data[0] : payload.data;
        assert.equal(detail.target.api_client_id, expected.clientId);
        assert.equal(detail.target.site_name, expected.configuration.name);
      }
    }
    const previous = sites.get(second.clientId)!;
    sites.update(second.clientId, { revision: previous.revision, configuration: { ...previous.configuration, name: "网站更名" } }, { actorId: "admin" });
    const selected = data.find(item => item.order_summary.api_client_id === second.clientId)!;
    const renamed = await f.app.request("/api/admin/v1/webhooks/deliveries/" + selected.delivery_id, { headers });
    assert.equal((await renamed.json() as { data: { target: { site_name: string } } }).data.target.site_name, "网站更名");
    assert.deepEqual(snapshot(), before);
    assert.equal((await f.app.request("/api/admin/v1/webhooks/deliveries/" + selected.delivery_id)).status, 401);
  });
});
