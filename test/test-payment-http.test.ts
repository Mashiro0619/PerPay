import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const ORIGIN = "http://localhost:6190";
const API_SECRET = Buffer.alloc(32, 19).toString("base64url");
const COLLECTION_CODE = "https://qr.alipay.com/fkx-test-payment-http";
const TEST_PAYMENT_ID = "12345678-1234-4123-8123-123456789abc";

describe("administrator test payment HTTP contract", () => {
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
    const request = { test_payment_id: TEST_PAYMENT_ID, amount_cents: 100 };

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
      assert.equal(createdBody.data.product_name, "配置测试支付（真实收款）");
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
