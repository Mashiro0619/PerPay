import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { signApiRequest } from "../src/security/api-signature.ts";

const apiSecret = Buffer.alloc(32, 7).toString("base64url");
const collectionCodePayload = "https://qr.alipay.com/fkx-test-code-2026";

describe("health endpoints", () => {
  it("reports process liveness and database readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const live = await app.request("/livez");
      assert.equal(live.status, 200);
      const liveBody = (await live.json()) as { status: string };
      assert.equal(liveBody.status, "alive");

      const ready = await app.request("/readyz");
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
        status: "ready",
        checks: { database: { ok: true, result: "ok" } },
      });

      const missing = await app.request("/missing");
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), "no-store");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("identity HTTP contract", () => {
  it("requires same-origin JSON login and protects state-changing routes with CSRF", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-identity-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const missingOrigin = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(missingOrigin.status, 403);

      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(login.status, 200);
      const setCookies = login.headers.getSetCookie();
      const sessionCookie = setCookies.find((value) => value.startsWith("perpay_session="));
      const csrfCookie = setCookies.find((value) => value.startsWith("perpay_csrf="));
      assert.ok(sessionCookie);
      assert.ok(csrfCookie);
      assert.match(sessionCookie, /perpay_session=ps1_[A-Za-z0-9_-]{43}/);
      assert.match(sessionCookie, /HttpOnly/);
      assert.match(sessionCookie, /SameSite=Strict/);
      assert.doesNotMatch(sessionCookie, /Secure/);
      assert.match(csrfCookie, /perpay_csrf=pc1_[A-Za-z0-9_-]{43}/);
      assert.doesNotMatch(csrfCookie, /HttpOnly/);
      const loginBody = (await login.json()) as { data: { csrf_token: string } };
      const cookie = [sessionCookie, csrfCookie]
        .map((value) => value.split(";", 1)[0])
        .join("; ");

      const restored = await app.request("/api/admin/v1/session", {
        headers: { cookie },
      });
      assert.equal(restored.status, 200);
      assert.equal(JSON.stringify(await restored.json()).includes(loginBody.data.csrf_token), false);

      const headerWithoutCsrfCookie = await app.request("/api/admin/v1/session/logout", {
        method: "POST",
        headers: {
          origin: "http://localhost:8080",
          cookie: sessionCookie.split(";", 1)[0],
          "x-csrf-token": loginBody.data.csrf_token,
        },
      });
      assert.equal(headerWithoutCsrfCookie.status, 403);

      const noCsrf = await app.request("/api/admin/v1/session/logout", {
        method: "POST",
        headers: { origin: "http://localhost:8080", cookie },
      });
      assert.equal(noCsrf.status, 403);
      assert.equal((await noCsrf.json() as { error: { code: string } }).error.code, "csrf_invalid");

      const logout = await app.request("/api/admin/v1/session/logout", {
        method: "POST",
        headers: {
          origin: "http://localhost:8080",
          cookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
      });
      assert.equal(logout.status, 204);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 and passwords over the byte limit before password work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-validation-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const invalidUtf8 = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: new Uint8Array([0xff]),
      });
      assert.equal(invalidUtf8.status, 400);
      assert.equal(
        (await invalidUtf8.json() as { error: { code: string } }).error.code,
        "invalid_json",
      );

      const oversizedPassword = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: JSON.stringify({ username: "admin", password: "密".repeat(342) }),
      });
      assert.equal(oversizedPassword.status, 422);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses __Host cookies and HSTS for an HTTPS public origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-secure-cookie-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "https://pay.local",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://pay.local",
        },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(login.status, 200);
      assert.equal(
        login.headers.get("strict-transport-security"),
        "max-age=31536000; includeSubDomains",
      );
      const cookies = login.headers.getSetCookie();
      assert.ok(cookies.some((value) => value.startsWith("__Host-perpay_session=") && /Secure/.test(value)));
      assert.ok(cookies.some((value) => value.startsWith("__Host-perpay_csrf=") && /Secure/.test(value)));
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("authenticates API requests, consumes nonce once, and does not expose secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-api-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const body = Buffer.alloc(0);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signed = signApiRequest({
        secret: Buffer.from(apiSecret, "base64url"),
        method: "GET",
        target: "/api/v1/system/status",
        body,
        clientId: "default",
        timestamp,
        nonce: Buffer.alloc(32, 7).toString("base64url"),
      });
      const headers = {
        "x-perpay-signature-version": signed.version,
        "x-perpay-client-id": signed.clientId,
        "x-perpay-timestamp": signed.timestamp,
        "x-perpay-nonce": signed.nonce,
        "x-perpay-signature": signed.signature,
      };
      const first = await app.request("/api/v1/system/status", { headers });
      assert.equal(first.status, 200);
      const firstBody = JSON.stringify(await first.json());
      assert.equal(firstBody.includes(apiSecret), false);

      const replay = await app.request("/api/v1/system/status", { headers });
      assert.equal(replay.status, 409);
      assert.equal((await replay.json() as { error: { code: string } }).error.code, "api_nonce_replayed");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("order HTTP contract", () => {
  it("creates, replays, queries, closes, and publicly projects an order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-orders-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const target = "/api/v1/orders";
      const requestBody = Buffer.from(
        JSON.stringify({
          idempotency_key: "http-order-attempt-1",
          merchant_order_no: "http-order-1",
          amount_cents: 1_000,
          description: "HTTP contract",
        }),
        "utf8",
      );
      const created = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, requestBody, 20),
          "content-type": "application/json",
        },
        body: requestBody,
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as {
        data: {
          order_id: string;
          merchant_order_no: string;
          requested_amount_cents: number;
          payable_amount_cents: number;
          checkout: { token: string; state_url: string; status: string };
        };
      };
      assert.match(createdBody.data.order_id, /^[0-9a-f-]{36}$/);
      assert.equal(createdBody.data.merchant_order_no, "http-order-1");
      assert.equal(createdBody.data.requested_amount_cents, 1_000);
      assert.equal(createdBody.data.payable_amount_cents, 1_001);
      assert.match(createdBody.data.checkout.token, /^pct1_[A-Za-z0-9_-]{43}$/);
      assert.equal(createdBody.data.checkout.status, "OPEN");
      assert.equal(
        created.headers.get("location"),
        `/api/v1/orders/${createdBody.data.order_id}`,
      );

      const replay = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, requestBody, 21),
          "content-type": "application/json",
        },
        body: requestBody,
      });
      assert.equal(replay.status, 200);
      const replayBody = (await replay.json()) as typeof createdBody;
      assert.equal(replayBody.data.order_id, createdBody.data.order_id);
      assert.equal(replayBody.data.checkout.token, createdBody.data.checkout.token);

      const byIdTarget = `/api/v1/orders/${createdBody.data.order_id}`;
      const byId = await app.request(byIdTarget, {
        headers: apiHeaders("GET", byIdTarget, Buffer.alloc(0), 22),
      });
      assert.equal(byId.status, 200);
      assert.equal(
        ((await byId.json()) as typeof createdBody).data.checkout.token,
        createdBody.data.checkout.token,
      );

      const merchantTarget = "/api/v1/orders/by-merchant-no/http-order-1";
      const byMerchant = await app.request(merchantTarget, {
        headers: apiHeaders("GET", merchantTarget, Buffer.alloc(0), 23),
      });
      assert.equal(byMerchant.status, 200);

      const publicTarget = new URL(createdBody.data.checkout.state_url).pathname;
      const publicResponse = await app.request(publicTarget);
      assert.equal(publicResponse.status, 200);
      const publicText = await publicResponse.text();
      assert.equal(publicText.includes(createdBody.data.checkout.token), false);
      assert.equal(publicText.includes(createdBody.data.order_id), false);
      assert.equal(publicText.includes(apiSecret), false);
      const publicBody = JSON.parse(publicText) as {
        data: {
          payment_instructions: {
            payable_amount_cents: number;
            collection_code_payload: string;
          } | null;
          checkout: { status: string };
        };
      };
      assert.equal(
        publicBody.data.payment_instructions?.collection_code_payload,
        collectionCodePayload,
      );
      assert.equal(publicBody.data.payment_instructions?.payable_amount_cents, 1_001);
      assert.equal(publicBody.data.checkout.status, "OPEN");

      const closeTarget = `/api/v1/orders/${createdBody.data.order_id}/actions/close`;
      const closed = await app.request(closeTarget, {
        method: "POST",
        headers: apiHeaders("POST", closeTarget, Buffer.alloc(0), 24),
      });
      assert.equal(closed.status, 200);
      assert.equal(
        ((await closed.json()) as { data: { checkout: { status: string } } }).data.checkout.status,
        "CLOSED",
      );

      const publicClosed = await app.request(publicTarget);
      assert.equal(publicClosed.status, 200);
      const publicClosedBody = (await publicClosed.json()) as {
        data: { payment_instructions: unknown; checkout: { status: string } };
      };
      assert.equal(
        publicClosedBody.data.checkout.status,
        "CLOSED",
      );
      assert.equal(publicClosedBody.data.payment_instructions, null);

      const replacementBody = Buffer.from(
        JSON.stringify({
          idempotency_key: "http-order-attempt-2",
          merchant_order_no: "http-order-2",
          amount_cents: 1_000,
        }),
      );
      const replacement = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, replacementBody, 25),
          "content-type": "application/json",
        },
        body: replacementBody,
      });
      assert.equal(replacement.status, 201);
      assert.equal(
        ((await replacement.json()) as { data: { payable_amount_cents: number } }).data
          .payable_amount_cents,
        1_001,
      );
      const terminalAfterReuse = (await (await app.request(publicTarget)).json()) as {
        data: { payment_instructions: unknown };
      };
      assert.equal(terminalAfterReuse.data.payment_instructions, null);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects changed idempotent requests and duplicate JSON keys after authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-order-errors-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const target = "/api/v1/orders";
      const original = Buffer.from(
        JSON.stringify({
          idempotency_key: "http-conflict-key",
          merchant_order_no: "http-conflict-order",
          amount_cents: 100,
        }),
      );
      const first = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, original, 30),
          "content-type": "application/json",
        },
        body: original,
      });
      assert.equal(first.status, 201);

      const changed = Buffer.from(
        JSON.stringify({
          idempotency_key: "http-conflict-key",
          merchant_order_no: "http-conflict-order",
          amount_cents: 101,
        }),
      );
      const conflict = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, changed, 31),
          "content-type": "application/json",
        },
        body: changed,
      });
      assert.equal(conflict.status, 409);
      assert.equal(
        ((await conflict.json()) as { error: { code: string } }).error.code,
        "idempotency_conflict",
      );

      const duplicate = Buffer.from(
        '{"idempotency_key":"duplicate-json","merchant_order_no":"duplicate-json-order","amount_cents":1,"amount_cents":2}',
      );
      const duplicateResponse = await app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, duplicate, 32),
          "content-type": "application/json",
        },
        body: duplicate,
      });
      assert.equal(duplicateResponse.status, 400);
      assert.equal(
        ((await duplicateResponse.json()) as { error: { code: string } }).error.code,
        "duplicate_json_key",
      );

      const missingTarget = `/api/public/v1/checkouts/pct1_${"A".repeat(43)}`;
      const missingCheckout = await app.request(missingTarget);
      assert.equal(missingCheckout.status, 404);
      assert.equal(
        ((await missingCheckout.json()) as { error: { code: string } }).error.code,
        "checkout_not_found",
      );

      let rateLimited: Response | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await app.request(missingTarget);
        if (response.status === 429) {
          rateLimited = response;
          break;
        }
      }
      assert.ok(rateLimited);
      assert.equal(rateLimited.headers.get("retry-after"), "1");
      assert.equal(
        ((await rateLimited.json()) as { error: { code: string } }).error.code,
        "public_checkout_rate_limited",
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function apiHeaders(
  method: string,
  target: string,
  body: Uint8Array,
  nonceByte: number,
): Record<string, string> {
  const signed = signApiRequest({
    secret: Buffer.from(apiSecret, "base64url"),
    method,
    target,
    body,
    clientId: "default",
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: Buffer.alloc(32, nonceByte).toString("base64url"),
  });
  return {
    "x-perpay-signature-version": signed.version,
    "x-perpay-client-id": signed.clientId,
    "x-perpay-timestamp": signed.timestamp,
    "x-perpay-nonce": signed.nonce,
    "x-perpay-signature": signed.signature,
  };
}
