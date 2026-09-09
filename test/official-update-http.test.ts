import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { OfficialUpdateChecker } from "../src/update/checker.ts";
import { APP_VERSION } from "../src/version.ts";

test("official update checks require a session and never gate login or collection readiness", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-update-http-"));
  const config = loadConfig({ PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4), PERPAY_DATA_DIR: join(directory, "data"),
    PERPAY_BACKUP_DIR: join(directory, "backups"), PERPAY_PUBLIC_URL: "http://localhost:6190" });
  const database = await AppDatabase.open(config.databasePath);
  try {
    const identity = new IdentityService(database);
    await identity.initialize();
    await identity.setupAdmin("synthetic-update-test-password");
    const settings = new RuntimeSettingsService({ store: new RuntimeSettingsStore(database, config.masterKey) });
    settings.initialize();
    const orders = new OrderService(database, () => settings.snapshot());
    let requests = 0, clock = Date.now(), unavailable = false;
    const updateChecker = new OfficialUpdateChecker({ clock: () => clock, fetch: async () => {
      requests++;
      if (unavailable) throw new Error("not returned to the browser");
      return Response.json({ tag_name: "v" + APP_VERSION, html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + APP_VERSION,
        draft: false, prerelease: false, published_at: "2026-09-09T09:00:00Z" });
    } });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(), updateChecker });
    assert.equal((await app.request("/api/admin/v1/system/update")).status, 401);
    const badLogin = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: "wrong-password" }) });
    assert.equal(badLogin.status, 401);
    assert.equal(requests, 0);
    const login = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: "synthetic-update-test-password" }) });
    assert.equal(login.status, 200);
    assert.equal(requests, 0, "login must not await any external update request");
    const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const headers = { cookie };
    const before = settings.view();
    const readiness = await (await app.request("/readyz")).json();
    const response = await app.request("/api/admin/v1/system/update", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json() as { data: { status: string; current_version: string; latest_version: string } };
    assert.equal(result.data.status, "up_to_date");
    assert.equal(result.data.current_version, APP_VERSION);
    assert.equal(result.data.latest_version, APP_VERSION);
    assert.equal(requests, 1);
    assert.equal((await app.request("/api/admin/v1/system/update?url=https://evil.invalid", { headers })).status, 422);
    assert.equal((await app.request("/api/admin/v1/system/update?force=true", { headers })).status, 422);
    assert.equal(requests, 1);

    unavailable = true; clock += 300_000;
    const failed = await app.request("/api/admin/v1/system/update", { headers });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("retry-after"), "60");
    assert.equal((await failed.json() as { error: { code: string } }).error.code, "update_check_unavailable");
    assert.equal((await app.request("/api/admin/v1/session", { headers })).status, 200);
    assert.equal((await app.request("/healthz")).status, 200);
    assert.deepEqual(await (await app.request("/readyz")).json(), readiness);
    assert.deepEqual(settings.view(), before);
    identity.revokeAllSessions(identity.authenticate(cookie.match(/perpay_session=([^;]+)/)![1]!)!);
    assert.equal((await app.request("/api/admin/v1/system/update", { headers })).status, 401);
    assert.equal(requests, 2);
  } finally {
    database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-update-http-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
