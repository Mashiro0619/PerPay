// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { clearStaleMaintenanceLock, compactDatabase } from "../src/database/maintenance.ts";
import { databaseMaintenanceLockPath, readDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { inspectDatabaseStorage } from "../src/database/storage.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

async function fixture(context: TestContext, bloat = false) {
  const root = mkdtempSync(join(tmpdir(), "perpay-database-storage-"));
  const services = await createConfiguredHttpServices({ directory: root, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/storage-fixture" });
  context.after(() => {
    services.database.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("perpay-database-storage-"));
    rmSync(root, { recursive: true, force: true });
  });
  const created = services.orders.create(createOrderRequestSchema.parse({
    idempotency_key: "storage-order", merchant_order_no: "storage-order", amount_cents: 100, product_name: "storage test",
  })).order;
  if (bloat) {
    services.database.write(db => db.exec(`CREATE TABLE storage_fixture(data BLOB);
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 512)
      INSERT INTO storage_fixture SELECT zeroblob(16384) FROM rows;`));
    services.database.write(db => db.exec("DROP TABLE storage_fixture"));
  }
  const snapshot = services.database.read(db => ({
    order: db.prepare("SELECT * FROM payment_orders WHERE order_id = ?").get(created.orderId),
    audit: db.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
    key: db.prepare("SELECT * FROM runtime_master_key_guard").all(),
    settings: db.prepare("SELECT * FROM runtime_configuration").all(),
  }));
  return { ...services, root, created, snapshot };
}

function readSnapshot(path: string, orderId: string) {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    return {
      order: db.prepare("SELECT * FROM payment_orders WHERE order_id = ?").get(orderId),
      audit: db.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
      key: db.prepare("SELECT * FROM runtime_master_key_guard").all(),
      settings: db.prepare("SELECT * FROM runtime_configuration").all(),
    };
  } finally { db.close(); }
}

describe("database storage maintenance", () => {
  it("reports table/index allocation and reclaimable pages without changing the database", async context => {
    const f = await fixture(context, true);
    f.database.close();
    const bytes = readFileSync(f.config.databasePath);
    const report = inspectDatabaseStorage(f.config.databasePath);
    assert.equal(report.databaseBytes, bytes.length);
    assert.equal(report.usedBytes + report.reclaimableBytes, report.pageCount * report.pageSize);
    assert.ok(report.reclaimableBytes > 4 * 1024 * 1024);
    const orders = report.tables.find(table => table.name === "payment_orders")!;
    assert.equal(orders.rows, 1);
    if (report.dbstatAvailable) {
      assert.ok(orders.tableBytes! > 0);
      assert.ok(orders.indexBytes! > 0);
    }
    assert.deepEqual(readFileSync(f.config.databasePath), bytes);
  });

  it("keeps row counts available when SQLite has no dbstat module", async context => {
    const f = await fixture(context);
    f.database.close();
    const prepare = DatabaseSync.prototype.prepare;
    context.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql === "SELECT 1 FROM pragma_module_list WHERE name = 'dbstat'") {
        return { get: () => undefined } as unknown as ReturnType<typeof prepare>;
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    const report = inspectDatabaseStorage(f.config.databasePath);
    assert.equal(report.dbstatAvailable, false);
    assert.equal(report.tables.find(table => table.name === "payment_orders")!.rows, 1);
    assert.ok(report.tables.every(table => table.tableBytes === null && table.indexBytes === null));
  });

  it("compacts real free pages and preserves orders, audit, settings and keys", async context => {
    const f = await fixture(context, true);
    f.database.close();
    const result = compactDatabase({ dataDirectory: f.config.dataDir, masterKey: f.config.masterKey, confirmStoppedServices: true });
    assert.ok(result.reclaimedBytes > 4 * 1024 * 1024);
    assert.equal(result.reclaimedBytes, result.before.totalBytes - result.after.totalBytes);
    assert.ok(result.after.databaseBytes < result.before.databaseBytes / 2);
    assert.deepEqual(readSnapshot(f.config.databasePath, f.created.orderId), f.snapshot);
    assert.equal(existsSync(databaseMaintenanceLockPath(f.config.databasePath)), false);
    const reopened = await AppDatabase.open(f.config.databasePath, { masterKey: f.config.masterKey });
    try { assert.equal(reopened.integrityCheck().ok, true); } finally { reopened.close(); }
  });

  it("refuses a live application and an incorrect key before compacting", async context => {
    const f = await fixture(context);
    assert.throws(() => compactDatabase({ dataDirectory: f.config.dataDir, masterKey: f.config.masterKey, confirmStoppedServices: true }), /still owned/);
    assert.equal(existsSync(databaseMaintenanceLockPath(f.config.databasePath)), false);
    assert.equal(f.database.health().ok, true);
    f.database.close();
    const bytes = readFileSync(f.config.databasePath);
    assert.throws(() => compactDatabase({ dataDirectory: f.config.dataDir, masterKey: Buffer.alloc(32, 0x57), confirmStoppedServices: true }), /master.key|authentication/i);
    assert.deepEqual(readFileSync(f.config.databasePath), bytes);
  });

  it("preserves the database and restores the process temporary directory when VACUUM fails", async context => {
    const f = await fixture(context, true);
    f.database.close();
    const alternate = join(f.root, "sqlite-temp"); mkdirSync(alternate);
    const probe = new DatabaseSync(":memory:");
    const originalTemporaryDirectory = probe.prepare("PRAGMA temp_store_directory").get()?.temp_store_directory;
    probe.exec(`PRAGMA temp_store_directory = '${alternate.replaceAll("'", "''")}'`);
    const exec = DatabaseSync.prototype.exec;
    const failure = Object.assign(new Error("synthetic disk full during VACUUM"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
    let vacuumAttempted = false;
    const hook = context.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql === "VACUUM") {
        vacuumAttempted = true;
        assert.equal(this.prepare("PRAGMA temp_store").get()!.temp_store, 1n);
        assert.equal(this.prepare("PRAGMA temp_store_directory").get()!.temp_store_directory, f.config.dataDir);
        throw failure;
      }
      return Reflect.apply(exec, this, [sql]);
    });
    try {
      assert.throws(() => compactDatabase({ dataDirectory: f.config.dataDir, masterKey: f.config.masterKey, confirmStoppedServices: true }), error => error === failure);
      assert.equal(vacuumAttempted, true);
      assert.equal(probe.prepare("PRAGMA temp_store_directory").get()!.temp_store_directory, alternate);
      assert.deepEqual(readSnapshot(f.config.databasePath, f.created.orderId), f.snapshot);
      assert.equal(existsSync(databaseMaintenanceLockPath(f.config.databasePath)), false);
    } finally {
      hook.mock.restore();
      probe.exec(`PRAGMA temp_store_directory = '${String(originalTemporaryDirectory ?? "").replaceAll("'", "''")}'`);
      probe.close();
    }
    const reopened = await AppDatabase.open(f.config.databasePath, { masterKey: f.config.masterKey });
    reopened.close();
  });

  it("checks disk headroom before claiming or changing the database", async context => {
    const f = await fixture(context);
    f.database.close();
    const bytes = readFileSync(f.config.databasePath), statfs = fs.statfsSync;
    const hook = context.mock.method(fs, "statfsSync", ((...args: Parameters<typeof statfs>) => ({ ...Reflect.apply(statfs, fs, args), bavail: 0n })) as typeof statfs);
    syncBuiltinESMExports();
    try {
      assert.throws(() => compactDatabase({ dataDirectory: f.config.dataDir, masterKey: f.config.masterKey, confirmStoppedServices: true }), /insufficient storage headroom/);
      assert.deepEqual(readFileSync(f.config.databasePath), bytes);
      assert.equal(existsSync(databaseMaintenanceLockPath(f.config.databasePath)), false);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  });

  it("retains maintenance ownership when post-compaction verification fails and uses the existing recovery command", async context => {
    const f = await fixture(context, true);
    f.database.close();
    const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
    let vacuumCompleted = false;
    const execHook = context.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      const result = Reflect.apply(exec, this, [sql]);
      if (sql === "VACUUM") vacuumCompleted = true;
      return result;
    });
    const prepareHook = context.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (vacuumCompleted && sql === "PRAGMA quick_check") throw new Error("synthetic post-compaction read failure");
      return Reflect.apply(prepare, this, [sql]);
    });
    try {
      assert.throws(() => compactDatabase({ dataDirectory: f.config.dataDir, masterKey: f.config.masterKey, confirmStoppedServices: true }),
        /maintenance lock was retained/);
    } finally { execHook.mock.restore(); prepareHook.mock.restore(); }
    assert.equal(vacuumCompleted, true);
    assert.deepEqual(readSnapshot(f.config.databasePath, f.created.orderId), f.snapshot);
    await assert.rejects(AppDatabase.open(f.config.databasePath, { masterKey: f.config.masterKey }), /maintenance/);
    const lock = readDatabaseMaintenanceLock(f.config.databasePath);
    assert.equal(lock.operation, "compact-database");
    clearStaleMaintenanceLock({ dataDirectory: f.config.dataDir, lockToken: lock.token,
      confirmNoMaintenanceProcess: true, forceAbandonMaintenanceLease: true });
    const reopened = await AppDatabase.open(f.config.databasePath, { masterKey: f.config.masterKey });
    try { assert.equal(reopened.integrityCheck().ok, true); } finally { reopened.close(); }
  });

  it("exposes read-only diagnostics and offline compaction through the maintenance CLI", async context => {
    const f = await fixture(context, true);
    f.database.close();
    const run = (command: string, key?: string, flags: string[] = []) => spawnSync(process.execPath, ["--experimental-strip-types", "src/database/maintenance.ts", command, ...flags], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, PERPAY_DATA_DIR: f.config.dataDir, PERPAY_BACKUP_DIR: f.config.backupDir,
        PERPAY_MASTER_KEY: key, PERPAY_SECRETS_DIR: join(f.root, "missing-secrets") },
    });
    const inspected = run("inspect-storage");
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).tables.find((table: { name: string }) => table.name === "payment_orders").rows, 1);
    assert.equal(run("compact-database", f.config.masterKey.toString("hex")).status, 1);
    const compacted = run("compact-database", f.config.masterKey.toString("hex"), ["--confirm-stopped-services"]);
    assert.equal(compacted.status, 0, compacted.stderr);
    assert.ok(JSON.parse(compacted.stdout).reclaimedBytes > 4 * 1024 * 1024);
    assert.deepEqual(readSnapshot(f.config.databasePath, f.created.orderId), f.snapshot);
  });
});
