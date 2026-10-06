import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { it } from "node:test";
import { login, withHttpFixture } from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { signApiRequest } from "../src/security/api-signature.ts";

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
    const clients = ["default", second.clientId].map(clientId => {
      if (!sites.credential(clientId)) sites.rotateSecret(clientId, "api_secret", sites.get(clientId)!.revision, { actorId: "admin" });
      return sites.credential(clientId)!;
    });
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
      const eventId = f.webhooks.delivery(item.delivery_id)!.event.eventId;
      for (const client of clients) {
        const target = "/api/v1/events/" + eventId;
        const signed = signApiRequest({ clientId: client.clientId, secret: Buffer.from(client.secret, "base64url"), method: "GET", target,
          body: Buffer.alloc(0), timestamp: String(Math.floor(Date.now() / 1000)), nonce: randomBytes(32).toString("base64url") });
        const response = await f.app.request(target, { headers: { "x-perpay-client-id": signed.clientId, "x-perpay-signature-version": signed.version,
          "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature } });
        assert.equal(response.status, client.clientId === expected.clientId ? 200 : 404);
        assert.equal((await response.text()).includes("site_name"), false, "admin website projection must not enter business events");
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
