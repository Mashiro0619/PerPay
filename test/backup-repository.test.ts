import assert from "node:assert/strict";
import fs, {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { BackupConfig } from "../src/backup/config.ts";
import {
  createLocalBackup,
  deleteLocalBackupArtifact,
  inspectLocalBackup,
  listLocalBackupArtifacts,
  listLocalBackups,
  pruneLocalBackups,
  recoverInterruptedBackupFiles,
  restoreLocalBackup,
} from "../src/backup/repository.ts";
import { AppDatabase } from "../src/database/database.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configuration(): BackupConfig {
  const root = mkdtempSync(join(tmpdir(), "perpay-local-backup-repository-"));
  directories.push(root);
  const dataDirectory = join(root, "data");
  const backupDirectory = join(root, "backups");
  mkdirSync(dataDirectory);
  mkdirSync(backupDirectory);
  return Object.freeze({
    dataDirectory,
    backupDirectory,
    intervalMilliseconds: 86_400_000,
    keepCount: 7,
  });
}

describe("local SQLite backup repository", () => {
  it("writes a verified online backup directly into the separate backup directory", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    database.write((connection) => {
      connection.prepare(
        "INSERT INTO system_metadata(key, value, updated_at) VALUES ('backup_marker', 'live-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run();
    });
    const instanceId = database.instanceId();
    let backup;
    try {
      backup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T01:00:00.000Z"),
        expectedInstanceId: instanceId,
      });
    } finally {
      database.close();
    }

    assert.equal(backup.instanceId, instanceId);
    assert.equal(backup.schemaVersion, DATABASE_COMPATIBILITY.maximum);
    assert.match(backup.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(existsSync(join(config.backupDirectory, backup.name)), true);
    assert.equal(existsSync(join(config.dataDirectory, backup.name)), false);

    const reopened = new DatabaseSync(join(config.backupDirectory, backup.name), {
      readOnly: true,
      readBigInts: true,
    });
    try {
      assert.equal(
        (reopened.prepare(
          "SELECT value FROM system_metadata WHERE key = 'backup_marker'",
        ).get() as { value: string }).value,
        "live-state",
      );
      assert.equal(
        Number((reopened.prepare("SELECT COUNT(*) AS count FROM app_lease").get() as {
          count: bigint;
        }).count),
        0,
      );
    } finally {
      reopened.close();
    }
  });

  it("lists only fully verified backups and rejects tampering", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let backup;
    try {
      backup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T02:00:00.000Z"),
      });
    } finally {
      database.close();
    }
    assert.deepEqual(
      listLocalBackups(
        config.backupDirectory,
        Date.parse("2026-08-17T02:00:00.000Z"),
      ).map((entry) => entry.name),
      [backup.name],
    );

    writeFileSync(join(config.backupDirectory, backup.name), "not-sqlite");
    assert.throws(
      () => inspectLocalBackup(
        config.backupDirectory,
        backup.name,
        Date.parse("2026-08-17T02:00:00.000Z"),
      ),
      /database|integrity|file is not a database|schema/u,
    );
  });

  it("keeps the newest configured number after preflighting every deletion", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    const backups = [];
    try {
      for (const timestamp of [
        "2026-08-17T03:00:00.000Z",
        "2026-08-17T04:00:00.000Z",
        "2026-08-17T05:00:00.000Z",
      ]) {
        backups.push(await createLocalBackup(config, { now: Date.parse(timestamp) }));
      }
    } finally {
      database.close();
    }

    const result = pruneLocalBackups(
      config.backupDirectory,
      2,
      Date.parse("2026-08-17T06:00:00.000Z"),
    );
    assert.deepEqual(
      result.kept.map((backup) => backup.createdAt),
      ["2026-08-17T05:00:00.000Z", "2026-08-17T04:00:00.000Z"],
    );
    assert.deepEqual(result.deleted.map((backup) => backup.name), [backups[0]?.name]);
    assert.equal(existsSync(join(config.backupDirectory, backups[0]!.name)), false);
  });

  it("never deletes the state-referenced recovery point", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    const backups = [];
    try {
      for (const timestamp of [
        "2026-08-17T03:00:00.000Z",
        "2026-08-17T04:00:00.000Z",
        "2026-08-17T05:00:00.000Z",
      ]) {
        backups.push(await createLocalBackup(config, { now: Date.parse(timestamp) }));
      }
    } finally {
      database.close();
    }
    const protectedBackup = backups[0]!;
    const result = pruneLocalBackups(
      config.backupDirectory,
      1,
      Date.parse("2026-08-17T06:00:00.000Z"),
      protectedBackup.name,
      protectedBackup.instanceId,
    );
    assert.deepEqual(result.kept.map((backup) => backup.name), [protectedBackup.name]);
    assert.equal(existsSync(join(config.backupDirectory, protectedBackup.name)), true);
    assert.equal(result.deleted.length, 2);
  });

  it("preserves a damaged old file without blocking newer recovery points or exact cleanup", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let older;
    let newer;
    try {
      older = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T05:10:00.000Z"),
      });
      newer = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T05:20:00.000Z"),
      });
    } finally {
      database.close();
    }
    writeFileSync(join(config.backupDirectory, older.name), "damaged-backup", {
      mode: 0o600,
    });

    const retention = pruneLocalBackups(
      config.backupDirectory,
      1,
      Date.parse("2026-08-17T05:30:00.000Z"),
      newer.name,
      newer.instanceId,
    );
    assert.deepEqual(retention.kept.map(({ name }) => name), [newer.name]);
    assert.deepEqual(retention.blocked.map(({ name }) => name), [older.name]);
    assert.equal(retention.retainedCount, 2);
    assert.equal(retention.deleted.length, 0);

    const artifacts = listLocalBackupArtifacts(
      config.backupDirectory,
      Date.parse("2026-08-17T05:30:00.000Z"),
    );
    const damaged = artifacts.find(({ name }) => name === older.name);
    assert.equal(damaged?.status, "invalid");
    assert.match(damaged?.sha256 ?? "", /^[0-9a-f]{64}$/u);
    assert.throws(
      () => deleteLocalBackupArtifact(
        config.backupDirectory,
        older.name,
        "0".repeat(64),
        newer.name,
      ),
      /SHA-256/u,
    );
    const deleted = deleteLocalBackupArtifact(
      config.backupDirectory,
      older.name,
      damaged!.sha256!,
      newer.name,
    );
    assert.equal(deleted.name, older.name);
    assert.equal(existsSync(join(config.backupDirectory, older.name)), false);
    assert.throws(
      () => deleteLocalBackupArtifact(
        config.backupDirectory,
        newer.name,
        newer.sha256,
        newer.name,
      ),
      /state-referenced/u,
    );
  });

  it("does not let a damaged state-referenced backup displace the last verified recovery point", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let older;
    let newer;
    try {
      older = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T05:40:00.000Z"),
      });
      newer = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T05:50:00.000Z"),
      });
    } finally {
      database.close();
    }
    writeFileSync(join(config.backupDirectory, newer.name), "damaged-backup", {
      mode: 0o600,
    });

    const retention = pruneLocalBackups(
      config.backupDirectory,
      1,
      Date.parse("2026-08-17T06:00:00.000Z"),
      newer.name,
      older.instanceId,
    );
    assert.deepEqual(retention.kept.map(({ name }) => name), [older.name]);
    assert.deepEqual(retention.blocked.map(({ name }) => name), [newer.name]);
    assert.equal(retention.deleted.length, 0);
    assert.equal(retention.retainedCount, 2);
    assert.equal(existsSync(join(config.backupDirectory, older.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, newer.name)), true);
  });

  it("does not let a newer foreign-instance backup consume the verified retention quota", async () => {
    const config = configuration();
    const primary = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let primaryBackup;
    try {
      primaryBackup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T06:10:00.000Z"),
      });
    } finally {
      primary.close();
    }

    const foreignDataDirectory = join(config.dataDirectory, "foreign");
    mkdirSync(foreignDataDirectory);
    const foreignConfig = Object.freeze({ ...config, dataDirectory: foreignDataDirectory });
    const foreign = await AppDatabase.open(join(foreignDataDirectory, "perpay.sqlite3"));
    let foreignBackup;
    try {
      foreignBackup = await createLocalBackup(foreignConfig, {
        now: Date.parse("2026-08-17T06:20:00.000Z"),
      });
    } finally {
      foreign.close();
    }

    const retention = pruneLocalBackups(
      config.backupDirectory,
      1,
      Date.parse("2026-08-17T06:30:00.000Z"),
      undefined,
      primaryBackup.instanceId,
    );
    assert.deepEqual(retention.kept.map(({ name }) => name), [primaryBackup.name]);
    assert.deepEqual(retention.blocked.map(({ name }) => name), [foreignBackup.name]);
    assert.equal(retention.deleted.length, 0);
    assert.equal(retention.retainedCount, 2);
  });

  it("requires the state-referenced digest and size when protecting a replaced file", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let protectedBackup;
    let replacement;
    try {
      protectedBackup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T06:40:00.000Z"),
      });
      database.write((connection) => {
        connection.prepare(
          "INSERT INTO system_metadata(key, value, updated_at) VALUES ('replacement_marker', 'changed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ).run();
      });
      replacement = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T06:50:00.000Z"),
      });
    } finally {
      database.close();
    }
    copyFileSync(
      join(config.backupDirectory, replacement.name),
      join(config.backupDirectory, protectedBackup.name),
    );

    const retention = pruneLocalBackups(
      config.backupDirectory,
      1,
      Date.parse("2026-08-17T07:00:00.000Z"),
      protectedBackup.name,
      protectedBackup.instanceId,
      protectedBackup.sha256,
      protectedBackup.sizeBytes,
    );
    assert.deepEqual(retention.kept.map(({ name }) => name), [replacement.name]);
    assert.deepEqual(retention.blocked.map(({ name }) => name), [protectedBackup.name]);
    assert.equal(retention.deleted.length, 0);
    assert.equal(existsSync(join(config.backupDirectory, protectedBackup.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, replacement.name)), true);
  });

  it("restores through verified staging on the data volume and preserves the displaced database", async () => {
    const config = configuration();
    const path = join(config.dataDirectory, "perpay.sqlite3");
    const database = await AppDatabase.open(path);
    database.write((connection) => {
      connection.prepare(
        "INSERT INTO system_metadata(key, value, updated_at) VALUES ('restore_marker', 'backup-state', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run();
    });
    const instanceId = database.instanceId();
    let backup;
    try {
      backup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T07:00:00.000Z"),
      });
    } finally {
      database.close();
    }

    const changed = await AppDatabase.open(path);
    try {
      changed.write((connection) => {
        connection.prepare(
          "UPDATE system_metadata SET value = 'newer-state' WHERE key = 'restore_marker'",
        ).run();
      });
    } finally {
      changed.close();
    }

    const restored = restoreLocalBackup(
      config,
      backup.name,
      backup.sha256,
      instanceId,
      Date.parse("2026-08-17T08:00:00.000Z"),
    );
    assert.equal(restored.restoredSchemaVersion, DATABASE_COMPATIBILITY.maximum);
    assert.notEqual(restored.quarantinedDatabaseName, null);
    assert.equal(
      existsSync(join(config.dataDirectory, restored.quarantinedDatabaseName!)),
      true,
    );
    const verification = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        (verification.prepare(
          "SELECT value FROM system_metadata WHERE key = 'restore_marker'",
        ).get() as { value: string }).value,
        "backup-state",
      );
    } finally {
      verification.close();
    }
  });

  it("rejects the wrong hash or application instance before replacing data", async () => {
    const config = configuration();
    const path = join(config.dataDirectory, "perpay.sqlite3");
    const database = await AppDatabase.open(path);
    let backup;
    try {
      backup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T09:00:00.000Z"),
      });
    } finally {
      database.close();
    }

    assert.throws(
      () => restoreLocalBackup(
        config,
        backup.name,
        "0".repeat(64),
        backup.instanceId,
        Date.parse("2026-08-17T10:00:00.000Z"),
      ),
      /SHA-256/u,
    );
    assert.throws(
      () => restoreLocalBackup(
        config,
        backup.name,
        backup.sha256,
        "f".repeat(32),
        Date.parse("2026-08-17T10:00:00.000Z"),
      ),
      /another application instance/u,
    );
    assert.equal(existsSync(path), true);
  });

  it("cleans only exact interrupted temporary backup files", () => {
    const config = configuration();
    const temporary =
      ".creating-12345678-1234-4123-8123-123456789abc.tmp";
    const stateTemporary =
      ".perpay-local-backup-state-12345678-1234-4123-8123-123456789abc.tmp";
    writeFileSync(join(config.backupDirectory, temporary), "partial", { mode: 0o600 });
    writeFileSync(join(config.backupDirectory, stateTemporary), "partial", { mode: 0o600 });
    writeFileSync(join(config.backupDirectory, "operator-note.txt"), "keep", { mode: 0o600 });
    assert.deepEqual(
      recoverInterruptedBackupFiles(config.backupDirectory),
      [stateTemporary, temporary].sort(),
    );
    assert.deepEqual(readdirSync(config.backupDirectory), ["operator-note.txt"]);
  });

  it("finishes an interrupted hard-link publication without deleting the backup", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createLocalBackup>>;
    try {
      backup = await createLocalBackup(config, {
        now: Date.parse("2026-08-17T10:30:00.000Z"),
      });
    } finally {
      database.close();
    }
    const temporary = ".creating-12345678-1234-4123-8123-123456789abc.tmp";
    linkSync(
      join(config.backupDirectory, backup.name),
      join(config.backupDirectory, temporary),
    );
    assert.equal(recoverInterruptedBackupFiles(config.backupDirectory)[0], temporary);
    assert.equal(existsSync(join(config.backupDirectory, backup.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, temporary)), false);
  });

  it("cancels an in-progress SQLite copy and removes every unpublished artifact", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    database.write((connection) => {
      connection.exec("CREATE TABLE cancellation_payload(bytes BLOB NOT NULL)");
      connection.prepare(
        "INSERT INTO cancellation_payload(bytes) VALUES (zeroblob(16777216))",
      ).run();
    });
    const controller = new AbortController();
    try {
      const pending = createLocalBackup(config, {
        now: Date.parse("2026-08-17T11:00:00.000Z"),
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      assert.deepEqual(readdirSync(config.backupDirectory), []);
    } finally {
      database.close();
    }
  });

  it("never overwrites an existing final name during publication", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    const originalLinkSync = fs.linkSync;
    let collisionPath: string | null = null;
    const hookedLinkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      const target = String(newPath);
      if (target.includes(".backup-") && target.endsWith(".sqlite3")) {
        collisionPath = target;
        writeFileSync(target, "operator-owned", { flag: "wx", mode: 0o600 });
      }
      return originalLinkSync(existingPath, newPath);
    }) as typeof fs.linkSync;
    assert.equal(Reflect.set(fs, "linkSync", hookedLinkSync), true);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        createLocalBackup(config, {
          now: Date.parse("2026-08-17T12:00:00.000Z"),
        }),
        /EEXIST|exist/u,
      );
      assert.notEqual(collisionPath, null);
      assert.equal(readFileSync(collisionPath!, "utf8"), "operator-owned");
    } finally {
      assert.equal(Reflect.set(fs, "linkSync", originalLinkSync), true);
      syncBuiltinESMExports();
      database.close();
    }
  });
});
