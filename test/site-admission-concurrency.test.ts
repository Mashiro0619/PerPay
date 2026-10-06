import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { OrderStore } from "../src/database/order-store.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

const audit = { actorId: "admin" };
const payload = (no: string) => ({ merchant_order_no: no, idempotency_key: no, product_name: "并发验收", amount_cents: 1000 });
async function fixture() {
  const f = await createSitePaymentFixture();
  const healthy = () => ({ enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: f.now(), lastSuccessAt: f.now(), lastErrorCode: null, consecutiveFailures: 0 });
  const app = createApp({ ...f, startedAt: new Date(), clock: f.now, ledgerHealth: healthy,
    reconciliationHealth: () => ({ ...healthy(), pendingOrders: 0, continuationPending: false }) });
  const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
  const adminHeaders = { origin: f.config.publicOrigin, "content-type": "application/json", "x-csrf-token": session.csrfToken,
    cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}` };
  function site(name: string, limit: number | null = null) {
    const created = f.createSite(name);
    f.sites.update(created.clientId, { revision: 0, configuration: { ...created.configuration,
      policy: { ...created.configuration.policy, orders: { ...created.configuration.policy.orders, pending_order_limit: limit, order_ttl_seconds: 60 } } } }, audit);
    const key = f.sites.rotateSecret(created.clientId, "api_secret", 1, audit);
    return { clientId: created.clientId, secret: key.secret };
  }
  const headers = (site: { clientId: string; secret: string }, method: string, path: string, body = Buffer.alloc(0), nonce = randomBytes(32).toString("base64url")) => {
    const signed = signApiRequest({ ...site, secret: Buffer.from(site.secret, "base64url"), method, target: path, body,
      timestamp: String(Math.floor(Date.now() / 1000)), nonce });
    return { "content-type": "application/json", "x-perpay-client-id": signed.clientId, "x-perpay-signature-version": signed.version,
      "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature };
  };
  const send = (site: { clientId: string; secret: string }, method: string, path: string, input?: unknown, nonce?: string) => {
    const body = input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input));
    return app.request(path, { method, headers: headers(site, method, path, body, nonce), ...(input === undefined ? {} : { body }) });
  };
  return { ...f, app, site, headers, send, adminHeaders };
}
function slowRequest(app: ReturnType<typeof createApp>, origin: string, path: string, method: string, headers: Record<string, string>, value: unknown) {
  const reading = Promise.withResolvers<void>();
  let release!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    release = () => { controller.enqueue(Buffer.from(JSON.stringify(value))); controller.close(); };
  }, pull() { reading.resolve(); } }, { highWaterMark: 0 });
  const response = app.request(new Request(origin + path, { method, headers, body, duplex: "half" } as RequestInit));
  return { reading: reading.promise, release, response };
}

describe("multi-site admission under concurrent requests", () => {
  it("allows the same nonce once per website and rejects cross-site lookup, close and forged body ownership", async () => {
    const f = await fixture();
    try {
      const a = f.site("A"), b = f.site("B"), nonce = randomBytes(32).toString("base64url");
      const results = await Promise.all([f.send(a, "POST", "/api/v1/orders", payload("same"), nonce), f.send(b, "POST", "/api/v1/orders", payload("same"), nonce)]);
      assert.deepEqual(results.map(r => r.status), [201, 201]);
      const orders = await Promise.all(results.map(async r => (await r.json() as { data: { order_id: string } }).data));
      for (const s of [a, b]) assert.equal((await f.send(s, "POST", "/api/v1/orders", payload("same"), nonce)).status, 409);
      const target = "/api/v1/orders/" + orders[1]!.order_id;
      for (const [method, path] of [["GET", target], ["POST", target + "/actions/close"]]) {
        assert.equal((await f.send(a, method!, path!)).status, 404);
      }
      assert.equal((await f.send({ clientId: b.clientId, secret: a.secret }, "GET", target)).status, 401);
      assert.equal((await f.send(a, "POST", "/api/v1/orders", { ...payload("forged"), api_client_id: b.clientId })).status, 422);
      assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM payment_orders").get()?.n), 2n);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("never exceeds independent quotas during a concurrent burst while globally reserving distinct amounts", async () => {
    const f = await fixture();
    try {
      const a = f.site("A", 3), b = f.site("B", 2);
      const responses = await Promise.all([a, b].flatMap(site => Array.from({ length: 8 }, (_, i) => f.send(site, "POST", "/api/v1/orders", payload("order-" + i)))));
      assert.equal(responses.filter(r => r.status === 201).length, 5);
      for (const response of responses.filter(r => r.status !== 201)) {
        assert.equal(response.status, 503); assert.ok(Number(response.headers.get("retry-after")) > 0);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "site_order_limit_exceeded");
      }
      const rows = f.database.read(db => db.prepare("SELECT api_client_id, count(*) AS n FROM payment_orders GROUP BY api_client_id").all());
      assert.equal(rows.find(r => r.api_client_id === a.clientId)?.n, 3n); assert.equal(rows.find(r => r.api_client_id === b.clientId)?.n, 2n);
      assert.equal(f.database.read(db => db.prepare("SELECT count(DISTINCT payable_amount_cents) AS n FROM payment_orders").get()?.n), 5n);
      assert.equal((await f.app.request("/readyz")).status, 200);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("coalesces concurrent idempotent requests before quota and pause checks and excludes expired-but-open orders", async () => {
    const f = await fixture();
    try {
      const a = f.site("A", 1);
      const responses = await Promise.all(Array.from({ length: 8 }, () => f.send(a, "POST", "/api/v1/orders", payload("same"))));
      assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 7);
      const before = f.sites.get(a.clientId)!;
      f.sites.update(a.clientId, { revision: before.revision, configuration: { ...before.configuration, accepting_orders: false } }, audit);
      assert.equal((await f.send(a, "POST", "/api/v1/orders", payload("same"))).status, 200);
      assert.equal((await f.send(a, "POST", "/api/v1/orders", payload("new"))).status, 503);
      assert.equal((await f.app.request("/readyz")).status, 200);
      f.sites.update(a.clientId, { revision: before.revision + 1, configuration: before.configuration }, audit);
      const expiry = f.database.read(db => Number(db.prepare("SELECT expires_at FROM payment_orders").get()?.expires_at));
      f.setNow(expiry);
      assert.equal(f.database.read(db => db.prepare("SELECT checkout_status FROM payment_orders").get()?.checkout_status), "OPEN");
      assert.doesNotThrow(() => f.sites.checkOrderAdmission(a.clientId, f.now()));
      assert.equal(f.database.read(db => db.prepare("SELECT checkout_status FROM payment_orders").get()?.checkout_status), "OPEN");
      assert.equal((await f.send(a, "POST", "/api/v1/orders", payload("after-expiry"))).status, 201);
    } finally { f.close(); }
  });
  for (const winner of ["delete", "order"] as const) it(`serializes deletion against delayed signed order creation: ${winner} wins`, async () => {
    const f = await fixture();
    try {
      const a = f.site("A"), site = f.sites.get(a.clientId)!;
      const path = "/api/admin/v1/sites/" + a.clientId;
      if (winner === "delete") {
        const input = payload("delayed"), bytes = Buffer.from(JSON.stringify(input));
        const slow = slowRequest(f.app, f.config.publicOrigin, "/api/v1/orders", "POST", f.headers(a, "POST", "/api/v1/orders", bytes), input);
        await slow.reading;
        assert.equal((await f.app.request(path, { method: "DELETE", headers: f.adminHeaders, body: JSON.stringify({ revision: site.revision }) })).status, 204);
        slow.release(); assert.equal((await slow.response).status, 409); // captured credential is rechecked at nonce consumption
        assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM payment_orders").get()?.n), 0n);
        assert.equal(f.sites.credential(a.clientId), null);
      } else {
        const slow = slowRequest(f.app, f.config.publicOrigin, path, "DELETE", f.adminHeaders, { revision: site.revision });
        await slow.reading;
        assert.equal((await f.send(a, "POST", "/api/v1/orders", payload("first"))).status, 201);
        slow.release(); const response = await slow.response;
        assert.equal(response.status, 409); assert.equal((await response.json() as { error: { code: string } }).error.code, "site_has_history");
        assert.ok(f.sites.get(a.clientId));
      }
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("rechecks site lifecycle inside the order transaction after a stale policy was captured", async t => {
    const f = await fixture();
    try {
      const a = f.site("A"), site = f.sites.get(a.clientId)!;
      const original = OrderStore.prototype.createOrder;
      t.mock.method(OrderStore.prototype, "createOrder", function(this: OrderStore, ...args: Parameters<OrderStore["createOrder"]>) {
        f.sites.delete(a.clientId, site.revision, audit);
        return original.apply(this, args);
      });
      assert.throws(() => f.orders.forSite(a.clientId).create(createOrderRequestSchema.parse(payload("stale"))), { code: "site_revision_conflict" });
      assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM payment_orders").get()?.n), 0n);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("rejects an in-flight request signed by a rotated credential without consuming the new key's nonce", async () => {
    const f = await fixture();
    try {
      const a = f.site("A"), nonce = randomBytes(32).toString("base64url"), input = payload("rotation-race");
      const slow = slowRequest(f.app, f.config.publicOrigin, "/api/v1/orders", "POST", f.headers(a, "POST", "/api/v1/orders", Buffer.from(JSON.stringify(input)), nonce), input);
      await slow.reading;
      const next = f.sites.rotateSecret(a.clientId, "api_secret", f.sites.get(a.clientId)!.revision, audit);
      slow.release(); assert.equal((await slow.response).status, 409);
      assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM api_nonces WHERE client_id = ?").get(a.clientId)?.n), 0n);
      assert.equal((await f.send({ ...a, secret: next.secret }, "POST", "/api/v1/orders", input, nonce)).status, 201);
    } finally { f.close(); }
  });
});

it("honors the previous website's longer cooldown and reuses its minimal amount at the exact boundary", async () => {
  const f = await createSitePaymentFixture();
  try {
    const a = f.createSite("long"), b = f.createSite("short");
    f.sites.update(b.clientId, { revision: 0, configuration: { ...b.configuration,
      policy: { ...b.configuration.policy, orders: { ...b.configuration.policy.orders, amount_reuse_cooldown_seconds: 60 } } } }, audit);
    const first = f.orders.forSite(a.clientId).create(createOrderRequestSchema.parse(payload("long"))).order;
    f.orders.forSite(a.clientId).close(first.orderId);
    const releasedAt = f.now();
    f.setNow(releasedAt + 60_000);
    const second = f.orders.forSite(b.clientId).create(createOrderRequestSchema.parse(payload("short"))).order;
    assert.equal(second.payableAmountCents, first.payableAmountCents + 1);
    f.orders.forSite(b.clientId).close(second.orderId);
    f.setNow(releasedAt + 600_000 - 1);
    const before = f.orders.forSite(b.clientId).create(createOrderRequestSchema.parse(payload("boundary-before"))).order;
    assert.equal(before.payableAmountCents, first.payableAmountCents + 1);
    f.setNow(releasedAt + 600_000);
    const exact = f.orders.forSite(b.clientId).create(createOrderRequestSchema.parse(payload("boundary-exact"))).order;
    assert.equal(exact.payableAmountCents, first.payableAmountCents);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});
