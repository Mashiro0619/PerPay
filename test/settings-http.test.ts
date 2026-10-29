import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import type { AlipayAccountView } from "../src/alipay-accounts/model.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const origin = "http://localhost:6190";
const apiSecret = Buffer.alloc(32, 0x72).toString("base64url");

function accountUpdate(account: AlipayAccountView) {
  return { revision: account.revision, name: account.name, enabled: account.enabled,
    code_payload: account.code_payload, environment: account.environment, app_id: account.app_id,
    platform_public_key: account.platform_public_key };
}

describe("advanced settings HTTP contract", () => {
  it("separates instance readiness from API authentication when no credential exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-no-api-credential-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/no-api", publicUrl: origin,
    });
    try {
      const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
      assert.equal(settings.instanceView().completion.complete, true);
      assert.equal(settings.instanceView().completion.sites, true);
      assert.equal(settings.instanceView().completion.next_step, null);
      const headers = await loginHeaders(app);
      const response = await app.request("/api/admin/v1/system/status", { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { data: { configured: boolean } }).data.configured, true);
      const business = await app.request("/api/v1/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(business.status, 401);
      assert.equal((await business.json() as { error: { code: string } }).error.code, "api_authentication_failed");
      assert.equal((await app.request("/api/admin/v1/settings")).status, 401);
      assert.equal(settings.siteStore()!.credential("default"), null);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-no-api-credential-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("requires a current revision and persists checkout lifecycle settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-advanced-settings-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.alipay.com/http-advanced-settings",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const elevatedHeaders = await loginHeaders(app);
      const revealed = await app.request(
        "/api/admin/v1/sites/default/secrets/api_secret/actions/view",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({}),
        },
      );
      assert.equal(revealed.status, 200);
      assert.equal(revealed.headers.get("cache-control"), "no-store");
      assert.deepEqual(await revealed.json(), {
        data: { secret: apiSecret },
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

describe("backup settings HTTP contract", () => {
  it("persists the administrator-controlled backup policy without changing payment revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-backup-settings-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.alipay.com/http-backup-settings",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const headers = await loginHeaders(app);
      const response = await app.request("/api/admin/v1/settings/backup", {
        method: "PUT",
        headers,
        body: JSON.stringify({ revision: 3, interval_seconds: 7_200, keep_count: 14 }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { revision: number; payment_revision: number; backup: { interval_seconds: number; keep_count: number } } };
      assert.equal(body.data.revision, 4);
      assert.equal(body.data.payment_revision, 2);
      assert.deepEqual(body.data.backup, { interval_seconds: 7_200, keep_count: 14 });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("adaptive scan settings HTTP contract", () => {
  it("round-trips isolated collection intervals and rejects incomplete mixed-era requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-adaptive-settings-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/adaptive-settings", publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const headers = await loginHeaders(app);
      const original = settings.instanceView();
      const provider = original.collection_policy;
      const update = (body: unknown) => app.request("/api/admin/v1/settings/collection-policy", {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      for (const invalid of [4, 31, 3601, 5.5]) {
        const response = await update({ ...provider, revision: original.revision, scan_interval_seconds: 30, active_scan_interval_seconds: invalid });
        assert.equal(response.status, 422);
        const body = await response.json() as { error: { fields: Record<string, string> } };
        assert.ok(body.error.fields.active_scan_interval_seconds);
      }
      assert.deepEqual(settings.instanceView(), original);
      const saved = await update({ ...provider, revision: original.revision, scan_interval_seconds: 30, active_scan_interval_seconds: 5, minimum_scan_interval_seconds: 5 });
      assert.equal(saved.status, 200);
      const body = await saved.json() as { data: { revision: number; collection_policy: { scan_interval_seconds: number; active_scan_interval_seconds: number } } };
      assert.equal(body.data.collection_policy.scan_interval_seconds, 30);
      assert.equal(body.data.collection_policy.active_scan_interval_seconds, 5);
      assert.equal(settings.instanceView().collection_policy.minimum_scan_interval_seconds, 5);
      const { active_scan_interval_seconds: _active, minimum_scan_interval_seconds: _minimum, ...legacy } = provider;
      const restored = await update({ ...legacy, revision: body.data.revision, scan_interval_seconds: 10 });
      assert.equal(restored.status, 422);
      assert.equal(settings.instanceView().collection_policy.active_scan_interval_seconds, 5);
      assert.equal(settings.instanceView().collection_policy.minimum_scan_interval_seconds, 5);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-http-adaptive-settings-")));
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
    const database = await AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
    const identity = new IdentityService(database);
    await identity.initialize();
    await identity.setupAdmin(HTTP_TEST_ADMIN_PASSWORD);
    const settings = new RuntimeSettingsService({
      store: new RuntimeSettingsStore(database, config.masterKey),
    });
    settings.initialize();
    const orders = new OrderService(database, () => settings.instanceSnapshot());
    orders.initialize();
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const unauthenticated = await app.request(
        "/api/admin/v1/alipay-accounts/draft/application-key",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(unauthenticated.status, 401);

      const login = await loginOnly(app);
      const elevatedHeaders = login.headers;
      const created = await app.request("/api/admin/v1/alipay-accounts", {
        method: "POST", headers: elevatedHeaders, body: JSON.stringify({ name: "首次接入账号" }),
      });
      assert.equal(created.status, 201);
      const account = (await created.json() as { data: AlipayAccountView }).data;
      const keyPath = "/api/admin/v1/alipay-accounts/" + account.id + "/application-key";
      const generated = await app.request(
        keyPath,
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(generated.status, 200);
      assert.equal(generated.headers.get("cache-control"), "no-store");
      const body = await generated.json() as { data: AlipayAccountView };
      assert.equal(body.data.id, account.id);
      assert.equal(body.data.revision, 1);
      assert.equal(body.data.configured, false);
      assert.ok(body.data.application_public_key);
      assert.match(body.data.application_key_fingerprint!, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(body).includes("PRIVATE KEY"), false);
      assert.equal(JSON.stringify(body).includes("BEGIN RSA"), false);

      const settingsResponse = await app.request("/api/admin/v1/alipay-accounts/" + account.id, {
        headers: { cookie: elevatedHeaders.cookie },
      });
      assert.equal(settingsResponse.status, 200);
      const settingsBody = await settingsResponse.json() as {
        data: { application_public_key: string; application_key_fingerprint: string };
      };
      assert.equal(settingsBody.data.application_public_key, body.data.application_public_key);
      assert.equal(settingsBody.data.application_key_fingerprint, body.data.application_key_fingerprint);

      const repeated = await app.request(
        keyPath,
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 0 }),
        },
      );
      assert.equal(repeated.status, 409);
      assert.equal((await repeated.json() as { error: { code: string } }).error.code, "alipay_account_revision_conflict");
      assert.equal(settings.accountService()!.get(account.id).application_public_key, body.data.application_public_key);
      const existing = await app.request(keyPath, { method: "POST", headers: elevatedHeaders, body: JSON.stringify({ revision: 1 }) });
      assert.equal(existing.status, 409);
      assert.equal((await existing.json() as { error: { code: string } }).error.code, "provider_application_key_change_conflict");
      assert.equal(settings.accountService()!.get(account.id).application_key_fingerprint, body.data.application_key_fingerprint);

      const future = await app.request(
        keyPath,
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: 2 }),
        },
      );
      assert.equal(future.status, 409);
      assert.equal(
        (await future.json() as { error: { code: string } }).error.code,
        "alipay_account_revision_conflict",
      );
      assert.equal(database.read((connection) => Number((connection.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'alipay_account.application_key_generated'`,
      ).get() as { count: bigint | number }).count)), 1);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects initial key generation and direct private-key replacement after an account is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-active-provider-key-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory,
      apiSecret,
      collectionCodePayload: "https://qr.alipay.com/http-active-provider-key",
      publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const elevatedHeaders = await loginHeaders(app);
      const account = settings.accountService()!.get("default");
      const response = await app.request(
        "/api/admin/v1/alipay-accounts/default/application-key",
        {
          method: "POST",
          headers: elevatedHeaders,
          body: JSON.stringify({ revision: account.revision }),
        },
      );
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json() as { error: { code: string } }).error.code,
        "provider_application_key_change_conflict",
      );

      const replacementPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const update = await app.request("/api/admin/v1/alipay-accounts/default", {
        method: "PUT",
        headers: elevatedHeaders,
        body: JSON.stringify({
          ...accountUpdate(account),
          private_key: replacementPrivateKey,
        }),
      });
      assert.equal(update.status, 409);
      assert.equal(
        (await update.json() as { error: { code: string } }).error.code,
        "provider_application_key_rotation_not_supported",
      );
      assert.deepEqual(settings.accountService()!.get("default"), account);
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


describe("actionable collection configuration errors", () => {
  it("rejects non-Alipay content and locates invalid provider keys without losing saved configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-field-validation-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({ directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/field-validation-test", publicUrl: origin });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const headers = await loginHeaders(app);
      const original = settings.accountService()!.get("default");
      const invalid = await app.request("/api/admin/v1/alipay-accounts/default", { method: "PUT", headers, body: JSON.stringify({ ...accountUpdate(original), code_payload: "not-a-payment-code" }) });
      assert.equal(invalid.status, 422);
      assert.ok((await invalid.json() as { error: { fields: Record<string, string> } }).error.fields.code_payload);
      for (const platform_public_key of ["invalid-secret-key-test", original.application_public_key!]) {
        const response = await app.request("/api/admin/v1/alipay-accounts/default", { method: "PUT", headers, body: JSON.stringify({ ...accountUpdate(original), platform_public_key }) });
        assert.equal(response.status, 422);
        const body = await response.json() as { error: { code: string; message: string; fields: Record<string, string> } };
        assert.equal(body.error.code, "settings_validation_failed");
        assert.match(body.error.fields.platform_public_key!, /支付宝.*公钥/);
        assert.equal(JSON.stringify(body).includes(platform_public_key), false);
      }
      assert.deepEqual(settings.accountService()!.get("default"), original);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-field-validation-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("marks a legacy invalid payload incomplete but keeps it visible for correction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-legacy-code-"));
    const { database, settings, config, identity, orders } = await createConfiguredHttpServices({ directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/legacy-test", publicUrl: origin });
    try {
      database.write(connection => connection.prepare("UPDATE alipay_accounts SET code_payload = 'not-a-payment-code', revision = revision + 1 WHERE account_id = 'default'").run());
      const account = settings.accountService()!.get("default");
      assert.equal(account.configured, false);
      assert.equal(account.code_payload, "not-a-payment-code");
      const view = settings.instanceView();
      assert.equal(view.completion.collection, false); assert.equal(view.completion.complete, false);
      assert.equal(view.collection?.code_payload, "not-a-payment-code");
      const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
      const response = await app.request("/readyz"); assert.equal(response.status, 503);
    } finally {
      database.close(); assert.ok(directory.startsWith(join(tmpdir(), "perpay-legacy-code-"))); rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe("saved Alipay public key visibility", () => {
  it("returns the full public key only to administrators, preserves it on reads and keeps private secrets hidden", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-public-key-visibility-"));
    const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
      directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/public-key-visibility", publicUrl: origin,
    });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(0) });
    try {
      const before = settings.accountService()!.get("default");
      const snapshot = settings.accountService()!.store().snapshot("default");
      const anonymous = await app.request("/api/admin/v1/alipay-accounts/default");
      assert.equal(anonymous.status, 401);
      assert.equal((await anonymous.text()).includes(snapshot.provider!.publicKeyPem), false);
      const headers = await loginHeaders(app);
      for (let index = 0; index < 2; index++) {
        const response = await app.request("/api/admin/v1/alipay-accounts/default", { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const { data } = await response.json() as { data: AlipayAccountView };
        assert.equal(data.platform_public_key, snapshot.provider!.publicKeyPem);
        assert.match(data.platform_public_key!, /^-----BEGIN PUBLIC KEY-----/);
        assert.deepEqual(settings.accountService()!.get("default"), before);
        const serialized = JSON.stringify(data);
        for (const secret of [snapshot.provider!.privateKeyPem, apiSecret, settings.siteStore()!.notificationSecret("default")]) {
          if (secret) assert.equal(serialized.includes(JSON.stringify(secret).slice(1, -1)), false);
        }
        assert.equal(serialized.includes("PRIVATE KEY"), false);
      }
      const response = await app.request("/api/admin/v1/alipay-accounts/default", {
        method: "PUT", headers, body: JSON.stringify(accountUpdate(before)),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json() as { data: AlipayAccountView };
      assert.equal(data.platform_public_key, snapshot.provider!.publicKeyPem);
      assert.equal(settings.accountService()!.store().snapshot("default").provider!.privateKeyPem, snapshot.provider!.privateKeyPem);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-public-key-visibility-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
