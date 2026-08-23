import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { AppDatabase, sha256FileSync } from "../src/database/database.ts";
import {
  clearStaleMaintenanceLock,
  createOperationalBackup,
  clearStalePublicationLock,
  inspectMaintenanceLock,
  inspectPublicationLock,
  listMigrationBackups,
  publicationLockPath,
  restoreMigrationBackup,
  restoreOperationalBackup,
} from "../src/database/maintenance.ts";
import {
  acquireDatabaseMaintenanceLock,
  databaseMaintenanceLockPath,
} from "../src/database/maintenance-lock.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

const directories: string[] = [];
const TEST_MASTER_KEY = Buffer.alloc(32, 0x11);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migration backup maintenance", () => {
  it("exposes and clears a stale cross-volume publication lock", () => {
    const backupDirectory = temporaryDirectory();
    const now = Date.parse("2026-08-23T00:00:00.000Z");
    const anchor = join(backupDirectory, ".perpay-source-publication");
    const lock = acquireDatabaseMaintenanceLock(
      anchor,
      "publish-operational-backup",
      now,
    );
    assert.equal(lock.path, publicationLockPath(backupDirectory));
    assert.equal(inspectPublicationLock(backupDirectory, now).status, "active");
    assert.throws(
      () => clearStalePublicationLock({
        backupDirectory,
        lockToken: lock.token,
        confirmNoMaintenanceProcess: true,
        now: now + 1,
      }),
      /not older than the seven-hour safety interval/u,
    );
    const cleared = clearStalePublicationLock({
      backupDirectory,
      lockToken: lock.token,
      confirmNoMaintenanceProcess: true,
      now: now + 7 * 60 * 60 * 1_000 + 1,
    });
    assert.equal(cleared.token, lock.token);
    assert.equal(inspectPublicationLock(backupDirectory, now).status, "missing");
  });

  it("clears an unreadable stale publication lock from the maintenance CLI", () => {
    const backupDirectory = temporaryDirectory();
    const lockPath = publicationLockPath(backupDirectory);
    fs.writeFileSync(lockPath, "{", { mode: 0o600 });
    const staleAt = new Date(Date.now() - 7 * 60 * 60 * 1_000 - 1_000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("src/database/maintenance.ts"),
        "clear-stale-publication-lock",
        "--force-unreadable-lock",
        "--confirm-no-maintenance-process",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PERPAY_DATA_DIR: join(temporaryDirectory(), "missing-data-directory"),
          PERPAY_BACKUP_DIR: backupDirectory,
          PERPAY_MASTER_KEY: "not-a-valid-key",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(lockPath), false);
  });

  it("clears an unreadable database maintenance lock from the maintenance CLI", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.close();
    const lockPath = databaseMaintenanceLockPath(databasePath);
    fs.writeFileSync(lockPath, "{", { mode: 0o600 });

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("src/database/maintenance.ts"),
        "clear-stale-maintenance-lock",
        "--force-unreadable-lock",
        "--confirm-no-maintenance-process",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PERPAY_DATA_DIR: directory,
          PERPAY_BACKUP_DIR: temporaryDirectory(),
          PERPAY_MASTER_KEY: "not-a-valid-key",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(lockPath), false);
  });

  it("rejects an operational restore before replacement when the master key is wrong", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    const backup = await createOperationalBackup({ dataDirectory: directory });
    database.close();

    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: directory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: Buffer.alloc(32, 0x22),
      }),
      /does not match this database/u,
    );
    assert.equal(existsSync(databasePath), true);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), false);
  });

  it("requires a deployment master key for every restore API", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    const backup = await createOperationalBackup({ dataDirectory: directory });
    const migrationName =
      "perpay.sqlite3.pre-migration-v" + DATABASE_COMPATIBILITY.maximum +
      "-to-v" + (DATABASE_COMPATIBILITY.maximum + 1) + ".sqlite3";
    await database.backupDetailed(join(directory, migrationName));
    database.close();

    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: directory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: undefined as unknown as Uint8Array,
      }),
      /deployment master key is required/u,
    );
    assert.throws(
      () => restoreMigrationBackup({
        dataDirectory: directory,
        backupName: migrationName,
        confirmReplaceCurrentDatabase: true,
        masterKey: undefined as unknown as Uint8Array,
      }),
      /deployment master key is required/u,
    );
    assert.equal(existsSync(databasePath), true);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), false);
  });

  it("loads the migration restore key from the mounted secrets directory", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const backupName =
      "perpay.sqlite3.pre-migration-v" + DATABASE_COMPATIBILITY.maximum +
      "-to-v" + (DATABASE_COMPATIBILITY.maximum + 1) + ".sqlite3";
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(join(directory, backupName));
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('migration_cli_restore_marker', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
    } finally {
      database.close();
    }
    const secretsDirectory = join(directory, "secrets");
    fs.mkdirSync(secretsDirectory, { mode: 0o700 });
    fs.writeFileSync(join(secretsDirectory, "master-key"), `${TEST_MASTER_KEY.toString("hex")}\n`, {
      mode: 0o600,
    });

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("src/database/maintenance.ts"),
        "restore-migration-backup",
        backupName,
        "--confirm-replace-current-database",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PERPAY_DATA_DIR: directory,
          PERPAY_BACKUP_DIR: temporaryDirectory(),
          PERPAY_SECRETS_DIR: secretsDirectory,
          PERPAY_MASTER_KEY: undefined,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const restored = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        restored.prepare(
          "SELECT value FROM system_metadata WHERE key = 'migration_cli_restore_marker'",
        ).get(),
        undefined,
      );
    } finally {
      restored.close();
    }
  });

  it("creates a self-contained current-state backup while the application is running", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    try {
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('online_backup_marker', 'present', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
      const backup = await createOperationalBackup({ dataDirectory: directory });

      assert.match(backup.name, /^perpay\.sqlite3\.backup-.+\.sqlite3$/);
      assert.equal(backup.schemaVersion, DATABASE_COMPATIBILITY.maximum);
      assert.ok(backup.pages > 0);
      assert.match(backup.sha256, /^[0-9a-f]{64}$/);
      assert.equal(existsSync(join(directory, backup.name)), true);

      const copy = new DatabaseSync(join(directory, backup.name), {
        readOnly: true,
        readBigInts: true,
      });
      try {
        assert.equal(
          (copy.prepare("SELECT value FROM system_metadata WHERE key = 'online_backup_marker'").get() as { value: string }).value,
          "present",
        );
        assert.equal(
          Number((copy.prepare("SELECT COUNT(*) AS count FROM app_lease").get() as { count: bigint }).count),
          0,
        );
      } finally {
        copy.close();
      }
    } finally {
      database.close();
    }
  });

  it("rejects and removes an unpublished online backup if restore replaces the database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.write((connection) => {
      connection.prepare(
        "INSERT INTO system_metadata(key, value, updated_at) VALUES ('replacement_marker', 'backup-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run();
    });
    const restoreSource = await createOperationalBackup({ dataDirectory: directory });
    database.write((connection) => {
      connection.prepare(
        "UPDATE system_metadata SET value = 'active-state' WHERE key = 'replacement_marker'",
      ).run();
    });
    database.close();

    const operationalBackupsBefore = readdirSync(directory)
      .filter((name) => name.startsWith("perpay.sqlite3.backup-"))
      .sort();
    const lockPath = databaseMaintenanceLockPath(databasePath);
    const originalOpenSync = fs.openSync;
    let restoreCompleted = false;
    const hookedOpenSync = ((...arguments_: Parameters<typeof fs.openSync>) => {
      const requestedPath = arguments_[0];
      if (
        !restoreCompleted &&
        typeof requestedPath === "string" &&
        resolve(requestedPath) === lockPath &&
        arguments_[1] === "wx"
      ) {
        restoreCompleted = true;
        restoreOperationalBackup({
          dataDirectory: directory,
          backupName: restoreSource.name,
          expectedSha256: restoreSource.sha256,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        });
      }
      return Reflect.apply(originalOpenSync, fs, arguments_);
    }) as typeof fs.openSync;
    assert.equal(Reflect.set(fs, "openSync", hookedOpenSync), true);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => createOperationalBackup({ dataDirectory: directory }),
        /path identity changed while the online backup was being created/,
      );
    } finally {
      assert.equal(Reflect.set(fs, "openSync", originalOpenSync), true);
      syncBuiltinESMExports();
    }

    assert.equal(restoreCompleted, true);
    assert.deepEqual(
      readdirSync(directory)
        .filter((name) => name.startsWith("perpay.sqlite3.backup-"))
        .sort(),
      operationalBackupsBefore,
    );
    assert.equal(existsSync(lockPath), false);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (restored.prepare(
          "SELECT value FROM system_metadata WHERE key = 'replacement_marker'",
        ).get() as { value: string }).value,
        "backup-state",
      );
    } finally {
      restored.close();
    }
  });

  it("restores a staged current-state backup into a fresh data directory", async () => {
    const sourceDirectory = temporaryDirectory();
    const sourceDatabase = await openTestDatabase(join(sourceDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      sourceDatabase.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('external_restore_marker', 'source-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
      backup = await createOperationalBackup({ dataDirectory: sourceDirectory });
    } finally {
      sourceDatabase.close();
    }

    const targetDirectory = temporaryDirectory();
    copyFileSync(
      join(sourceDirectory, backup.name),
      join(targetDirectory, backup.name),
    );
    const result = restoreOperationalBackup({
      dataDirectory: targetDirectory,
      backupName: backup.name,
      expectedSha256: backup.sha256,
      confirmReplaceCurrentDatabase: true,
      masterKey: TEST_MASTER_KEY,
    });

    assert.deepEqual(result, {
      backupName: backup.name,
      restoredSchemaVersion: DATABASE_COMPATIBILITY.maximum,
      sha256: backup.sha256,
      quarantinedDatabaseName: null,
    });
    assert.equal(existsSync(join(targetDirectory, "perpay.sqlite3")), true);
    assert.equal(lstatSync(join(targetDirectory, "perpay.sqlite3")).nlink, 1);
    assert.equal(existsSync(databaseMaintenanceLockPath(join(targetDirectory, "perpay.sqlite3"))), false);
    assert.deepEqual(
      readdirSync(targetDirectory).filter((name) =>
        name.includes(".restore-") || name.endsWith(".staging") ||
        name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal")
      ),
      [],
    );

    const restored = new DatabaseSync(join(targetDirectory, "perpay.sqlite3"), {
      readOnly: true,
      readBigInts: true,
    });
    try {
      assert.equal(
        (restored.prepare(
          "SELECT value FROM system_metadata WHERE key = 'external_restore_marker'",
        ).get() as { value: string }).value,
        "source-state",
      );
      assert.equal(
        Number((restored.prepare("SELECT COUNT(*) AS count FROM app_lease").get() as { count: bigint }).count),
        0,
      );
    } finally {
      restored.close();
    }

    const reopened = await openTestDatabase(join(targetDirectory, "perpay.sqlite3"));
    reopened.close();
  });

  it("refuses a fresh restore beside orphaned SQLite sidecars and preserves recovery state", async () => {
    const sourceDirectory = temporaryDirectory();
    const sourceDatabase = await openTestDatabase(join(sourceDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: sourceDirectory });
    } finally {
      sourceDatabase.close();
    }

    const targetDirectory = temporaryDirectory();
    const databasePath = join(targetDirectory, "perpay.sqlite3");
    copyFileSync(join(sourceDirectory, backup.name), join(targetDirectory, backup.name));
    closeSync(openSync(`${databasePath}-wal`, "wx", 0o600));

    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /fresh restore target is not self-contained because -wal exists/,
    );
    const lock = inspectMaintenanceLock(targetDirectory);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(`${databasePath}-wal`), true);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), true);

    rmSync(`${databasePath}-wal`);
    clearStaleMaintenanceLock({
      dataDirectory: targetDirectory,
      lockToken: lock.token,
      confirmNoMaintenanceProcess: true,
    });
    const result = restoreOperationalBackup({
      dataDirectory: targetDirectory,
      backupName: backup.name,
      expectedSha256: backup.sha256,
      confirmReplaceCurrentDatabase: true,
      masterKey: TEST_MASTER_KEY,
    });
    assert.equal(result.quarantinedDatabaseName, null);
    assert.equal(lstatSync(databasePath).nlink, 1);
  });

  it("refuses a live target and preserves the old database when later replacing it", async () => {
    const sourceDirectory = temporaryDirectory();
    const sourceDatabase = await openTestDatabase(join(sourceDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      sourceDatabase.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('external_restore_marker', 'source-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
      backup = await createOperationalBackup({ dataDirectory: sourceDirectory });
    } finally {
      sourceDatabase.close();
    }

    const targetDirectory = temporaryDirectory();
    const targetPath = join(targetDirectory, "perpay.sqlite3");
    const targetDatabase = await openTestDatabase(targetPath);
    targetDatabase.write((connection) => {
      connection.prepare(
        "INSERT INTO system_metadata(key, value, updated_at) VALUES ('pre_restore_marker', 'target-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run();
    });
    copyFileSync(
      join(sourceDirectory, backup.name),
      join(targetDirectory, backup.name),
    );

    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /still owned/,
    );
    assert.equal(existsSync(databaseMaintenanceLockPath(targetPath)), false);
    assert.equal(
      (targetDatabase.read((connection) => connection.prepare(
        "SELECT value FROM system_metadata WHERE key = 'pre_restore_marker'",
      ).get()) as { value: string }).value,
      "target-state",
    );
    targetDatabase.close();

    const result = restoreOperationalBackup({
      dataDirectory: targetDirectory,
      backupName: backup.name,
      expectedSha256: backup.sha256,
      confirmReplaceCurrentDatabase: true,
      masterKey: TEST_MASTER_KEY,
    });
    assert.notEqual(result.quarantinedDatabaseName, null);
    assert.equal(existsSync(join(targetDirectory, result.quarantinedDatabaseName ?? "")), true);

    const restored = new DatabaseSync(targetPath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        (restored.prepare(
          "SELECT value FROM system_metadata WHERE key = 'external_restore_marker'",
        ).get() as { value: string }).value,
        "source-state",
      );
      assert.equal(
        restored.prepare("SELECT value FROM system_metadata WHERE key = 'pre_restore_marker'").get(),
        undefined,
      );
    } finally {
      restored.close();
    }

    const quarantined = new DatabaseSync(
      join(targetDirectory, result.quarantinedDatabaseName ?? ""),
      { readOnly: true, readBigInts: true },
    );
    try {
      assert.equal(
        (quarantined.prepare(
          "SELECT value FROM system_metadata WHERE key = 'pre_restore_marker'",
        ).get() as { value: string }).value,
        "target-state",
      );
    } finally {
      quarantined.close();
    }
  });

  it("requires an exact backup basename, SHA-256, ordinary file, and no sidecars", async () => {
    const sourceDirectory = temporaryDirectory();
    const sourceDatabase = await openTestDatabase(join(sourceDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: sourceDirectory });
    } finally {
      sourceDatabase.close();
    }

    const targetDirectory = temporaryDirectory();
    const backupPath = join(targetDirectory, backup.name);
    copyFileSync(join(sourceDirectory, backup.name), backupPath);

    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: false,
        masterKey: TEST_MASTER_KEY,
      }),
      /explicit replacement confirmation/,
    );
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: `../${backup.name}`,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /name is invalid/,
    );
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: backup.sha256.toUpperCase(),
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /64 lowercase hexadecimal/,
    );
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: "0".repeat(64),
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /does not match/,
    );
    assert.equal(existsSync(join(targetDirectory, "perpay.sqlite3")), false);

    const sidecar = openSync(`${backupPath}-wal`, "wx", 0o600);
    closeSync(sidecar);
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /not self-contained/,
    );
    rmSync(`${backupPath}-wal`);

    const forged = new DatabaseSync(backupPath);
    try {
      forged.exec("DROP TABLE system_metadata; PRAGMA journal_mode = DELETE;");
    } finally {
      forged.close();
    }
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: backup.name,
        expectedSha256: sha256FileSync(backupPath),
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /failed application integrity checks/,
    );
    copyFileSync(join(sourceDirectory, backup.name), backupPath);

    const linkedName = backup.name.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite3$/u,
      "00000000-0000-4000-8000-000000000000.sqlite3",
    );
    linkSync(backupPath, join(targetDirectory, linkedName));
    assert.throws(
      () => restoreOperationalBackup({
        dataDirectory: targetDirectory,
        backupName: linkedName,
        expectedSha256: backup.sha256,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /ordinary file with one link/,
    );
  });

  it("restores a verified backup and preserves the replaced database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(join(directory, backupName));
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('restore_test_marker', 'new-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
    } finally {
      database.close();
    }

    const result = restoreMigrationBackup({
      dataDirectory: directory,
      backupName,
      confirmReplaceCurrentDatabase: true,
      masterKey: TEST_MASTER_KEY,
    });

    assert.equal(result.backupName, backupName);
    assert.equal(result.restoredSchemaVersion, fromVersion);
    assert.equal(existsSync(join(directory, result.quarantinedDatabaseName)), true);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes(".restore-") || name.endsWith(".staging") || name.endsWith("-wal") || name.endsWith("-shm")),
      [],
    );
    assert.deepEqual(listMigrationBackups(directory), [{
      name: backupName,
      fromVersion,
      toVersion: fromVersion + 1,
    }]);

    const restored = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        restored.prepare("SELECT value FROM system_metadata WHERE key = 'restore_test_marker'").get(),
        undefined,
      );
    } finally {
      restored.close();
    }

    const quarantined = new DatabaseSync(join(directory, result.quarantinedDatabaseName), {
      readOnly: true,
      readBigInts: true,
    });
    try {
      const marker = quarantined.prepare(
        "SELECT value FROM system_metadata WHERE key = 'restore_test_marker'",
      ).get() as { value: string } | undefined;
      assert.equal(marker?.value, "new-state");
    } finally {
      quarantined.close();
    }

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("rejects a migration backup replaced after source preflight", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const backupPath = join(directory, backupName);
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(backupPath);
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('migration_source_race_target_marker', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
    } finally {
      database.close();
    }

    const foreignDirectory = temporaryDirectory();
    const foreignDatabasePath = join(foreignDirectory, "perpay.sqlite3");
    const foreignBackupPath = join(foreignDirectory, "replacement.sqlite3");
    const foreignDatabase = await AppDatabase.open(foreignDatabasePath);
    try {
      new RuntimeSettingsStore(foreignDatabase, Buffer.alloc(32, 0x22)).initialize();
      await foreignDatabase.backupDetailed(foreignBackupPath);
    } finally {
      foreignDatabase.close();
    }
    const replacementStaging = join(directory, ".migration-source-replacement.tmp");
    copyFileSync(foreignBackupPath, replacementStaging);

    const lockPath = databaseMaintenanceLockPath(databasePath);
    const originalOpenSync = fs.openSync;
    let sourceReplaced = false;
    const hookedOpenSync = ((...arguments_: Parameters<typeof fs.openSync>) => {
      const requestedPath = arguments_[0];
      if (
        !sourceReplaced &&
        typeof requestedPath === "string" &&
        resolve(requestedPath) === lockPath &&
        arguments_[1] === "wx"
      ) {
        fs.renameSync(replacementStaging, backupPath);
        sourceReplaced = true;
      }
      return Reflect.apply(originalOpenSync, fs, arguments_);
    }) as typeof fs.openSync;
    assert.equal(Reflect.set(fs, "openSync", hookedOpenSync), true);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => restoreMigrationBackup({
          dataDirectory: directory,
          backupName,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        }),
        /migration backup changed after source preflight/u,
      );
    } finally {
      assert.equal(Reflect.set(fs, "openSync", originalOpenSync), true);
      syncBuiltinESMExports();
    }

    assert.equal(sourceReplaced, true);
    assert.equal(existsSync(lockPath), false);
    const retained = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        (retained.prepare(
          "SELECT value FROM system_metadata WHERE key = 'migration_source_race_target_marker'",
        ).get() as { value: string }).value,
        "active",
      );
    } finally {
      retained.close();
    }
  });

  it("does not trust a migration restore target replaced while preparing its lease", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const backupPath = join(directory, backupName);
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(backupPath);
    } finally {
      database.close();
    }

    const replacementPath = join(directory, ".migration-preparation-target-replacement.tmp");
    const originalLstatSync = fs.lstatSync;
    let targetLstatCalls = 0;
    let targetReplaced = false;
    const hookedLstatSync = ((...arguments_: Parameters<typeof fs.lstatSync>) => {
      const requestedPath = arguments_[0];
      if (typeof requestedPath === "string" && resolve(requestedPath) === databasePath) {
        targetLstatCalls += 1;
        if (!targetReplaced && targetLstatCalls === 3) {
          copyFileSync(databasePath, replacementPath);
          const replacement = new DatabaseSync(replacementPath, { readBigInts: true });
          try {
            replacement.prepare(
              "INSERT INTO system_metadata(key, value, updated_at) VALUES ('migration_preparation_race_marker', 'replacement', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            ).run();
          } finally {
            replacement.close();
          }
          fs.renameSync(replacementPath, databasePath);
          targetReplaced = true;
        }
      }
      return Reflect.apply(originalLstatSync, fs, arguments_);
    }) as typeof fs.lstatSync;
    assert.equal(Reflect.set(fs, "lstatSync", hookedLstatSync), true);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => restoreMigrationBackup({
          dataDirectory: directory,
          backupName,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        }),
        /application database path identity changed while the database restore was being prepared/u,
      );
    } finally {
      assert.equal(Reflect.set(fs, "lstatSync", originalLstatSync), true);
      syncBuiltinESMExports();
    }

    assert.equal(targetReplaced, true);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), false);
    const replacement = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        (replacement.prepare(
          "SELECT value FROM system_metadata WHERE key = 'migration_preparation_race_marker'",
        ).get() as { value: string }).value,
        "replacement",
      );
    } finally {
      replacement.close();
    }
  });

  it("does not overwrite a migration restore target replaced after quarantine", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const backupPath = join(directory, backupName);
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(backupPath);
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('migration_target_race_original_marker', 'original', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
    } finally {
      database.close();
    }

    const replacementPath = join(directory, ".migration-target-replacement.tmp");
    const originalRenameSync = fs.renameSync;
    let targetReplaced = false;
    const hookedRenameSync = ((...arguments_: Parameters<typeof fs.renameSync>) => {
      const result = Reflect.apply(originalRenameSync, fs, arguments_);
      const sourcePath = arguments_[0];
      const destinationPath = arguments_[1];
      if (
        !targetReplaced &&
        typeof sourcePath === "string" &&
        typeof destinationPath === "string" &&
        sourcePath.endsWith(".staging") &&
        basename(destinationPath).startsWith("perpay.sqlite3.before-restore-")
      ) {
        copyFileSync(databasePath, replacementPath);
        const replacement = new DatabaseSync(replacementPath, { readBigInts: true });
        try {
          replacement.prepare(
            "INSERT INTO system_metadata(key, value, updated_at) VALUES ('migration_target_race_replacement_marker', 'replacement', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          ).run();
        } finally {
          replacement.close();
        }
        Reflect.apply(originalRenameSync, fs, [replacementPath, databasePath]);
        targetReplaced = true;
      }
      return result;
    }) as typeof fs.renameSync;
    assert.equal(Reflect.set(fs, "renameSync", hookedRenameSync), true);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => restoreMigrationBackup({
          dataDirectory: directory,
          backupName,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        }),
        /application database changed while it was being copied/u,
      );
    } finally {
      assert.equal(Reflect.set(fs, "renameSync", originalRenameSync), true);
      syncBuiltinESMExports();
    }

    assert.equal(targetReplaced, true);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), false);
    const replacement = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        (replacement.prepare(
          "SELECT value FROM system_metadata WHERE key = 'migration_target_race_replacement_marker'",
        ).get() as { value: string }).value,
        "replacement",
      );
    } finally {
      replacement.close();
    }
  });

  it("refuses restore while the application still owns the database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(join(directory, backupName));
      assert.throws(
        () => restoreMigrationBackup({
          dataDirectory: directory,
          backupName,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        }),
        /still owned/,
      );
    } finally {
      database.close();
    }
  });

  it("rejects a backup whose schema disagrees with its filename", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const backupName = "perpay.sqlite3.pre-migration-v1-to-v2.sqlite3";
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(join(directory, backupName));
    } finally {
      database.close();
    }

    assert.throws(
      () => restoreMigrationBackup({
        dataDirectory: directory,
        backupName,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /schema does not match/,
    );
  });

  it("accepts only generated backup basenames inside the data directory", () => {
    const directory = temporaryDirectory();
    assert.throws(
      () => restoreMigrationBackup({
        dataDirectory: directory,
        backupName: "../perpay.sqlite3.pre-migration-v1-to-v2.sqlite3",
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /name is invalid/,
    );
  });

  it("requires an explicit acknowledgement before replacing the active database", () => {
    const directory = temporaryDirectory();
    assert.throws(
      () => restoreMigrationBackup({
        dataDirectory: directory,
        backupName: "perpay.sqlite3.pre-migration-v1-to-v2.sqlite3",
        confirmReplaceCurrentDatabase: false,
        masterKey: TEST_MASTER_KEY,
      }),
      /explicit replacement confirmation/,
    );
  });

  it("rejects a backup with WAL state instead of silently copying only its main file", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const backupPath = join(directory, backupName);
    const database = await openTestDatabase(databasePath);
    try {
      await database.backupDetailed(backupPath);
    } finally {
      database.close();
    }

    const writer = new DatabaseSync(backupPath, { readBigInts: true });
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.prepare(
        "INSERT INTO system_metadata(key, value, updated_at) VALUES ('wal_only', 'present', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run();
      assert.equal(existsSync(`${backupPath}-wal`), true);
      assert.throws(
        () => restoreMigrationBackup({
          dataDirectory: directory,
          backupName,
          confirmReplaceCurrentDatabase: true,
          masterKey: TEST_MASTER_KEY,
        }),
        /not self-contained/,
      );
    } finally {
      writer.close();
    }
  });

  it("rejects forged migration metadata without the application schema", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const fromVersion = DATABASE_COMPATIBILITY.maximum;
    const backupName = `perpay.sqlite3.pre-migration-v${fromVersion}-to-v${fromVersion + 1}.sqlite3`;
    const database = await openTestDatabase(databasePath);
    database.close();

    const forged = new DatabaseSync(join(directory, backupName));
    try {
      forged.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY) STRICT;
        INSERT INTO schema_migrations(version) VALUES (${fromVersion});
        PRAGMA journal_mode = DELETE;
      `);
    } finally {
      forged.close();
    }

    assert.throws(
      () => restoreMigrationBackup({
        dataDirectory: directory,
        backupName,
        confirmReplaceCurrentDatabase: true,
        masterKey: TEST_MASTER_KEY,
      }),
      /application integrity checks/,
    );
  });

  it("prevents application startup while a database maintenance lock is held", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.close();

    const lock = acquireDatabaseMaintenanceLock(databasePath, "test-restore", Date.now());
    try {
      await assert.rejects(
        () => openTestDatabase(databasePath),
        /database maintenance is in progress/,
      );
    } finally {
      lock.release();
    }

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("makes an already open application fail closed while maintenance is pending", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    const lock = acquireDatabaseMaintenanceLock(databasePath, "test-concurrent-restore", Date.now());
    try {
      assert.throws(
        () => database.read((connection) => connection.prepare("SELECT 1").get()),
        /database maintenance is in progress/,
      );
      assert.throws(
        () => database.write((connection) => connection.prepare("SELECT 1").get()),
        /database maintenance is in progress/,
      );
    } finally {
      lock.release();
    }

    assert.notEqual(database.read((connection) => connection.prepare("SELECT 1").get()), undefined);
    database.close();
  });

  it("reports not ready as soon as a maintenance lock is created", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    const lock = acquireDatabaseMaintenanceLock(databasePath, "test-health-lock", Date.now());
    try {
      // The maintenance workflow claims its persisted lease only after it has
      // begun validating the database. Readiness must fail during that gap.
      assert.deepEqual(database.health(), {
        ok: false,
        result: "database_maintenance_in_progress",
      });
    } finally {
      lock.release();
      database.close();
    }
  });

  it("clears a stale maintenance lock only with its exact token and no live app lease", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.close();

    const lock = acquireDatabaseMaintenanceLock(databasePath, "interrupted-restore", Date.now());
    assert.equal(inspectMaintenanceLock(directory).token, lock.token);
    assert.throws(
      () => clearStaleMaintenanceLock({
        dataDirectory: directory,
        lockToken: randomWrongToken(),
        confirmNoMaintenanceProcess: true,
      }),
      /token does not match/,
    );
    const cleared = clearStaleMaintenanceLock({
      dataDirectory: directory,
      lockToken: lock.token,
      confirmNoMaintenanceProcess: true,
    });
    assert.equal(cleared.token, lock.token);

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("strictly finalizes the two-link state left by an interrupted fresh restore", async () => {
    const sourceDirectory = temporaryDirectory();
    const sourceDatabase = await openTestDatabase(join(sourceDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: sourceDirectory });
    } finally {
      sourceDatabase.close();
    }

    const targetDirectory = temporaryDirectory();
    const backupDirectory = temporaryDirectory();
    const backupPath = join(backupDirectory, backup.name);
    const databasePath = join(targetDirectory, "perpay.sqlite3");
    const stagingPath = join(
      targetDirectory,
      ".perpay.sqlite3.restore-00000000-0000-4000-8000-000000000001.tmp",
    );
    copyFileSync(join(sourceDirectory, backup.name), backupPath);
    copyFileSync(backupPath, stagingPath);
    linkSync(stagingPath, databasePath);
    const lock = acquireDatabaseMaintenanceLock(
      databasePath,
      `restore-backup:${backup.name}`,
      Date.now(),
    );

    assert.equal(lstatSync(databasePath).nlink, 2);
    assert.throws(
      () => clearStaleMaintenanceLock({
        dataDirectory: targetDirectory,
        lockToken: lock.token,
        confirmNoMaintenanceProcess: true,
      }),
      /ordinary file with one link/,
    );
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), true);
    assert.equal(existsSync(stagingPath), true);

    const finalized = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve("src/database/maintenance.ts"),
        "clear-stale-maintenance-lock",
        lock.token,
        "--confirm-no-maintenance-process",
        "--finalize-interrupted-fresh-restore",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PERPAY_DATA_DIR: targetDirectory,
          PERPAY_BACKUP_DIR: backupDirectory,
        },
      },
    );
    assert.equal(finalized.status, 0, finalized.stderr);
    const cleared = JSON.parse(finalized.stdout) as { token: string };
    assert.equal(cleared.token, lock.token);
    assert.equal(lstatSync(databasePath).nlink, 1);
    assert.equal(existsSync(stagingPath), false);
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), false);
    assert.equal(lstatSync(backupPath).nlink, 1);

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("requires an explicit force flag before abandoning a live maintenance lease", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.close();

    const lock = acquireDatabaseMaintenanceLock(databasePath, "interrupted-restore", Date.now());
    const raw = new DatabaseSync(databasePath, { readBigInts: true });
    try {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      raw.prepare(
        `INSERT INTO app_lease(
            lease_key, owner_token, owner_pid, owner_host, acquired_at, expires_at
          ) VALUES (1, ?, ?, 'maintenance', ?, ?)`,
      ).run(`maintenance:${lock.token}`, process.pid, Date.now(), expiresAt);
    } finally {
      raw.close();
    }

    assert.throws(
      () => clearStaleMaintenanceLock({
        dataDirectory: directory,
        lockToken: lock.token,
        confirmNoMaintenanceProcess: true,
      }),
      /maintenance lease is still live/,
    );
    assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), true);

    const cleared = clearStaleMaintenanceLock({
      dataDirectory: directory,
      lockToken: lock.token,
      confirmNoMaintenanceProcess: true,
      forceAbandonMaintenanceLease: true,
    });
    assert.equal(cleared.token, lock.token);

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("does not let force-abandon override a live application lease", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    const lock = acquireDatabaseMaintenanceLock(databasePath, "unsafe-clear", Date.now());
    try {
      assert.throws(
        () => clearStaleMaintenanceLock({
          dataDirectory: directory,
          lockToken: lock.token,
          confirmNoMaintenanceProcess: true,
          forceAbandonMaintenanceLease: true,
        }),
        /live application lease prevents clearing/,
      );
      assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), true);
    } finally {
      lock.release();
      database.close();
    }
  });

  it("provides an explicit recovery path for a lock whose record was never written", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await openTestDatabase(databasePath);
    database.close();

    const lockPath = databaseMaintenanceLockPath(databasePath);
    const handle = openSync(lockPath, "wx", 0o600);
    closeSync(handle);
    assert.throws(() => inspectMaintenanceLock(directory), /ordinary file|unreadable|invalid/);
    const result = clearStaleMaintenanceLock({
      dataDirectory: directory,
      confirmNoMaintenanceProcess: true,
      forceUnreadableLock: true,
    });
    assert.equal(result.operation, "unreadable-lock-cleared");

    const reopened = await openTestDatabase(databasePath);
    reopened.close();
  });

  it("preserves every maintenance lock beside an orphaned SQLite sidecar", () => {
    for (const unreadable of [false, true]) {
      const directory = temporaryDirectory();
      const databasePath = join(directory, "perpay.sqlite3");
      const lock = acquireDatabaseMaintenanceLock(
        databasePath,
        unreadable ? "unreadable-orphaned-sidecar" : "orphaned-sidecar",
        Date.now(),
      );
      fs.writeFileSync(`${databasePath}-wal`, "orphaned-wal-state", { mode: 0o600 });
      if (unreadable) {
        fs.writeFileSync(databaseMaintenanceLockPath(databasePath), "{", { mode: 0o600 });
      }

      assert.throws(
        () => clearStaleMaintenanceLock({
          dataDirectory: directory,
          ...(unreadable
            ? { forceUnreadableLock: true }
            : { lockToken: lock.token }),
          confirmNoMaintenanceProcess: true,
        }),
        /not self-contained because -wal exists/,
      );
      assert.equal(existsSync(databaseMaintenanceLockPath(databasePath)), true);
      assert.equal(existsSync(`${databasePath}-wal`), true);
      assert.equal(existsSync(databasePath), false);
    }
  });
});

async function openTestDatabase(path: string): Promise<AppDatabase> {
  const database = await AppDatabase.open(path);
  new RuntimeSettingsStore(database, TEST_MASTER_KEY).initialize();
  return database;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "perpay-maintenance-"));
  directories.push(directory);
  return directory;
}

function randomWrongToken(): string {
  return "00000000-0000-4000-8000-000000000000";
}
