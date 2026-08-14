import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { signApiRequest } from "../src/security/api-signature.ts";

const apiSecret = Buffer.alloc(32, 7).toString("base64url");

describe("health endpoints", () => {
  it("reports process liveness and database readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_DATA_DIR: directory,
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const app = createApp({ config, database, identity, startedAt: new Date(0) });
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
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const app = createApp({ config, database, identity, startedAt: new Date(0) });
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
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const app = createApp({ config, database, identity, startedAt: new Date(0) });
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
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "https://pay.local",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const app = createApp({ config, database, identity, startedAt: new Date(0) });
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
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const app = createApp({ config, database, identity, startedAt: new Date(0) });
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
