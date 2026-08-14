import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";

describe("AppDatabase", () => {
  it("migrates once and preserves the instance identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-db-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const first = await AppDatabase.open(databasePath);
      const instanceId = first.instanceId();
      assert.deepEqual(first.health(), { ok: true, result: "ok" });
      assert.deepEqual(first.integrityCheck(), {
        ok: true,
        quickCheck: "ok",
        foreignKeyViolations: 0,
        schema: "ok",
      });

      await assert.rejects(() => AppDatabase.open(databasePath), /already owns the database lease/);
      first.close();

      const reopened = await AppDatabase.open(databasePath);
      assert.equal(reopened.instanceId(), instanceId);
      assert.deepEqual(reopened.health(), { ok: true, result: "ok" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a consistent online backup that can be reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-backup-"));
    const databasePath = join(directory, "database.sqlite3");
    const backupPath = join(directory, "backup", "database.sqlite3");
    try {
      const source = await AppDatabase.open(databasePath);
      const instanceId = source.instanceId();
      const backup = await source.backupDetailed(backupPath);
      assert.ok(backup.pages > 0);
      assert.match(backup.sha256, /^[0-9a-f]{64}$/);
      assert.equal(backup.targetPath, backupPath);
      assert.equal(
        readdirSync(join(directory, "backup")).some((name) => name.endsWith(".tmp")),
        false,
      );
      source.close();

      const restored = await AppDatabase.open(backupPath);
      assert.equal(restored.instanceId(), instanceId);
      assert.deepEqual(restored.health(), { ok: true, result: "ok" });
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers an expired lease left by a crashed process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-stale-lease-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.close();
      const raw = new DatabaseSync(databasePath);
      raw.prepare(
        "INSERT INTO app_lease(lease_key, owner_token, owner_pid, owner_host, acquired_at, expires_at) VALUES (1, 'stale', 1, 'old', 0, ?)",
      ).run(Date.now() - 1);
      raw.close();

      const recovered = await AppDatabase.open(databasePath);
      assert.deepEqual(recovered.health(), { ok: true, result: "ok" });
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a changed applied migration checksum", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-checksum-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.close();
      const raw = new DatabaseSync(databasePath);
      raw.prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1").run();
      raw.close();
      await assert.rejects(() => AppDatabase.open(databasePath), /migration checksum mismatch/);
      assert.equal(existsSync(`${databasePath}-wal`), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
