import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { acquireDatabaseMaintenanceLock, hasDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { IdentityService } from "../src/identity/service.ts";
import { PasswordInputError } from "../src/identity/crypto.ts";
import { recoverAdministratorPassword } from "../src/identity/recovery.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { RuntimeSettingsStore } from "../src/settings/index.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const openDatabases = new Map<string, AppDatabase>();
function temp(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-admin-recovery-"));
  context.after(() => {
    openDatabases.get(directory)?.close(); openDatabases.delete(directory);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("perpay-admin-recovery-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
async function fixture(context: TestContext) {
  const directory = temp(context);
  const app = await createConfiguredHttpServices({ directory, apiSecret: Buffer.alloc(32, 7).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/recovery-test-only" });
  openDatabases.set(directory, app.database);
  return app;
}

describe("offline administrator recovery", () => {
  it("preserves orders and encrypted settings, revokes sessions and appends an audit event", async (context) => {
    const app = await fixture(context);
    const login = await app.identity.login(HTTP_TEST_ADMIN_PASSWORD);
    app.orders.create(createOrderRequestSchema.parse({ idempotency_key: "recovery-preserve-key", merchant_order_no: "recovery-preserve-order", amount_cents: 100, product_name: "保留的测试订单" }));
    const originalSettings = app.settings.snapshot();
    const preserved = (database: AppDatabase) => database.read((connection) => ["payment_orders", "runtime_secrets", "api_client_keys", "collection_profiles"].map((table) => connection.prepare("SELECT * FROM " + table).all()));
    const before = preserved(app.database);
    const generation = app.identity.store.read((transaction) => transaction.adminIdentity()!.sessionGeneration);
    app.database.close();
    const result = await recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password: "新密码甲乙丙", confirmed: true });
    assert.equal(result.sessionGeneration, generation + 1);
    assert.equal(result.revokedSessions, 1);
    assert.equal(hasDatabaseMaintenanceLock(app.config.databasePath), false);
    const reopened = await AppDatabase.open(app.config.databasePath);
    try {
      assert.deepEqual(preserved(reopened), before);
      assert.deepEqual(new RuntimeSettingsStore(reopened, app.config.masterKey).snapshot(), originalSettings);
      const identity = new IdentityService(reopened);
      assert.equal(identity.authenticate(login.sessionToken), undefined);
      await assert.rejects(identity.login(HTTP_TEST_ADMIN_PASSWORD));
      const next = await identity.login("新密码甲乙丙"); assert.ok(identity.authenticate(next.sessionToken));
      const audit = reopened.read((connection) => connection.prepare("SELECT details_json FROM audit_events WHERE action = 'admin.password_recover'").get()) as { details_json: string };
      assert.deepEqual(JSON.parse(audit.details_json), { session_generation: generation + 1, revoked_count: 1 });
      identity.store.read((transaction) => transaction.assertAuditChain());
    } finally { reopened.close(); }
  });

  it("refuses a live instance and does not invalidate its session or lease", async (context) => {
    const app = await fixture(context); const login = await app.identity.login(HTTP_TEST_ADMIN_PASSWORD);
    await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password: "abcdef", confirmed: true }), /租约/);
    assert.ok(app.database.health().ok); assert.ok(app.identity.authenticate(login.sessionToken));
    assert.equal(hasDatabaseMaintenanceLock(app.config.databasePath), false);
  });

  it("requires confirmation and the existing password rules", async (context) => {
    const app = await fixture(context);
    await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password: "abcdef", confirmed: false }), /未确认/);
    for (const password of ["short", "🔐".repeat(5)]) {
      await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password, confirmed: true }), PasswordInputError);
    }
    app.database.close();
    for (const password of ["a".repeat(1025), "abcdef\ud800"]) {
      await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password, confirmed: true }), PasswordInputError);
    }
  });

  it("never creates a missing database or initializes a fresh identity", async (context) => {
    const directory = temp(context); const missing = join(directory, "missing");
    await assert.rejects(recoverAdministratorPassword({ dataDirectory: missing, password: "abcdef", confirmed: true }), /不会创建/);
    assert.equal(existsSync(missing), false);
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3")); database.close();
    await assert.rejects(recoverAdministratorPassword({ dataDirectory: directory, password: "abcdef", confirmed: true }), /尚未初始化/);
  });

  it("respects the maintenance lock and rejects schema drift", async (context) => {
    const app = await fixture(context); app.database.close();
    const lock = acquireDatabaseMaintenanceLock(app.config.databasePath, "test-existing-maintenance", Date.now());
    try { await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password: "abcdef", confirmed: true }), /maintenance lock/); }
    finally { lock.release(); }
    const { DatabaseSync } = await import("node:sqlite"); const raw = new DatabaseSync(app.config.databasePath);
    raw.exec("CREATE TABLE unexpected_schema(value TEXT)"); raw.close();
    await assert.rejects(recoverAdministratorPassword({ dataDirectory: app.config.dataDir, password: "abcdef", confirmed: true }), /完整性/);
  });

  it("accepts stdin only with explicit flags and never prints the password", async (context) => {
    const app = await fixture(context); app.database.close(); const secret = "stdin-private-test-password";
    const invoke = (args: string[], input: string) => spawnSync(process.execPath, ["src/identity/recover.ts", ...args], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, PERPAY_DATA_DIR: app.config.dataDir }, input, encoding: "utf8", windowsHide: true });
    for (const args of [[], ["--confirm-reset-admin-password"], ["--confirm-reset-admin-password", "--password=" + secret]]) {
      const result = invoke(args, secret); assert.equal(result.status, 1); assert.equal((result.stdout + result.stderr).includes(secret), false);
    }
    const result = invoke(["--confirm-reset-admin-password", "--password-stdin"], secret + "\n");
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /已重设/); assert.equal((result.stdout + result.stderr).includes(secret), false);
  });
});
