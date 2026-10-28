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
const CURRENT_VERSION = "0.2.2";

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
    const orders = new OrderService(database, () => settings.instanceSnapshot());
    let requests = 0, clock = Date.now(), unavailable = false;
    const updateChecker = new OfficialUpdateChecker({ currentVersion: CURRENT_VERSION, clock: () => clock, fetch: async url => {
      requests++;
      if (unavailable) throw new Error("not returned to the browser");
      if (String(url).includes("?per_page=")) return Response.json([{ tag_name: "v0.3.0-rc.1",
        html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v0.3.0-rc.1",
        draft: false, prerelease: true, published_at: "2026-09-09T09:00:00Z" }]);
      return Response.json({ tag_name: "v" + CURRENT_VERSION, html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + CURRENT_VERSION,
        draft: false, prerelease: false, published_at: "2026-09-09T09:00:00Z" });
    } });
    const app = createApp({ config, database, identity, settings, orders, startedAt: new Date(), updateChecker });
    assert.equal((await app.request("/api/admin/v1/system/update")).status, 401);
    assert.equal((await app.request("/api/admin/v1/system/update?channel=prerelease")).status, 401);
    const badLogin = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: "wrong-password" }) });
    assert.equal(badLogin.status, 401);
    assert.equal(requests, 0);
    const login = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: "synthetic-update-test-password" }) });
    assert.equal(login.status, 200);
    assert.equal(requests, 0, "login must not await any external update request");
    const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const headers = { cookie };
    const before = settings.instanceView();
    const readiness = await (await app.request("/readyz")).json();
    const response = await app.request("/api/admin/v1/system/update", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json() as { data: { status: string; current_version: string; latest_version: string } };
    assert.equal(result.data.status, "update_available");
    assert.equal(result.data.current_version, CURRENT_VERSION);
    assert.equal(result.data.latest_version, "0.3.0-rc.1", "omitted channel includes prereleases even on a stable installation");
    assert.deepEqual(Object.keys(result.data).sort(), ["checked_at", "current_version", "latest_version", "published_at", "release_url", "status"]);
    assert.equal(requests, 2);
    for (const query of [
      "url=https://evil.invalid", "force=true", "channel=", "channel=auto", "channel=preview", "channel=STABLE", "channel=%20stable",
      "channel=stable&channel=stable", "channel=auto&channel=prerelease", "channel=stable&force=true",
      "channel=prerelease&unknown=", "Channel=stable", "channel[]=stable",
    ]) {
      const invalid = await app.request("/api/admin/v1/system/update?" + query, { headers });
      assert.equal(invalid.status, 422, query);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "validation_failed");
    }
    assert.equal(requests, 2);
    const preview = await app.request("/api/admin/v1/system/update?channel=prerelease", { headers });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), result);
    assert.equal(requests, 2, "omitted and explicit prerelease channels share the cache");
    const stable = await app.request("/api/admin/v1/system/update?channel=stable", { headers });
    assert.equal(stable.status, 200);
    const stableResult = await stable.json() as { data: { status: string; latest_version: string } };
    assert.equal(stableResult.data.status, "up_to_date");
    assert.equal(stableResult.data.latest_version, CURRENT_VERSION);
    assert.equal(requests, 3);
    for (const query of ["", "?channel=prerelease", "?channel=stable"]) {
      assert.equal((await app.request("/api/admin/v1/system/update" + query, { headers })).status, 200);
    }
    assert.equal(requests, 3);

    unavailable = true; clock += 300_000;
    const failed = await app.request("/api/admin/v1/system/update", { headers });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("retry-after"), "60");
    assert.equal((await failed.json() as { error: { code: string } }).error.code, "update_check_unavailable");
    assert.equal((await app.request("/api/admin/v1/session", { headers })).status, 200);
    assert.equal((await app.request("/healthz")).status, 200);
    assert.deepEqual(await (await app.request("/readyz")).json(), readiness);
    assert.deepEqual(settings.instanceView(), before);
    identity.revokeAllSessions(identity.authenticate(cookie.match(/perpay_session=([^;]+)/)![1]!)!);
    assert.equal((await app.request("/api/admin/v1/system/update", { headers })).status, 401);
    assert.equal(requests, 4);
  } finally {
    database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-update-http-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
