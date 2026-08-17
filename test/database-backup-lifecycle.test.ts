import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AppDatabase, sha256FileSync } from "../src/database/database.ts";
import {
  createOperationalBackup,
  deleteBackupArtifact,
  deletePreRestoreQuarantine,
  listBackupArtifacts,
  listPreRestoreQuarantines,
  pruneOperationalBackups,
  prunePreRestoreQuarantines,
  restoreOperationalBackup,
} from "../src/database/maintenance.ts";
import { acquireDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const directories: string[] = [];
const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database backup artifact lifecycle", () => {
  it("classifies every recognized artifact and returns bounded deterministic metadata", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let operational: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      operational = await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T02:03:04.005Z"),
      });
      await database.backupDetailed(join(
        directory,
        `perpay.sqlite3.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum + 1}.sqlite3`,
      ));
    } finally {
      database.close();
    }
    const quarantineName =
      `perpay.sqlite3.before-restore-2026-08-16T03-04-05.006Z-${UUIDS[0]}`;
    copyFileSync(join(directory, operational.name), join(directory, quarantineName));
    fs.writeFileSync(join(directory, "perpay.sqlite3-wal"), "not-an-artifact");
    fs.writeFileSync(join(directory, ".perpay.sqlite3.restore-not-staging.tmp"), "ignored");

    const artifacts = listBackupArtifacts(directory);

    assert.deepEqual(
      artifacts.map(({ name, classification }) => ({ name, classification })),
      [
        { name: operational.name, classification: "operational" },
        {
          name: `perpay.sqlite3.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum + 1}.sqlite3`,
          classification: "migration",
        },
        { name: quarantineName, classification: "pre-restore-quarantine" },
      ],
    );
    for (const artifact of artifacts) {
      assert.equal(Number.isSafeInteger(artifact.sizeBytes), true);
      assert.ok(artifact.sizeBytes > 0);
      assert.equal(artifact.schemaVersion, DATABASE_COMPATIBILITY.maximum);
      assert.match(artifact.modifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
      assert.deepEqual(Object.keys(artifact).sort(), [
        "classification",
        "modifiedAt",
        "name",
        "schemaVersion",
        "sha256",
        "sizeBytes",
      ]);
    }
  });

  it("lists a damaged quarantine and removes it only with its exact digest", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T06:00:00.000Z"),
      });
    } finally {
      database.close();
    }

    const validName = `perpay.sqlite3.before-restore-2026-08-16T08-00-00.000Z-${UUIDS[0]}`;
    const damagedName = `perpay.sqlite3.before-restore-2026-08-16T07-00-00.000Z-${UUIDS[1]}`;
    copyFileSync(join(directory, backup.name), join(directory, validName));
    fs.writeFileSync(join(directory, damagedName), Buffer.from("damaged quarantine"));

    const listed = listPreRestoreQuarantines(
      directory,
      Date.parse("2026-08-16T09:00:00.000Z"),
    );
    assert.deepEqual(listed.map(({ name }) => name), [validName, damagedName]);
    assert.equal(listed[0]?.status, "verified");
    assert.equal(listed[1]?.status, "invalid");
    assert.equal(listed[1]?.sha256, sha256FileSync(join(directory, damagedName)));
    const retained = prunePreRestoreQuarantines({
      dataDirectory: directory,
      keepCount: 1,
      confirmPrunePreRestoreQuarantines: true,
    });
    assert.deepEqual(retained.kept.map(({ name }) => name), [validName, damagedName]);
    assert.deepEqual(retained.deleted, []);
    assert.equal(existsSync(join(directory, validName)), true);

    assert.throws(
      () => deletePreRestoreQuarantine({
        dataDirectory: directory,
        quarantineName: damagedName,
        expectedSha256: "0".repeat(64),
        confirmDeletePreRestoreQuarantine: true,
      }),
      /does not match/u,
    );
    assert.throws(
      () => deletePreRestoreQuarantine({
        dataDirectory: directory,
        quarantineName: `../${damagedName}`,
        expectedSha256: listed[1]!.sha256!,
        confirmDeletePreRestoreQuarantine: true,
      }),
      /name is invalid/u,
    );
    assert.throws(
      () => deletePreRestoreQuarantine({
        dataDirectory: directory,
        quarantineName: damagedName,
        expectedSha256: listed[1]!.sha256!,
        confirmDeletePreRestoreQuarantine: false,
      }),
      /explicit confirmation/u,
    );
    fs.writeFileSync(`${join(directory, damagedName)}-wal`, "sidecar");
    assert.throws(
      () => deletePreRestoreQuarantine({
        dataDirectory: directory,
        quarantineName: damagedName,
        expectedSha256: listed[1]!.sha256!,
        confirmDeletePreRestoreQuarantine: true,
      }),
      /not self-contained/u,
    );
    rmSync(`${join(directory, damagedName)}-wal`);
    const deleted = deletePreRestoreQuarantine({
      dataDirectory: directory,
      quarantineName: damagedName,
      expectedSha256: listed[1]!.sha256!,
      confirmDeletePreRestoreQuarantine: true,
    });
    assert.equal(deleted.deleted.name, damagedName);
    assert.equal(existsSync(join(directory, damagedName)), false);
    assert.equal(existsSync(join(directory, validName)), true);
  });

  it("prunes old quarantines by filename age and ignores them during operational retention", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let first: Awaited<ReturnType<typeof createOperationalBackup>>;
    let second: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      first = await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T10:00:00.000Z"),
      });
      second = await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T11:00:00.000Z"),
      });
    } finally {
      database.close();
    }
    const oldName = `perpay.sqlite3.before-restore-2026-08-16T12-00-00.000Z-${UUIDS[0]}`;
    const newestName = `perpay.sqlite3.before-restore-2026-08-16T13-00-00.000Z-${UUIDS[1]}`;
    copyFileSync(join(directory, first.name), join(directory, oldName));
    copyFileSync(join(directory, second.name), join(directory, newestName));

    const retained = prunePreRestoreQuarantines({
      dataDirectory: directory,
      keepCount: 1,
      confirmPrunePreRestoreQuarantines: true,
      now: Date.parse("2026-08-16T14:00:00.000Z"),
    });
    assert.deepEqual(retained.kept.map(({ name }) => name), [newestName]);
    assert.deepEqual(retained.deleted.map(({ name }) => name), [oldName]);
    assert.equal(existsSync(join(directory, oldName)), false);
    assert.equal(existsSync(join(directory, newestName)), true);

    fs.writeFileSync(join(directory, newestName), Buffer.from("corrupt but unrelated"));
    const operational = pruneOperationalBackups({
      dataDirectory: directory,
      keepCount: 1,
      confirmPruneOperationalBackups: true,
      now: Date.parse("2026-08-16T15:00:00.000Z"),
    });
    assert.deepEqual(operational.kept.map(({ name }) => name), [second.name]);
    assert.deepEqual(operational.deleted.map(({ name }) => name), [first.name]);
  });

  it("exposes quarantine listing and cleanup through the maintenance CLI", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T16:00:00.000Z"),
      });
    } finally {
      database.close();
    }
    const quarantineName =
      `perpay.sqlite3.before-restore-2026-08-16T17-00-00.000Z-${UUIDS[2]}`;
    copyFileSync(join(directory, backup.name), join(directory, quarantineName));
    const maintenance = resolve("src/database/maintenance.ts");
    const environment = { ...process.env, PERPAY_DATA_DIR: directory };
    const listed = spawnSync(
      process.execPath,
      ["--experimental-strip-types", maintenance, "list-pre-restore-quarantines"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(listed.status, 0, listed.stderr);
    const listPayload = JSON.parse(listed.stdout) as {
      quarantines: readonly { name: string; sha256: string | null }[];
    };
    assert.equal(listPayload.quarantines[0]?.name, quarantineName);
    assert.equal(listPayload.quarantines[0]?.sha256, sha256FileSync(join(directory, quarantineName)));

    const deleted = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        maintenance,
        "delete-pre-restore-quarantine",
        quarantineName,
        listPayload.quarantines[0]!.sha256!,
        "--confirm-delete-pre-restore-quarantine",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.equal(existsSync(join(directory, quarantineName)), false);
  });

  it("deletes only an exact verified ordinary one-link self-contained SQLite artifact", async (context) => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await AppDatabase.open(databasePath);
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: directory });
    } finally {
      database.close();
    }
    const backupPath = join(directory, backup.name);

    assert.throws(() => deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: backup.name,
      expectedSha256: backup.sha256,
      confirmDeleteBackupArtifact: false,
    }), /explicit confirmation/);
    assert.throws(() => deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: `../${backup.name}`,
      expectedSha256: backup.sha256,
      confirmDeleteBackupArtifact: true,
    }), /name is invalid/);
    assert.throws(() => deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: backup.name,
      expectedSha256: "0".repeat(64),
      confirmDeleteBackupArtifact: true,
    }), /does not match/);

    fs.writeFileSync(`${backupPath}-wal`, "sidecar");
    assert.throws(() => deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: backup.name,
      expectedSha256: backup.sha256,
      confirmDeleteBackupArtifact: true,
    }), /not self-contained/);
    rmSync(`${backupPath}-wal`);

    const hardlinkName = operationalName("2026-08-16T04-00-00.000Z", UUIDS[0]);
    linkSync(backupPath, join(directory, hardlinkName));
    assert.throws(() => deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: hardlinkName,
      expectedSha256: backup.sha256,
      confirmDeleteBackupArtifact: true,
    }), /ordinary file with one link/);
    rmSync(join(directory, hardlinkName));

    const symlinkName = operationalName("2026-08-16T05-00-00.000Z", UUIDS[1]);
    try {
      symlinkSync(backupPath, join(directory, symlinkName), "file");
      assert.throws(() => deleteBackupArtifact({
        dataDirectory: directory,
        artifactName: symlinkName,
        expectedSha256: backup.sha256,
        confirmDeleteBackupArtifact: true,
      }), /ordinary file/);
      rmSync(join(directory, symlinkName));
    } catch (error) {
      if (isFileSystemError(error, "EPERM") || isFileSystemError(error, "EACCES")) {
        context.diagnostic("file symlink creation is unavailable on this host");
      } else {
        throw error;
      }
    }

    const deleted = deleteBackupArtifact({
      dataDirectory: directory,
      artifactName: backup.name,
      expectedSha256: backup.sha256,
      confirmDeleteBackupArtifact: true,
    });
    assert.equal(deleted.deleted.name, backup.name);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(databasePath), true);
  });

  it("rejects a same-path content race before unlinking", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: directory });
    } finally {
      database.close();
    }
    const backupPath = resolve(directory, backup.name);
    const originalReadSync = fs.readSync;
    let changed = false;
    const hookedReadSync = ((...arguments_: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(originalReadSync, fs, arguments_);
      if (!changed) {
        changed = true;
        fs.appendFileSync(backupPath, Buffer.from([0]));
      }
      return result;
    }) as typeof fs.readSync;
    assert.equal(Reflect.set(fs, "readSync", hookedReadSync), true);
    syncBuiltinESMExports();
    try {
      assert.throws(() => deleteBackupArtifact({
        dataDirectory: directory,
        artifactName: backup.name,
        expectedSha256: backup.sha256,
        confirmDeleteBackupArtifact: true,
      }), /changed while it was being copied/);
    } finally {
      assert.equal(Reflect.set(fs, "readSync", originalReadSync), true);
      syncBuiltinESMExports();
    }
    assert.equal(changed, true);
    assert.equal(existsSync(backupPath), true);
  });

  it("prunes operational backups newest-first without touching other artifact classes", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await AppDatabase.open(databasePath);
    const backups: Awaited<ReturnType<typeof createOperationalBackup>>[] = [];
    try {
      for (const now of [
        Date.parse("2026-08-16T01:00:00.000Z"),
        Date.parse("2026-08-16T03:00:00.000Z"),
        Date.parse("2026-08-16T02:00:00.000Z"),
      ]) {
        backups.push(await createOperationalBackup({ dataDirectory: directory, now }));
      }
      await database.backupDetailed(join(
        directory,
        `perpay.sqlite3.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum + 1}.sqlite3`,
      ));
    } finally {
      database.close();
    }
    const quarantineName =
      `perpay.sqlite3.before-restore-2026-08-16T04-00-00.000Z-${UUIDS[0]}`;
    copyFileSync(join(directory, backups[0]!.name), join(directory, quarantineName));

    assert.throws(() => pruneOperationalBackups({
      dataDirectory: directory,
      keepCount: 0,
      confirmPruneOperationalBackups: true,
    }), /keep count/);
    assert.throws(() => pruneOperationalBackups({
      dataDirectory: directory,
      keepCount: 1,
      confirmPruneOperationalBackups: false,
    }), /explicit confirmation/);

    const result = pruneOperationalBackups({
      dataDirectory: directory,
      keepCount: 1,
      confirmPruneOperationalBackups: true,
    });
    assert.deepEqual(result.kept.map(({ name }) => name), [backups[1]!.name]);
    assert.deepEqual(result.deleted.map(({ name }) => name), [
      backups[2]!.name,
      backups[0]!.name,
    ]);
    assert.equal(existsSync(join(directory, backups[1]!.name)), true);
    assert.equal(existsSync(join(directory, backups[2]!.name)), false);
    assert.equal(existsSync(join(directory, backups[0]!.name)), false);
    assert.equal(existsSync(join(directory, quarantineName)), true);
    assert.equal(
      existsSync(join(
        directory,
        `perpay.sqlite3.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum + 1}.sqlite3`,
      )),
      true,
    );
  });

  it("does not select a concurrently created backup and cannot overlap restore maintenance", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "perpay.sqlite3");
    const database = await AppDatabase.open(databasePath);
    const oldBackups: Awaited<ReturnType<typeof createOperationalBackup>>[] = [];
    try {
      oldBackups.push(await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T01:00:00.000Z"),
      }));
      oldBackups.push(await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T02:00:00.000Z"),
      }));
    } finally {
      database.close();
    }
    const concurrentName = operationalName("2026-08-16T03-00-00.000Z", UUIDS[2]);
    const originalUnlinkSync = fs.unlinkSync;
    let concurrentCreated = false;
    const hookedUnlinkSync = ((path: fs.PathLike) => {
      if (!concurrentCreated && String(path).includes(".backup-")) {
        concurrentCreated = true;
        copyFileSync(join(directory, oldBackups[1]!.name), join(directory, concurrentName));
      }
      return originalUnlinkSync(path);
    }) as typeof fs.unlinkSync;
    assert.equal(Reflect.set(fs, "unlinkSync", hookedUnlinkSync), true);
    syncBuiltinESMExports();
    try {
      pruneOperationalBackups({
        dataDirectory: directory,
        keepCount: 1,
        confirmPruneOperationalBackups: true,
      });
    } finally {
      assert.equal(Reflect.set(fs, "unlinkSync", originalUnlinkSync), true);
      syncBuiltinESMExports();
    }
    assert.equal(concurrentCreated, true);
    assert.equal(existsSync(join(directory, concurrentName)), true);

    const lock = acquireDatabaseMaintenanceLock(databasePath, "restore-race-test", Date.now());
    try {
      assert.throws(() => pruneOperationalBackups({
        dataDirectory: directory,
        keepCount: 1,
        confirmPruneOperationalBackups: true,
      }), /maintenance lock already exists/);
      assert.equal(existsSync(join(directory, concurrentName)), true);
    } finally {
      lock.release();
    }
  });

  it("publishes an online backup while retention maintenance is excluded", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      await createOperationalBackup({
        dataDirectory: directory,
        now: Date.parse("2026-08-16T01:00:00.000Z"),
      });

      const originalLinkSync = fs.linkSync;
      let pruneBlocked = false;
      const hookedLinkSync = ((source: fs.PathLike, target: fs.PathLike) => {
        const result = originalLinkSync(source, target);
        if (
          !pruneBlocked &&
          String(source).includes(".creating-") &&
          operationalNamePattern().test(String(target).split(/[\\/]/u).at(-1) ?? "")
        ) {
          assert.throws(() => pruneOperationalBackups({
            dataDirectory: directory,
            keepCount: 1,
            confirmPruneOperationalBackups: true,
          }), /maintenance lock already exists/);
          pruneBlocked = true;
        }
        return result;
      }) as typeof fs.linkSync;
      assert.equal(Reflect.set(fs, "linkSync", hookedLinkSync), true);
      syncBuiltinESMExports();
      try {
        await createOperationalBackup({
          dataDirectory: directory,
          now: Date.parse("2026-08-16T02:00:00.000Z"),
        });
      } finally {
        assert.equal(Reflect.set(fs, "linkSync", originalLinkSync), true);
        syncBuiltinESMExports();
      }
      assert.equal(pruneBlocked, true);
      assert.equal(
        listBackupArtifacts(directory).filter(({ classification }) =>
          classification === "operational"
        ).length,
        2,
      );
    } finally {
      database.close();
    }
  });

  it("keeps ordinary backup commands on the dedicated backup runner", async () => {
    const directory = temporaryDirectory();
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    database.close();
    const entryPoint = resolve("src/database/maintenance.ts");
    const environment = { ...process.env, PERPAY_DATA_DIR: directory };
    for (const arguments_ of [
      ["create-backup"],
      ["list-backup-artifacts"],
      ["prune-operational-backups", "1", "--confirm-prune-operational-backups"],
      ["delete-backup-artifact", "backup.sqlite3", "a".repeat(64),
        "--confirm-delete-backup-artifact"],
      ["restore-backup", "backup.sqlite3", "a".repeat(64),
        "--confirm-replace-current-database"],
    ]) {
      const retired = spawnSync(
        process.execPath,
        ["--experimental-strip-types", entryPoint, ...arguments_],
        { encoding: "utf8", env: environment },
      );
      assert.equal(retired.status, 1);
      assert.match(retired.stderr, /usage: maintenance/);
    }

    const migrations = spawnSync(
      process.execPath,
      ["--experimental-strip-types", entryPoint, "list-migration-backups"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(migrations.status, 0, migrations.stderr);
    assert.deepEqual(JSON.parse(migrations.stdout), { backups: [] });
  });

  it("keeps operational staging short in a long data directory", async () => {
    const directory = longTemporaryDirectory(120);
    const now = Date.parse("2026-08-16T02:03:04.005Z");
    const exampleName = operationalName("2026-08-16T02-03-04.005Z", UUIDS[0]);
    assert.ok(resolve(directory, exampleName).length < 260);
    assert.ok(
      resolve(directory, `.${exampleName}.creating-${UUIDS[1]}.tmp`).length >= 260,
    );

    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    let backup: Awaited<ReturnType<typeof createOperationalBackup>>;
    try {
      backup = await createOperationalBackup({ dataDirectory: directory, now });
    } finally {
      database.close();
    }
    assert.deepEqual(
      listBackupArtifacts(directory).map(({ name }) => name),
      [backup.name],
    );

    const restored = restoreOperationalBackup({
      dataDirectory: directory,
      backupName: backup.name,
      expectedSha256: backup.sha256,
      confirmReplaceCurrentDatabase: true,
      now: now + 1_000,
    });
    assert.equal(restored.backupName, backup.name);
    const reopened = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      assert.deepEqual(reopened.health(), { ok: true, result: "ok" });
    } finally {
      reopened.close();
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "perpay-backup-lifecycle-"));
  directories.push(directory);
  return directory;
}

function longTemporaryDirectory(minimumLength: number): string {
  const root = temporaryDirectory();
  if (root.length >= minimumLength) return root;
  const directory = join(root, "d".repeat(minimumLength - root.length - 1));
  mkdirSync(directory);
  return directory;
}

function operationalName(timestamp: string, uuid: string): string {
  return `perpay.sqlite3.backup-${timestamp}-${uuid}.sqlite3`;
}

function operationalNamePattern(): RegExp {
  return /^perpay\.sqlite3\.backup-.+\.sqlite3$/u;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
