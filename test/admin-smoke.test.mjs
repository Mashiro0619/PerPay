import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { listAdminAssets, runAdminSmoke } from "../scripts/admin-smoke.mjs";
import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { SESSION_IDLE_TTL_MS } from "../src/database/identity-store.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";

const origin = "http://localhost:6190";
async function open(directory, clock = Date.now) {
  const config = loadConfig({ PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4), PERPAY_DATA_DIR: join(directory, "data"), PERPAY_BACKUP_DIR: join(directory, "backups"), PERPAY_PUBLIC_URL: origin });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, clock);
  await identity.initialize();
  const settings = new RuntimeSettingsService({ store: new RuntimeSettingsStore(database, config.masterKey) });
  settings.initialize();
  const orders = new OrderService(database, () => settings.snapshot());
  orders.initialize();
  return { database, identity, app: createApp({ config, database, identity, settings, orders, startedAt: new Date() }) };
}

function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("perpay-admin-smoke-"));
  rmSync(directory, { recursive: true, force: true });
}

describe("production administrator smoke", () => {
  it("uses real Hono, SQLite and build assets through setup, auth, conflicts and restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-admin-smoke-"));
    const password = randomBytes(32).toString("hex");
    let services = await open(directory);
    try {
      const options = { baseUrl: origin, password, isolated: true, assets: listAdminAssets() };
      const first = await runAdminSmoke({ ...options, initialize: true, request: (url, init) => services.app.request(url, init) });
      assert.ok(first.assetsChecked > 10);
      services.database.close();
      services = await open(directory);
      const restarted = await runAdminSmoke({ ...options, request: (url, init) => services.app.request(url, init) });
      assert.equal(restarted.instanceId, first.instanceId);
    } finally { services.database.close(); cleanup(directory); }
  });

  it("expires real sessions rather than relying on a browser mock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-admin-smoke-"));
    let now = Date.now();
    const services = await open(directory, () => now);
    try {
      const password = randomBytes(24).toString("hex");
      await services.identity.setupAdmin(password);
      const login = await services.app.request(`${origin}/api/admin/v1/session/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
      assert.equal((await services.app.request("/api/admin/v1/orders", { headers: { cookie } })).status, 200);
      now += SESSION_IDLE_TTL_MS + 1;
      assert.equal((await services.app.request("/api/admin/v1/orders", { headers: { cookie } })).status, 401);
    } finally { services.database.close(); cleanup(directory); }
  });

  it("refuses non-isolated and non-loopback targets before sending a request", async () => {
    const request = () => { throw new Error("must not send"); };
    await assert.rejects(runAdminSmoke({ baseUrl: origin, password: "x".repeat(32), request }), /isolated/);
    await assert.rejects(runAdminSmoke({ baseUrl: "https://pay.example.com", password: "x".repeat(32), isolated: true, request }), /loopback/);
  });
});
