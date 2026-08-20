import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const origin = "http://localhost:6190";
const apiSecret = Buffer.alloc(32, 0x72).toString("base64url");

describe("advanced settings HTTP contract", () => {
  it("requires a current revision and persists checkout lifecycle settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-advanced-settings-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.local.invalid/http-advanced-settings",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const elevatedHeaders = await loginHeaders(app);
      const revealed = await app.request(
        "/api/admin/v1/settings/secrets/api_secret/actions/reveal",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({}),
        },
      );
      assert.equal(revealed.status, 200);
      assert.equal(revealed.headers.get("cache-control"), "no-store");
      assert.deepEqual(await revealed.json(), {
        data: { name: "api_secret", value: apiSecret },
      });

      const saved = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 3,
          checkout_key_rotation_days: 30,
          checkout_terminal_observation_seconds: 3_600,
        }),
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.headers.get("cache-control"), "no-store");
      const savedBody = await saved.json() as {
        data: {
          revision: number;
          payment_revision: number;
          advanced: {
            checkout_key_rotation_days: number;
            checkout_terminal_observation_seconds: number;
          };
        };
      };
      assert.equal(savedBody.data.revision, 4);
      assert.equal(savedBody.data.payment_revision, 2);
      assert.deepEqual(savedBody.data.advanced, {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
      });

      const stale = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 3,
          checkout_key_rotation_days: 60,
          checkout_terminal_observation_seconds: 7_200,
        }),
      });
      assert.equal(stale.status, 409);
      assert.equal(
        (await stale.json() as { error: { code: string } }).error.code,
        "settings_revision_conflict",
      );

      const invalid = await app.request("/api/admin/v1/settings/advanced", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 4,
          checkout_key_rotation_days: 0,
          checkout_terminal_observation_seconds: 59,
        }),
      });
      assert.equal(invalid.status, 422);
      assert.equal(
        (await invalid.json() as { error: { code: string } }).error.code,
        "validation_failed",
      );

      const audit = database.read((connection) => connection.prepare(
        `SELECT details_json FROM audit_events
          WHERE action = 'settings.advanced_updated'`,
      ).get() as { details_json: string });
      assert.deepEqual(JSON.parse(audit.details_json), {
        checkout_key_rotation_days: 30,
        checkout_terminal_observation_seconds: 3_600,
        payment_revision_changed: false,
        revision: 4,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("provider application key HTTP contract", () => {
  it("generates the initial application key without returning the private key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-provider-key-"));
    const config = loadConfig({
      PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4),
      PERPAY_DATA_DIR: join(directory, "data"),
      PERPAY_BACKUP_DIR: join(directory, "backups"),
      PERPAY_PUBLIC_URL: origin,
    });
    const database = await AppDatabase.open(config.databasePath);
    const identity = new IdentityService(database);
    await identity.initialize();
    await identity.setupAdmin(HTTP_TEST_ADMIN_PASSWORD);
    const settings = new RuntimeSettingsService({
      store: new RuntimeSettingsStore(database, config.masterKey),
    });
    settings.initialize();
    const orders = new OrderService(database, () => settings.snapshot());
    orders.initialize();
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const unauthenticated = await app.request(
        "/api/admin/v1/settings/provider/application-key/actions/generate",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(unauthenticated.status, 401);

      const login = await loginOnly(app);
      const elevatedHeaders = login.headers;
      const generated = await app.request(
        "/api/admin/v1/settings/provider/application-key/actions/generate",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(generated.status, 201);
      assert.equal(generated.headers.get("cache-control"), "no-store");
      const body = await generated.json() as {
        data: {
          settings: {
            revision: number;
            payment_revision: number;
            application_public_key: string;
            application_key_fingerprint: string;
          };
          created: boolean;
          public_key: string;
          fingerprint: string;
        };
      };
      assert.equal(body.data.created, true);
      assert.equal(body.data.settings.revision, 1);
      assert.equal(body.data.settings.payment_revision, 0);
      assert.equal(body.data.settings.application_public_key, body.data.public_key);
      assert.equal(body.data.settings.application_key_fingerprint, body.data.fingerprint);
      assert.equal(JSON.stringify(body).includes("PRIVATE KEY"), false);
      assert.equal(JSON.stringify(body).includes("BEGIN RSA"), false);

      const settingsResponse = await app.request("/api/admin/v1/settings", {
        headers: { cookie: elevatedHeaders.cookie },
      });
      assert.equal(settingsResponse.status, 200);
      const settingsBody = await settingsResponse.json() as {
        data: { application_public_key: string; application_key_fingerprint: string };
      };
      assert.equal(settingsBody.data.application_public_key, body.data.public_key);
      assert.equal(settingsBody.data.application_key_fingerprint, body.data.fingerprint);

      const repeated = await app.request(
        "/api/admin/v1/settings/provider/application-key/actions/generate",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(repeated.status, 200);
      const repeatedBody = await repeated.json() as typeof body;
      assert.equal(repeatedBody.data.created, false);
      assert.equal(repeatedBody.data.settings.revision, 1);
      assert.equal(repeatedBody.data.public_key, body.data.public_key);
      assert.equal(repeatedBody.data.fingerprint, body.data.fingerprint);

      const future = await app.request(
        "/api/admin/v1/settings/provider/application-key/actions/generate",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 2 }),
        },
      );
      assert.equal(future.status, 409);
      assert.equal(
        (await future.json() as { error: { code: string } }).error.code,
        "settings_revision_conflict",
      );
      assert.equal(database.read((connection) => Number((connection.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'settings.provider_application_key_generated'`,
      ).get() as { count: bigint | number }).count)), 1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects regeneration after a provider application is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-active-provider-key-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.local.invalid/http-active-provider-key",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const elevatedHeaders = await loginHeaders(app);
      const response = await app.request(
        "/api/admin/v1/settings/provider/application-key/actions/generate",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 3 }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json() as { error: { code: string } }).error.code,
        "provider_application_key_rotation_not_supported",
      );

      const replacementPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const update = await app.request("/api/admin/v1/settings/provider", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          revision: 3,
          environment: "PRODUCTION",
          app_id: "2026000000000001",
          private_key: replacementPrivateKey,
          timeout_milliseconds: 8_000,
          scan_interval_seconds: 10,
          safety_lag_seconds: 10,
          maximum_success_age_seconds: 60,
        }),
      });
      assert.equal(update.status, 409);
      assert.equal(
        (await update.json() as { error: { code: string } }).error.code,
        "provider_application_key_rotation_not_supported",
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function loginHeaders(app: ReturnType<typeof createApp>): Promise<Record<string, string>> {
  const login = await loginOnly(app);
  return login.headers;
}

async function loginOnly(app: ReturnType<typeof createApp>): Promise<{
  readonly headers: Record<string, string>;
  readonly cookie: string;
  readonly csrfToken: string;
}> {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrf_token: string } };
  const cookie = response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return {
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      "x-csrf-token": body.data.csrf_token,
    },
    cookie,
    csrfToken: body.data.csrf_token,
  };
}
