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
import { DatabaseSync } from "node:sqlite";

import { AppDatabase, assertDatabaseIntegrity, DatabaseIntegrityCheckError, inspectDatabaseIntegrity, sha256FileSync } from "../src/database/database.ts";
import { openIntegrityDatabase } from "../src/database/connection.ts";
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
import { RuntimeSettingsStore } from "../src/settings/store.ts";

const directories: string[] = [];
const TEST_MASTER_KEY = Buffer.alloc(32, 0x11);
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
  it("keeps independent integrity reads in memory while preserving read-only and foreign-key options", async () => {
    const path = join(temporaryDirectory(), "perpay.sqlite3");
    const owner = await openTestDatabase(path);
    owner.close();
    const database = openIntegrityDatabase(path, { readOnly: true, enableForeignKeyConstraints: true, readBigInts: true, defensive: true });
    try {
      assert.equal(database.prepare("PRAGMA temp_store").get()!.temp_store, 2n);
      assert.equal(database.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1n);
      assert.equal(inspectDatabaseIntegrity(database).ok, true);
      assert.throws(() => database.exec("CREATE TABLE unexpected(value TEXT)"), /readonly/i);
      database.exec("CREATE TEMP TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('retained')");
      assert.equal(inspectDatabaseIntegrity(database).ok, true);
      assert.equal(database.prepare("SELECT value FROM preserved").get()!.value, "retained");
    } finally { database.close(); }
  });

  for (const [stage, query] of [
    ["quick_check", "PRAGMA quick_check"],
    ["foreign_keys", "PRAGMA foreign_key_check"],
    ["access_settings", "SELECT admin_access FROM runtime_configuration"],
    ["domain", "LAG(page.response_fingerprint)"],
    ["cryptographic", "SELECT key_version, key_material, activated_at, retired_at"],
    ["schema", "SELECT type, name, tbl_name AS table_name, sql"],
  ] as const) {
    for (const errcode of [13, 11]) it(`preserves ${stage} execution failure ${errcode} and completed inspection results`, async context => {
      const owner = await openTestDatabase(join(temporaryDirectory(), "perpay.sqlite3"));
      const database = owner.read(connection => connection);
      const prepare = database.prepare.bind(database);
      const cause = Object.assign(new Error("synthetic private database path"), { code: "ERR_SQLITE_ERROR", errcode });
      context.mock.method(database, "prepare", (sql: string) => {
        if (sql.includes(query)) throw cause;
        return prepare(sql);
      });
      try {
        const result = inspectDatabaseIntegrity(database);
        assert.equal(result.ok, false);
        assert.equal(result.quickCheck, stage === "quick_check" ? "not_checked" : "ok");
        assert.equal(result.foreignKeyViolations, stage === "quick_check" || stage === "foreign_keys" ? -1 : 0);
        assert.equal(result.failure?.stage, stage);
        assert.equal(result.failure?.cause, cause);
        assert.equal(JSON.stringify(result).includes(cause.message), false);
        assert.throws(() => assertDatabaseIntegrity(database, "backup verification failed"), error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`inspection_stage=${stage}$`));
          assert.ok(error.cause instanceof DatabaseIntegrityCheckError);
          assert.equal(error.cause.cause, cause);
          return true;
        });
      } finally { owner.close(); }
    });
  }

  it("still rejects real foreign-key violations as completed integrity findings", () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    database.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1)");
    try {
      const result = inspectDatabaseIntegrity(database);
      assert.equal(result.ok, false);
      assert.equal(result.quickCheck, "ok");
      assert.equal(result.foreignKeyViolations, 1);
      assert.equal(result.failure, undefined);
      assert.throws(() => assertDatabaseIntegrity(database, "backup verification failed"), /foreign_key_violations=1/);
    } finally { database.close(); }
  });

  it("still rejects persisted domain violations after completing every inspection stage", async () => {
    const owner = await openTestDatabase(join(temporaryDirectory(), "perpay.sqlite3"));
    const database = owner.read(connection => connection);
    try {
      const trigger = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'order_clock_no_delete'").get()!.sql as string;
      database.exec("DROP TRIGGER order_clock_no_delete; DELETE FROM order_clock");
      database.exec(trigger);
      const result = inspectDatabaseIntegrity(database);
      assert.equal(result.ok, false);
      assert.equal(result.quickCheck, "ok");
      assert.equal(result.foreignKeyViolations, 0);
      assert.ok(result.domainViolations > 0);
      assert.equal(result.schema, "ok");
      assert.equal(result.failure, undefined);
      assert.throws(() => assertDatabaseIntegrity(database, "backup verification failed"), /domain_violations=[1-9]/);
    } finally { owner.close(); }
  });

  it("classifies every recognized artifact and returns bounded deterministic metadata", async () => {
    const directory = temporaryDirectory();
    const database = await openTestDatabase(join(directory, "perpay.sqlite3"));
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
    const database = await openTestDatabase(join(directory, "perpay.sqlite3"));
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

    const database = await openTestDatabase(join(directory, "perpay.sqlite3"));
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
      masterKey: TEST_MASTER_KEY,
      now: now + 1_000,
    });
    assert.equal(restored.backupName, backup.name);
    const reopened = await openTestDatabase(join(directory, "perpay.sqlite3"));
    try {
      assert.deepEqual(reopened.health(), { ok: true, result: "ok" });
    } finally {
      reopened.close();
    }
  });
});

async function openTestDatabase(path: string): Promise<AppDatabase> {
  const database = await AppDatabase.open(path);
  new RuntimeSettingsStore(database, TEST_MASTER_KEY).initialize();
  return database;
}

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
