import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { IdentityService } from "../src/identity/service.ts";

it("upgrades schema 35 without invalidating old sessions and retains login metadata through backup and restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-session-migration-"));
  const path = join(directory, "db.sqlite3");
  const backupPath = join(directory, "restored.sqlite3");
  const clock = { now: Date.parse("2026-10-25T12:00:00Z") };
  let database: AppDatabase | undefined;
  try {
    database = await AppDatabase.open(path);
    let identity = new IdentityService(database, () => clock.now);
    await identity.initialize();
    await identity.setupAdmin("session-migration-password");
    const oldLogin = await identity.login("session-migration-password", {}, { remember: true });
    const oldSession = identity.authenticate(oldLogin.sessionToken)!;
    database.close();
    database = undefined;
    const legacy = new DatabaseSync(path, { readBigInts: true });
    try {
      legacy.exec("ALTER TABLE admin_sessions DROP COLUMN user_agent; ALTER TABLE admin_sessions DROP COLUMN source_address; DELETE FROM schema_migrations WHERE version = 36;");
      assert.equal(inspectDatabaseIntegrity(legacy).ok, true);
    } finally {
      legacy.close();
    }

    database = await AppDatabase.open(path);
    identity = new IdentityService(database, () => clock.now);
    await identity.initialize();
    const restoredOld = identity.authenticate(oldLogin.sessionToken)!;
    assert.equal(restoredOld.session.sessionId, oldSession.session.sessionId);
    assert.equal(restoredOld.session.generation, oldSession.session.generation);
    assert.equal(identity.verifyCsrf(restoredOld, oldLogin.csrfToken), true);
    assert.deepEqual(identity.listSessions(restoredOld)[0], {
      sessionId: oldSession.session.sessionId,
      isCurrent: true,
      userAgent: null,
      ipAddress: null,
      authMethod: "password",
      lastSeenAt: oldSession.session.lastSeenAt,
      expiresAt: oldLogin.absoluteExpiresAt,
    });
    const preMigrationPath = `${path}.pre-migration-v35-to-v36.sqlite3`;
    assert.equal(existsSync(preMigrationPath), true);
    const original = new DatabaseSync(preMigrationPath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(inspectDatabaseIntegrity(original).ok, true);
      assert.equal(original.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version, 35n);
      const columns = original.prepare("PRAGMA table_info(admin_sessions)").all().map((row) => row.name);
      assert.equal(columns.includes("source_address"), false);
      assert.equal(columns.includes("user_agent"), false);
    } finally {
      original.close();
    }

    const newLogin = await identity.login("session-migration-password", {
      userAgent: "Chrome Android", sourceAddress: "2001:db8::8",
    }, { remember: true });
    const current = identity.authenticate(newLogin.sessionToken)!;
    await database.backup(backupPath);
    database.close();
    database = await AppDatabase.open(backupPath);
    identity = new IdentityService(database, () => clock.now);
    await identity.initialize();
    const restoredNew = identity.authenticate(newLogin.sessionToken)!;
    assert.equal(restoredNew.session.sessionId, current.session.sessionId);
    assert.equal(identity.verifyCsrf(restoredNew, newLogin.csrfToken), true);
    assert.ok(identity.authenticate(oldLogin.sessionToken));
    assert.equal(database.integrityCheck().ok, true);
    const metadata = identity.listSessions(restoredNew);
    assert.equal(metadata[0]!.userAgent, "Chrome Android");
    assert.equal(metadata[0]!.ipAddress, "2001:db8::8");
    assert.equal(metadata[1]!.userAgent, null);
    assert.equal(metadata[1]!.ipAddress, null);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
