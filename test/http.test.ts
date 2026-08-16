import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
    const collectionNow = 1_700_000_005_000;
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const live = await app.request("/livez");
      assert.equal(live.status, 200);
      const liveBody = (await live.json()) as { status: string };
      assert.equal(liveBody.status, "alive");

      const ready = await app.request("/readyz");
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), { status: "not_ready" });

      const firstScanPending = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "running",
          inFlight: true,
          lastAttemptAt: 1_700_000_000_000,
          lastSuccessAt: null,
          lastErrorCode: null,
          consecutiveFailures: 0,
        }),
      });
      const firstScanPendingReady = await firstScanPending.request("/readyz");
      assert.equal(firstScanPendingReady.status, 503);
      assert.equal(
        ((await firstScanPendingReady.json()) as { status: string }).status,
        "not_ready",
      );

      const degraded = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "degraded",
          inFlight: false,
          lastAttemptAt: 1_700_000_000_000,
          lastSuccessAt: 1_699_999_990_000,
          lastErrorCode: "remote_authorization_failed",
          consecutiveFailures: 1,
        }),
      });
      const degradedReady = await degraded.request("/readyz");
      assert.equal(degradedReady.status, 200);
      assert.deepEqual(await degradedReady.json(), { status: "degraded" });

      const catchingUp = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "catching_up",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - 1_000,
          lastErrorCode: "provider_page_limit_reached",
          consecutiveFailures: 0,
        }),
      });
      const catchingUpReady = await catchingUp.request("/readyz");
      assert.equal(catchingUpReady.status, 200);
      assert.deepEqual(await catchingUpReady.json(), { status: "degraded" });

      const exactFreshnessBoundary = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "healthy",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - config.alipay.maximumSuccessAgeMilliseconds,
          lastErrorCode: null,
          consecutiveFailures: 0,
        }),
      });
      const exactBoundaryReady = await exactFreshnessBoundary.request("/readyz");
      assert.equal(exactBoundaryReady.status, 200);
      assert.deepEqual(await exactBoundaryReady.json(), { status: "ready" });

      const futureSuccess = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "healthy",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow + 1,
          lastErrorCode: null,
          consecutiveFailures: 0,
        }),
      });
      const futureSuccessReady = await futureSuccess.request("/readyz");
      assert.equal(futureSuccessReady.status, 503);
      assert.deepEqual(await futureSuccessReady.json(), { status: "not_ready" });

      const stale = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "degraded",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - config.alipay.maximumSuccessAgeMilliseconds - 1,
          lastErrorCode: "remote_authorization_failed",
          consecutiveFailures: 4,
        }),
      });
      const staleReady = await stale.request("/readyz");
      assert.equal(staleReady.status, 503);
      assert.deepEqual(await staleReady.json(), { status: "not_ready" });

      const reconciliationDegraded = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        reconciliationHealth: () => ({
          enabled: true,
          state: "degraded",
          inFlight: false,
          lastAttemptAt: 1_700_000_001_000,
          lastSuccessAt: collectionNow - 10_000,
          lastErrorCode: "reconciliation_item_failed",
          consecutiveFailures: 2,
          pendingOrders: 1,
          continuationPending: true,
        }),
      });
      const reconciliationReady = await reconciliationDegraded.request("/readyz");
      assert.equal(reconciliationReady.status, 200);
      const reconciliationReadyBody = (await reconciliationReady.json()) as { status: string };
      assert.equal(reconciliationReadyBody.status, "degraded");

      const backupUnhealthy = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        backupHealth: () => ({
          ok: true,
          status: "healthy",
          last_attempt_at: collectionNow,
          last_success_at: collectionNow,
          last_error_at: null,
          last_error_stage: null,
          backup_name:
            "perpay.sqlite3.backup-2026-08-16T04-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3",
          snapshot_id: "a".repeat(64),
          instance_id: "f".repeat(32),
          repository_id: "b".repeat(64),
          interval_milliseconds: 86_400_000,
          maximum_age_milliseconds: 95_040_000,
          clock_moved_backwards: false,
          configuration_mismatch: false,
        }),
      });
      const backupReady = await backupUnhealthy.request("/readyz");
      assert.equal(backupReady.status, 200);
      assert.deepEqual(await backupReady.json(), { status: "ready" });

      const backupLogin = await backupUnhealthy.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: config.publicOrigin,
        },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(backupLogin.status, 200);
      const backupCookie = backupLogin.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const backupStatus = await backupUnhealthy.request("/api/admin/v1/system/status", {
        headers: { cookie: backupCookie },
      });
      assert.equal(backupStatus.status, 200);
      const backupStatusBody = (await backupStatus.json()) as {
        data: {
          status: string;
          backup: { enabled: boolean; status: string; instance_matches: boolean | null };
        };
      };
      assert.equal(backupStatusBody.data.status, "degraded");
      assert.deepEqual(
        {
          enabled: backupStatusBody.data.backup.enabled,
          status: backupStatusBody.data.backup.status,
          instance_matches: backupStatusBody.data.backup.instance_matches,
        },
        { enabled: true, status: "unhealthy", instance_matches: false },
      );

      const backupUnavailable = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        backupHealth() {
          throw new Error("backup state is unreadable");
        },
      });
      const unavailableReady = await backupUnavailable.request("/readyz");
      assert.equal(unavailableReady.status, 200);
      assert.deepEqual(await unavailableReady.json(), { status: "ready" });
      const unavailableStatus = await backupUnavailable.request(
        "/api/admin/v1/system/status",
        { headers: { cookie: backupCookie } },
      );
      assert.equal(unavailableStatus.status, 200);
      const unavailableStatusBody = await unavailableStatus.json() as {
        data: { status: string; backup: Record<string, unknown> };
      };
      assert.equal(unavailableStatusBody.data.status, "degraded");
      assert.deepEqual(unavailableStatusBody.data.backup, {
        enabled: true,
        ok: false,
        status: "unavailable",
        last_attempt_at: null,
        last_success_at: null,
        last_error_at: null,
        last_error_stage: null,
        backup_name: null,
        snapshot_id: null,
        instance_id: null,
        repository_id: null,
        interval_milliseconds: null,
        maximum_age_milliseconds: null,
        clock_moved_backwards: false,
        configuration_mismatch: false,
        instance_matches: null,
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

      const malformedExistingPassword = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: JSON.stringify({ username: "admin", password: "malformed-\ud800-password" }),
      });
      assert.equal(malformedExistingPassword.status, 401);
      assert.equal(
        (await malformedExistingPassword.json() as { error: { code: string } }).error.code,
        "invalid_credentials",
      );

      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { data: { csrf_token: string } };
      const cookie = login.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const authenticatedHeaders = {
        "content-type": "application/json",
        origin: "http://localhost:8080",
        cookie,
        "x-csrf-token": loginBody.data.csrf_token,
      };
      const stepUp = await app.request("/api/admin/v1/session/step-up", {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({ password: "a-secure-local-password" }),
      });
      assert.equal(stepUp.status, 200);
      const stepUpBody = await stepUp.json() as { data: { csrf_token: string } };
      const elevatedHeaders = {
        ...authenticatedHeaders,
        cookie: stepUp.headers.getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; "),
        "x-csrf-token": stepUpBody.data.csrf_token,
      };

      const malformedNewPassword = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: elevatedHeaders,
        body: JSON.stringify({
          current_password: "a-secure-local-password",
          new_password: "malformed-\ud800-new-password",
        }),
      });
      assert.equal(malformedNewPassword.status, 422);
      assert.equal(
        (await malformedNewPassword.json() as { error: { code: string } }).error.code,
        "validation_failed",
      );

      const failedActions = database.read((connection) =>
        connection.prepare(
          "SELECT action FROM audit_events WHERE outcome = 'FAILURE' ORDER BY sequence",
        ).all() as Array<{ action: string }>,
      ).map((event) => event.action);
      assert.deepEqual(failedActions, ["admin.login"]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates credentials on step-up and preserves them when an identical password is rejected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-step-up-rotation-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_API_SECRET: apiSecret,
      PERPAY_COLLECTION_CODE_PAYLOAD: collectionCodePayload,
      PERPAY_DATA_DIR: directory,
      PERPAY_PUBLIC_URL: "http://localhost:8080",
    });
    const database = await AppDatabase.open(config.databasePath);
    const clock = { now: Date.parse("2026-08-16T12:00:00Z") };
    const identity = new IdentityService(database, config, () => clock.now);
    await identity.initialize();
    const orders = new OrderService(database, config);
    orders.initialize();
    const app = createApp({ config, database, identity, orders, startedAt: new Date(0) });
    try {
      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
        },
        body: JSON.stringify({ username: "admin", password: "a-secure-local-password" }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as {
        data: { csrf_token: string; absolute_expires_at: string };
      };
      const loginCookie = login.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      clock.now += 60_000;

      const stepUp = await app.request("/api/admin/v1/session/step-up", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: JSON.stringify({ password: "a-secure-local-password" }),
      });
      assert.equal(stepUp.status, 200);
      const stepUpCookies = stepUp.headers.getSetCookie();
      const replacementSessionCookie = stepUpCookies.find((value) =>
        value.startsWith("perpay_session=")
      );
      const replacementCsrfCookie = stepUpCookies.find((value) =>
        value.startsWith("perpay_csrf=")
      );
      assert.ok(replacementSessionCookie);
      assert.ok(replacementCsrfCookie);
      assert.match(replacementSessionCookie, /Max-Age=43140/);
      assert.match(replacementCsrfCookie, /Max-Age=43140/);
      const stepUpBody = await stepUp.json() as {
        data: {
          csrf_token: string;
          step_up_expires_at: string;
          absolute_expires_at: string;
        };
      };
      assert.notEqual(stepUpBody.data.csrf_token, loginBody.data.csrf_token);
      assert.equal(stepUpBody.data.absolute_expires_at, loginBody.data.absolute_expires_at);
      const replacementCookie = [replacementSessionCookie, replacementCsrfCookie]
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      assert.notEqual(replacementCookie, loginCookie);

      const oldSession = await app.request("/api/admin/v1/session", {
        headers: { cookie: loginCookie },
      });
      assert.equal(oldSession.status, 401);
      const replacementSession = await app.request("/api/admin/v1/session", {
        headers: { cookie: replacementCookie },
      });
      assert.equal(replacementSession.status, 200);
      assert.equal(
        (await replacementSession.json() as { data: { step_up_active: boolean } }).data
          .step_up_active,
        true,
      );

      const identityBefore = identity.store.read((transaction) => transaction.adminIdentity());
      const auditBefore = identity.store.read((transaction) => transaction.auditEvents());
      const unchanged = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8080",
          cookie: replacementCookie,
          "x-csrf-token": stepUpBody.data.csrf_token,
        },
        body: JSON.stringify({
          current_password: "a-secure-local-password",
          new_password: "a-secure-local-password",
        }),
      });
      assert.equal(unchanged.status, 409);
      assert.equal(
        (await unchanged.json() as { error: { code: string } }).error.code,
        "password_unchanged",
      );
      assert.deepEqual(
        identity.store.read((transaction) => transaction.adminIdentity()),
        identityBefore,
      );
      assert.deepEqual(
        identity.store.read((transaction) => transaction.auditEvents()),
        auditBefore,
      );
      assert.deepEqual(unchanged.headers.getSetCookie(), []);

      const stillElevated = await app.request("/api/admin/v1/session", {
        headers: { cookie: replacementCookie },
      });
      assert.equal(stillElevated.status, 200);
      assert.equal(
        (await stillElevated.json() as { data: { step_up_active: boolean } }).data.step_up_active,
        true,
      );
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
      PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1",
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
    const signedBackupHealth = Object.freeze({
      ok: true,
      status: "healthy" as const,
      last_attempt_at: 1_700_000_000_000,
      last_success_at: 1_700_000_000_000,
      last_error_at: null,
      last_error_stage: null,
      backup_name:
        "perpay.sqlite3.backup-2026-08-16T04-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3",
      snapshot_id: "a".repeat(64),
      instance_id: database.instanceId(),
      repository_id: "b".repeat(64),
      interval_milliseconds: 86_400_000,
      maximum_age_milliseconds: 95_040_000,
      clock_moved_backwards: false,
      configuration_mismatch: false,
    });
    const app = createApp({
      config,
      database,
      identity,
      orders,
      startedAt: new Date(0),
      clock: () => 1_700_000_000_000,
      ...readyPaymentRuntime(1_700_000_000_000),
      backupHealth: () => signedBackupHealth,
    });
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
      const parsedFirst = await first.json() as {
        data: {
          database: { ok: boolean; result: string };
          ledger: {
            collection_ready: boolean;
            last_success_age_milliseconds: number | null;
            maximum_success_age_milliseconds: number;
          };
          reconciliation: {
            confirmation_ready: boolean;
            last_success_age_milliseconds: number | null;
            maximum_success_age_milliseconds: number;
          };
          backup: Record<string, unknown>;
        };
      };
      assert.deepEqual(parsedFirst.data.database, { ok: true, result: "ok" });
      assert.deepEqual(
        {
          collection_ready: parsedFirst.data.ledger.collection_ready,
          last_success_age_milliseconds:
            parsedFirst.data.ledger.last_success_age_milliseconds,
          maximum_success_age_milliseconds:
            parsedFirst.data.ledger.maximum_success_age_milliseconds,
        },
        {
          collection_ready: true,
          last_success_age_milliseconds: 0,
          maximum_success_age_milliseconds: 60_000,
        },
      );
      assert.deepEqual(
        {
          confirmation_ready: parsedFirst.data.reconciliation.confirmation_ready,
          last_success_age_milliseconds:
            parsedFirst.data.reconciliation.last_success_age_milliseconds,
          maximum_success_age_milliseconds:
            parsedFirst.data.reconciliation.maximum_success_age_milliseconds,
        },
        {
          confirmation_ready: true,
          last_success_age_milliseconds: 0,
          maximum_success_age_milliseconds: 60_000,
        },
      );
      assert.deepEqual(parsedFirst.data.backup, {
        enabled: true,
        ...signedBackupHealth,
        instance_matches: true,
      });
      const firstBody = JSON.stringify(parsedFirst);
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
  it("blocks new orders until the first provider scan succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-first-scan-"));
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
    const requestBody = Buffer.from(JSON.stringify({
      idempotency_key: "first-scan-gate",
      merchant_order_no: "first-scan-gate",
      amount_cents: 1_000,
    }));
    const target = "/api/v1/orders";
    let collectionNow = 1_700_000_001_000;
    let collectionState: "degraded" | "healthy" = "healthy";
    let collectionLastSuccessAt = collectionNow;
    let collectionLastErrorCode: string | null = null;
    let collectionConsecutiveFailures = 0;
    let reconciliationState: "healthy" | "degraded" | "stopped" = "healthy";
    let reconciliationLastSuccessAt: number | null = collectionNow;
    let reconciliationLastErrorCode: string | null = null;
    let reconciliationConsecutiveFailures = 0;
    try {
      const pending = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "degraded",
          inFlight: false,
          lastAttemptAt: 1_700_000_000_000,
          lastSuccessAt: null,
          lastErrorCode: "remote_authorization_failed",
          consecutiveFailures: 1,
        }),
      });
      const blocked = await pending.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, requestBody, 18),
          "content-type": "application/json",
        },
        body: requestBody,
      });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.headers.get("retry-after"), "10");
      assert.equal(
        ((await blocked.json()) as { error: { code: string } }).error.code,
        "collection_not_ready",
      );
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM payment_orders",
        ).get() as { count: bigint | number }).count)),
        0,
      );

      const ready = createApp({
        config,
        database,
        identity,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: collectionState,
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionLastSuccessAt,
          lastErrorCode: collectionLastErrorCode,
          consecutiveFailures: collectionConsecutiveFailures,
        }),
        reconciliationHealth: () => ({
          enabled: true,
          state: reconciliationState,
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: reconciliationLastSuccessAt,
          lastErrorCode: reconciliationLastErrorCode,
          consecutiveFailures: reconciliationConsecutiveFailures,
          pendingOrders: 0,
          continuationPending: false,
        }),
      });
      const created = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, requestBody, 19),
          "content-type": "application/json",
        },
        body: requestBody,
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as {
        data: { checkout: { state_url: string } };
      };
      const publicTarget = new URL(createdBody.data.checkout.state_url).pathname;
      const blockedCheckout = await pending.request(publicTarget);
      assert.equal(blockedCheckout.status, 503);
      assert.equal(
        ((await blockedCheckout.json()) as { error: { code: string } }).error.code,
        "collection_not_ready",
      );

      collectionNow += config.alipay.maximumSuccessAgeMilliseconds + 1;
      collectionState = "degraded";
      collectionLastErrorCode = "remote_authorization_failed";
      collectionConsecutiveFailures = 4;
      const staleRequestBody = Buffer.from(JSON.stringify({
        idempotency_key: "stale-scan-gate",
        merchant_order_no: "stale-scan-gate",
        amount_cents: 2_000,
      }));
      const staleCreate = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, staleRequestBody, 40),
          "content-type": "application/json",
        },
        body: staleRequestBody,
      });
      assert.equal(staleCreate.status, 503);
      assert.equal(
        ((await staleCreate.json()) as { error: { code: string } }).error.code,
        "collection_not_ready",
      );

      collectionState = "healthy";
      collectionLastSuccessAt = collectionNow;
      collectionLastErrorCode = null;
      collectionConsecutiveFailures = 0;
      reconciliationLastSuccessAt = collectionNow;
      const recoveredCreate = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, staleRequestBody, 41),
          "content-type": "application/json",
        },
        body: staleRequestBody,
      });
      assert.equal(recoveredCreate.status, 201);

      const reconciliationBody = Buffer.from(JSON.stringify({
        idempotency_key: "reconciliation-readiness-gate",
        merchant_order_no: "reconciliation-readiness-gate",
        amount_cents: 3_000,
      }));
      reconciliationState = "degraded";
      reconciliationLastSuccessAt = null;
      reconciliationLastErrorCode = "reconciliation_item_failed";
      reconciliationConsecutiveFailures = 1;
      const reconciliationPending = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, reconciliationBody, 42),
          "content-type": "application/json",
        },
        body: reconciliationBody,
      });
      assert.equal(reconciliationPending.status, 503);
      assert.equal(
        ((await reconciliationPending.json()) as { error: { code: string } }).error.code,
        "reconciliation_not_ready",
      );

      reconciliationLastSuccessAt = collectionNow;
      const degradedButFresh = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, reconciliationBody, 43),
          "content-type": "application/json",
        },
        body: reconciliationBody,
      });
      assert.equal(degradedButFresh.status, 201);
      const degradedReady = await ready.request("/readyz");
      assert.equal(degradedReady.status, 200);
      assert.deepEqual(await degradedReady.json(), { status: "degraded" });

      reconciliationState = "stopped";
      const stoppedBody = Buffer.from(JSON.stringify({
        idempotency_key: "reconciliation-stopped-gate",
        merchant_order_no: "reconciliation-stopped-gate",
        amount_cents: 4_000,
      }));
      const stopped = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, stoppedBody, 44),
          "content-type": "application/json",
        },
        body: stoppedBody,
      });
      assert.equal(stopped.status, 503);
      assert.equal(
        ((await stopped.json()) as { error: { code: string } }).error.code,
        "reconciliation_not_ready",
      );

      const replayWhileStopped = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, requestBody, 46),
          "content-type": "application/json",
        },
        body: requestBody,
      });
      assert.equal(replayWhileStopped.status, 200);
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM payment_orders",
        ).get() as { count: bigint | number }).count)),
        3,
      );

      const terminal = orders.create("default", {
        idempotency_key: "terminal-checkout-readiness",
        merchant_order_no: "terminal-checkout-readiness",
        amount_cents: 5_000,
      }).order;
      orders.close("default", terminal.orderId);
      const terminalResponse = await ready.request(
        `/api/public/v1/checkouts/${encodeURIComponent(terminal.checkoutToken)}`,
      );
      assert.equal(terminalResponse.status, 200);
      assert.equal(
        ((await terminalResponse.json()) as { data: { payment_instructions: unknown } })
          .data.payment_instructions,
        null,
      );

      reconciliationState = "degraded";
      reconciliationLastSuccessAt =
        collectionNow - config.alipay.maximumSuccessAgeMilliseconds - 1;
      const staleReconciliation = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, stoppedBody, 45),
          "content-type": "application/json",
        },
        body: stoppedBody,
      });
      assert.equal(staleReconciliation.status, 503);
      assert.equal(
        ((await staleReconciliation.json()) as { error: { code: string } }).error.code,
        "reconciliation_not_ready",
      );

      reconciliationState = "healthy";
      reconciliationLastSuccessAt = collectionNow;
      reconciliationLastErrorCode = null;
      reconciliationConsecutiveFailures = 0;

      const originalStatfsSync = fs.statfsSync;
      const noHeadroomStatfsSync = ((...arguments_: unknown[]) => {
        const result = Reflect.apply(originalStatfsSync, fs, arguments_) as {
          bavail: bigint | number;
          [key: string]: unknown;
        };
        return { ...result, bavail: typeof result.bavail === "bigint" ? 0n : 0 };
      }) as typeof fs.statfsSync;
      assert.equal(Reflect.set(fs, "statfsSync", noHeadroomStatfsSync), true);
      syncBuiltinESMExports();
      try {
        const storageReady = await ready.request("/readyz");
        assert.equal(storageReady.status, 503);
        assert.deepEqual(await storageReady.json(), { status: "not_ready" });
        assert.equal(database.health().result, "database_storage_low");

        const storageCheckout = await ready.request(publicTarget);
        assert.equal(storageCheckout.status, 503);
        assert.equal(
          ((await storageCheckout.json()) as { error: { code: string } }).error.code,
          "system_not_ready",
        );

        const storageRequestBody = Buffer.from(JSON.stringify({
          idempotency_key: "storage-core-gate",
          merchant_order_no: "storage-core-gate",
          amount_cents: 1_000,
        }));
        const storageCreate = await ready.request(target, {
          method: "POST",
          headers: {
            ...apiHeaders("POST", target, storageRequestBody, 20),
            "content-type": "application/json",
          },
          body: storageRequestBody,
        });
        assert.equal(storageCreate.status, 503);
        assert.equal(
          ((await storageCreate.json()) as { error: { code: string } }).error.code,
          "system_not_ready",
        );
      } finally {
        assert.equal(Reflect.set(fs, "statfsSync", originalStatfsSync), true);
        syncBuiltinESMExports();
      }

      database.write((connection) => {
        connection.prepare(
          "UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1",
        ).run(Date.now() + 10 * 60 * 1_000);
      });
      const unsafeCheckout = await ready.request(publicTarget);
      assert.equal(unsafeCheckout.status, 503);
      assert.equal(
        ((await unsafeCheckout.json()) as { error: { code: string } }).error.code,
        "order_clock_unavailable",
      );

      const unsafeRequestBody = Buffer.from(JSON.stringify({
        idempotency_key: "unsafe-core-gate",
        merchant_order_no: "unsafe-core-gate",
        amount_cents: 1_000,
      }));
      const unsafeCreate = await ready.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, unsafeRequestBody, 21),
          "content-type": "application/json",
        },
        body: unsafeRequestBody,
      });
      assert.equal(unsafeCreate.status, 503);
      assert.equal(
        ((await unsafeCreate.json()) as { error: { code: string } }).error.code,
        "system_not_ready",
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    const reconciliationTriggers: string[] = [];
    const app = createApp({
      config,
      database,
      identity,
      orders,
      startedAt: new Date(0),
      ...readyPaymentRuntime(Date.now()),
      onOrderAvailable: (orderId) => reconciliationTriggers.push(orderId),
    });
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
      assert.deepEqual(reconciliationTriggers, [createdBody.data.order_id]);
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
      assert.deepEqual(reconciliationTriggers, [
        createdBody.data.order_id,
        createdBody.data.order_id,
      ]);

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
      const replacementBodyResponse = (await replacement.json()) as {
        data: { order_id: string; payable_amount_cents: number };
      };
      assert.equal(
        replacementBodyResponse.data.payable_amount_cents,
        1_001,
      );
      assert.deepEqual(reconciliationTriggers, [
        createdBody.data.order_id,
        createdBody.data.order_id,
        replacementBodyResponse.data.order_id,
      ]);
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
    const app = createApp({
      config,
      database,
      identity,
      orders,
      startedAt: new Date(0),
      ...readyPaymentRuntime(Date.now()),
    });
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
