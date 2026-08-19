import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { AUTH_FAILURE_THRESHOLD } from "../src/database/identity-store.ts";
import { createApp } from "../src/http/app.ts";
import { WEB_ASSET_URLS } from "../src/http/web/assets.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";

const PUBLIC_ORIGIN = "http://localhost:6190";
const MASTER_KEY = "0123456789abcdef".repeat(4);
const ADMIN_PASSWORD = "first-run-admin-password";

describe("first-run administrator HTTP flow", () => {
  it("sets the password directly, creates no session, and permanently closes setup", async () => {
    const fixture = await createFixture();
    try {
      const root = await fixture.app.request("/");
      assert.equal(root.status, 302);
      assert.equal(root.headers.get("location"), "/admin/setup");

      const setupPage = await fixture.app.request("/admin/setup");
      assert.equal(setupPage.status, 200);
      const setupHtml = await setupPage.text();
      assert.match(setupHtml, /id="perpay-admin-root" data-mode="setup"/);
      assert.ok(setupHtml.includes(WEB_ASSET_URLS.adminScript));
      assert.doesNotMatch(setupHtml, /setup-code|setup-token|设置码|验证码/i);

      const unexpectedField = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, code: "not-used" }),
      });
      assert.equal(unexpectedField.status, 422);

      const tooShortUnicodePassword = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: "🔐".repeat(6) }),
      });
      assert.equal(tooShortUnicodePassword.status, 422);
      assert.equal(
        ((await tooShortUnicodePassword.json()) as { error: { code: string } }).error.code,
        "validation_failed",
      );

      const setup = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      assert.equal(setup.status, 204);
      assert.deepEqual(setup.headers.getSetCookie(), []);

      const setupAfterInitialization = await fixture.app.request("/admin/setup");
      assert.equal(setupAfterInitialization.status, 302);
      assert.equal(setupAfterInitialization.headers.get("location"), "/admin/login");

      const repeatedSetup = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: "another-first-run-password" }),
      });
      assert.equal(repeatedSetup.status, 409);
      assert.equal(
        ((await repeatedSetup.json()) as { error: { code: string } }).error.code,
        "identity_already_initialized",
      );

      const loginWithUsername = await fixture.app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
      });
      assert.equal(loginWithUsername.status, 422);

      const login = await fixture.app.request("/api/admin/v1/session/login", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      assert.equal(login.status, 200);
      assert.ok(login.headers.getSetCookie().some((value) => value.startsWith("perpay_session=")));
    } finally {
      fixture.close();
    }
  });

  it("allows only one concurrent setup request to initialize the database", async () => {
    const fixture = await createFixture();
    try {
      const responses = await Promise.all([
        fixture.app.request("/api/admin/v1/setup", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ password: ADMIN_PASSWORD }),
        }),
        fixture.app.request("/api/admin/v1/setup", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ password: "competing-first-run-password" }),
        }),
      ]);
      assert.equal(responses.filter((response) => response.status === 204).length, 1);
      assert.equal(fixture.identity.isInitialized(), true);
      assert.equal(
        fixture.identity.store.read((transaction) =>
          transaction.authLimit(fixture.identity.sourceHash("unknown"))
        )?.failureCount,
        1,
      );
    } finally {
      fixture.close();
    }
  });

  it("rate limits setup from persisted source attempts before password hashing", async () => {
    const fixture = await createFixture();
    const sourceHash = fixture.identity.sourceHash("unknown");
    try {
      const seededAt = Date.now();
      fixture.identity.store.transaction((transaction) => {
        for (let attempt = 1; attempt < AUTH_FAILURE_THRESHOLD; attempt += 1) {
          transaction.recordAuthFailure(sourceHash, seededAt + attempt);
        }
      });
      fixture.database.write((connection) => connection.exec(`
        CREATE TRIGGER injected_http_setup_failure
        BEFORE INSERT ON admin_identity
        BEGIN
          SELECT RAISE(ABORT, 'injected HTTP setup failure');
        END;
      `));

      const failed = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      assert.equal(failed.status, 500);
      assert.equal(fixture.identity.isInitialized(), false);
      assert.equal(
        fixture.identity.store.read((transaction) => transaction.authLimit(sourceHash))?.failureCount,
        AUTH_FAILURE_THRESHOLD,
      );

      fixture.database.write((connection) =>
        connection.exec("DROP TRIGGER injected_http_setup_failure"));
      const limited = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after") !== null, true);
      assert.equal(
        ((await limited.json()) as { error: { code: string } }).error.code,
        "auth_rate_limited",
      );
      assert.equal(fixture.identity.isInitialized(), false);
    } finally {
      fixture.database.write((connection) =>
        connection.exec("DROP TRIGGER IF EXISTS injected_http_setup_failure"));
      fixture.close();
    }
  });
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-initial-setup-http-"));
  const config = loadConfig({
    PERPAY_MASTER_KEY: MASTER_KEY,
    PERPAY_DATA_DIR: join(directory, "data"),
    PERPAY_BACKUP_DIR: join(directory, "backups"),
    PERPAY_PUBLIC_URL: PUBLIC_ORIGIN,
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database);
  await identity.initialize();
  const settings = new RuntimeSettingsService({
    store: new RuntimeSettingsStore(database, config.masterKey),
  });
  settings.initialize();
  const orders = new OrderService(database, () => settings.snapshot());
  const app = createApp({
    config,
    database,
    identity,
    settings,
    orders,
    startedAt: new Date(0),
  });
  return {
    app,
    database,
    identity,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: PUBLIC_ORIGIN,
  };
}
