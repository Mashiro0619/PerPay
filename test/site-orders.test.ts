import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { SiteError } from "../src/sites/store.ts";
import { createSitePaymentFixture as fixture } from "./site-payment-fixture.ts";

const request = (name = "same-order") => createOrderRequestSchema.parse({ merchant_order_no: name, idempotency_key: name, amount_cents: 10000, product_name: "test product" });
const audit = { actorId: "admin" };

describe("website orders on the shared payment engine", () => {
  it("isolates merchant order/idempotency namespaces while sharing the amount pool", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A"), b = f.createSite("B");
      const oa = f.orders.forSite(a.clientId), ob = f.orders.forSite(b.clientId);
      const first = oa.create(request()).order, second = ob.create(request()).order;
      assert.notEqual(first.orderId, second.orderId);
      assert.equal(first.payableAmountCents, 10001);
      assert.equal(second.payableAmountCents, 10002);
      assert.equal(oa.create(request()).order.orderId, first.orderId);
      assert.equal(ob.getByMerchantOrderNumber("same-order").orderId, second.orderId);
      assert.throws(() => oa.get(second.orderId));
      assert.throws(() => ob.close(first.orderId));
      assert.throws(() => f.orders.create(request("unscoped")), SiteError);
      const owners = f.database.read(connection => connection.prepare("SELECT api_client_id FROM payment_orders ORDER BY payable_amount_cents").all());
      assert.deepEqual(owners.map(row => row.api_client_id), [a.clientId, b.clientId]);
      assert.equal(f.orders.publicCheckout(first.checkoutToken).paymentInstructions?.collectionCodePayload, "https://qr.alipay.com/site-orders");
      const configuration = a.configuration;
      configuration.policy.display.checkout_name = "A 的收银台";
      configuration.policy.display.checkout_show_product_name = false;
      f.sites.update(a.clientId, { revision: 0, configuration }, audit);
      assert.equal(f.orders.publicCheckout(first.checkoutToken).display?.name, "A 的收银台");
      assert.equal(f.orders.publicCheckout(first.checkoutToken).display?.showProductName, false);
      assert.equal(f.orders.publicCheckout(second.checkoutToken).display?.name, "PerPay");
    } finally { f.close(); }
  });
  it("keeps legal replays and existing order access working when paused or full", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A");
      const configuration = a.configuration; configuration.policy.orders.pending_order_limit = 1;
      f.sites.update(a.clientId, { revision: 0, configuration }, audit);
      const scoped = f.orders.forSite(a.clientId);
      const created = scoped.create(request()).order;
      assert.throws(() => scoped.create(request("over-limit")), (e: unknown) => e instanceof SiteError && e.code === "site_order_limit_exceeded");
      assert.equal(scoped.create(request()).order.orderId, created.orderId);
      f.sites.update(a.clientId, { revision: 1, configuration: { ...configuration, accepting_orders: false } }, audit);
      assert.equal(scoped.create(request()).order.orderId, created.orderId);
      assert.equal(scoped.get(created.orderId).orderId, created.orderId);
      assert.throws(() => scoped.create(request("paused")), (e: unknown) => e instanceof SiteError && e.code === "site_paused");
      assert.equal(scoped.close(created.orderId).checkout.status, "CLOSED");
      assert.throws(() => f.sites.delete(a.clientId, 2, audit), (e: unknown) => e instanceof SiteError && e.code === "site_has_history");
    } finally { f.close(); }
  });
  it("stores each site's financial snapshots without changing existing orders", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A"), b = f.createSite("B");
      const config = b.configuration;
      config.policy.orders.order_ttl_seconds = 600;
      config.policy.orders.amount_offset_maximum_cents = 10;
      config.policy.orders.amount_reuse_cooldown_seconds = 60;
      f.sites.update(b.clientId, { revision: 0, configuration: config }, audit);
      const first = f.orders.forSite(a.clientId).create(request()).order;
      const second = f.orders.forSite(b.clientId).create(request()).order;
      const values = () => f.database.read(connection => connection.prepare("SELECT order_id, expires_at - created_at AS ttl, allocation_offset_max_cents, amount_reuse_cooldown_seconds FROM payment_orders ORDER BY payable_amount_cents").all());
      const before = values();
      assert.equal(before[0]?.ttl, 300000n); assert.equal(before[1]?.ttl, 600000n);
      assert.equal(before[1]?.allocation_offset_max_cents, 10n); assert.equal(before[1]?.amount_reuse_cooldown_seconds, 60n);
      config.policy.orders.order_ttl_seconds = 900;
      f.sites.update(b.clientId, { revision: 1, configuration: config }, audit);
      assert.deepEqual(values(), before);
      assert.equal(f.orders.forSite(a.clientId).get(first.orderId).orderId, first.orderId);
      assert.equal(f.orders.forSite(b.clientId).get(second.orderId).orderId, second.orderId);
    } finally { f.close(); }
  });
  it("pins separate callback/return origins and preserves unchanged historical replays", async () => {
    const f = await fixture();
    try {
      const a = f.createSite("A");
      f.sites.rotateSecret(a.clientId, "webhook_secret", 0, audit);
      const config = { ...a.configuration, notifications_enabled: true, notification_origin: "https://notify.example.com", return_origin: "https://shop.example.com" };
      f.sites.update(a.clientId, { revision: 1, configuration: config }, audit);
      const scoped = f.orders.forSite(a.clientId);
      const input = createOrderRequestSchema.parse({ ...request(), notify_url: "https://notify.example.com/callback", return_url: "https://shop.example.com/order" });
      const created = scoped.create(input).order;
      assert.throws(() => scoped.create({ ...request("wrong-origin"), return_url: "https://notify.example.com/order" }));
      f.sites.update(a.clientId, { revision: 2, configuration: { ...config, notification_origin: "https://new-notify.example.com", return_origin: "https://new-shop.example.com" } }, audit);
      assert.equal(scoped.create(input).order.orderId, created.orderId);
      assert.equal(scoped.get(created.orderId).returnUrl, input.return_url);
    } finally { f.close(); }
  });
});

it("creates with explicit website policy after the migrated default website is deleted", async () => {
  const f = await fixture();
  try {
    const old = f.sites.get("default")!;
    f.sites.delete("default", old.revision, audit, f.now());
    const site = f.createSite("独立网站");
    const policy = structuredClone(site.configuration);
    policy.policy.orders.order_ttl_seconds = 450;
    f.sites.update(site.clientId, { revision: site.revision, configuration: policy }, audit, f.now());
    const defaults = f.sites.defaults();
    f.sites.saveDefaults({ revision: defaults.revision, policy: { ...defaults.policy, orders: { ...defaults.policy.orders, order_ttl_seconds: 600 } } }, audit, f.now());
    const created = f.orders.forSite(site.clientId).create(request("no-default")).order;
    assert.equal(f.orders.adminGet(created.orderId).apiClientId, site.clientId);
    assert.equal(created.checkout.expiresAt - created.createdAt, 450000);
    assert.throws(() => f.orders.forSite("default").create(request("deleted")), { code: "site_not_found" });
  } finally { f.close(); }
});
