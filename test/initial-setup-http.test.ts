import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { AUTH_FAILURE_THRESHOLD } from "../src/database/identity-store.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";

const PUBLIC_ORIGIN = "http://localhost:6190";
const MASTER_KEY = "0123456789abcdef".repeat(4);
const ADMIN_PASSWORD = "first-run-admin-password";

describe("first-run administrator HTTP flow", () => {
  for (const [token, status, code] of [
    [undefined, 422, "validation_failed"],
    ["wrong-setup-token", 403, "setup_token_invalid"],
    ["0".repeat(64), 403, "setup_token_invalid"],
  ] as const) {
    it(`rejects a ${token === undefined ? "missing" : token.length === 64 ? "wrong" : "malformed"} setup token before creating an administrator`, async () => {
      const fixture = await createFixture();
      try {
        const response = await fixture.app.request("/api/admin/v1/setup", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: token }),
        });
        assert.equal(response.status, status);
        assert.equal((await response.json() as { error: { code: string } }).error.code, code);
        assert.equal(fixture.identity.isInitialized(), false);
        assert.equal(fixture.identity.store.read((transaction) =>
          transaction.authLimit(fixture.identity.sourceHash("unknown"))), undefined);
      } finally {
        fixture.close();
      }
    });
  }

  it("issues a token only to the startup callback and rotates it when an uninitialized app restarts", async () => {
    const fixture = await createFixture();
    try {
      assert.equal(fixture.issuedTokens.length, 1);
      const firstToken = fixture.issuedTokens[0]!;
      assert.match(firstToken, /^[0-9a-f]{64}$/);
      for (const path of ["/admin/", "/admin/setup", "/healthz", "/readyz"]) {
        const response = await fixture.app.request(path);
        assert.equal((await response.text()).includes(firstToken), false, path);
      }
      assert.equal(fixture.issuedTokens.length, 1);
      const restarted = fixture.recreateApp();
      const nextToken = fixture.issuedTokens[1]!;
      assert.match(nextToken, /^[0-9a-f]{64}$/);
      assert.notEqual(nextToken, firstToken);
      const stale = await restarted.request("/api/admin/v1/setup", {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: firstToken }),
      });
      assert.equal(stale.status, 403);
      const failureText = await stale.text();
      assert.equal(failureText.includes(firstToken), false);
      assert.equal(failureText.includes(nextToken), false);
      const setup = await restarted.request("/api/admin/v1/setup", {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: nextToken }),
      });
      assert.equal(setup.status, 204);
      assert.deepEqual(setup.headers.getSetCookie(), []);
      const initialized = fixture.recreateApp();
      assert.equal(fixture.issuedTokens.length, 2, "initialized startup must not issue a token");
      for (const token of [firstToken, nextToken, undefined]) {
        const response = await initialized.request("/api/admin/v1/setup", {
          method: "POST", headers: jsonHeaders(),
          body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: token }),
        });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "identity_already_initialized");
      }
    } finally {
      fixture.close();
    }
  });

  for (const [name, password, replacement] of [
    ["ASCII", "aB3!xY", "bC4!yZ"],
    ["Unicode code point", "🔐".repeat(6), "密".repeat(6)],
  ] as const) {
    it(`accepts six ${name} characters for setup and password changes but rejects five`, async () => {
      const fixture = await createFixture();
      try {
        const short = Array.from(password).slice(0, 5).join("");
        const invalidSetup = await fixture.app.request("/api/admin/v1/setup", {
          method: "POST", headers: jsonHeaders(), body: JSON.stringify({ password: short, setup_token: fixture.setupToken }),
        });
        assert.equal(invalidSetup.status, 422);
        const setup = await fixture.app.request("/api/admin/v1/setup", {
          method: "POST", headers: jsonHeaders(), body: JSON.stringify({ password, setup_token: fixture.setupToken }),
        });
        assert.equal(setup.status, 204);
        assert.deepEqual(setup.headers.getSetCookie(), []);
        const login = await fixture.app.request("/api/admin/v1/session/login", {
          method: "POST", headers: jsonHeaders(), body: JSON.stringify({ password }),
        });
        assert.equal(login.status, 200);
        const body = await login.json() as { data: { csrf_token: string } };
        const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
        const headers = { ...jsonHeaders(), cookie, "x-csrf-token": body.data.csrf_token };
        const invalidChange = await fixture.app.request("/api/admin/v1/password", {
          method: "POST", headers, body: JSON.stringify({ new_password: short }),
        });
        assert.equal(invalidChange.status, 422);
        assert.equal((await fixture.app.request("/api/admin/v1/session", { headers: { cookie } })).status, 200);
        const change = await fixture.app.request("/api/admin/v1/password", {
          method: "POST", headers, body: JSON.stringify({ new_password: replacement }),
        });
        assert.equal(change.status, 204);
        assert.equal((await fixture.app.request("/api/admin/v1/session", { headers: { cookie } })).status, 401);
        const nextLogin = await fixture.app.request("/api/admin/v1/session/login", {
          method: "POST", headers: jsonHeaders(), body: JSON.stringify({ password: replacement }),
        });
        assert.equal(nextLogin.status, 200);
      } finally {
        fixture.close();
      }
    });
  }

  it("sets the password directly, creates no session, and permanently closes setup", async () => {
    const fixture = await createFixture();
    try {
      const root = await fixture.app.request("/");
      assert.equal(root.status, 302);
      assert.equal(root.headers.get("location"), "/admin/");
      const canonical = await fixture.app.request("/admin");
      assert.equal(canonical.status, 308);
      assert.equal(canonical.headers.get("location"), "/admin/");

      for (const path of ["/admin/", "/admin/login", "/admin/setup"]) {
        const page = await fixture.app.request(path);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("cache-control"), "no-store");
        assert.match(await page.text(), /name="perpay-initialized" content="false"/);
      }

      const unexpectedField = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken, code: "not-used" }),
      });
      assert.equal(unexpectedField.status, 422);

      const tooShortUnicodePassword = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: "🔐".repeat(5), setup_token: fixture.setupToken }),
      });
      assert.equal(tooShortUnicodePassword.status, 422);
      assert.equal(
        ((await tooShortUnicodePassword.json()) as { error: { code: string } }).error.code,
        "validation_failed",
      );

      const setup = await fixture.app.request("/api/admin/v1/setup", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken }),
      });
      assert.equal(setup.status, 204);
      assert.deepEqual(setup.headers.getSetCookie(), []);

      for (const path of ["/admin/", "/admin/login", "/admin/setup"]) {
        const page = await fixture.app.request(path);
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("cache-control"), "no-store");
        assert.match(await page.text(), /name="perpay-initialized" content="true"/);
      }

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
          body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken }),
        }),
        fixture.app.request("/api/admin/v1/setup", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ password: "competing-first-run-password", setup_token: fixture.setupToken }),
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

  it("keeps the same token usable after the administrator transaction rolls back", async () => {
    const fixture = await createFixture();
    try {
      fixture.database.write((connection) => connection.exec(`
        CREATE TRIGGER injected_retryable_setup_failure
        BEFORE INSERT ON admin_identity
        BEGIN
          SELECT RAISE(ABORT, 'injected retryable setup failure');
        END;
      `));
      const request = {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken }),
      };
      assert.equal((await fixture.app.request("/api/admin/v1/setup", request)).status, 500);
      assert.equal(fixture.identity.isInitialized(), false);
      fixture.database.write((connection) => connection.exec("DROP TRIGGER injected_retryable_setup_failure"));
      const retried = await fixture.app.request("/api/admin/v1/setup", request);
      assert.equal(retried.status, 204);
      assert.deepEqual(retried.headers.getSetCookie(), []);
      assert.equal((await fixture.app.request("/api/admin/v1/setup", request)).status, 409);
      assert.equal(fixture.issuedTokens.length, 1, "retry must not issue a replacement token");
      const audit = fixture.database.read((connection) => connection.prepare(
        "SELECT details_json FROM audit_events WHERE action = 'admin.initialized'",
      ).all());
      assert.equal(JSON.stringify(audit).includes(fixture.setupToken), false);
    } finally {
      fixture.database.write((connection) => connection.exec("DROP TRIGGER IF EXISTS injected_retryable_setup_failure"));
      fixture.close();
    }
  });

  it("rate limits setup from persisted source attempts before password hashing", async () => {
    const now = Date.UTC(2026, 0, 1);
    const fixture = await createFixture(() => now);
    const sourceHash = fixture.identity.sourceHash("unknown");
    try {
      // Keep seeded attempts before the request clock; future timestamps are already blocked.
      const seededAt = now - AUTH_FAILURE_THRESHOLD;
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
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken }),
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
        body: JSON.stringify({ password: ADMIN_PASSWORD, setup_token: fixture.setupToken }),
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

async function createFixture(clock: () => number = Date.now) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-initial-setup-http-"));
  const config = loadConfig({
    PERPAY_MASTER_KEY: MASTER_KEY,
    PERPAY_DATA_DIR: join(directory, "data"),
    PERPAY_BACKUP_DIR: join(directory, "backups"),
    PERPAY_PUBLIC_URL: PUBLIC_ORIGIN,
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, clock);
  await identity.initialize();
  const settings = new RuntimeSettingsService({
    store: new RuntimeSettingsStore(database, config.masterKey),
  });
  settings.initialize();
  const orders = new OrderService(database, () => settings.instanceSnapshot());
  const issuedTokens: string[] = [];
  const recreateApp = () => createApp({
    config,
    database,
    identity,
    settings,
    orders,
    startedAt: new Date(0),
    onSetupToken: (token: string) => issuedTokens.push(token),
  });
  const app = recreateApp();
  return {
    app,
    issuedTokens,
    recreateApp,
    setupToken: issuedTokens[0]!,
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
