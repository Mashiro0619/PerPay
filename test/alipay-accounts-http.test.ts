import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { AlipayAccountService } from "../src/alipay-accounts/service.ts";
import type { AlipayAccountView } from "../src/alipay-accounts/model.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";

async function fixture() {
  const f = await createSitePaymentFixture();
  let fails = true;
  const alipayAccounts = new AlipayAccountService({ store: f.settings.accountService()!.store(), verifyProviderApplicationKey: async () => { if (fails) throw new Error("offline"); } });
  const app = createApp({ ...f, alipayAccounts, startedAt: new Date() });
  const session = await f.identity.login(HTTP_TEST_ADMIN_PASSWORD);
  const headers = { cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}`, "x-csrf-token": session.csrfToken, origin: f.config.publicOrigin, "content-type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown, custom = headers) => app.request("/api/admin/v1/" + path, { method, headers: custom, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ...f, app, headers, request, online: () => { fails = false; } };
}
const update = (account: AlipayAccountView, name = account.name) => ({ revision: account.revision, name, enabled: account.enabled, code_payload: account.code_payload, app_id: account.app_id, environment: account.environment, platform_public_key: account.platform_public_key });

describe("Alipay account management HTTP", () => {
  it("keeps an existing checkout and its verification available when all accounts are paused", async () => {
    const f = await fixture();
    try {
      const order = f.orders.forSite("default").create(createOrderRequestSchema.parse({ merchant_order_no: "paused-old-order", idempotency_key: "paused-old-order", amount_cents: 1234, product_name: "旧订单" })).order;
      const accounts = f.settings.accountService()!;
      const account = accounts.get("default");
      await accounts.update("default", { ...update(account), enabled: false }, { actorId: "admin" });
      const snapshot = f.settings.instanceSnapshot();
      let requestedOrder: string | null = null;
      const app = createApp({ ...f, alipayAccounts: accounts, startedAt: new Date(),
        runtimeStatus: () => ({ configured: false, transitioning: false, paymentRevision: snapshot.paymentRevision, activeProviderAccountKey: null, scanIntervalMilliseconds: 10000, maximumSuccessAgeMilliseconds: 60000 }),
        accountHealth: () => ({ state: "idle", lastSuccessAt: Date.now(), lastErrorCode: null, collectionReady: false }),
        reconciliationHealth: () => ({ enabled: true, paymentRevision: snapshot.paymentRevision, state: "idle", inFlight: false, lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastErrorCode: null, consecutiveFailures: 0, pendingOrders: 1, continuationPending: false }),
        requestCheckoutVerification: id => { requestedOrder = id; return { id: randomUUID(), state: "WAITING", requested_at: new Date().toISOString(), retry_after_seconds: 5 }; },
      });
      const path = `/api/public/v1/checkouts/${order.checkoutToken}`;
      assert.equal((await app.request(path)).status, 200);
      assert.equal((await app.request(path + "/qr.svg")).status, 200);
      assert.equal((await app.request(path + "/check", { method: "POST", headers: { origin: f.config.publicOrigin, "content-type": "application/json" }, body: "{}" })).status, 202);
      assert.equal(requestedOrder, order.orderId);
    } finally { f.close(); }
  });
  it("requires authentication and CSRF, saves drafts and deletes unused accounts", async () => {
    const f = await fixture();
    try {
      assert.equal((await f.app.request("/api/admin/v1/alipay-accounts")).status, 401);
      assert.equal((await f.request("alipay-accounts", "POST", { name: "账号 B" }, { ...f.headers, "x-csrf-token": "" })).status, 403);
      const created = await f.request("alipay-accounts", "POST", { name: "账号 B" });
      assert.equal(created.status, 201);
      const { data } = await created.json() as { data: AlipayAccountView };
      assert.equal(data.configured, false);
      assert.equal(data.deletable, true);
      assert.equal("private_key" in data, false);
      assert.equal((await f.request(`alipay-accounts/${data.id}`, "PUT", { ...update(data), revision: data.revision + 1 })).status, 409);
      assert.equal((await f.request(`alipay-accounts/${data.id}`, "DELETE", { revision: data.revision })).status, 204);
      assert.equal((await f.request(`alipay-accounts/${data.id}`)).status, 404);
    } finally { f.close(); }
  });

  it("reports save and connection results separately and refuses legacy writes", async () => {
    const f = await fixture();
    try {
      const account = (await (await f.request("alipay-accounts/default")).json() as { data: AlipayAccountView }).data;
      const saved = await f.request("alipay-accounts/default", "PUT", update(account, "主收款账号"));
      assert.equal(saved.status, 200);
      const failed = await f.request("alipay-accounts/default/check", "POST", {});
      assert.equal(failed.status, 200);
      assert.equal((await failed.json() as { data: { ok: boolean } }).data.ok, false);
      assert.equal((await (await f.request("alipay-accounts/default")).json() as { data: AlipayAccountView }).data.name, "主收款账号");
      f.online();
      assert.equal((await (await f.request("alipay-accounts/default/check", "POST", {})).json() as { data: { ok: boolean } }).data.ok, true);
      for (const endpoint of ["settings/provider", "settings/collection"]) {
        const response = await f.request(endpoint, "PUT", {});
        assert.equal(response.status, 410);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "alipay_settings_moved");
      }
      assert.equal((await f.request("alipay-accounts/default", "DELETE", { revision: account.revision + 1 })).status, 409);
    } finally { f.close(); }
  });

  it("validates website selections and binds paging to the account filter", async () => {
    const f = await fixture();
    try {
      const created = await f.request("alipay-accounts", "POST", { name: "备用账号" });
      const secondary = (await created.json() as { data: AlipayAccountView }).data;
      const configuration = { name: "按权重收款", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: f.sites.defaults().policy };
      const create = (collection?: unknown) => f.request("sites", "POST", { operation_id: randomUUID(), configuration: { ...configuration, ...(collection ? { collection } : {}) } });
      assert.equal((await create()).status, 422);
      assert.equal((await create({ mode: "FIXED", accounts: [{ account_id: "missing", weight: 1 }] })).status, 422);
      assert.equal((await create({ mode: "WEIGHTED", accounts: [{ account_id: "default", weight: 0 }] })).status, 422);
      assert.equal((await create({ mode: "RANDOM", accounts: [{ account_id: "default", weight: 1 }, { account_id: "default", weight: 1 }] })).status, 422);
      const valid = await create({ mode: "WEIGHTED", accounts: [{ account_id: "default", weight: 3 }, { account_id: secondary.id, weight: 1 }] });
      assert.equal(valid.status, 201);
      const site = (await valid.json() as { data: { configuration: { collection: { mode: string } } } }).data;
      assert.equal(site.configuration.collection.mode, "WEIGHTED");
      assert.equal((await f.request("orders?alipay_account_id=default&alipay_account_id=missing")).status, 422);
      assert.equal((await f.request("ledger/entries?alipay_account_id=bad%20id")).status, 422);
    } finally { f.close(); }
  });
});
