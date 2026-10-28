import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { LedgerManualScanner } from "../src/runtime/ledger-manual-scan.ts";
import type { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import type { LedgerScanResult } from "../src/ledger/service.ts";
import type { LedgerManualScanRequest, LedgerManualScanStatus } from "../src/shared/ledger-manual-scan.ts";

test("manual scan is an authenticated, CSRF-protected strict administrator action with observable results", async t => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-manual-scan-http-"));
  const config = loadConfig({ PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4), PERPAY_DATA_DIR: join(directory, "data"),
    PERPAY_BACKUP_DIR: join(directory, "backups"), PERPAY_PUBLIC_URL: "http://localhost:6190" });
  const database = await AppDatabase.open(config.databasePath);
  try {
    const identity = new IdentityService(database); await identity.initialize(); await identity.setupAdmin("synthetic-manual-scan-password");
    const settings = new RuntimeSettingsService({ store: new RuntimeSettingsStore(database, config.masterKey) }); settings.initialize();
    const orders = new OrderService(database, () => settings.instanceSnapshot());
    const manual = new LedgerManualScanner();
    let calls = 0, finish!: (value: LedgerScanResult) => void;
    const scheduler = { trigger() { calls++; return new Promise<LedgerScanResult>(resolve => { finish = resolve; }); },
      health: () => ({ inFlight: true, lastAttemptAt: Date.now(), lastErrorCode: null }), nextScanAt: () => null } as unknown as LedgerIngestScheduler;
    let reason: LedgerManualScanStatus["unavailable_reason"] = null;
    const dependencies = { config, database, identity, settings, orders, startedAt: new Date(),
      ledgerManualScan: (): LedgerManualScanStatus => ({ available: reason === null, unavailable_reason: reason, request: manual.get() }),
      requestLedgerScan: () => manual.request(scheduler, () => true),
    };
    const app = createApp(dependencies), path = "/api/admin/v1/system/ledger/scan";
    assert.equal((await app.request(path, { method: "POST", body: "{}" })).status, 401);
    const login = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { origin: config.publicOrigin, "content-type": "application/json" }, body: JSON.stringify({ password: "synthetic-manual-scan-password" }) });
    assert.equal(login.status, 200);
    const csrf = (await login.json() as { data: { csrf_token: string } }).data.csrf_token;
    const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const headers = { cookie, origin: config.publicOrigin, "content-type": "application/json", "x-csrf-token": csrf };
    for (const [override, status] of [
      [{ "x-csrf-token": "" }, 403], [{ origin: "https://foreign.invalid" }, 403], [{ "content-type": "text/plain" }, 415],
    ] as const) assert.equal((await app.request(path, { method: "POST", headers: { ...headers, ...override }, body: "{}" })).status, status);
    for (const body of ['{"force":true}', '[]', 'null']) {
      assert.equal((await app.request(path, { method: "POST", headers, body })).status, 422, body);
    }
    assert.equal((await app.request(path, { method: "POST", headers, body: '{"force":false,"force":true}' })).status, 400);
    for (const query of ["force=true", "x=1&x=2", "channel=stable"]) {
      assert.equal((await app.request(path + "?" + query, { method: "POST", headers, body: "{}" })).status, 422);
    }
    assert.equal(calls, 0);
    const accepted = await app.request(path, { method: "POST", headers, body: "{}" });
    assert.equal(accepted.status, 202); assert.equal(accepted.headers.get("cache-control"), "no-store");
    const request = (await accepted.json() as { data: LedgerManualScanRequest }).data;
    assert.equal(request.state, "RUNNING");
    const repeated = await app.request(path, { method: "POST", headers, body: "{}" });
    assert.equal((await repeated.json() as { data: LedgerManualScanRequest }).data.id, request.id); assert.equal(calls, 1);
    finish({ status: "COMPLETED", errorCode: null, ingestRunId: "synthetic-run" } as LedgerScanResult); await setImmediate();
    const status = async (target = app) => (await (await target.request("/api/admin/v1/system/status", { headers })).json() as { data: { ledger: { manual_scan: LedgerManualScanStatus } } }).data.ledger.manual_scan;
    assert.equal((await status()).request?.state, "COMPLETED");
    assert.equal((await status()).request?.ingest_run_id, "synthetic-run");
    for (const unavailable of ["not_configured", "transitioning", "stopped", "storage_unavailable"] as const) {
      reason = unavailable;
      assert.equal((await status()).unavailable_reason, unavailable);
      const response = await app.request(path, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 503); assert.equal((await response.json() as { error: { code: string } }).error.code, "ledger_scan_unavailable");
    }
    reason = null;
    const demo = createApp({ ...dependencies, demoMode: true });
    assert.equal((await status(demo)).unavailable_reason, "demo_read_only");
    assert.equal((await demo.request(path, { method: "POST", headers, body: "{}" })).status, 403);
    const health = t.mock.method(database, "health", () => ({ ok: false, result: "database_lease_lost" }));
    assert.equal((await status()).unavailable_reason, "database_unavailable");
    assert.equal((await app.request(path, { method: "POST", headers, body: "{}" })).status, 503);
    health.mock.restore();
    assert.equal(calls, 1);
  } finally {
    database.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-manual-scan-http-")); rmSync(directory, { recursive: true, force: true });
  }
});
