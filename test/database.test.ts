import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase, sha256FileSync } from "../src/database/database.ts";

describe("AppDatabase", () => {
  it("migrates once and preserves the instance identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-db-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const first = await AppDatabase.open(databasePath);
      const instanceId = first.instanceId();
      const checkoutTokenKey = first.read((connection) =>
        (connection
          .prepare(
            `SELECT hex(key_material) AS value
               FROM checkout_token_keys
              WHERE retired_at IS NULL`,
          )
          .get() as { value: string }).value,
      );
      assert.match(checkoutTokenKey, /^[0-9A-F]{64}$/);
      assert.deepEqual(first.health(), { ok: true, result: "ok" });
      assert.deepEqual(first.integrityCheck(), {
        ok: true,
        quickCheck: "ok",
        foreignKeyViolations: 0,
        domainViolations: 0,
        schema: "ok",
      });

      await assert.rejects(() => AppDatabase.open(databasePath), /already owns the database lease/);
      first.close();

      const reopened = await AppDatabase.open(databasePath);
      assert.equal(reopened.instanceId(), instanceId);
      assert.equal(
        reopened.read((connection) =>
          (connection
            .prepare(
              `SELECT hex(key_material) AS value
                 FROM checkout_token_keys
                WHERE retired_at IS NULL`,
            )
            .get() as { value: string }).value,
        ),
        checkoutTokenKey,
      );
      assert.deepEqual(reopened.health(), { ok: true, result: "ok" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
        readdirSync(join(directory, "backup")).some(
          (name) => name.includes(".tmp") || name.endsWith("-wal") || name.endsWith("-shm"),
        ),
        false,
      );
      source.close();

      const restored = await AppDatabase.open(backupPath);
      assert.equal(restored.instanceId(), instanceId);
      assert.deepEqual(restored.health(), { ok: true, result: "ok" });
      restored.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("compacts reclaimed pages in a restorable backup without rewriting the live database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-compact-backup-"));
    const databasePath = join(directory, "database.sqlite3");
    const backupPath = join(directory, "backup", "database.sqlite3");
    const source = await AppDatabase.open(databasePath);
    try {
      const instanceId = source.instanceId();
      source.write(connection => {
        connection.exec("CREATE TABLE backup_padding(value BLOB); INSERT INTO backup_padding VALUES (zeroblob(12582912)); DROP TABLE backup_padding");
      });
      const sourcePages = source.read(connection => Number(connection.prepare("PRAGMA page_count").get()!.page_count));
      const sourceFreePages = source.read(connection => Number(connection.prepare("PRAGMA freelist_count").get()!.freelist_count));
      assert.ok(sourceFreePages > sourcePages / 2);

      const backup = await source.backupDetailed(backupPath);
      assert.ok(backup.pages < sourcePages / 2);
      assert.equal(backup.sha256, sha256FileSync(backupPath));
      assert.equal(source.read(connection => Number(connection.prepare("PRAGMA page_count").get()!.page_count)), sourcePages);
      assert.equal(source.read(connection => Number(connection.prepare("PRAGMA freelist_count").get()!.freelist_count)), sourceFreePages);
      assert.deepEqual(readdirSync(join(directory, "backup")), ["database.sqlite3"]);

      const restored = await AppDatabase.open(backupPath);
      try {
        assert.equal(restored.instanceId(), instanceId);
        assert.equal(restored.integrityCheck().ok, true);
        assert.equal(restored.read(connection => Number(connection.prepare("PRAGMA freelist_count").get()!.freelist_count)), 0);
        const pageSize = restored.read(connection => Number(connection.prepare("PRAGMA page_size").get()!.page_size));
        assert.equal(statSync(backupPath).size, backup.pages * pageSize);
      } finally { restored.close(); }
    } finally {
      source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not amplify a valid long backup target into an overlong temporary path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-long-backup-"));
    const databasePath = join(directory, "database.sqlite3");
    const backupDirectory = join(directory, "backup");
    const targetLength = 230;
    const suffix = ".sqlite3";
    const nameLength = targetLength - backupDirectory.length - 1;
    assert.ok(nameLength > suffix.length);
    const name = `${"b".repeat(nameLength - suffix.length)}${suffix}`;
    const backupPath = join(backupDirectory, name);
    assert.equal(backupPath.length, targetLength);
    assert.ok(join(backupDirectory, `.${name}.${"0".repeat(36)}.tmp`).length >= 260);

    const database = await AppDatabase.open(databasePath);
    try {
      const backup = await database.backupDetailed(backupPath);
      assert.equal(backup.targetPath, backupPath);
      assert.equal(existsSync(backupPath), true);
    } finally {
      database.close();
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
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("renews its lease before committing a long synchronous write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-write-lease-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.write((connection) => {
        connection.prepare(
          "UPDATE app_lease SET expires_at = ? WHERE lease_key = 1",
        ).run(Date.now() - 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      });
      assert.deepEqual(database.health(), { ok: true, result: "ok" });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("reports not ready when the persisted order clock is too far ahead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-order-clock-health-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.write((connection) => {
        connection
          .prepare("UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1")
          .run(Date.now() + 10 * 60 * 1000);
      });
      assert.deepEqual(database.health(), { ok: false, result: "order_clock_ahead" });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("returns a stable code instead of exposing database probe errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-database-health-error-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.read((connection) => {
        connection.exec("ALTER TABLE app_lease RENAME TO app_lease_probe_failure");
      });
      try {
        assert.deepEqual(database.health(), { ok: false, result: "database_probe_failed" });
      } finally {
        const repair = new DatabaseSync(databasePath);
        try {
          repair.exec("ALTER TABLE app_lease_probe_failure RENAME TO app_lease");
        } finally {
          repair.close();
          database.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("refuses startup when cross-table domain state has been externally damaged", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-domain-integrity-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      database.close();
      const raw = new DatabaseSync(databasePath);
      raw.exec("DROP TRIGGER order_clock_no_delete");
      raw.exec("DELETE FROM order_clock");
      raw.close();

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /schema=invalid/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rolls back the entire pending migration batch atomically when a later migration fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-atomic-migration-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const { createPreAccountDatabase } = await import("./legacy-settings-fixture.ts");
      const { RuntimeSecretCipher } = await import("../src/settings/crypto.ts");
      const masterKey = Buffer.alloc(32, 0x22);
      const fixture = createPreAccountDatabase(databasePath);
      try {
        const instanceId = fixture.owner.instanceId();
        const cipher = new RuntimeSecretCipher(masterKey, instanceId);
        const guard = cipher.createGuard();
        const secret = cipher.encrypt("provider_private_key", 1, Buffer.from("legacy-private-key", "utf8"));
        fixture.owner.write((connection) => {
          connection.prepare(
            `INSERT INTO runtime_master_key_guard(singleton_key, cipher_version, nonce, ciphertext, authentication_tag, created_at)
             VALUES (1, ?, ?, ?, ?, ?)`,
          ).run(guard.cipherVersion, guard.nonce, guard.ciphertext, guard.authenticationTag, Date.now());
          connection.prepare(
            `INSERT INTO runtime_secrets(secret_name, secret_version, cipher_version, nonce, ciphertext, authentication_tag, secret_fingerprint, updated_at)
             VALUES ('provider_private_key', 1, ?, ?, ?, ?, ?, ?)`,
          ).run(secret.cipherVersion, secret.nonce, secret.ciphertext, secret.authenticationTag, "a".repeat(64), Date.now());
        });
      } finally {
        fixture.owner.close();
      }

      // Roll the seeded DB back to schema 35 so both v36 and v37 are pending.
      const legacy = new DatabaseSync(databasePath, { readBigInts: true });
      try {
        legacy.exec("ALTER TABLE admin_sessions DROP COLUMN user_agent; ALTER TABLE admin_sessions DROP COLUMN source_address; DELETE FROM schema_migrations WHERE version = 36;");
      } finally {
        legacy.close();
      }

      // Opening without masterKey runs v36 inside the batch and fails on v37 (multiple_alipay_accounts).
      await assert.rejects(() => AppDatabase.open(databasePath), /database migration 37/u);

      // Verify v36 was rolled back atomically along with v37 — schema stays at v35!
      const inspect = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
      try {
        const maxVersion = Number((inspect.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: bigint }).version);
        assert.equal(maxVersion, 35);
        const columns = (inspect.prepare("PRAGMA table_info(admin_sessions)").all() as Array<{ name: string }>).map(row => row.name);
        assert.equal(columns.includes("user_agent"), false);
        assert.equal(columns.includes("source_address"), false);
      } finally {
        inspect.close();
      }

      // Supplying the valid masterKey subsequently upgrades the untouched v35 DB cleanly.
      const upgraded = await AppDatabase.open(databasePath, { masterKey });
      try {
        assert.equal(upgraded.integrityCheck().ok, true);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
