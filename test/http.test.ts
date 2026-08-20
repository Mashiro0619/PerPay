import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { WEB_ASSET_URLS } from "../src/http/web/assets.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const apiSecret = Buffer.alloc(32, 7).toString("base64url");
const collectionCodePayload = "https://qr.alipay.com/fkx-test-code-2026";

describe("health endpoints", () => {
  it("separates application health from payment readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
    });
    const collectionNow = 1_700_000_005_000;
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const health = await app.request("/healthz");
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as {
        status: string;
        database: { ok: boolean; result: string };
      };
      assert.equal(healthBody.status, "healthy");
      assert.deepEqual(healthBody.database, { ok: true, result: "ok" });

      const ready = await app.request("/readyz");
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), {
        status: "not_ready",
        code: "reconciliation_not_ready",
      });

      const firstScanPending = createApp({
        config,
        database,
        identity,
        settings,
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
        settings,
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
      assert.deepEqual(await degradedReady.json(), { status: "degraded", code: null });

      const collectionRetryRunning = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "running",
          inFlight: true,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - 10_000,
          lastErrorCode: "remote_authorization_failed",
          consecutiveFailures: 1,
        }),
      });
      const collectionRetryReady = await collectionRetryRunning.request("/readyz");
      assert.equal(collectionRetryReady.status, 200);
      assert.deepEqual(await collectionRetryReady.json(), { status: "degraded", code: null });

      const catchingUp = createApp({
        config,
        database,
        identity,
        settings,
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
      assert.deepEqual(await catchingUpReady.json(), { status: "degraded", code: null });

      const exactFreshnessBoundary = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "healthy",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt:
            collectionNow - settings.snapshot().provider!.maximumSuccessAgeMilliseconds,
          lastErrorCode: null,
          consecutiveFailures: 0,
        }),
      });
      const exactBoundaryReady = await exactFreshnessBoundary.request("/readyz");
      assert.equal(exactBoundaryReady.status, 200);
      assert.deepEqual(await exactBoundaryReady.json(), { status: "ready", code: null });

      const futureSuccess = createApp({
        config,
        database,
        identity,
        settings,
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
      assert.deepEqual(await futureSuccessReady.json(), {
        status: "not_ready",
        code: "reconciliation_not_ready",
      });

      const stale = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        ledgerHealth: () => ({
          enabled: true,
          state: "degraded",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt:
            collectionNow - settings.snapshot().provider!.maximumSuccessAgeMilliseconds - 1,
          lastErrorCode: "remote_authorization_failed",
          consecutiveFailures: 4,
        }),
      });
      const staleReady = await stale.request("/readyz");
      assert.equal(staleReady.status, 503);
      assert.deepEqual(await staleReady.json(), {
        status: "not_ready",
        code: "reconciliation_not_ready",
      });

      const reconciliationDegraded = createApp({
        config,
        database,
        identity,
        settings,
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

      const reconciliationRetryRunning = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        reconciliationHealth: () => ({
          enabled: true,
          state: "running",
          inFlight: true,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - 10_000,
          lastErrorCode: "reconciliation_item_failed",
          consecutiveFailures: 1,
          pendingOrders: 1,
          continuationPending: true,
        }),
      });
      const reconciliationRetryReady = await reconciliationRetryRunning.request("/readyz");
      assert.equal(reconciliationRetryReady.status, 200);
      assert.deepEqual(await reconciliationRetryReady.json(), { status: "degraded", code: null });

      const webhookRetryRunning = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        webhookHealth: () => ({
          enabled: true,
          state: "running",
          inFlight: true,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow - 10_000,
          lastErrorCode: "delivery_network_error",
          consecutiveFailures: 1,
          pendingDeliveries: 1,
          deadLetters: 0,
        }),
      });
      const webhookRetryReady = await webhookRetryRunning.request("/readyz");
      assert.equal(webhookRetryReady.status, 200);
      assert.deepEqual(await webhookRetryReady.json(), { status: "degraded", code: null });

      const webhookStopped = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        webhookHealth: () => ({
          enabled: true,
          state: "stopped",
          inFlight: false,
          lastAttemptAt: collectionNow,
          lastSuccessAt: collectionNow,
          lastErrorCode: null,
          consecutiveFailures: 0,
          pendingDeliveries: 0,
          deadLetters: 0,
        }),
      });
      const webhookStoppedReady = await webhookStopped.request("/readyz");
      assert.equal(webhookStoppedReady.status, 200);
      assert.deepEqual(await webhookStoppedReady.json(), { status: "degraded", code: null });

      const backupUnhealthy = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        backupHealth: async () => {
          await Promise.resolve();
          return {
            ok: true,
            status: "healthy",
            last_attempt_at: collectionNow,
            last_success_at: collectionNow,
            last_error_at: null,
            last_error_stage: null,
            backup_name:
              "perpay.sqlite3.backup-2026-08-16T04-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3",
            backup_sha256: "a".repeat(64),
            backup_size_bytes: 4096,
            instance_id: "f".repeat(32),
            schema_version: 13,
            interval_milliseconds: 86_400_000,
            keep_count: 7,
            retained_count: 7,
          maximum_age_milliseconds: 95_040_000,
          backup_required: false,
          backup_in_progress: false,
          backup_available: true,
            recovery_required: false,
            clock_moved_backwards: false,
            configuration_mismatch: false,
          };
        },
      });
      const backupReady = await backupUnhealthy.request("/readyz");
      assert.equal(backupReady.status, 200);
      assert.deepEqual(await backupReady.json(), { status: "ready", code: null });

      const backupLogin = await backupUnhealthy.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: config.publicOrigin,
        },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
      });
      assert.equal(backupLogin.status, 200);
      const backupCookie = backupLogin.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const webhookStoppedStatus = await webhookStopped.request("/api/admin/v1/system/status", {
        headers: { cookie: backupCookie },
      });
      assert.equal(webhookStoppedStatus.status, 200);
      const webhookStoppedStatusBody = (await webhookStoppedStatus.json()) as {
        data: { status: string; webhook: { state: string } };
      };
      assert.equal(webhookStoppedStatusBody.data.status, "degraded");
      assert.equal(webhookStoppedStatusBody.data.webhook.state, "stopped");

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
        settings,
        orders,
        startedAt: new Date(0),
        clock: () => collectionNow,
        ...readyPaymentRuntime(collectionNow),
        async backupHealth() {
          await Promise.resolve();
          throw new Error("backup state is unreadable");
        },
      });
      const unavailableReady = await backupUnavailable.request("/readyz");
      assert.equal(unavailableReady.status, 200);
      assert.deepEqual(await unavailableReady.json(), { status: "ready", code: null });
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
        backup_sha256: null,
        backup_size_bytes: null,
        instance_id: null,
        schema_version: null,
        interval_milliseconds: null,
        keep_count: null,
        retained_count: null,
        maximum_age_milliseconds: null,
        backup_required: false,
        backup_in_progress: false,
        backup_available: false,
        recovery_required: false,
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
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "http://localhost:6190",
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const missingOrigin = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
      });
      assert.equal(missingOrigin.status, 403);

      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
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
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: sessionCookie.split(";", 1)[0],
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: "{}",
      });
      assert.equal(headerWithoutCsrfCookie.status, 403);

      const noCsrf = await app.request("/api/admin/v1/session/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie,
        },
        body: "{}",
      });
      assert.equal(noCsrf.status, 403);
      assert.equal((await noCsrf.json() as { error: { code: string } }).error.code, "csrf_invalid");

      const logout = await app.request("/api/admin/v1/session/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: "{}",
      });
      assert.equal(logout.status, 204);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 and passwords over the byte limit before password work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-validation-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "http://localhost:6190",
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const invalidUtf8 = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
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
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: "密".repeat(342) }),
      });
      assert.equal(oversizedPassword.status, 422);

      const malformedExistingPassword = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: "malformed-\ud800-password" }),
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
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { data: { csrf_token: string } };
      const cookie = login.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const authenticatedHeaders = {
        "content-type": "application/json",
        origin: "http://localhost:6190",
        cookie,
        "x-csrf-token": loginBody.data.csrf_token,
      };
      const malformedNewPassword = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
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

  it("removes step-up and changes the password from an authenticated session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-password-change-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "http://localhost:6190",
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { data: { csrf_token: string } };
      const loginCookie = login.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");

      const removedStepUp = await app.request("/api/admin/v1/session/step-up", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: JSON.stringify({ password: "a-secure-local-password" }),
      });
      assert.equal(removedStepUp.status, 404);
      assert.equal(
        (await removedStepUp.json() as { error: { code: string } }).error.code,
        "route_not_found",
      );

      const sessionResponse = await app.request("/api/admin/v1/session", {
        headers: { cookie: loginCookie },
      });
      assert.equal(sessionResponse.status, 200);
      const sessionBody = await sessionResponse.json() as { data: Record<string, unknown> };
      assert.equal(Object.hasOwn(sessionBody.data, "step_up_active"), false);

      const passwordRequestBody = JSON.stringify({ new_password: "next-secure-local-password" });
      const passwordWithoutOrigin = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: passwordRequestBody,
      });
      assert.equal(passwordWithoutOrigin.status, 403);

      const passwordWithoutCsrf = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: loginCookie,
        },
        body: passwordRequestBody,
      });
      assert.equal(passwordWithoutCsrf.status, 403);
      assert.equal(
        (await passwordWithoutCsrf.json() as { error: { code: string } }).error.code,
        "csrf_invalid",
      );

      const passwordWithoutJson = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "http://localhost:6190",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: passwordRequestBody,
      });
      assert.equal(passwordWithoutJson.status, 415);
      assert.equal(
        (await passwordWithoutJson.json() as { error: { code: string } }).error.code,
        "unsupported_media_type",
      );

      const identityBefore = identity.store.read((transaction) => transaction.adminIdentity());
      const auditBefore = identity.store.read((transaction) => transaction.auditEvents());
      const unchanged = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: JSON.stringify({
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

      const changed = await app.request("/api/admin/v1/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: loginCookie,
          "x-csrf-token": loginBody.data.csrf_token,
        },
        body: JSON.stringify({ new_password: "next-secure-local-password" }),
      });
      assert.equal(changed.status, 204);
      assert.ok(changed.headers.getSetCookie().length >= 2);
      assert.equal(
        (await app.request("/api/admin/v1/session", { headers: { cookie: loginCookie } })).status,
        401,
      );

      const replacementLogin = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
        },
        body: JSON.stringify({ password: "next-secure-local-password" }),
      });
      assert.equal(replacementLogin.status, 200);
      const replacementBody = await replacementLogin.json() as { data: { csrf_token: string } };
      const replacementCookie = replacementLogin.headers.getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const revoked = await app.request("/api/admin/v1/sessions/revoke-all", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:6190",
          cookie: replacementCookie,
          "x-csrf-token": replacementBody.data.csrf_token,
        },
        body: "{}",
      });
      assert.equal(revoked.status, 200);
      assert.equal(
        (await revoked.json() as { data: { revoked_sessions: number } }).data.revoked_sessions,
        1,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses __Host cookies and HSTS for an HTTPS public origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-secure-cookie-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "https://pay.local",
      environment: { PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1" },
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const login = await app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://pay.local",
        },
        body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
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
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "http://localhost:6190",
    });
    const signedBackupHealth = Object.freeze({
      ok: true,
      status: "healthy" as const,
      last_attempt_at: 1_700_000_000_000,
      last_success_at: 1_700_000_000_000,
      last_error_at: null,
      last_error_stage: null,
      backup_name:
        "perpay.sqlite3.backup-2026-08-16T04-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3",
      backup_sha256: "a".repeat(64),
      backup_size_bytes: 4096,
      instance_id: database.instanceId(),
      schema_version: 13,
      interval_milliseconds: 86_400_000,
      keep_count: 7,
      retained_count: 7,
      maximum_age_milliseconds: 95_040_000,
      backup_required: false,
      backup_in_progress: false,
      backup_available: true,
      recovery_required: false,
      clock_moved_backwards: false,
      configuration_mismatch: false,
    });
    const app = createApp({
      config,
      database,
      identity,
      settings,
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
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
    });
    const requestBody = Buffer.from(JSON.stringify({
      idempotency_key: "first-scan-gate",
      merchant_order_no: "first-scan-gate",
      amount_cents: 1_000,
      product_name: "first-scan-gate",
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
        settings,
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
        "reconciliation_not_ready",
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
        settings,
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
        data: { checkout: { checkout_url: string; state_url: string } };
      };
      const publicTarget = new URL(createdBody.data.checkout.state_url).pathname;
      const blockedCheckout = await pending.request(publicTarget);
      assert.equal(blockedCheckout.status, 503);
      assert.equal(
        ((await blockedCheckout.json()) as { error: { code: string } }).error.code,
        "reconciliation_not_ready",
      );

      collectionNow += settings.snapshot().provider!.maximumSuccessAgeMilliseconds + 1;
      collectionState = "degraded";
      collectionLastErrorCode = "remote_authorization_failed";
      collectionConsecutiveFailures = 4;
      const staleRequestBody = Buffer.from(JSON.stringify({
        idempotency_key: "stale-scan-gate",
         merchant_order_no: "stale-scan-gate",
         amount_cents: 2_000,
         product_name: "stale-scan-gate",
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
        "reconciliation_not_ready",
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
        product_name: "reconciliation-readiness-gate",
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
      assert.deepEqual(await degradedReady.json(), { status: "degraded", code: null });

      reconciliationState = "stopped";
      const stoppedBody = Buffer.from(JSON.stringify({
        idempotency_key: "reconciliation-stopped-gate",
        merchant_order_no: "reconciliation-stopped-gate",
        amount_cents: 4_000,
        product_name: "reconciliation-stopped-gate",
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

      const terminal = orders.create({
        idempotency_key: "terminal-checkout-readiness",
        merchant_order_no: "terminal-checkout-readiness",
        amount_cents: 5_000,
        product_name: "terminal-checkout-readiness",
      }).order;
      orders.close(terminal.orderId);
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
        collectionNow - settings.snapshot().provider!.maximumSuccessAgeMilliseconds - 1;
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
        const storageHealth = await ready.request("/healthz");
        assert.equal(storageHealth.status, 503);
        const storageHealthBody = await storageHealth.json() as {
          status: string;
          database: { ok: boolean; result: string };
        };
        assert.equal(storageHealthBody.status, "unhealthy");
        assert.deepEqual(storageHealthBody.database, {
          ok: false,
          result: "database_storage_low",
        });

        const storageReady = await ready.request("/readyz");
        assert.equal(storageReady.status, 503);
        assert.deepEqual(await storageReady.json(), {
          status: "not_ready",
          code: "system_not_ready",
        });
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
          product_name: "storage-core-gate",
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
      const unsafeCheckoutPage = await ready.request(
        new URL(createdBody.data.checkout.checkout_url).pathname,
      );
      assert.equal(unsafeCheckoutPage.status, 503);
      assert.match(unsafeCheckoutPage.headers.get("content-type") ?? "", /^text\/html/);
      const unsafeCheckoutHtml = await unsafeCheckoutPage.text();
      assert.match(unsafeCheckoutHtml, /data-initial-state="UNAVAILABLE"/);
      assert.match(unsafeCheckoutHtml, /order_clock_unavailable/);

      const unsafeRequestBody = Buffer.from(JSON.stringify({
        idempotency_key: "unsafe-core-gate",
         merchant_order_no: "unsafe-core-gate",
         amount_cents: 1_000,
         product_name: "unsafe-core-gate",
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
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
      publicUrl: "http://localhost:6190",
    });
    const reconciliationTriggers: string[] = [];
    const app = createApp({
      config,
      database,
      identity,
      settings,
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
          product_name: "HTTP contract",
          note: "内部订单备注",
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
           product_name: string;
           note: string | null;
          requested_amount_cents: number;
          payable_amount_cents: number;
          checkout: { token: string; state_url: string; checkout_url: string; status: string };
        };
      };
      assert.match(createdBody.data.order_id, /^[0-9a-f-]{36}$/);
      assert.equal(createdBody.data.merchant_order_no, "http-order-1");
      assert.equal(createdBody.data.product_name, "HTTP contract");
      assert.equal(createdBody.data.note, "内部订单备注");
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
          product_name: string;
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
      assert.equal(publicBody.data.product_name, "HTTP contract");
      assert.equal(Object.hasOwn(publicBody.data, "note"), false);
      assert.equal(publicBody.data.payment_instructions?.payable_amount_cents, 1_001);
      assert.equal(publicBody.data.checkout.status, "OPEN");

      assert.equal(
        new URL(createdBody.data.checkout.checkout_url).pathname,
        `/checkout/${createdBody.data.checkout.token}`,
      );
      const checkoutPage = await app.request(
        new URL(createdBody.data.checkout.checkout_url).pathname,
      );
      assert.equal(checkoutPage.status, 200);
      assert.match(checkoutPage.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(
        checkoutPage.headers.get("content-security-policy") ?? "",
        /script-src 'self'; style-src-elem 'self' 'nonce-[A-Za-z0-9+/=]+'; style-src-attr 'none'; connect-src 'self'; img-src 'self'/,
      );
      const checkoutHtml = await checkoutPage.text();
      assert.match(checkoutHtml, /data-payable-amount[^>]*>10\.01<\/strong>/);
      assert.ok(checkoutHtml.includes(WEB_ASSET_URLS.checkoutStylesheet));
      assert.match(checkoutHtml, /\/api\/public\/v1\/checkouts\/[^" ]+\/qr\.svg/);
      assert.equal(checkoutHtml.includes(collectionCodePayload), false);
      assert.doesNotMatch(checkoutHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);
      assert.doesNotMatch(checkoutHtml, /\sstyle=/i);

      const qrTarget = `/api/public/v1/checkouts/${createdBody.data.checkout.token}/qr.svg`;
      const qrResponse = await app.request(qrTarget);
      assert.equal(qrResponse.status, 200);
      assert.match(qrResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);
      const qrSvg = await qrResponse.text();
      assert.match(qrSvg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.doesNotMatch(qrSvg, /<script|<foreignObject/i);

      const adminPage = await app.request("/admin");
      assert.equal(adminPage.status, 200);
      const adminHtml = await adminPage.text();
      assert.match(adminHtml, /id="perpay-admin-root" data-mode="application"/);
      assert.ok(adminHtml.includes(WEB_ASSET_URLS.adminScript));
      const adminNonce = /<meta name="csp-nonce" content="([A-Za-z0-9+/=]+)">/.exec(adminHtml)?.[1];
      assert.ok(adminNonce);
      assert.ok(
        adminPage.headers.get("content-security-policy")?.includes(`'nonce-${adminNonce}'`),
      );
      assert.doesNotMatch(adminHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);

      const stylesheet = await app.request(WEB_ASSET_URLS.checkoutStylesheet);
      assert.equal(stylesheet.status, 200);
      assert.equal(stylesheet.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.ok(stylesheet.headers.get("etag"));
      const alipayIcon = await app.request(WEB_ASSET_URLS.alipayIcon);
      assert.equal(alipayIcon.status, 200);
      assert.equal(alipayIcon.headers.get("content-type"), "image/png");
      assert.deepEqual(
        [...new Uint8Array(await alipayIcon.arrayBuffer()).slice(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      const notModified = await app.request(
        WEB_ASSET_URLS.checkoutStylesheet,
        { headers: { "if-none-match": stylesheet.headers.get("etag")! } },
      );
      assert.equal(notModified.status, 304);

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
          product_name: "HTTP contract 2",
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
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload,
    });
    const app = createApp({
      config,
      database,
      identity,
      settings,
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
          product_name: "HTTP conflict",
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
          product_name: "HTTP conflict",
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

      const oversizedCheckoutToken = "x".repeat(513);
      const oversizedCheckoutPage = await app.request(`/checkout/${oversizedCheckoutToken}`);
      assert.equal(oversizedCheckoutPage.status, 404);
      assert.match(oversizedCheckoutPage.headers.get("content-type") ?? "", /^text\/html/);
      const oversizedCheckoutHtml = await oversizedCheckoutPage.text();
      assert.match(oversizedCheckoutHtml, /data-initial-state="NOT_FOUND"/);
      assert.equal(oversizedCheckoutHtml.includes(oversizedCheckoutToken), false);

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
