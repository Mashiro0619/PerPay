import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

async function fixture() {
  const f = await createSitePaymentFixture();
  const app = createApp({ ...f, startedAt: new Date() });
  const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
  const adminHeaders = {
    cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken,
    origin: f.config.publicOrigin,
    "content-type": "application/json",
  };
  const site = f.createSite("可变接入身份");
  const key = f.sites.rotateSecret(site.clientId, "api_secret", site.revision, { actorId: "admin" });
  const command = createOrderRequestSchema.parse({ merchant_order_no: "before-rename", idempotency_key: "before-rename", amount_cents: 100, product_name: "原网站订单" });
  const order = f.orders.forSite(site.clientId).create(command).order;
  const rename = (body: object, headers = adminHeaders, stableId = site.clientId) => app.request(`/api/admin/v1/sites/${stableId}/actions/change-client-id`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  return { ...f, app, adminHeaders, site: key.site, secret: key.secret, command, order, rename };
}

function signedHeaders(clientId: string, secret: string, method: string, target: string, body = "", nonce = randomBytes(32).toString("base64url")) {
  const signed = signApiRequest({ clientId, secret: Buffer.from(secret, "base64url"), method, target,
    body: Buffer.from(body), nonce, timestamp: String(Math.floor(Date.now() / 1000)) });
  return { "content-type": "application/json", "x-perpay-signature-version": signed.version,
    "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp,
    "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature };
}

async function data(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { data: Record<string, any> }).data;
}

it("changes the public API ID while retaining management paths, credentials and historical order replay", async () => {
  const f = await fixture();
  try {
    const target = "/api/v1/orders/" + f.order.orderId;
    const usedNonce = randomBytes(32).toString("base64url");
    assert.equal((await f.app.request(target, { headers: signedHeaders(f.site.clientId, f.secret, "GET", target, "", usedNonce) })).status, 200);
    const rename = { operation_id: randomUUID(), revision: f.site.revision, client_id: "Shop.Renamed" };
    const changed = await data(await f.rename(rename));
    assert.equal(changed.client_id, f.site.clientId);
    assert.equal(changed.api_client_id, rename.client_id);
    assert.equal(changed.revision, f.site.revision + 1);
    assert.equal((await f.app.request(target, { headers: signedHeaders(f.site.clientId, f.secret, "GET", target) })).status, 401);
    assert.equal((await f.app.request(target, { headers: signedHeaders(rename.client_id, f.secret, "GET", target, "", usedNonce) })).status, 409);
    assert.equal((await data(await f.app.request(target, { headers: signedHeaders(rename.client_id, f.secret, "GET", target) }))).order_id, f.order.orderId);

    const body = JSON.stringify(f.command);
    const replay = await data(await f.app.request("/api/v1/orders", { method: "POST", body,
      headers: signedHeaders(rename.client_id, f.secret, "POST", "/api/v1/orders", body) }));
    assert.equal(replay.order_id, f.order.orderId);
    assert.equal(replay.checkout.token, f.order.checkoutToken);
    const merchantPath = "/api/v1/orders/by-merchant-no/" + f.command.merchant_order_no;
    assert.equal((await data(await f.app.request(merchantPath, { headers: signedHeaders(rename.client_id, f.secret, "GET", merchantPath) }))).order_id, f.order.orderId);
    const statusPath = "/api/v1/system/status";
    const status = await data(await f.app.request(statusPath, { headers: signedHeaders(rename.client_id, f.secret, "GET", statusPath) }));
    assert.equal(status.client_id, rename.client_id);
    assert.equal(status.site_id, f.site.clientId);
    const management = await data(await f.app.request("/api/admin/v1/sites/" + f.site.clientId, { headers: f.adminHeaders }));
    assert.equal(management.api_client_id, rename.client_id);
    const overview = await data(await f.app.request("/api/admin/v1/sites/overview?q=Shop.Renamed", { headers: f.adminHeaders }));
    assert.deepEqual(overview.map((site: Record<string, unknown>) => [site.client_id, site.api_client_id]), [[f.site.clientId, rename.client_id]]);
    const oldOverview = await data(await f.app.request("/api/admin/v1/sites/overview?q=" + f.site.clientId, { headers: f.adminHeaders }));
    assert.deepEqual(oldOverview, []);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("authenticates ID changes and returns current state for an old operation replay", async () => {
  const f = await fixture();
  try {
    const first = { operation_id: randomUUID(), revision: f.site.revision, client_id: "Shop.First" };
    assert.equal((await f.rename(first, { ...f.adminHeaders, "x-csrf-token": "invalid" })).status, 403);
    assert.equal((await f.rename(first, { ...f.adminHeaders, origin: "https://other.example" })).status, 403);
    const malformed = await f.rename({ ...first, client_id: "defaults" });
    assert.equal(malformed.status, 422);
    assert.ok((await malformed.json() as { error: { fields: Record<string, string> } }).error.fields.client_id);
    const changed = await data(await f.rename(first));
    const second = { operation_id: randomUUID(), revision: changed.revision, client_id: "shop.first" };
    const latest = await data(await f.rename(second));
    assert.equal(latest.client_id, f.site.clientId);
    assert.equal(latest.api_client_id, second.client_id);
    assert.deepEqual(await data(await f.rename(first)), latest);
    assert.equal((await f.rename({ ...first, client_id: "Shop.Other" })).status, 409);
    assert.equal((await f.rename({ ...second, operation_id: randomUUID(), client_id: "Shop.Stale" })).status, 409);
    const reuse = await f.rename({ operation_id: randomUUID(), revision: latest.revision, client_id: first.client_id });
    assert.equal(reuse.status, 409);
    const rejected = await reuse.json() as { error: { code: string; fields: Record<string, string> } };
    assert.equal(rejected.error.code, "site_client_id_conflict");
    assert.ok(rejected.error.fields.client_id);
    const other = f.createSite("另一网站");
    assert.equal((await f.rename(first, f.adminHeaders, other.clientId)).status, 409);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("rejects an old public ID renamed while its signed request body is still arriving", async context => {
  const f = await fixture();
  try {
    let releaseCredential!: () => void;
    const credentialRead = new Promise<void>(resolve => { releaseCredential = resolve; });
    const readCredential = f.sites.credential.bind(f.sites);
    context.mock.method(f.sites, "credential", (publicId: string) => {
      const credential = readCredential(publicId);
      releaseCredential();
      return credential;
    });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const body = JSON.stringify(f.command);
    const nonce = randomBytes(32).toString("base64url");
    const headers = signedHeaders(f.site.clientId, f.secret, "POST", "/api/v1/orders", body, nonce);
    const pending = f.app.request(new Request(f.config.publicOrigin + "/api/v1/orders", {
      method: "POST", headers, body: stream, duplex: "half",
    }));
    await credentialRead;
    const renamed = f.sites.changeClientId(f.site.clientId, {
      operation_id: randomUUID(), revision: f.site.revision, client_id: "After.Body.Wait",
    }, { actorId: "admin" });
    bodyController.enqueue(Buffer.from(body));
    bodyController.close();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "api_authentication_failed");
    assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS total FROM api_nonces WHERE client_id=? AND nonce=?").get(f.site.clientId, nonce)!.total), 0n);
    const retry = await data(await f.app.request("/api/v1/orders", { method: "POST", body,
      headers: signedHeaders(renamed.apiClientId, f.secret, "POST", "/api/v1/orders", body, nonce) }));
    assert.equal(retry.order_id, f.order.orderId);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});
