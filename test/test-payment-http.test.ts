import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { OrderError } from "../src/orders/service.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const ORIGIN = "http://localhost:6190";
const API_SECRET = Buffer.alloc(32, 19).toString("base64url");
const COLLECTION_CODE = "https://qr.alipay.com/fkx-test-payment-http";
const TEST_PAYMENT_ID = "12345678-1234-4123-8123-123456789abc";
const LEGACY_TEST_PRODUCT_NAME = "配置测试支付（真实收款）";

describe("administrator test payment HTTP contract", () => {
  for (const invalidation of ["logout", "revoke-all", "expire"] as const) {
    it(`rejects a delayed request body after session ${invalidation}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-test-payment-session-"));
      let now = Date.now();
      const services = await createConfiguredHttpServices({
        directory, apiSecret: null, collectionCodePayload: COLLECTION_CODE,
        publicUrl: ORIGIN, identityClock: () => now,
      });
      try {
        const triggered: string[] = [];
        const app = createApp({ ...services, startedAt: new Date(0),
          clock: () => now, ...readyPaymentRuntime(now),
          onOrderAvailable: (id) => triggered.push(id),
        });
        const login = await administratorLogin(app);
        const reading = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            reading.resolve();
            await release.promise;
            controller.enqueue(Buffer.from(JSON.stringify({
              api_client_id: "default", test_payment_id: TEST_PAYMENT_ID, amount_cents: 100,
            })));
            controller.close();
          },
        }, { highWaterMark: 0 });
        const request = new Request(ORIGIN + "/api/admin/v1/test-payments", {
          method: "POST", headers: login.headers, body: stream, duplex: "half",
        } as RequestInit);
        const pending = app.request(request);
        try {
          await reading.promise;
          if (invalidation === "expire") now += 31 * 86_400_000;
          else {
            const path = invalidation === "logout"
              ? "/api/admin/v1/session/logout" : "/api/admin/v1/sessions/revoke-all";
            const revoked = await app.request(path, {
              method: "POST", headers: login.headers, body: "{}",
            });
            assert.ok(revoked.ok);
          }
          assert.equal((await app.request("/api/admin/v1/session", { headers: login.headers })).status, 401);
        } finally { release.resolve(); }
        const response = await pending;
        assert.equal(response.status, 401);
        assert.equal(await errorCode(response), "session_invalid");
        assert.equal(orderCount(services.database), 0);
        assert.deepEqual(triggered, []);
      } finally {
        services.database.close();
        assert.ok(directory.startsWith(join(tmpdir(), "perpay-test-payment-session-")));
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("creates an administrator test payment before a business API credential is generated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-test-payment-no-api-"));
    const services = await createConfiguredHttpServices({
      directory,
      apiSecret: null,
      collectionCodePayload: COLLECTION_CODE,
      publicUrl: ORIGIN,
    });
    try {
      const now = 1_700_000_000_000;
      const app = createApp({
        ...services,
        startedAt: new Date(0),
        clock: () => now,
        ...readyPaymentRuntime(now),
      });
      const login = await administratorLogin(app);
      const response = await app.request("/api/admin/v1/test-payments", {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify({ api_client_id: "default", test_payment_id: TEST_PAYMENT_ID, amount_cents: 100 }),
      });
      assert.equal(response.status, 201);
      assert.equal(orderCount(services.database), 1);
      assert.equal(services.settings.instanceView().completion.complete, true);
      assert.equal(services.sites.credential("default"), null);
      assert.equal(services.database.integrityCheck().ok, true);
      services.database.read((connection) => {
        assert.equal(connection.prepare("SELECT 1 FROM api_client_keys").get(), undefined);
      });
      services.sites.rotateSecret("default", "api_secret", services.sites.get("default")!.revision, { actorId: "admin" });
      assert.equal(services.sites.credential("default")?.keyVersion, 1);
      assert.equal(orderCount(services.database), 1);
      const unsignedBusinessRequest = await app.request("/api/v1/orders", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert.equal(unsignedBusinessRequest.status, 401);
      assert.equal(services.database.integrityCheck().ok, true);
    } finally {
      services.database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-test-payment-no-api-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const scope of ["global", "site"] as const) {
    it(`preserves test-payment replay across product-label changes on the ${scope} route`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-test-payment-label-"));
      const services = await createConfiguredHttpServices({
        directory, apiSecret: null, collectionCodePayload: COLLECTION_CODE, publicUrl: ORIGIN,
      });
      try {
        const now = Date.now();
        const ready = createApp({ ...services, startedAt: new Date(0), clock: () => now, ...readyPaymentRuntime(now) });
        const unready = createApp({ ...services, startedAt: new Date(0), clock: () => now });
        const login = await administratorLogin(ready);
        const target = scope === "global" ? "/api/admin/v1/test-payments" : "/api/admin/v1/sites/default/test-payments";
        const post = (id: string, amount = 100, app = ready) => app.request(target, {
          method: "POST", headers: login.headers,
          body: JSON.stringify({
            ...(scope === "global" ? { api_client_id: "default" } : {}),
            test_payment_id: id, amount_cents: amount,
          }),
        });

        // Recreate the immutable request used by the previous administrator endpoint.
        const legacyRequest = {
          idempotency_key: `admin-test-payment:${TEST_PAYMENT_ID}`,
          merchant_order_no: `test-${TEST_PAYMENT_ID}`,
          amount_cents: 100, product_name: LEGACY_TEST_PRODUCT_NAME, note: null,
        };
        const legacyOrder = services.orders.forSite("default").create(legacyRequest).order;
        const legacySnapshot = () => services.database.read((db) => db.prepare(
          "SELECT product_name, request_fingerprint, request_fingerprint_version FROM payment_orders WHERE order_id = ?",
        ).get(legacyOrder.orderId));
        const beforeReplay = legacySnapshot();
        for (const app of [ready, unready]) {
          const replay = await post(TEST_PAYMENT_ID, 100, app);
          assert.equal(replay.status, 200);
          const body = await replay.json() as { data: TestPaymentResponse };
          assert.equal(body.data.order_id, legacyOrder.orderId);
          assert.equal(body.data.product_name, LEGACY_TEST_PRODUCT_NAME);
          assert.equal(body.data.checkout.checkout_url, `${ORIGIN}/checkout/${encodeURIComponent(legacyOrder.checkoutToken)}`);
        }
        assert.deepEqual(legacySnapshot(), beforeReplay);
        assert.equal(orderCount(services.database), 1);

        const changedLegacyAmount = await post(TEST_PAYMENT_ID, 101);
        assert.equal(changedLegacyAmount.status, 409);
        assert.equal(await errorCode(changedLegacyAmount), "idempotency_conflict");
        // The compatibility rule belongs to the administrator endpoint, not general order creation.
        assert.throws(() => services.orders.forSite("default").create({
          ...legacyRequest, product_name: "测试订单",
        }), (error: unknown) => error instanceof OrderError && error.code === "idempotency_conflict");

        const newId = randomUUID();
        const created = await post(newId);
        assert.equal(created.status, 201);
        const createdBody = await created.json() as { data: TestPaymentResponse };
        assert.equal(createdBody.data.product_name, "测试订单");
        const currentReplay = await post(newId);
        assert.equal(currentReplay.status, 200);
        assert.equal(((await currentReplay.json()) as { data: TestPaymentResponse }).data.order_id, createdBody.data.order_id);
        const changedCurrentAmount = await post(newId, 101);
        assert.equal(changedCurrentAmount.status, 409);
        assert.equal(await errorCode(changedCurrentAmount), "idempotency_conflict");

        const conflictingRequests = [
          { product_name: "普通业务商品", note: null, merchantPrefix: "test-" },
          { product_name: LEGACY_TEST_PRODUCT_NAME, note: "业务订单备注", merchantPrefix: "test-" },
          { product_name: LEGACY_TEST_PRODUCT_NAME, note: null, merchantPrefix: "business-" },
        ];
        for (const conflict of conflictingRequests) {
          const id = randomUUID();
          services.orders.forSite("default").create({
            ...legacyRequest,
            idempotency_key: `admin-test-payment:${id}`,
            merchant_order_no: conflict.merchantPrefix + id,
            product_name: conflict.product_name,
            note: conflict.note,
          });
          const rejected = await post(id);
          assert.equal(rejected.status, 409);
          assert.equal(await errorCode(rejected), "idempotency_conflict");
        }
        assert.equal(orderCount(services.database), 2 + conflictingRequests.length);
        assert.deepEqual(legacySnapshot(), beforeReplay);
      } finally {
        services.database.close();
        assert.ok(directory.startsWith(join(tmpdir(), "perpay-test-payment-label-")));
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("uses the real order path with readiness, session, and idempotency protection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-test-payment-http-"));
    const services = await createConfiguredHttpServices({
      directory,
      apiSecret: API_SECRET,
      collectionCodePayload: COLLECTION_CODE,
      publicUrl: ORIGIN,
    });
    const now = 1_700_000_000_000;
    const triggeredOrderIds: string[] = [];
    const unready = createApp({
      ...services,
      startedAt: new Date(0),
      clock: () => now,
    });
    const ready = createApp({
      ...services,
      startedAt: new Date(0),
      clock: () => now,
      ...readyPaymentRuntime(now),
      onOrderAvailable: (orderId) => triggeredOrderIds.push(orderId),
    });
    const target = "/api/admin/v1/test-payments";
    const request = { api_client_id: "default", test_payment_id: TEST_PAYMENT_ID, amount_cents: 100 };

    try {
      const anonymous = await ready.request(target, jsonRequest(request));
      assert.equal(anonymous.status, 401);

      const login = await administratorLogin(ready);
      const crossOrigin = await ready.request(target, {
        method: "POST",
        headers: {
          ...login.headers,
          origin: "https://untrusted.example",
        },
        body: JSON.stringify(request),
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(await errorCode(crossOrigin), "origin_not_allowed");

      const missingCsrf = await ready.request(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          cookie: login.cookie,
        },
        body: JSON.stringify(request),
      });
      assert.equal(missingCsrf.status, 403);
      assert.equal(await errorCode(missingCsrf), "csrf_invalid");

      const blocked = await unready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify(request),
      });
      assert.equal(blocked.status, 503);
      assert.equal(await errorCode(blocked), "reconciliation_not_ready");
      assert.equal(orderCount(services.database), 0);

      const invalidAmount = await ready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify({ ...request, amount_cents: 10_001 }),
      });
      assert.equal(invalidAmount.status, 422);
      assert.equal(await errorCode(invalidAmount), "validation_failed");
      assert.equal(orderCount(services.database), 0);

      const created = await ready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify(request),
      });
      assert.equal(created.status, 201);
      const createdBody = await created.json() as { data: TestPaymentResponse };
      assert.equal(createdBody.data.merchant_order_no, `test-${TEST_PAYMENT_ID}`);
      assert.equal(createdBody.data.requested_amount_cents, 100);
      assert.ok(createdBody.data.payable_amount_cents >= 100);
      assert.equal(createdBody.data.product_name, "测试订单");
      assert.equal(createdBody.data.payment.status, "UNPAID");
      assert.equal(createdBody.data.notification.notify_url, null);
      assert.match(createdBody.data.checkout.checkout_url, /^http:\/\/localhost:6190\/checkout\//);
      assert.match(createdBody.data.checkout.state_url, /^http:\/\/localhost:6190\/api\/public\/v1\/checkouts\//);
      assert.equal(
        created.headers.get("location"),
        `/api/admin/v1/orders/${createdBody.data.order_id}`,
      );
      assert.deepEqual(triggeredOrderIds, [createdBody.data.order_id]);

      const replay = await ready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify(request),
      });
      assert.equal(replay.status, 200);
      const replayBody = await replay.json() as { data: TestPaymentResponse };
      assert.equal(replayBody.data.order_id, createdBody.data.order_id);
      assert.equal(replayBody.data.checkout.checkout_url, createdBody.data.checkout.checkout_url);
      assert.deepEqual(triggeredOrderIds, [createdBody.data.order_id, createdBody.data.order_id]);

      // Recovery must return the existing order even when the background workers are no longer ready.
      const unreadyReplay = await unready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify(request),
      });
      assert.equal(unreadyReplay.status, 200);
      const recovered = await unreadyReplay.json() as { data: TestPaymentResponse };
      assert.equal(recovered.data.order_id, createdBody.data.order_id);
      assert.equal(recovered.data.checkout.checkout_url, createdBody.data.checkout.checkout_url);
      assert.equal(orderCount(services.database), 1);

      const unreadyNewRequest = await unready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify({ ...request, api_client_id: "default", test_payment_id: "12345678-1234-4123-8123-123456789abd" }),
      });
      assert.equal(unreadyNewRequest.status, 503);
      assert.equal(await errorCode(unreadyNewRequest), "reconciliation_not_ready");
      assert.equal(orderCount(services.database), 1);

      const conflictingReplay = await ready.request(target, {
        method: "POST",
        headers: login.headers,
        body: JSON.stringify({ ...request, amount_cents: 101 }),
      });
      assert.equal(conflictingReplay.status, 409);
      assert.equal(await errorCode(conflictingReplay), "idempotency_conflict");
      assert.equal(orderCount(services.database), 1);
      assert.deepEqual(triggeredOrderIds, [createdBody.data.order_id, createdBody.data.order_id]);
    } finally {
      services.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface TestPaymentResponse {
  readonly order_id: string;
  readonly merchant_order_no: string;
  readonly requested_amount_cents: number;
  readonly payable_amount_cents: number;
  readonly product_name: string;
  readonly checkout: {
    readonly checkout_url: string;
    readonly state_url: string;
  };
  readonly payment: { readonly status: string };
  readonly notification: { readonly notify_url: string | null };
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  };
}

async function administratorLogin(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrf_token: string } };
  const cookie = response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return {
    cookie,
    csrfToken: body.data.csrf_token,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie,
      "x-csrf-token": body.data.csrf_token,
    },
  };
}

function readyPaymentRuntime(now: number) {
  return {
    ledgerHealth: () => ({
      enabled: true,
      state: "healthy" as const,
      inFlight: false,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: null,
      consecutiveFailures: 0,
    }),
    reconciliationHealth: () => ({
      enabled: true,
      state: "healthy" as const,
      inFlight: false,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingOrders: 0,
      continuationPending: false,
    }),
  };
}

function orderCount(database: AppDatabase): number {
  return database.read((connection) => Number((connection.prepare(
    "SELECT COUNT(*) AS count FROM payment_orders",
  ).get() as { count: bigint | number }).count));
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
