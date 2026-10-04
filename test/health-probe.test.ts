import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { acquireDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { HealthProbeCache } from "../src/infrastructure/health-probe-cache.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { createApp } from "../src/http/app.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

describe("public health probe caching", () => {
  it("expires at one second, invalidates keys, and never serves stale success after a failed refresh", (t) => {
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const cache = new HealthProbeCache<number>(); let calls = 0;
    const load = () => ++calls;
    assert.equal(cache.read("a", load), 1);
    now = 1_099; assert.equal(cache.read("a", load), 1);
    now = 1_100; assert.equal(cache.read("a", load), 2);
    assert.equal(cache.read("b", load), 3);
    now = 2_100;
    assert.throws(() => cache.read("b", () => { throw new Error("unavailable"); }));
    assert.equal(cache.read("b", load), 4);
    now = 0; assert.equal(cache.read("b", load), 5);
  });

  it("shares bounded schema checks while strict checks invalidate a cached success immediately", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-probe-schema-"));
    const database = await AppDatabase.open(join(directory, "db.sqlite3"));
    try {
      let now = Math.ceil(performance.now());
      t.mock.method(performance, "now", () => now);
      let catalogs = 0;
      const connection = database.read(c => c);
      const prepare = connection.prepare.bind(connection);
      t.mock.method(connection, "prepare", (sql: string) => {
        if (sql.includes("SELECT type, name, tbl_name AS table_name, sql")) catalogs++;
        return prepare(sql);
      });
      for (let i = 0; i < 20; i++) assert.equal(database.probeHealth().ok, true);
      assert.equal(catalogs, 1);
      now += 1_000; assert.equal(database.probeHealth().ok, true);
      assert.equal(catalogs, 2);
      connection.exec("CREATE TABLE probe_extra(value TEXT)");
      assert.equal(database.probeHealth().ok, true);
      assert.equal(database.health().result, "database_schema_invalid");
      assert.equal(catalogs, 3);
      assert.equal(database.probeHealth().result, "database_schema_invalid");
      connection.exec("DROP TABLE probe_extra");
      assert.equal(database.probeHealth().ok, false);
      now += 1_000; assert.equal(database.probeHealth().ok, true);
      assert.equal(catalogs, 4);
      // A probe's own failed refresh is cached, but never beyond its deadline.
      connection.exec("CREATE TABLE probe_extra(value TEXT)");
      now += 1_000; assert.equal(database.probeHealth().result, "database_schema_invalid");
      connection.exec("DROP TABLE probe_extra");
      assert.equal(database.probeHealth().ok, false);
      now += 1_000; assert.equal(database.probeHealth().ok, true);
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not cache maintenance, lease, clock or closed-database admission", async () => {
    for (const condition of ["lease", "clock", "closed"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "perpay-probe-live-"));
      const path = join(directory, "db.sqlite3");
      const database = await AppDatabase.open(path);
      try {
        assert.equal(database.probeHealth().ok, true);
        const lock = acquireDatabaseMaintenanceLock(path, "probe-test", Date.now());
        try { assert.equal(database.probeHealth().result, "database_maintenance_in_progress"); }
        finally { lock.release(); }
        assert.equal(database.probeHealth().ok, true);
        if (condition === "closed") database.close();
        else database.read(c => c.prepare(condition === "lease"
          ? "UPDATE app_lease SET expires_at = 0 WHERE lease_key = 1"
          : "UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1")
          .run(...(condition === "clock" ? [Date.now() + 600_000] : [])));
        assert.equal(database.probeHealth().result, condition === "lease" ? "database_lease_lost" : condition === "clock" ? "order_clock_ahead" : "database_closed");
      } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it("shares probe schema work and bounds ready aggregates without caching runtime transitions", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-probe-http-"));
    const services = await createConfiguredHttpServices({ directory, apiSecret: Buffer.alloc(32, 7).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/probe-test" });
    try {
      let now = Math.ceil(performance.now()); t.mock.method(performance, "now", () => now);
      const ledger = new LedgerStore(services.database);
      const reconciliation = new ReconciliationStore(services.database);
      const conflicts = t.mock.method(ledger, "conflictSummary");
      const exceptions = t.mock.method(reconciliation, "exceptionSummary");
      let paymentRevision = 2; let transitioning = false;
      let account = services.settings.snapshot().activeProviderAccountKey;
      const app = createApp({ ...services, ledger, reconciliation, startedAt: new Date(),
        runtimeStatus: () => ({ configured: true, transitioning, paymentRevision,
          activeProviderAccountKey: account,
          scanIntervalMilliseconds: 10_000, maximumSuccessAgeMilliseconds: 60_000 }),
      });
      for (let i = 0; i < 10; i++) {
        assert.equal((await app.request("/healthz")).status, 200);
        assert.equal((await app.request("/readyz")).status, 503);
      }
      assert.equal(conflicts.mock.callCount(), 1); assert.equal(exceptions.mock.callCount(), 1);
      now += 1_000; await app.request("/readyz");
      assert.equal(conflicts.mock.callCount(), 2);
      paymentRevision++; await app.request("/readyz");
      assert.equal(conflicts.mock.callCount(), 3);
      transitioning = true; assert.equal((await app.request("/readyz")).status, 503);
      assert.equal(conflicts.mock.callCount(), 4);
      account = "other-account"; await app.request("/readyz");
      assert.equal(conflicts.mock.callCount(), 5);
      const previousStatus = services.settings.status();
      t.mock.method(services.settings, "status", () => ({ ...previousStatus, revision: previousStatus.revision + 1 }));
      await app.request("/readyz"); assert.equal(conflicts.mock.callCount(), 6);
      // Failures are cached as unavailable summaries, not replaced with old successful data.
      conflicts.mock.restore(); const failing = t.mock.method(ledger, "conflictSummary", () => { throw new Error("unavailable"); });
      now += 1_000; await app.request("/readyz"); await app.request("/readyz");
      assert.equal(failing.mock.callCount(), 1);
      // Financial admission must not trust the public probe's fresh schema snapshot.
      assert.equal((await app.request("/healthz")).status, 200);
      services.database.read(c => c.exec("CREATE TABLE probe_extra(value TEXT)"));
      const target = "/api/v1/orders";
      const body = Buffer.from(JSON.stringify({ idempotency_key: "probe-strict", merchant_order_no: "probe-strict", amount_cents: 100 }));
      const signed = signApiRequest({ secret: Buffer.alloc(32, 7), method: "POST", target, body,
        clientId: "default", timestamp: String(Math.floor(Date.now() / 1000)), nonce: Buffer.alloc(32, 9).toString("base64url") });
      const result = await app.request(target, { method: "POST", body, headers: {
        "content-type": "application/json", "x-perpay-signature-version": signed.version,
        "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp,
        "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature,
      } });
      assert.equal(result.status, 503);
      assert.equal((await result.json() as { error: { code: string } }).error.code, "system_not_ready");
      assert.equal((await app.request("/healthz")).status, 503);
      services.database.read(c => c.exec("DROP TABLE probe_extra"));
    } finally { services.database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
