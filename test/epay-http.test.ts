// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { createApp } from "../src/http/app.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { signEpayV1, signEpayV2, verifyEpayV1, verifyEpayV2, type EpayProtocol } from "../src/epay/protocol.ts";
import type { EpayCredentials } from "../src/epay/model.ts";
import type { OrderProjection } from "../src/orders/model.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";

const audit = { actorId: "admin" };
const merchantOrigin = "https://merchant.example.com";

async function fixture() {
  const f = await createSitePaymentFixture();
  const epay = f.settings.epayStore()!;
  function merchant(name: string) {
    let site = f.createSite(name);
    const api = f.sites.rotateSecret(site.clientId, "api_secret", site.revision, audit);
    const webhook = f.sites.rotateSecret(site.clientId, "webhook_secret", api.site.revision, audit);
    site = f.sites.update(site.clientId, { revision: webhook.site.revision, configuration: {
      ...webhook.site.configuration, notifications_enabled: true,
      notification_origin: merchantOrigin, return_origin: merchantOrigin,
    } }, audit);
    const configured = epay.get(site.clientId);
    assert.equal(configured.revision, 1);
    assert.equal(configured.v1Enabled, true);
    assert.equal(configured.v2Enabled, true);
    assert.equal(configured.v1KeyVersion, 1);
    assert.equal(configured.merchantKeyVersion, 1);
    assert.equal(configured.platformKeyVersion, 1);
    return { site, credentials: epay.credential(configured.pid)!, apiSecret: api.secret, webhookSecret: webhook.secret };
  }
  const first = merchant("HTTP 商户一");
  const second = merchant("HTTP 商户二");
  assert.notEqual(first.credentials.v1Key, second.credentials.v1Key);
  assert.notEqual(first.credentials.merchantPrivateKey, second.credentials.merchantPrivateKey);
  assert.notEqual(first.credentials.platformPrivateKey, second.credentials.platformPrivateKey);
  const health = () => ({ enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: f.now(), lastSuccessAt: f.now(), lastErrorCode: null, consecutiveFailures: 0 });
  const app = createApp({ ...f, startedAt: new Date(f.now()), clock: f.now,
    ledgerHealth: health,
    reconciliationHealth: () => ({ ...health(), pendingOrders: 0, continuationPending: false }),
  });
  const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
  const headers = { cookie: "perpay_session=" + session.sessionToken + "; perpay_csrf=" + session.csrfToken,
    "x-csrf-token": session.csrfToken, origin: f.config.publicOrigin, "content-type": "application/json" };
  function parameters(credentials: EpayCredentials, protocol: EpayProtocol, fields: Record<string, string>) {
    const result = { pid: credentials.pid, ...fields,
      ...(protocol === "epay_v2" ? { timestamp: String(Math.floor(f.now() / 1000)) } : {}), sign_type: protocol === "epay_v1" ? "MD5" : "RSA" };
    return { ...result, sign: protocol === "epay_v1" ? signEpayV1(result, credentials.v1Key!) : signEpayV2(result, credentials.merchantPrivateKey!) };
  }
  function send(path: string, values: Record<string, string>, method = "POST") {
    const encoded = new URLSearchParams(values).toString();
    return app.request(path + (method === "GET" ? "?" + encoded : ""), {
      method, ...(method === "GET" ? {} : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: encoded }),
    });
  }
  function create(protocol: EpayProtocol, outTradeNo: string, credentials = first.credentials, extra: Record<string, string> = {}) {
    const body = parameters(credentials, protocol, { type: "alipay", method: "jump", out_trade_no: outTradeNo,
      name: "中文 商品 + = %26", money: "10.00", notify_url: merchantOrigin + "/notify",
      return_url: merchantOrigin + "/return?campaign=summer", param: "0", ...extra });
    return send(protocol === "epay_v1" ? "/mapi.php" : "/api/pay/create", body);
  }
  function settle(order: OrderProjection) {
    const providerTime = (timestamp: number) => new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    f.setNow(f.now() + 5000);
    const entry = recordLedgerEntry(new LedgerStore(f.database), { start: providerTime(f.now() - 60_000), end: providerTime(f.now() + 60_000) },
      order.orderId + "-credit", order.payableAmountCents, f.now() - 1000, f.now(), "CREDIT", f.snapshot.activeProviderAccountKey!);
    f.setNow(f.now() + 10);
    assert.equal(new ReconciliationStore(f.database).reconcileEntry(entry.ledgerEntryId, f.now()).kind, "auto_settled");
  }
  return { ...f, epay, first, second, app, headers, parameters, send, create, settle };
}

test("epay administration protects credentials and enforces configuration versions", async () => {
  const f = await fixture();
  try {
    const path = "/api/admin/v1/sites/" + f.first.site.clientId;
    assert.equal((await f.app.request(path + "/epay")).status, 401);
    const read = await f.app.request(path + "/epay", { headers: f.headers });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    const configuration = (await read.json() as { data: Record<string, unknown> }).data;
    assert.equal(configuration.client_id, f.first.site.clientId);
    assert.equal(configuration.pid, f.first.credentials.pid);
    assert.ok(!JSON.stringify(configuration).includes("PRIVATE KEY"));
    const body = JSON.stringify({ revision: configuration.revision, v1_enabled: false, v2_enabled: true });
    assert.equal((await f.app.request(path + "/epay", { method: "PUT", headers: { cookie: f.headers.cookie, origin: f.headers.origin, "content-type": "application/json" }, body })).status, 403);
    assert.equal((await f.app.request(path + "/epay", { method: "PUT", headers: { ...f.headers, origin: "https://other.example.com" }, body })).status, 403);
    assert.equal((await f.app.request(path + "/epay", { method: "PUT", headers: f.headers, body })).status, 200);
    assert.equal((await f.app.request(path + "/epay", { method: "PUT", headers: f.headers, body })).status, 409);
    const reveal = await f.app.request(path + "/secrets/epay_merchant/actions/view", { method: "POST", headers: f.headers, body: "{}" });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.headers.get("cache-control"), "no-store");
    assert.equal((await reveal.json() as { data: { secret: string } }).data.secret, f.first.credentials.merchantPrivateKey);
    const rotateBody = JSON.stringify({ revision: f.epay.get(f.first.site.clientId).revision });
    const rotate = () => f.app.request(path + "/secrets/epay_v1/actions/rotate", { method: "POST", headers: f.headers, body: rotateBody });
    assert.equal((await rotate()).status, 200);
    assert.equal((await rotate()).status, 409);
  } finally { f.close(); }
});

test("V1 and V2 normal entry points authenticate, replay once and isolate orders and original amounts", async () => {
  const f = await fixture();
  try {
    for (const protocol of ["epay_v1", "epay_v2"] as const) {
      const number = protocol + "-same";
      const responses = await Promise.all([f.create(protocol, number), f.create(protocol, number)]);
      const [first, second] = await Promise.all(responses.map(response => response.json() as Promise<Record<string, unknown>>));
      assert.equal(first!.code, protocol === "epay_v1" ? 1 : 0, JSON.stringify(first));
      assert.equal(second!.trade_no, first!.trade_no);
      if (protocol === "epay_v2") assert.equal(verifyEpayV2(first!, f.first.credentials.platformPublicKey!), true);
      assert.equal((await (await f.create(protocol, number, f.first.credentials, { money: "11.00" })).json() as { code: number }).code, -1);
      const metadata = f.epay.findOrder(f.first.site.clientId, { outTradeNo: number })!;
      assert.match(metadata.tradeNo, /^[1-9]\d*$/);
      assert.equal(metadata.param, "0");
      const query = (credentials: EpayCredentials) => protocol === "epay_v1"
        ? f.send("/api.php", { act: "order", pid: credentials.pid, key: credentials.v1Key!, trade_no: metadata.tradeNo, out_trade_no: "ignored-other-number" }, "GET")
        : f.send("/api/pay/query", f.parameters(credentials, protocol, { trade_no: metadata.tradeNo, out_trade_no: "ignored-other-number" }));
      const own = await (await query(f.first.credentials)).json() as Record<string, unknown>;
      assert.equal(own.money, "10.00");
      assert.equal(own.status, 0);
      if (protocol === "epay_v2") assert.equal(verifyEpayV2(own, f.first.credentials.platformPublicKey!), true);
      assert.equal((await (await query(f.second.credentials)).json() as { code: number }).code, -1);
      const list = await (protocol === "epay_v1"
        ? f.send("/api.php", { act: "orders", pid: f.first.credentials.pid, key: f.first.credentials.v1Key!, page: "1", limit: "50" })
        : f.send("/api/merchant/orders", f.parameters(f.first.credentials, protocol, { offset: "0", limit: "50" })));
      const catalog = await list.json() as { code: number; data: { pid: string; trade_no: string }[] };
      assert.ok(catalog.data.some(item => item.trade_no === metadata.tradeNo));
      assert.ok(catalog.data.every(item => item.pid === f.first.credentials.pid));
      if (protocol === "epay_v2") assert.equal(verifyEpayV2(catalog, f.first.credentials.platformPublicKey!), true);
      const config = f.epay.get(f.first.site.clientId);
      f.epay.update(f.first.site.clientId, { revision: config.revision, v1_enabled: false, v2_enabled: false }, audit);
      assert.equal((await (await query(f.first.credentials)).json() as { code: number }).code, protocol === "epay_v1" ? 1 : 0);
      assert.equal((await (await f.create(protocol, protocol + "-disabled")).json() as { code: number }).code, -1);
      f.epay.update(f.first.site.clientId, { revision: config.revision + 1, v1_enabled: true, v2_enabled: true }, audit);
    }
    const rows = f.epay.orders(f.first.site.clientId);
    assert.equal(rows.length, 2);
    const orders = rows.map(row => f.orders.forSite(row.siteId).get(row.orderId));
    assert.ok(orders.some(order => order.payableAmountCents > order.requestedAmountCents));
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("invalid signatures, stale timestamps, duplicate fields and conflicting native numbers create no compatibility orders", async () => {
  const f = await fixture();
  try {
    const signed = f.parameters(f.first.credentials, "epay_v2", { type: "alipay", method: "jump", out_trade_no: "invalid-signature", name: "item", money: "1.00", notify_url: merchantOrigin + "/notify" });
    for (const parameters of [{ ...signed, money: "2.00" }, { ...signed, timestamp: "1000000000" }]) {
      assert.equal((await (await f.send("/api/pay/create", parameters)).json() as { code: number }).code, -1);
    }
    const duplicate = await f.app.request("/api/pay/create?pid=" + f.first.credentials.pid, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(signed).toString(),
    });
    assert.equal((await duplicate.json() as { code: number }).code, -1);
    assert.equal(f.epay.orders(f.first.site.clientId).length, 0);
    f.orders.forSite(f.first.site.clientId).create({ idempotency_key: randomUUID(), merchant_order_no: "native-existing", amount_cents: 1000, product_name: "native" });
    assert.equal((await (await f.create("epay_v1", "native-existing")).json() as { code: number }).code, -1);
    assert.equal(f.epay.orders(f.first.site.clientId).length, 0);
  } finally { f.close(); }
});

test("paid synchronous return signs the complete merchant query and uses the original order amount", async () => {
  const f = await fixture();
  try {
    for (const protocol of ["epay_v1", "epay_v2"] as const) {
      const created = await (await f.create(protocol, protocol + "-return")).json() as Record<string, unknown>;
      assert.equal(created.code, protocol === "epay_v1" ? 1 : 0, JSON.stringify(created));
      const metadata = f.epay.findOrder(f.first.site.clientId, { outTradeNo: protocol + "-return" })!;
      const order = f.orders.forSite(metadata.siteId).get(metadata.orderId);
      const target = "/api/public/v1/checkouts/" + order.checkoutToken + "/return";
      const unpaid = await f.app.request(target);
      assert.equal(unpaid.status, 302);
      assert.equal(unpaid.headers.get("location"), merchantOrigin + "/return?campaign=summer");
      f.settle(order);
      const paid = await f.app.request(target);
      assert.equal(paid.status, 302);
      const parameters = Object.fromEntries(new URL(paid.headers.get("location")!).searchParams);
      assert.equal(parameters.campaign, "summer");
      assert.equal(parameters.money, "10.00");
      assert.equal(parameters.trade_status, "TRADE_SUCCESS");
      assert.equal(protocol === "epay_v1" ? verifyEpayV1(parameters, f.first.credentials.v1Key!) : verifyEpayV2(parameters, f.first.credentials.platformPublicKey!), true);
      const updated = f.epay.rotate(metadata.siteId, protocol === "epay_v1" ? "v1_key" : "v2_platform", f.epay.get(metadata.siteId).revision, audit);
      const refreshed = Object.fromEntries(new URL((await f.app.request(target)).headers.get("location")!).searchParams);
      assert.equal(protocol === "epay_v1" ? verifyEpayV1(refreshed, updated.credentials.v1Key!) : verifyEpayV2(refreshed, updated.credentials.platformPublicKey!), true);
    }
  } finally { f.close(); }
});

test("unpaid returns preserve encoded query values in Unicode merchant URLs", async () => {
  const f = await fixture();
  try {
    for (const protocol of ["epay_v1", "epay_v2"] as const) {
      const returnUrl = merchantOrigin + "/返回?token=%2B%2526%3D";
      const created = await (await f.create(protocol, protocol + "-unicode-return", f.first.credentials, { return_url: returnUrl })).json() as { code: number };
      assert.equal(created.code, protocol === "epay_v1" ? 1 : 0);
      const metadata = f.epay.findOrder(f.first.site.clientId, { outTradeNo: protocol + "-unicode-return" })!;
      const order = f.orders.forSite(metadata.siteId).get(metadata.orderId);
      assert.equal(metadata.returnUrl, returnUrl, "keep the original request for existing order replay checks");
      const response = await f.app.request("/api/public/v1/checkouts/" + order.checkoutToken + "/return");
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), new URL(returnUrl).href);
      assert.equal(new URL(response.headers.get("location")!).searchParams.get("token"), "+%26=");
    }
  } finally { f.close(); }
});

for (const protocol of ["epay_v1", "epay_v2"] as const) test(protocol + " queries keep payment completion time after checkout expiry", async () => {
  const f = await fixture();
  try {
      const outTradeNo = protocol + "-completion-time";
      const created = await (await f.create(protocol, outTradeNo)).json() as { code: number };
      assert.equal(created.code, protocol === "epay_v1" ? 1 : 0, JSON.stringify(created));
      const metadata = f.epay.findOrder(f.first.site.clientId, { outTradeNo })!;
      const order = f.orders.forSite(metadata.siteId).get(metadata.orderId);
      const query = async () => (await (protocol === "epay_v1"
        ? f.send("/api.php", { act: "order", pid: metadata.pid, key: f.first.credentials.v1Key!, trade_no: metadata.tradeNo })
        : f.send("/api/pay/query", f.parameters(f.first.credentials, protocol, { trade_no: metadata.tradeNo })))).json() as Promise<Record<string, unknown>>;
      assert.equal((await query()).endtime, "");
      f.settle(order);
      const confirmedAt = f.now();
      const expected = new Date(confirmedAt + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
      assert.equal((await query()).endtime, expected);
      f.setNow(order.checkout.expiresAt + 1000);
      const expired = await query();
      assert.equal(expired.status, 1);
      assert.equal(expired.endtime, expected);
      if (protocol === "epay_v2") assert.equal(verifyEpayV2(expired, f.first.credentials.platformPublicKey!), true);
      const list = await (protocol === "epay_v1"
        ? f.send("/api.php", { act: "orders", pid: metadata.pid, key: f.first.credentials.v1Key! })
        : f.send("/api/merchant/orders", f.parameters(f.first.credentials, protocol, {})));
      const catalog = await list.json() as { data: { trade_no: string; endtime: string }[] };
      assert.equal(catalog.data.find(item => item.trade_no === metadata.tradeNo)?.endtime, expected);
      assert.ok(f.orders.forSite(metadata.siteId).get(metadata.orderId).updatedAt > confirmedAt);
  } finally { f.close(); }
});

test("V2 order lists filter payment status before applying offset and limit", async () => {
  const f = await fixture();
  try {
    const numbers = ["status-first-open", "status-paid", "status-last-open"];
    for (const number of numbers) {
      const result = await (await f.create("epay_v2", number)).json() as { code: number };
      assert.equal(result.code, 0);
      f.setNow(f.now() + 1000);
    }
    const paid = f.epay.findOrder(f.first.site.clientId, { outTradeNo: numbers[1]! })!;
    f.settle(f.orders.forSite(paid.siteId).get(paid.orderId));
    const query = async (status: string, offset: string) => {
      const response = await f.send("/api/merchant/orders", f.parameters(f.first.credentials, "epay_v2", { status, offset, limit: "1" }));
      const value = await response.json() as { code: number; data: { out_trade_no: string; status: number }[] };
      assert.equal(verifyEpayV2(value, f.first.credentials.platformPublicKey!), true);
      return value;
    };
    const successful = await query("1", "0");
    assert.equal(successful.code, 0);
    assert.deepEqual(successful.data.map(order => [order.out_trade_no, order.status]), [["status-paid", 1]]);
    const open = await query("0", "1");
    assert.equal(open.code, 0);
    assert.deepEqual(open.data.map(order => [order.out_trade_no, order.status]), [["status-first-open", 0]]);
    assert.deepEqual((await query("1", "1")).data, []);
    assert.equal((await query("2", "0")).code, -1);
  } finally { f.close(); }
});

test("V2 authentication failures remain unsigned while authenticated business errors are signed", async () => {
  const f = await fixture();
  try {
    const valid = f.parameters(f.first.credentials, "epay_v2", { type: "alipay", method: "unsupported", out_trade_no: "auth-failure",
      name: "item", money: "1.00", notify_url: merchantOrigin + "/notify" });
    const expired = { ...valid, timestamp: String(Math.floor(f.now() / 1000) - 301) };
    expired.sign = signEpayV2(expired, f.first.credentials.merchantPrivateKey!);
    for (const parameters of [{ ...valid, pid: "999999999" }, { ...valid, sign: "invalid" }, expired]) {
      const result = await (await f.send("/api/pay/create", parameters)).json() as Record<string, unknown>;
      assert.equal(result.code, -1);
      assert.equal(result.sign, undefined);
      assert.equal(result.sign_type, undefined);
    }
    const business = await (await f.send("/api/pay/create", valid)).json() as Record<string, unknown>;
    assert.equal(business.code, -1);
    assert.equal(verifyEpayV2(business, f.first.credentials.platformPublicKey!), true);
    assert.equal(f.epay.orders(f.first.site.clientId).length, 0);
  } finally { f.close(); }
});

test("page submit accepts an omitted type while rejecting conflicting return parameters and duplicate form names", async () => {
  const f = await fixture();
  try {
    for (const protocol of ["epay_v1", "epay_v2"] as const) {
      const path = protocol === "epay_v1" ? "/submit.php" : "/api/pay/submit";
      const base = { out_trade_no: protocol + "-page", name: "Page item", money: "3.14", notify_url: merchantOrigin + "/notify", return_url: merchantOrigin + "/return" };
      const bad = await f.send(path, f.parameters(f.first.credentials, protocol, { ...base, return_url: merchantOrigin + "/return?money=3.14" }), "GET");
      assert.equal((await bad.json() as { code: number }).code, -1);
      const signed = f.parameters(f.first.credentials, protocol, base);
      const repeated = await f.app.request(path + "?money=3.14", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(signed).toString() });
      assert.equal((await repeated.json() as { code: number }).code, -1);
      const page = await f.send(path, signed, "GET");
      assert.equal(page.status, 302, await page.clone().text());
      assert.ok(page.headers.get("location")?.startsWith(f.config.publicOrigin + "/checkout/"));
    }
    assert.equal(f.epay.orders(f.first.site.clientId).length, 2);
  } finally { f.close(); }
});

test("complete configuration downloads bind both versions, remain available while paused and exclude other website secrets", async () => {
  const f = await fixture();
  try {
    const path = "/api/admin/v1/sites/" + f.first.site.clientId + "/integration/export";
    const config = f.epay.get(f.first.site.clientId);
    f.epay.update(f.first.site.clientId, { revision: config.revision, v1_enabled: false, v2_enabled: false }, audit);
    const v1Info = await f.send("/api.php", { act: "query", pid: f.first.credentials.pid, key: f.first.credentials.v1Key! }, "GET");
    assert.equal((await v1Info.json() as { active: number }).active, 0);
    const v2Info = await f.send("/api/merchant/info", f.parameters(f.first.credentials, "epay_v2", {}));
    assert.equal((await v2Info.json() as { pay_status: number }).pay_status, 0);
    const base = { site_revision: f.first.site.revision, epay_revision: config.revision + 1, notify_url: merchantOrigin + "/notify", return_url: merchantOrigin + "/return" };
    const request = (body: object, headers = f.headers) => f.app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    for (const protocol of ["native", "epay_v1", "epay_v2"] as const) {
      const exported = await request({ ...base, protocol });
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.equal(exported.headers.get("cache-control"), "no-store");
      assert.ok(exported.headers.get("content-disposition")?.includes(".env"));
      const text = await exported.text();
      const values = parseEnv(text);
      assert.equal(values.PAYMENT_PROTOCOL, protocol);
      assert.equal(values.DEMO_NOTIFY_URL, base.notify_url);
      assert.equal(values.DEMO_RETURN_URL, base.return_url);
      assert.equal(values.DEMO_DATA_DIR, "./data/" + f.first.site.clientId + "-" + protocol);
      if (protocol === "native") assert.equal(values.PERPAY_API_SECRET, f.first.apiSecret);
      else assert.equal(values.EPAY_URL, f.config.publicOrigin + "/");
      if (protocol === "epay_v1") assert.equal(values.EPAY_V1_KEY, f.first.credentials.v1Key);
      if (protocol === "epay_v2") assert.match(values.EPAY_MERCHANT_PRIVATE_KEY!, /^[A-Za-z0-9+/]+=*$/);
      assert.ok(!text.includes(f.second.apiSecret));
      assert.ok(!text.includes(f.second.credentials.v1Key!));
    }
    assert.equal((await request({ ...base, protocol: "epay_v1", epay_revision: config.revision })).status, 409);
    const quotedUrl = await request({ ...base, protocol: "epay_v1", notify_url: merchantOrigin + '/notify"quoted', return_url: merchantOrigin + '/return"quoted' });
    assert.equal(quotedUrl.status, 200);
    const quotedValues = parseEnv(await quotedUrl.text());
    assert.equal(quotedValues.DEMO_NOTIFY_URL, merchantOrigin + "/notify%22quoted");
    assert.equal(quotedValues.DEMO_RETURN_URL, merchantOrigin + "/return%22quoted");
    assert.equal((await request({ ...base, protocol: "epay_v1", site_revision: base.site_revision - 1 })).status, 409);
    assert.equal((await request({ ...base, protocol: "epay_v1", notify_url: "https://other.example.com/notify" })).status, 422);
    assert.equal((await request({ ...base, protocol: "epay_v2", return_url: merchantOrigin + "/return?trade_no=collision" })).status, 422);
  } finally { f.close(); }
});
