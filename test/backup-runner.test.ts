import assert from "node:assert/strict";
import fs, {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { BackupConfig } from "../src/backup/config.ts";
import {
  BACKUP_CYCLE_TIMEOUT_MILLISECONDS,
  BACKUP_LOCK_STALE_MILLISECONDS,
  acquireBackupLock,
  backupLockPath,
  clearStaleBackupLock,
  inspectBackupLock,
  readBackupLock,
} from "../src/backup/lock.ts";
import type { LocalBackup } from "../src/backup/repository.ts";
import { createLocalBackup, inspectLocalBackup } from "../src/backup/repository.ts";
import {
  BackupCycleError,
  inspectBackupHealth,
  inspectPersistedBackupHealth,
  nextScheduledDelayMilliseconds,
  reconcileBackupRetention,
  runBackupCommand,
  runTrackedCycle,
  type BackupOperations,
} from "../src/backup/runner.ts";
import { AppDatabase } from "../src/database/database.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const instanceId = "c".repeat(32);
const sha256 = "d236906afac4baaba89924427135f1f0f5d22fbb1c46a0e176e276aabb215add";
const backupName =
  "perpay.sqlite3.backup-2026-08-17T00-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configuration(): BackupConfig {
  const root = mkdtempSync(join(tmpdir(), "perpay-local-backup-runner-"));
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

function fakeBackup(config: BackupConfig): LocalBackup {
  writeFileSync(join(config.backupDirectory, backupName), "verified-backup", {
    mode: 0o600,
  });
  return fakeBackupRecord();
}

function fakeBackupRecord(): LocalBackup {
  return Object.freeze({
    name: backupName,
    sha256,
    sizeBytes: 15,
    createdAt: "2026-08-17T00:00:00.000Z",
    schemaVersion: DATABASE_COMPATIBILITY.maximum,
    instanceId,
  });
}

function fakeOperations(
  config: BackupConfig,
  overrides: Partial<BackupOperations> = {},
): { readonly operations: BackupOperations; readonly calls: string[] } {
  const calls: string[] = [];
  const operations: BackupOperations = {
    async create(_configuration, options) {
      calls.push(`create:${options.expectedInstanceId ?? "unbound"}`);
      return fakeBackup(config);
    },
    inspect() {
      calls.push(`inspect:${config.backupDirectory}:${backupName}`);
      return fakeBackupRecord();
    },
    list(directory) {
      calls.push(`list:${directory}`);
      return existsSync(join(config.backupDirectory, backupName))
        ? Object.freeze([fakeBackupRecord()])
        : Object.freeze([]);
    },
    listArtifacts(directory) {
      calls.push(`list-artifacts:${directory}`);
      const backup = fakeBackupRecord();
      return existsSync(join(config.backupDirectory, backupName))
        ? Object.freeze([Object.freeze({
            name: backup.name,
            createdAt: backup.createdAt,
            status: "verified" as const,
            sha256: backup.sha256,
            sizeBytes: backup.sizeBytes,
            schemaVersion: backup.schemaVersion,
            instanceId: backup.instanceId,
            error: null,
          })])
        : Object.freeze([]);
    },
    deleteArtifact() {
      throw new Error("backup artifact deletion was not expected");
    },
    prune(directory, keepCount) {
      calls.push(`prune:${directory}:${keepCount}`);
      const kept = existsSync(join(config.backupDirectory, backupName))
        ? Object.freeze([fakeBackupRecord()])
        : Object.freeze([]);
      return Object.freeze({
        kept,
        deleted: Object.freeze([]),
        blocked: Object.freeze([]),
        retainedCount: kept.length,
      });
    },
    recover(directory) {
      calls.push(`recover:${directory}`);
      return Object.freeze([]);
    },
    restore() {
      throw new Error("restore was not expected");
    },
    ...overrides,
  };
  return { operations, calls };
}

describe("local backup state and scheduling", () => {
  it("emits the frozen run-once and list-backups JSON shapes", async () => {
    const config = configuration();
    const fake = fakeOperations(config);
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };
    const runOutput = await captureStandardOutput(() =>
      runBackupCommand(["run-once"], environment, fake.operations));
    const run = JSON.parse(runOutput) as Record<string, unknown>;
    assert.deepEqual(Object.keys(run), [
      "backup",
      "verified_at",
      "deleted_backups",
      "recovered_temporary_files",
    ]);
    assert.deepEqual(Object.keys(run.backup as Record<string, unknown>), [
      "name",
      "sha256",
      "size_bytes",
      "created_at",
      "schema_version",
      "instance_id",
    ]);

    const listOutput = await captureStandardOutput(() =>
      runBackupCommand(["list-backups"], environment, fake.operations));
    const listed = JSON.parse(listOutput) as {
      backups: readonly Record<string, unknown>[];
    };
    assert.deepEqual(Object.keys(listed.backups[0]!), [
      "name",
      "sha256",
      "size_bytes",
      "created_at",
      "schema_version",
      "instance_id",
    ]);

    const fileOutput = await captureStandardOutput(() =>
      runBackupCommand(["list-backup-files"], environment, fake.operations));
    const files = JSON.parse(fileOutput) as {
      files: readonly Record<string, unknown>[];
    };
    assert.deepEqual(Object.keys(files.files[0]!), [
      "name",
      "created_at",
      "status",
      "sha256",
      "size_bytes",
      "schema_version",
      "instance_id",
      "error",
    ]);
  });

  it("requires explicit confirmation before deleting one exact backup file", async () => {
    const config = configuration();
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };
    let deletionCalls = 0;
    const fake = fakeOperations(config, {
      deleteArtifact(_directory, name, expectedSha256, protectedName) {
        deletionCalls += 1;
        assert.equal(name, backupName);
        assert.equal(expectedSha256, sha256);
        assert.equal(protectedName, undefined);
        return Object.freeze({
          name,
          createdAt: "2026-08-17T00:00:00.000Z",
          status: "invalid",
          sha256: expectedSha256,
          sizeBytes: 15,
          schemaVersion: null,
          instanceId: null,
          error: "damaged backup",
        });
      },
    });
    await assert.rejects(
      runBackupCommand(["delete-backup-file", backupName, sha256], environment, fake.operations),
      /usage/u,
    );
    assert.equal(deletionCalls, 0);

    const output = JSON.parse(await captureStandardOutput(() => runBackupCommand([
      "delete-backup-file",
      backupName,
      sha256,
      "--confirm-delete-backup-file",
    ], environment, fake.operations))) as {
      deleted: { name: string; sha256: string; status: string };
    };
    assert.deepEqual(
      { name: output.deleted.name, sha256: output.deleted.sha256, status: output.deleted.status },
      { name: backupName, sha256, status: "invalid" },
    );
    assert.equal(deletionCalls, 1);
  });

  it("tracks one verified cycle and reports healthy persisted state", async () => {
    const config = configuration();
    const fake = fakeOperations(config);
    const result = await runTrackedCycle(config, fake.operations);

    assert.equal(result.backup.instanceId, instanceId);
    assert.equal(result.deletedBackups, 0);
    assert.deepEqual(fake.calls, [
      `recover:${config.backupDirectory}`,
      "create:unbound",
      `inspect:${config.backupDirectory}:${backupName}`,
      `prune:${config.backupDirectory}:7`,
    ]);

    const health = inspectBackupHealth(config, result.verifiedAt);
    assert.equal(health.ok, true);
    assert.equal(health.backup_required, false);
    assert.equal(health.backup_available, true);
    assert.equal(health.recovery_required, false);
    assert.equal(health.instance_id, instanceId);
    assert.equal(health.keep_count, 7);
    assert.equal(inspectPersistedBackupHealth(config.backupDirectory, result.verifiedAt).ok, true);

    const state = JSON.parse(
      readFileSync(join(config.backupDirectory, "perpay-local-backup-state.json"), "utf8"),
    ) as { version: number; instanceId: string; backupName: string };
    assert.equal(state.version, 2);
    assert.equal(state.instanceId, instanceId);
    assert.equal(state.backupName, backupName);
  });

  it("binds later cycles to the first verified application instance", async () => {
    const config = configuration();
    const first = fakeOperations(config);
    await runTrackedCycle(config, first.operations);
    const second = fakeOperations(config);
    await runTrackedCycle(config, second.operations);
    assert.equal(second.calls.includes(`create:${instanceId}`), true);
  });

  it("persists the exact failure stage without overwriting the last success", async () => {
    const config = configuration();
    await runTrackedCycle(config, fakeOperations(config).operations);
    const failure = fakeOperations(config, {
      async create() {
        throw new Error("SQLite backup failed");
      },
    });

    await assert.rejects(
      runTrackedCycle(config, failure.operations),
      (error: unknown) =>
        error instanceof BackupCycleError && error.stage === "database_backup",
    );
    const health = inspectBackupHealth(config, Date.now());
    assert.equal(health.ok, false);
    assert.equal(health.last_error_stage, "database_backup");
    assert.equal(health.backup_name, backupName);
  });

  it("persists recovery failures so an earlier success cannot remain healthy", async () => {
    const cycleConfig = configuration();
    await runTrackedCycle(cycleConfig, fakeOperations(cycleConfig).operations);
    const failedCycle = fakeOperations(cycleConfig, {
      recover() {
        throw new Error("temporary artifact recovery failed");
      },
    });
    await assert.rejects(
      runTrackedCycle(cycleConfig, failedCycle.operations),
      (error: unknown) => error instanceof BackupCycleError && error.stage === "state",
    );
    const cycleHealth = inspectBackupHealth(cycleConfig, Date.now());
    assert.equal(cycleHealth.ok, false);
    assert.equal(cycleHealth.last_error_stage, "state");

    const retentionConfig = configuration();
    await runTrackedCycle(retentionConfig, fakeOperations(retentionConfig).operations);
    const failedRetention = fakeOperations(retentionConfig, {
      recover() {
        throw new Error("retention recovery failed");
      },
    });
    await assert.rejects(
      reconcileBackupRetention(retentionConfig, failedRetention.operations),
      (error: unknown) => error instanceof BackupCycleError && error.stage === "state",
    );
    const retentionHealth = inspectBackupHealth(retentionConfig, Date.now());
    assert.equal(retentionHealth.ok, false);
    assert.equal(retentionHealth.last_error_stage, "state");
  });

  it("fails retention as a separate stage after preserving the new backup", async () => {
    const config = configuration();
    const fake = fakeOperations(config, {
      prune() {
        throw new Error("retention preflight failed");
      },
    });
    await assert.rejects(
      runTrackedCycle(config, fake.operations),
      (error: unknown) =>
        error instanceof BackupCycleError && error.stage === "retention",
    );
    assert.equal(
      readFileSync(join(config.backupDirectory, backupName), "utf8"),
      "verified-backup",
    );
    const health = inspectBackupHealth(config, Date.now());
    assert.equal(health.backup_name, backupName);
    assert.equal(health.backup_sha256, sha256);
    assert.equal(health.backup_available, true);
    assert.equal(health.last_error_stage, "retention");

    const recovery = fakeOperations(config);
    await reconcileBackupRetention(config, recovery.operations);
    assert.equal(recovery.calls.some((call) => call.startsWith("create:")), false);
    const recovered = inspectBackupHealth(config, Date.now());
    assert.equal(recovered.last_error_stage, null);
    assert.equal(recovered.ok, true);
  });

  it("refuses retention cleanup after the persisted clock moves into the future", async () => {
    const config = configuration();
    await runTrackedCycle(config, fakeOperations(config).operations);
    const statePath = join(config.backupDirectory, "perpay-local-backup-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      lastAttemptAt: number;
      lastSuccessAt: number;
      lastErrorAt: number | null;
    };
    const future = Date.now() + 60 * 60 * 1_000;
    state.lastAttemptAt = future;
    state.lastSuccessAt = future;
    state.lastErrorAt = null;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const recovery = fakeOperations(config);
    await assert.rejects(
      reconcileBackupRetention(config, recovery.operations),
      (error: unknown) => error instanceof BackupCycleError && error.stage === "state",
    );
    assert.equal(recovery.calls.some((call) => call.startsWith("prune:")), false);
  });

  it("publishes a new recovery point before reporting an unsafe old retention file", async () => {
    const config = configuration();
    const fake = fakeOperations(config, {
      prune() {
        return Object.freeze({
          kept: Object.freeze([Object.freeze({
            name: backupName,
            createdAt: "2026-08-17T00:00:00.000Z",
          })]),
          deleted: Object.freeze([]),
          blocked: Object.freeze([Object.freeze({
            name:
              "perpay.sqlite3.backup-2026-08-16T00-00-00.000Z-22345678-1234-4123-8123-123456789abc.sqlite3",
            createdAt: "2026-08-16T00:00:00.000Z",
          })]),
          retainedCount: 2,
        });
      },
    });

    await assert.rejects(
      runTrackedCycle(config, fake.operations),
      (error: unknown) => error instanceof BackupCycleError && error.stage === "retention",
    );
    assert.deepEqual(fake.calls.slice(0, 3), [
      `recover:${config.backupDirectory}`,
      "create:unbound",
      `inspect:${config.backupDirectory}:${backupName}`,
    ]);
    const health = inspectBackupHealth(config, Date.now());
    assert.equal(health.backup_name, backupName);
    assert.equal(health.backup_available, true);
    assert.equal(health.last_success_at === null, false);
    assert.equal(health.last_error_stage, "retention");
    assert.equal(health.retained_count, 2);
    const delay = nextScheduledDelayMilliseconds(config, health.last_error_at!);
    assert.equal(delay > config.intervalMilliseconds - 1_000, true);
    assert.equal(delay <= config.intervalMilliseconds, true);
  });

  it("leaves old external-tool state untouched and uses new state names", async () => {
    const config = configuration();
    const legacyStatePath = join(config.dataDirectory, "perpay-backup-state.json");
    writeFileSync(legacyStatePath, "{not-json}\n");
    await runTrackedCycle(config, fakeOperations(config).operations);
    assert.equal(readFileSync(legacyStatePath, "utf8"), "{not-json}\n");
  });

  it("fails health closed for missing artifacts, stale success, and policy changes", async () => {
    const config = configuration();
    const result = await runTrackedCycle(config, fakeOperations(config).operations);
    rmSync(join(config.backupDirectory, backupName));
    assert.equal(inspectBackupHealth(config, result.verifiedAt).ok, false);

    writeFileSync(join(config.backupDirectory, backupName), "verified-backup");
    const current = inspectBackupHealth(config, result.verifiedAt);
    assert.equal(
      inspectBackupHealth(
        config,
        result.verifiedAt + current.maximum_age_milliseconds! + 1,
      ).ok,
      false,
    );
    assert.equal(
      inspectBackupHealth({ ...config, keepCount: 8 }, result.verifiedAt)
        .configuration_mismatch,
      true,
    );
  });

  it("fails health closed while an interrupted publication awaits recovery", async () => {
    const config = configuration();
    const result = await runTrackedCycle(config, fakeOperations(config).operations);
    const temporary = join(
      config.backupDirectory,
      ".creating-12345678-1234-4123-8123-123456789abc.tmp",
    );
    writeFileSync(temporary, "interrupted", { mode: 0o600 });
    const activeLock = acquireBackupLock(config, "backup-cycle", result.verifiedAt);
    const active = inspectBackupHealth(config, result.verifiedAt);
    assert.equal(active.ok, true);
    assert.equal(active.backup_in_progress, true);
    assert.equal(active.recovery_required, false);
    activeLock.release();

    const interrupted = inspectBackupHealth(config, result.verifiedAt);
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.backup_in_progress, false);
    assert.equal(interrupted.backup_available, true);
    assert.equal(interrupted.recovery_required, true);
    rmSync(temporary);
    const recovered = inspectBackupHealth(config, result.verifiedAt);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.backup_in_progress, false);
    assert.equal(recovered.recovery_required, false);
  });

  it("derives the restart delay from persisted success and retry timestamps", async () => {
    const config = configuration();
    const result = await runTrackedCycle(config, fakeOperations(config).operations);
    assert.equal(
      nextScheduledDelayMilliseconds(config, result.verifiedAt),
      config.intervalMilliseconds,
    );
    assert.equal(
      nextScheduledDelayMilliseconds(
        config,
        result.verifiedAt + config.intervalMilliseconds - 1,
      ),
      1,
    );
    assert.equal(
      nextScheduledDelayMilliseconds(
        config,
        result.verifiedAt + config.intervalMilliseconds,
      ),
      0,
    );
    const statePath = join(config.backupDirectory, "perpay-local-backup-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      lastAttemptAt: number;
      lastSuccessAt: number;
    };
    const interruptedAt = state.lastSuccessAt + 1;
    writeFileSync(statePath, `${JSON.stringify({
      ...state,
      lastAttemptAt: interruptedAt,
    })}\n`);
    assert.equal(
      nextScheduledDelayMilliseconds(config, interruptedAt),
      5 * 60 * 1_000,
    );
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const failure = fakeOperations(config, {
      async create() {
        throw new Error("backup failed");
      },
    });
    await assert.rejects(runTrackedCycle(config, failure.operations));
    const failedHealth = inspectBackupHealth(config, Date.now());
    assert.equal(
      nextScheduledDelayMilliseconds(config, failedHealth.last_error_at!),
      5 * 60 * 1_000,
    );
  });

  it("passes cancellation into the database-copy operation and records the failure", async () => {
    const config = configuration();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const fake = fakeOperations(config, {
      async create(_configuration, options) {
        assert.notEqual(options.signal, undefined);
        entered.resolve();
        await new Promise<void>((resolvePromise) => {
          options.signal!.addEventListener("abort", () => resolvePromise(), { once: true });
        });
        options.signal!.throwIfAborted();
        return fakeBackup(config);
      },
    });
    const running = runTrackedCycle(config, fake.operations, controller.signal);
    await entered.promise;
    controller.abort();
    await assert.rejects(running, { name: "BackupCycleError" });
    assert.equal(inspectBackupHealth(config, Date.now()).last_error_stage, "database_backup");
  });

  it("protects a restored older backup and forces an immediate replacement backup", async () => {
    const config = configuration();
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "2",
    };
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    database.write((connection) => {
      connection.prepare(
        "INSERT INTO system_metadata(key,value,updated_at) VALUES ('restore_marker','older',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run();
    });
    const older = JSON.parse(await captureStandardOutput(() =>
      runBackupCommand(["run-once"], environment))) as { backup: LocalBackup };
    database.write((connection) => {
      connection.prepare(
        "UPDATE system_metadata SET value='newer',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='restore_marker'",
      ).run();
    });
    const newer = JSON.parse(await captureStandardOutput(() =>
      runBackupCommand(["run-once"], environment))) as { backup: LocalBackup };
    database.close();
    const olderRecord = inspectLocalBackup(
      config.backupDirectory,
      older.backup.name,
      Date.now(),
    );

    const restoreEnvironment = { ...environment, PERPAY_BACKUP_KEEP_COUNT: "1" };
    const statePath = join(config.backupDirectory, "perpay-local-backup-state.json");
    const failedRestore = fakeOperations(config, {
      inspect(_directory, requestedName) {
        assert.equal(requestedName, older.backup.name);
        return olderRecord;
      },
      restore() {
        throw new Error("database replacement failed");
      },
    });
    await assert.rejects(
      runBackupCommand([
        "restore",
        older.backup.name,
        older.backup.sha256,
        "--confirm-replace-current-database",
      ], restoreEnvironment, failedRestore.operations),
      (error: unknown) =>
        error instanceof BackupCycleError && error.stage === "restore",
    );
    const failedRestoreState = JSON.parse(readFileSync(statePath, "utf8")) as {
      backupName: string;
      backupRequired: boolean;
      lastErrorStage: string | null;
    };
    assert.equal(failedRestoreState.backupName, older.backup.name);
    assert.equal(failedRestoreState.backupRequired, true);
    assert.equal(failedRestoreState.lastErrorStage, "restore");
    const oneBackupConfig = { ...config, keepCount: 1 };
    const failedRestoreRetention = fakeOperations(oneBackupConfig);
    assert.equal(
      await reconcileBackupRetention(oneBackupConfig, failedRestoreRetention.operations),
      0,
    );
    assert.equal(
      failedRestoreRetention.calls.some((call) => call.startsWith("prune:")),
      false,
    );
    assert.equal(existsSync(join(config.backupDirectory, older.backup.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, newer.backup.name)), true);

    await captureStandardOutput(() => runBackupCommand([
      "restore",
      older.backup.name,
      older.backup.sha256,
      "--confirm-replace-current-database",
    ], restoreEnvironment));
    const restoredState = JSON.parse(readFileSync(statePath, "utf8")) as {
      backupName: string;
      backupRequired: boolean;
    };
    assert.equal(restoredState.backupName, older.backup.name);
    assert.equal(restoredState.backupRequired, true);
    assert.equal(nextScheduledDelayMilliseconds(oneBackupConfig, Date.now()), 0);
    assert.equal(inspectBackupHealth(oneBackupConfig, Date.now()).backup_required, true);

    assert.equal(await reconcileBackupRetention(oneBackupConfig), 0);
    assert.equal(existsSync(join(config.backupDirectory, older.backup.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, newer.backup.name)), true);

    const failedReplacement = fakeOperations(oneBackupConfig, {
      async create() {
        throw new Error("replacement backup failed");
      },
    });
    await assert.rejects(
      runTrackedCycle(oneBackupConfig, failedReplacement.operations),
      (error: unknown) =>
        error instanceof BackupCycleError && error.stage === "database_backup",
    );
    assert.equal(
      failedReplacement.calls.some((call) => call.startsWith("prune:")),
      false,
    );
    assert.equal(existsSync(join(config.backupDirectory, older.backup.name)), true);
    assert.equal(existsSync(join(config.backupDirectory, newer.backup.name)), true);
    const reopened = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    try {
      assert.equal(reopened.read((connection) =>
        (connection.prepare(
          "SELECT value FROM system_metadata WHERE key='restore_marker'",
        ).get() as { value: string }).value), "older");
    } finally {
      reopened.close();
    }

    await runTrackedCycle(oneBackupConfig);
    const refreshed = JSON.parse(readFileSync(statePath, "utf8")) as {
      backupName: string;
      backupRequired: boolean;
    };
    assert.equal(refreshed.backupRequired, false);
    assert.notEqual(refreshed.backupName, older.backup.name);
  });

  it("requires an explicit state rebuild before restoring through damaged metadata", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    const backup = await createLocalBackup(config);
    database.close();
    writeFileSync(
      join(config.backupDirectory, "perpay-local-backup-state.json"),
      "{damaged\n",
      { mode: 0o600 },
    );
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };
    await assert.rejects(
      runBackupCommand([
        "restore",
        backup.name,
        backup.sha256,
        "--confirm-replace-current-database",
      ], environment),
      /repeat restore with --rebuild-state/u,
    );
    await captureStandardOutput(() => runBackupCommand([
      "restore",
      backup.name,
      backup.sha256,
      "--confirm-replace-current-database",
      "--rebuild-state",
    ], environment));
    const rebuilt = JSON.parse(readFileSync(
      join(config.backupDirectory, "perpay-local-backup-state.json"),
      "utf8",
    )) as { version: number; backupName: string; backupRequired: boolean };
    assert.equal(rebuilt.version, 2);
    assert.equal(rebuilt.backupName, backup.name);
    assert.equal(rebuilt.backupRequired, true);
  });

  it("requires an explicit state rebuild when state metadata is missing", async () => {
    const config = configuration();
    const database = await AppDatabase.open(join(config.dataDirectory, "perpay.sqlite3"));
    database.close();
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };
    const backup = JSON.parse(await captureStandardOutput(() =>
      runBackupCommand(["run-once"], environment))) as { backup: LocalBackup };
    rmSync(join(config.backupDirectory, "perpay-local-backup-state.json"));
    await assert.rejects(
      runBackupCommand([
        "restore",
        backup.backup.name,
        backup.backup.sha256,
        "--confirm-replace-current-database",
      ], environment),
      /repeat restore with --rebuild-state/u,
    );
    await captureStandardOutput(() => runBackupCommand([
      "restore",
      backup.backup.name,
      backup.backup.sha256,
      "--confirm-replace-current-database",
      "--rebuild-state",
    ], environment));
  });
});

async function captureStandardOutput(action: () => Promise<unknown>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  const replacement = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  assert.equal(Reflect.set(process.stdout, "write", replacement), true);
  try {
    await action();
  } finally {
    assert.equal(Reflect.set(process.stdout, "write", originalWrite), true);
  }
  return output.trim();
}

describe("local backup lock", () => {
  it("classifies every lock age without writing or repairing lock artifacts", () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const missingConfig = configuration();
    const missingEntries = readdirSync(missingConfig.backupDirectory);
    assert.deepEqual(inspectBackupLock(missingConfig, now), {
      status: "missing",
      record: null,
      ageMilliseconds: null,
      cleanupEligible: false,
    });
    assert.deepEqual(readdirSync(missingConfig.backupDirectory), missingEntries);

    for (const fixture of [
      {
        status: "active" as const,
        ageMilliseconds: BACKUP_CYCLE_TIMEOUT_MILLISECONDS,
        cleanupEligible: false,
      },
      {
        status: "expired" as const,
        ageMilliseconds: BACKUP_CYCLE_TIMEOUT_MILLISECONDS + 1,
        cleanupEligible: false,
      },
      {
        status: "stale" as const,
        ageMilliseconds: BACKUP_LOCK_STALE_MILLISECONDS + 1,
        cleanupEligible: true,
      },
      {
        status: "future" as const,
        ageMilliseconds: -1,
        cleanupEligible: false,
      },
    ]) {
      const config = configuration();
      const lock = acquireBackupLock(
        config,
        `inspect-${fixture.status}`,
        now - fixture.ageMilliseconds,
      );
      const path = backupLockPath(config);
      const beforeBytes = readFileSync(path);
      const beforeStat = lstatSync(path, { bigint: true });
      const beforeEntries = readdirSync(config.backupDirectory);

      const inspection = inspectBackupLock(config, now);
      assert.equal(inspection.status, fixture.status);
      assert.deepEqual(inspection.record, lock.record);
      assert.equal(inspection.ageMilliseconds, fixture.ageMilliseconds);
      assert.equal(inspection.cleanupEligible, fixture.cleanupEligible);
      assert.deepEqual(readFileSync(path), beforeBytes);
      assert.deepEqual(readdirSync(config.backupDirectory), beforeEntries);
      const afterStat = lstatSync(path, { bigint: true });
      assert.deepEqual(
        {
          dev: afterStat.dev,
          ino: afterStat.ino,
          mode: afterStat.mode,
          nlink: afterStat.nlink,
          size: afterStat.size,
          mtimeNs: afterStat.mtimeNs,
        },
        {
          dev: beforeStat.dev,
          ino: beforeStat.ino,
          mode: beforeStat.mode,
          nlink: beforeStat.nlink,
          size: beforeStat.size,
          mtimeNs: beforeStat.mtimeNs,
        },
      );
      lock.release();
    }

    const unreadableConfig = configuration();
    const unreadablePath = backupLockPath(unreadableConfig);
    const modifiedAt = now - BACKUP_LOCK_STALE_MILLISECONDS - 1;
    writeFileSync(unreadablePath, "{unreadable\n", { mode: 0o600 });
    utimesSync(unreadablePath, modifiedAt / 1_000, modifiedAt / 1_000);
    const beforeBytes = readFileSync(unreadablePath);
    const beforeStat = lstatSync(unreadablePath, { bigint: true });
    const beforeEntries = readdirSync(unreadableConfig.backupDirectory);
    const inspection = inspectBackupLock(unreadableConfig, now);
    assert.equal(inspection.status, "unreadable");
    assert.equal(inspection.record, null);
    assert.equal(inspection.cleanupEligible, true);
    assert.deepEqual(readFileSync(unreadablePath), beforeBytes);
    assert.deepEqual(readdirSync(unreadableConfig.backupDirectory), beforeEntries);
    const afterStat = lstatSync(unreadablePath, { bigint: true });
    assert.deepEqual(
      {
        dev: afterStat.dev,
        ino: afterStat.ino,
        mode: afterStat.mode,
        nlink: afterStat.nlink,
        size: afterStat.size,
        mtimeNs: afterStat.mtimeNs,
      },
      {
        dev: beforeStat.dev,
        ino: beforeStat.ino,
        mode: beforeStat.mode,
        nlink: beforeStat.nlink,
        size: beforeStat.size,
        mtimeNs: beforeStat.mtimeNs,
      },
    );
  });

  it("fails fresh backup health closed for every non-active blocking lock", async () => {
    for (const fixture of [
      {
        status: "expired",
        ageMilliseconds: BACKUP_CYCLE_TIMEOUT_MILLISECONDS + 1,
      },
      {
        status: "stale",
        ageMilliseconds: BACKUP_LOCK_STALE_MILLISECONDS + 1,
      },
      {
        status: "future",
        ageMilliseconds: -1,
      },
      {
        status: "unreadable",
        ageMilliseconds: BACKUP_LOCK_STALE_MILLISECONDS + 1,
      },
    ] as const) {
      const config = configuration();
      const cycle = await runTrackedCycle(config, fakeOperations(config).operations);
      const now = Math.max(Date.now(), cycle.verifiedAt);
      if (fixture.status === "unreadable") {
        const path = backupLockPath(config);
        writeFileSync(path, "{unreadable\n", { mode: 0o600 });
        const modifiedAt = now - fixture.ageMilliseconds;
        utimesSync(path, modifiedAt / 1_000, modifiedAt / 1_000);
      } else {
        acquireBackupLock(config, fixture.status, now - fixture.ageMilliseconds);
      }

      assert.equal(inspectBackupLock(config, now).status, fixture.status);
      const health = inspectBackupHealth(config, now);
      assert.equal(health.backup_available, true);
      assert.equal(health.ok, false);
      assert.equal(health.status, "unhealthy");
      assert.equal(health.backup_in_progress, false);
      assert.equal(health.recovery_required, true);
    }
  });

  it("prints the exact stale lock record and cleanup eligibility through inspect-lock", async () => {
    const config = configuration();
    const createdAt = Date.now() - BACKUP_LOCK_STALE_MILLISECONDS - 10_000;
    const lock = acquireBackupLock(config, "cli-inspection", createdAt);
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };

    const output = JSON.parse(await captureStandardOutput(() =>
      runBackupCommand(["inspect-lock"], environment))) as {
        status: string;
        record: Record<string, unknown> | null;
        age_milliseconds: number | null;
        cleanup_eligible: boolean;
      };
    assert.equal(output.status, "stale");
    assert.deepEqual(output.record, lock.record);
    assert.equal(output.cleanup_eligible, true);
    assert.ok((output.age_milliseconds ?? 0) > BACKUP_LOCK_STALE_MILLISECONDS);
    assert.equal(readBackupLock(config).token, lock.record.token);
  });

  it("does not remove a live one-link creation artifact before publication", () => {
    const config = configuration();
    const originalFsyncSync = fs.fsyncSync;
    let recoveryInterleaved = false;
    const hookedFsyncSync = ((...arguments_: Parameters<typeof fs.fsyncSync>) => {
      const result = Reflect.apply(originalFsyncSync, fs, arguments_);
      if (!recoveryInterleaved) {
        recoveryInterleaved = true;
        assert.throws(
          () => readBackupLock(config),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT",
        );
      }
      return result;
    }) as typeof fs.fsyncSync;
    assert.equal(Reflect.set(fs, "fsyncSync", hookedFsyncSync), true);
    syncBuiltinESMExports();
    let lock: ReturnType<typeof acquireBackupLock> | undefined;
    try {
      lock = acquireBackupLock(config, "pre-publication-recovery", Date.now());
    } finally {
      assert.equal(Reflect.set(fs, "fsyncSync", originalFsyncSync), true);
      syncBuiltinESMExports();
    }
    assert.equal(recoveryInterleaved, true);
    assert.equal(readBackupLock(config).token, lock.record.token);
    lock.release();
  });

  it("retains ownership when recovery finishes a two-link publication", () => {
    const config = configuration();
    const originalLinkSync = fs.linkSync;
    let recoveredToken: string | null = null;
    const hookedLinkSync = ((...arguments_: Parameters<typeof fs.linkSync>) => {
      const result = Reflect.apply(originalLinkSync, fs, arguments_);
      if (
        recoveredToken === null &&
        String(arguments_[1]) === backupLockPath(config)
      ) {
        recoveredToken = readBackupLock(config).token;
      }
      return result;
    }) as typeof fs.linkSync;
    assert.equal(Reflect.set(fs, "linkSync", hookedLinkSync), true);
    syncBuiltinESMExports();
    let lock: ReturnType<typeof acquireBackupLock> | undefined;
    try {
      lock = acquireBackupLock(config, "publication-recovery", Date.now());
    } finally {
      assert.equal(Reflect.set(fs, "linkSync", originalLinkSync), true);
      syncBuiltinESMExports();
    }
    assert.equal(recoveredToken, lock.record.token);
    assert.equal(readBackupLock(config).token, lock.record.token);
    lock.release();
    assert.equal(existsSync(backupLockPath(config)), false);
  });

  it("repairs an interrupted two-link lock publication", () => {
    const config = configuration();
    const lock = acquireBackupLock(config, "atomic-publication", Date.now());
    const temporary = join(
      config.backupDirectory,
      ".perpay-local-backup-lock-12345678-1234-4123-8123-123456789abc.tmp",
    );
    linkSync(lock.path, temporary);
    assert.equal(existsSync(temporary), true);
    assert.equal(readBackupLock(config).token, lock.record.token);
    assert.equal(existsSync(temporary), false);
    lock.release();
  });

  it("lives in the backup volume and requires explicit stale-lock cleanup", () => {
    const config = configuration();
    const now = Date.parse("2026-08-17T00:00:00Z");
    const first = acquireBackupLock(config, "first", now);
    assert.equal(backupLockPath(config), join(config.backupDirectory, "perpay-local-backup.lock"));
    assert.throws(
      () => acquireBackupLock(config, "second", now + 1),
      /already running/u,
    );
    const staleNow = now + BACKUP_LOCK_STALE_MILLISECONDS + 1;
    assert.throws(
      () => acquireBackupLock(config, "second", staleNow),
      /stale.*clear it explicitly/u,
    );
    assert.throws(
      () => clearStaleBackupLock(config, {
        expectedToken: "12345678-1234-4123-8123-123456789abc",
        confirmNoBackupProcess: true,
        now: staleNow,
      }),
      /token does not match/u,
    );
    const cleared = clearStaleBackupLock(config, {
      expectedToken: first.record.token,
      confirmNoBackupProcess: true,
      now: staleNow,
    });
    assert.equal(cleared.token, first.record.token);
    const second = acquireBackupLock(config, "second", staleNow);
    second.release();
  });

  it("requires force and the seven-hour interval for an unreadable lock", () => {
    const config = configuration();
    const path = backupLockPath(config);
    const old = Date.parse("2026-08-17T00:00:00Z");
    writeFileSync(path, "{unreadable\n", { mode: 0o600 });
    utimesSync(path, old / 1_000, old / 1_000);
    assert.throws(
      () => clearStaleBackupLock(config, {
        confirmNoBackupProcess: true,
        forceUnreadableLock: true,
        now: old + BACKUP_LOCK_STALE_MILLISECONDS,
      }),
      /older than seven hours/u,
    );
    assert.throws(
      () => clearStaleBackupLock(config, {
        expectedToken: "12345678-1234-4123-8123-123456789abc",
        confirmNoBackupProcess: true,
        now: old + BACKUP_LOCK_STALE_MILLISECONDS + 1,
      }),
      /unreadable/u,
    );
    const cleared = clearStaleBackupLock(config, {
      confirmNoBackupProcess: true,
      forceUnreadableLock: true,
      now: old + BACKUP_LOCK_STALE_MILLISECONDS + 1,
    });
    assert.equal(cleared.token, "unreadable-lock-cleared");
    assert.equal(existsSync(path), false);
  });

  it("exposes stale-lock cleanup only through the explicit CLI contract", async () => {
    const config = configuration();
    const lock = acquireBackupLock(
      config,
      "cli-cleanup",
      Date.now() - BACKUP_LOCK_STALE_MILLISECONDS - 10_000,
    );
    const environment = {
      PERPAY_DATA_DIR: config.dataDirectory,
      PERPAY_BACKUP_DIR: config.backupDirectory,
      PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
      PERPAY_BACKUP_KEEP_COUNT: "7",
    };
    await assert.rejects(
      runBackupCommand(["clear-lock", lock.record.token], environment),
      /usage/u,
    );
    const output = JSON.parse(await captureStandardOutput(() => runBackupCommand([
      "clear-lock",
      lock.record.token,
      "--confirm-no-backup-process",
    ], environment))) as { token: string };
    assert.equal(output.token, lock.record.token);
    assert.equal(existsSync(lock.path), false);
  });

  it("holds the lock for the full asynchronous database copy", async () => {
    const config = configuration();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const first = fakeOperations(config, {
      async create() {
        entered.resolve();
        await resume.promise;
        return fakeBackup(config);
      },
    });
    const running = runTrackedCycle(config, first.operations);
    await entered.promise;
    await assert.rejects(
      runTrackedCycle(config, fakeOperations(config).operations),
      /already running/u,
    );
    resume.resolve();
    await running;
  });
});
