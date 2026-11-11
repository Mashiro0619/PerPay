import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ActivitySpoolWriter } from "../audit/spool.ts";
import { artifactAuditTarget, lockAuditTarget, type MaintenanceAuditTarget } from "../audit/maintenance-target.ts";

import {
  loadBackupConfig,
  loadBackupRestoreMasterKey,
  type BackupConfig,
} from "./config.ts";
import { readBackupPolicy } from "./policy.ts";
import { backupErrorDetails } from "./error-details.ts";
import {
  BACKUP_CYCLE_TIMEOUT_MILLISECONDS,
  acquireBackupLock,
  clearStaleBackupLock,
  inspectBackupLock,
} from "./lock.ts";
import {
  createLocalBackup,
  deleteLocalBackupArtifact,
  hasInterruptedBackupFiles,
  hasPublishedBackupFiles,
  inspectLocalBackup,
  listLocalBackupArtifacts,
  LOCAL_BACKUP_NAME_PATTERN,
  listLocalBackups,
  pruneLocalBackups,
  recoverInterruptedBackupFiles,
  restoreLocalBackup,
  type CreateLocalBackupOptions,
  type LocalBackup,
  type LocalBackupArtifact,
  type LocalBackupRetentionResult,
} from "./repository.ts";
import { syncDirectory } from "../database/maintenance-lock.ts";
import {
  clearStalePublicationLock,
  inspectPublicationLock,
} from "../database/maintenance.ts";
import {
  ensurePrivateDirectory,
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
} from "../infrastructure/storage/permissions.ts";

const BACKUP_STATE_VERSION = 2;
const RETRY_DELAY_MILLISECONDS = 5 * 60 * 1_000;
const POLICY_REFRESH_MILLISECONDS = 30_000;
const RESTORE_CONFIRMATION_ARGUMENT = "--confirm-replace-current-database";
const REBUILD_STATE_ARGUMENT = "--rebuild-state";
const QUARANTINE_UNREADABLE_ARGUMENT = "--quarantine-unreadable-current";
const CLEAR_LOCK_CONFIRMATION_ARGUMENT = "--confirm-no-backup-process";
const CLEAR_PUBLICATION_LOCK_CONFIRMATION_ARGUMENT = "--confirm-no-maintenance-process";
const FORCE_UNREADABLE_LOCK_ARGUMENT = "--force-unreadable-lock";
const DELETE_BACKUP_FILE_CONFIRMATION_ARGUMENT = "--confirm-delete-backup-file";
const BACKUP_STATE_KEYS = Object.freeze([
  "backupName",
  "backupRequired",
  "backupSha256",
  "backupSizeBytes",
  "instanceId",
  "intervalMilliseconds",
  "keepCount",
  "lastAttemptAt",
  "lastErrorAt",
  "lastErrorStage",
  "lastSuccessAt",
  "retainedCount",
  "schemaVersion",
  "version",
]);
const BACKUP_FAILURE_STAGES = new Set<BackupFailureStage>([
  "state",
  "database_backup",
  "verification",
  "retention",
  "restore",
  "unknown",
]);
const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type BackupFailureStage =
  | "state"
  | "database_backup"
  | "verification"
  | "retention"
  | "restore"
  | "unknown";

export class BackupCycleError extends Error {
  readonly stage: BackupFailureStage;

  constructor(stage: BackupFailureStage, cause: unknown) {
    super(`backup operation failed during ${stage}`, { cause });
    this.name = "BackupCycleError";
    this.stage = stage;
  }
}

interface BackupState {
  readonly version: typeof BACKUP_STATE_VERSION;
  /** Current policy acknowledged by the backup process, independent of backup age. */
  readonly intervalMilliseconds: number | null;
  readonly keepCount: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorAt: number | null;
  readonly lastErrorStage: BackupFailureStage | null;
  readonly backupName: string | null;
  readonly backupRequired: boolean;
  readonly backupSha256: string | null;
  readonly backupSizeBytes: number | null;
  readonly instanceId: string | null;
  readonly schemaVersion: number | null;
  readonly retainedCount: number | null;
}

const emptyBackupState: BackupState = Object.freeze({
  version: BACKUP_STATE_VERSION,
  intervalMilliseconds: null,
  keepCount: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorStage: null,
  backupName: null,
  backupRequired: false,
  backupSha256: null,
  backupSizeBytes: null,
  instanceId: null,
  schemaVersion: null,
  retainedCount: null,
});

export interface BackupOperations {
  create(config: BackupConfig, options: CreateLocalBackupOptions): Promise<LocalBackup>;
  inspect(backupDirectory: string, backupName: string, now: number): LocalBackup;
  list(backupDirectory: string, now: number): readonly LocalBackup[];
  listArtifacts(backupDirectory: string, now: number): readonly LocalBackupArtifact[];
  deleteArtifact(
    backupDirectory: string,
    backupName: string,
    expectedSha256: string,
    protectedBackupName?: string,
  ): LocalBackupArtifact;
  prune(
    backupDirectory: string,
    keepCount: number,
    now: number,
    protectedBackupName?: string,
    expectedInstanceId?: string,
    expectedSha256?: string,
    expectedSizeBytes?: number,
  ): LocalBackupRetentionResult;
  recover(backupDirectory: string): readonly string[];
  restore(
    config: BackupConfig,
    backupName: string,
    expectedSha256: string,
    expectedInstanceId: string | undefined,
    now: number,
    quarantineUnreadableCurrent?: boolean,
  ): Readonly<{
    backupName: string;
    restoredSchemaVersion: number;
    sha256: string;
    quarantinedDatabaseName: string | null;
  }>;
}

const defaultBackupOperations: BackupOperations = Object.freeze({
  create: createLocalBackup,
  inspect: inspectLocalBackup,
  list: listLocalBackups,
  listArtifacts: listLocalBackupArtifacts,
  deleteArtifact: deleteLocalBackupArtifact,
  prune: pruneLocalBackups,
  recover: recoverInterruptedBackupFiles,
  restore: restoreLocalBackup,
});

export interface BackupCycleResult {
  readonly backup: LocalBackup;
  readonly deletedBackups: number;
  readonly recoveredTemporaryFiles: number;
  readonly verifiedAt: number;
}

export interface BackupHealth {
  readonly ok: boolean;
  readonly status: "healthy" | "unhealthy";
  readonly last_attempt_at: number | null;
  readonly last_success_at: number | null;
  readonly last_error_at: number | null;
  readonly last_error_stage: BackupFailureStage | null;
  readonly backup_name: string | null;
  readonly backup_sha256: string | null;
  readonly backup_size_bytes: number | null;
  readonly instance_id: string | null;
  readonly schema_version: number | null;
  readonly interval_milliseconds: number | null;
  readonly keep_count: number | null;
  readonly retained_count: number | null;
  readonly maximum_age_milliseconds: number | null;
  readonly backup_required: boolean;
  /** True while a current backup operation owns a fresh cycle lock. */
  readonly backup_in_progress: boolean;
  readonly backup_available: boolean;
  readonly recovery_required: boolean;
  readonly clock_moved_backwards: boolean;
  readonly configuration_mismatch: boolean;
}

export async function runBackupCommand(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  operations: BackupOperations = defaultBackupOperations,
): Promise<number> {
  const command = arguments_[0] ?? "schedule";
  const activity = new ActivitySpoolWriter({ backupDirectory: environment.PERPAY_BACKUP_DIR ?? "/backups",
    kind: command === "schedule" ? "backup" : "maintenance" });
  const action = backupCommandAction(command);
  const startedAt = Date.now();
  let target: MaintenanceAuditTarget | undefined;
  try {
    const code = await executeBackupCommand(arguments_, environment, operations, activity, value => { target = value; });
    activity.record({ action, outcome: code === 0 ? "SUCCESS" : "FAILURE", durationMs: Math.max(0, Date.now() - startedAt),
      subjectType: target?.subjectType, subjectId: target?.subjectId,
      details: { ...target?.details, command: action, exit_code: code, rebuild_state: arguments_.includes(REBUILD_STATE_ARGUMENT),
        quarantine_unreadable: arguments_.includes(QUARANTINE_UNREADABLE_ARGUMENT), force_unreadable_lock: arguments_.includes(FORCE_UNREADABLE_LOCK_ARGUMENT) } },
    { instanceId: target?.instanceId ?? null, permanent: ["restore", "delete-backup-file", "clear-lock", "clear-stale-publication-lock"].includes(command) });
    return code;
  } catch (error) {
    activity.record({ action, outcome: "FAILURE", durationMs: Math.max(0, Date.now() - startedAt),
      subjectType: target?.subjectType, subjectId: target?.subjectId,
      details: { ...target?.details, command: action, stage: error instanceof BackupCycleError ? error.stage : "unknown" } },
    { permanent: ["restore", "delete-backup-file", "clear-lock", "clear-stale-publication-lock"].includes(command) });
    throw error;
  } finally { activity.close(); }
}

async function executeBackupCommand(
  arguments_: readonly string[], environment: NodeJS.ProcessEnv, operations: BackupOperations, activity: ActivitySpoolWriter,
  setTarget: (target: MaintenanceAuditTarget) => void,
): Promise<number> {
  hardenProcessFileCreation();
  const command = arguments_[0] ?? "schedule";

  // Publication locks live on the backup volume so they remain recoverable
  // even when the active data volume is missing or damaged.  Keep these
  // operator commands independent from runtime policy and master-key loading.
  if (command === "inspect-publication-lock" && arguments_.length === 1) {
    const backupDirectory = resolveBackupDirectoryForLock(environment);
    const inspection = inspectPublicationLock(backupDirectory, Date.now());
    process.stdout.write(`${JSON.stringify({
      status: inspection.status,
      record: inspection.record,
      age_milliseconds: inspection.ageMilliseconds,
      cleanup_eligible: inspection.cleanupEligible,
    })}\n`);
    return 0;
  }
  if (
    command === "clear-stale-publication-lock" &&
    arguments_.length === 3 &&
    arguments_[1] === FORCE_UNREADABLE_LOCK_ARGUMENT &&
    arguments_[2] === CLEAR_PUBLICATION_LOCK_CONFIRMATION_ARGUMENT
  ) {
    const result = clearStalePublicationLock({
      backupDirectory: resolveBackupDirectoryForLock(environment),
      confirmNoMaintenanceProcess: true,
      forceUnreadableLock: true,
      now: Date.now(),
    });
    setTarget(lockAuditTarget("publication", result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (
    command === "clear-stale-publication-lock" &&
    arguments_.length === 3 &&
    arguments_[1] !== undefined &&
    arguments_[2] === CLEAR_PUBLICATION_LOCK_CONFIRMATION_ARGUMENT
  ) {
    const result = clearStalePublicationLock({
      backupDirectory: resolveBackupDirectoryForLock(environment),
      lockToken: arguments_[1],
      confirmNoMaintenanceProcess: true,
      now: Date.now(),
    });
    setTarget(lockAuditTarget("publication", result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const baseConfig = loadBackupConfig(environment);
  const restoreFlags = arguments_.slice(4);
  const quarantineUnreadableCurrent = restoreFlags.includes(QUARANTINE_UNREADABLE_ARGUMENT);
  const config = command === "restore"
    ? withRestorePolicy(baseConfig)
    : withCurrentPolicy(baseConfig);
  ensurePrivateDirectory(config.backupDirectory);
  if (arguments_.length === 1 && command === "run-once") {
    const result = await runTrackedCycle(config, operations, undefined, activity);
    process.stdout.write(`${JSON.stringify(serializeResult(result))}\n`);
    return 0;
  }
  if (arguments_.length === 1 && command === "health") {
    const health = inspectBackupHealth(config, Date.now());
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return health.ok ? 0 : 1;
  }
  if (arguments_.length === 1 && command === "inspect-lock") {
    const inspection = inspectBackupLock(config, Date.now());
    process.stdout.write(`${JSON.stringify({
      status: inspection.status,
      record: inspection.record,
      age_milliseconds: inspection.ageMilliseconds,
      cleanup_eligible: inspection.cleanupEligible,
    })}\n`);
    return 0;
  }
  if (arguments_.length === 1 && command === "list-backups") {
    const backups = await withBackupLock(config, "list-backups", undefined, () =>
      operations.list(config.backupDirectory, Date.now()));
    process.stdout.write(`${JSON.stringify({
      backups: backups.map(serializeBackup),
    })}\n`);
    return 0;
  }
  if (arguments_.length === 1 && command === "list-backup-files") {
    const artifacts = await withBackupLock(config, "list-backup-files", undefined, () =>
      operations.listArtifacts(config.backupDirectory, Date.now()));
    process.stdout.write(`${JSON.stringify({
      files: artifacts.map(serializeBackupArtifact),
    })}\n`);
    return 0;
  }
  if (
    arguments_.length === 4 &&
    command === "delete-backup-file" &&
    arguments_[1] !== undefined &&
    arguments_[2] !== undefined &&
    arguments_[3] === DELETE_BACKUP_FILE_CONFIRMATION_ARGUMENT
  ) {
    const deleted = await withBackupLock(config, "delete-backup-file", undefined, () => {
      const state = readBackupState(config.backupDirectory);
      return operations.deleteArtifact(
        config.backupDirectory,
        arguments_[1]!,
        arguments_[2]!,
        state.backupName ?? undefined,
      );
    });
    // A deleted artifact can belong to a different instance. Keep that target
    // identity in details, without binding its spool event to the deleted DB.
    setTarget(artifactAuditTarget("backup", deleted));
    process.stdout.write(`${JSON.stringify({
      deleted: serializeBackupArtifact(deleted),
    })}\n`);
    return 0;
  }
  if (
    arguments_.length === 3 &&
    command === "clear-lock" &&
    arguments_[1] === FORCE_UNREADABLE_LOCK_ARGUMENT &&
    arguments_[2] === CLEAR_LOCK_CONFIRMATION_ARGUMENT
  ) {
    const result = clearStaleBackupLock(config, {
      confirmNoBackupProcess: true,
      forceUnreadableLock: true,
      now: Date.now(),
    });
    setTarget(lockAuditTarget("backup", result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (
    arguments_.length === 3 &&
    command === "clear-lock" &&
    arguments_[1] !== undefined &&
    arguments_[2] === CLEAR_LOCK_CONFIRMATION_ARGUMENT
  ) {
    const result = clearStaleBackupLock(config, {
      expectedToken: arguments_[1],
      confirmNoBackupProcess: true,
      now: Date.now(),
    });
    setTarget(lockAuditTarget("backup", result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (
    arguments_.length >= 4 && arguments_.length <= 6 &&
    command === "restore" &&
    arguments_[3] === RESTORE_CONFIRMATION_ARGUMENT &&
    new Set(restoreFlags).size === restoreFlags.length &&
    restoreFlags.every(flag => flag === REBUILD_STATE_ARGUMENT || flag === QUARANTINE_UNREADABLE_ARGUMENT)
  ) {
    const restoreConfig = Object.freeze({
      ...config,
      masterKey: loadBackupRestoreMasterKey(environment),
    });
    const backupName = arguments_[1] ?? "";
    const expectedSha256 = arguments_[2] ?? "";
    const result = await withBackupLock(restoreConfig, "restore", undefined, () => {
      const startedAt = Date.now();
      operations.recover(config.backupDirectory);
      if (!SHA256_PATTERN.test(expectedSha256)) {
        throw new TypeError(
          "expected backup SHA-256 must be 64 lowercase hexadecimal characters",
        );
      }
      const previousState = readBackupStateForRestore(
        config.backupDirectory,
        restoreFlags.includes(REBUILD_STATE_ARGUMENT),
      );
      const selected = operations.inspect(
        config.backupDirectory,
        backupName,
        startedAt,
      );
      if (selected.sha256 !== expectedSha256) {
        throw new Error("backup SHA-256 does not match the expected value");
      }
      if (
        previousState !== null &&
        previousState.instanceId !== null &&
        previousState.instanceId !== selected.instanceId
      ) {
        throw new Error("backup belongs to another application instance");
      }
      const selectedTarget = artifactAuditTarget("backup", selected);
      setTarget(selectedTarget);
      let state = restoredBackupState(config, selected, startedAt, true);
      // Protect the selected recovery point before replacing the database. If
      // the process dies after publication, restart retention cannot delete it.
      writeBackupState(config.backupDirectory, state);
      try {
        const restored = operations.restore(
          restoreConfig,
          backupName,
          expectedSha256,
          selected.instanceId,
          startedAt,
          quarantineUnreadableCurrent,
        );
        setTarget({ ...selectedTarget, instanceId: selected.instanceId, details: { ...selectedTarget.details,
          schema_version: restored.restoredSchemaVersion, quarantined_database_name: restored.quarantinedDatabaseName,
          restore_completed: true } });
        const succeededAt = Math.max(Date.now(), startedAt);
        state = Object.freeze({
          ...state,
          lastSuccessAt: succeededAt,
          lastErrorAt: null,
          lastErrorStage: null,
        });
        writeBackupState(config.backupDirectory, state);
        return restored;
      } catch (error) {
        const failedAt = Math.max(Date.now(), startedAt);
        state = Object.freeze({
          ...state,
          lastErrorAt: failedAt,
          lastErrorStage: "restore",
        });
        writeBackupState(config.backupDirectory, state);
        throw asBackupError("restore", error);
      }
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (arguments_.length === 1 && command === "schedule") {
    await schedule(baseConfig, operations, activity);
    return 0;
  }
  throw new Error(
    "usage: backup-runner <schedule|run-once|health|inspect-lock|inspect-publication-lock|" +
    "list-backups|list-backup-files|" +
    `delete-backup-file NAME SHA256 ${DELETE_BACKUP_FILE_CONFIRMATION_ARGUMENT}|` +
    `clear-lock LOCK_TOKEN ${CLEAR_LOCK_CONFIRMATION_ARGUMENT}|` +
    `clear-lock ${FORCE_UNREADABLE_LOCK_ARGUMENT} ${CLEAR_LOCK_CONFIRMATION_ARGUMENT}|` +
    `clear-stale-publication-lock LOCK_TOKEN ${CLEAR_PUBLICATION_LOCK_CONFIRMATION_ARGUMENT}|` +
    `clear-stale-publication-lock ${FORCE_UNREADABLE_LOCK_ARGUMENT} ` +
    `${CLEAR_PUBLICATION_LOCK_CONFIRMATION_ARGUMENT}|` +
    `restore BACKUP_NAME SHA256 ${RESTORE_CONFIRMATION_ARGUMENT} [${REBUILD_STATE_ARGUMENT}] [${QUARANTINE_UNREADABLE_ARGUMENT}]>`,
  );
}

async function schedule(config: BackupConfig, operations: BackupOperations, activity: ActivitySpoolWriter): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let reconcileBeforeDelay = true;
  try {
    while (!controller.signal.aborted) {
      const activeConfig = withCurrentPolicy(config);
      try {
        const state = readBackupState(activeConfig.backupDirectory);
        if (
          reconcileBeforeDelay ||
          state.intervalMilliseconds !== activeConfig.intervalMilliseconds ||
          state.keepCount !== activeConfig.keepCount
        ) {
          reconcileBeforeDelay = false;
          try {
            await activity.run("backup.retention", {}, () => reconcileBackupRetention(activeConfig, operations, controller.signal),
              { summarize: count => ({ deleted_backups: count }) });
            // Re-read the policy after retention before selecting a deadline.
            continue;
          } catch (error) {
            if (controller.signal.aborted) break;
            process.stderr.write(`${JSON.stringify({
              level: "warn",
              event: "backup_retention_recovery_failed",
              stage: error instanceof BackupCycleError ? error.stage : "unknown",
              ...backupErrorDetails(error),
            })}\n`);
          }
        }
        const delayMilliseconds = nextScheduledDelayMilliseconds(activeConfig, Date.now());
        if (delayMilliseconds > 0) {
          // A policy saved during the wait may move the deadline in either
          // direction. Re-read it before deciding whether to start a cycle.
          await waitFor(Math.min(delayMilliseconds, POLICY_REFRESH_MILLISECONDS), controller.signal);
          continue;
        }
        const result = await runTrackedCycle(activeConfig, operations, controller.signal, activity);
        process.stdout.write(`${JSON.stringify({
          level: "info",
          event: "backup_cycle_succeeded",
          ...serializeResult(result),
        })}\n`);
      } catch (error) {
        if (controller.signal.aborted) break;
        process.stderr.write(`${JSON.stringify({
          level: "error",
          event: "backup_cycle_failed",
          stage: error instanceof BackupCycleError ? error.stage : "unknown",
          ...backupErrorDetails(error),
        })}\n`);
        await waitFor(
          Math.min(activeConfig.intervalMilliseconds, RETRY_DELAY_MILLISECONDS),
          controller.signal,
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function withCurrentPolicy(config: BackupConfig): BackupConfig {
  const policy = readBackupPolicy(config.dataDirectory);
  return Object.freeze({
    ...config,
    intervalMilliseconds: policy.intervalMilliseconds,
    keepCount: policy.keepCount,
  });
}

function withRestorePolicy(config: BackupConfig): BackupConfig {
  // Even a read-only SQLite connection may change sidecars. No restore command
  // may open the current database before the locked evidence-preserving probe.
  process.stderr.write(`${JSON.stringify({
    level: "warn",
    event: "backup_restore_policy_skipped",
    message: "Restore is using startup backup interval and retention settings without reading the current database policy.",
    interval_milliseconds: config.intervalMilliseconds,
    keep_count: config.keepCount,
  })}\n`);
  return config;
}

function resolveBackupDirectoryForLock(environment: NodeJS.ProcessEnv): string {
  const configured = environment.PERPAY_BACKUP_DIR;
  if (configured === undefined) return resolve("/backups");
  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    throw new Error("backup configuration validation failed: PERPAY_BACKUP_DIR must not be empty");
  }
  return resolve(trimmed);
}

export async function reconcileBackupRetention(
  config: BackupConfig,
  operations: BackupOperations = defaultBackupOperations,
  signal?: AbortSignal,
): Promise<number> {
  return withBackupLock(config, "retention-recovery", signal, (cycleSignal) => {
    cycleSignal.throwIfAborted();
    let state: BackupState;
    try {
      state = readBackupState(config.backupDirectory);
    } catch (error) {
      throw asBackupError("state", error);
    }
    // Policy reconciliation cannot resolve an earlier backup failure or move
    // its retry deadline, even when recovery or retention also fails.
    const pendingFailure =
      state.lastErrorAt !== null &&
      state.lastErrorStage !== "retention" &&
      (state.lastSuccessAt === null || state.lastErrorAt >= state.lastSuccessAt)
        ? { lastErrorAt: state.lastErrorAt, lastErrorStage: state.lastErrorStage }
        : null;
    const startedAt = Date.now();
    const latestRecordedAt = latestStateTimestamp(state);
    if (latestRecordedAt !== null && startedAt < latestRecordedAt) {
      const failedAt = Math.max(Date.now(), startedAt);
      state = Object.freeze({
        ...state,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        ...(pendingFailure ?? { lastErrorAt: failedAt, lastErrorStage: "state" as const }),
      });
      writeBackupState(config.backupDirectory, state);
      throw asBackupError(
        "state",
        new Error("system clock moved backwards relative to persisted backup state"),
      );
    }
    try {
      operations.recover(config.backupDirectory);
    } catch (error) {
      state = Object.freeze({
        ...state,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        ...(pendingFailure ?? {
          lastErrorAt: Math.max(Date.now(), startedAt),
          lastErrorStage: "state" as const,
        }),
      });
      writeBackupState(config.backupDirectory, state);
      throw asBackupError("state", error);
    }
    if (
      state.backupRequired ||
      state.backupName === null ||
      state.instanceId === null
    ) {
      writeBackupState(config.backupDirectory, Object.freeze({
        ...state,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
      }));
      return 0;
    }
    const now = Math.max(Date.now(), startedAt);
    try {
      const retention = operations.prune(
        config.backupDirectory,
        config.keepCount,
        now,
        state.backupName,
        state.instanceId,
        state.backupSha256 ?? undefined,
        state.backupSizeBytes ?? undefined,
      );
      state = Object.freeze({
        ...state,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        retainedCount: retention.retainedCount,
      });
      if (retention.blocked.length > 0) {
        throw new Error("backup retention contains files requiring explicit cleanup");
      }
      state = Object.freeze({
        ...state,
        // Policy reconciliation only resolves retention failures. A failed
        // backup or verification still needs its scheduled retry to succeed.
        ...(state.lastErrorStage === "retention"
          ? { lastErrorAt: null, lastErrorStage: null }
          : {}),
      });
      writeBackupState(config.backupDirectory, state);
      return retention.deleted.length;
    } catch (error) {
      const failedAt = Math.max(Date.now(), now);
      state = Object.freeze({
        ...state,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        ...(pendingFailure ?? { lastErrorAt: failedAt, lastErrorStage: "retention" as const }),
      });
      writeBackupState(config.backupDirectory, state);
      throw asBackupError("retention", error);
    }
  });
}

export function nextScheduledDelayMilliseconds(
  config: Pick<BackupConfig, "backupDirectory" | "intervalMilliseconds">,
  now: number,
): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("backup schedule clock is invalid");
  }
  const state = readBackupState(config.backupDirectory);
  const latestRecordedAt = latestStateTimestamp(state);
  if (latestRecordedAt !== null && now < latestRecordedAt) {
    throw new Error("system clock moved backwards relative to persisted backup state");
  }
  if (state.backupRequired) return 0;
  const recentFailure =
    state.lastErrorAt !== null &&
    (state.lastSuccessAt === null || state.lastErrorAt >= state.lastSuccessAt);
  const interruptedAttempt =
    state.lastAttemptAt !== null &&
    (state.lastSuccessAt === null || state.lastAttemptAt > state.lastSuccessAt) &&
    (state.lastErrorAt === null || state.lastErrorAt < state.lastAttemptAt ||
      // Older reconciliation could overwrite an unfinished backup's error.
      state.lastErrorStage === "retention");
  if (interruptedAttempt) {
    return Math.max(
      0,
      state.lastAttemptAt! + Math.min(config.intervalMilliseconds, RETRY_DELAY_MILLISECONDS) - now,
    );
  }
  if (recentFailure) {
    // A retention problem must not create a new full backup every five
    // minutes, but it also must not gate the next scheduled recovery point.
    if (state.lastErrorStage === "retention" && state.lastSuccessAt !== null) {
      return Math.max(0, state.lastSuccessAt + config.intervalMilliseconds - now);
    }
    return Math.max(
      0,
      state.lastErrorAt! + Math.min(config.intervalMilliseconds, RETRY_DELAY_MILLISECONDS) - now,
    );
  }
  if (state.lastSuccessAt === null) return 0;
  return Math.max(0, state.lastSuccessAt + config.intervalMilliseconds - now);
}

export async function runTrackedCycle(
  config: BackupConfig,
  operations: BackupOperations = defaultBackupOperations,
  signal?: AbortSignal,
  activity?: ActivitySpoolWriter,
): Promise<BackupCycleResult> {
  const writer = activity ?? new ActivitySpoolWriter({ backupDirectory: config.backupDirectory, kind: "backup" });
  try {
    return await writer.run("backup.cycle", {}, () => executeTrackedCycle(config, operations, signal), {
      summarize: result => ({ backup_name: result.backup.name, instance_id: result.backup.instanceId, schema_version: result.backup.schemaVersion,
        backup_size_bytes: result.backup.sizeBytes, deleted_backups: result.deletedBackups, recovered_temporary_files: result.recoveredTemporaryFiles }),
    });
  } finally { if (!activity) writer.close(); }
}

async function executeTrackedCycle(config: BackupConfig, operations: BackupOperations, signal?: AbortSignal): Promise<BackupCycleResult> {
  return withBackupLock(config, "backup-cycle", signal, async (cycleSignal) => {
    cycleSignal.throwIfAborted();
    const startedAt = Date.now();
    let current: BackupState;
    try {
      current = readBackupState(config.backupDirectory);
    } catch (error) {
      throw asBackupError("state", error);
    }
    let recoveredTemporaryFiles: readonly string[] = Object.freeze([]);
    let deletedBackups = 0;
    try {
      const latestRecordedAt = latestStateTimestamp(current);
      if (latestRecordedAt !== null && startedAt < latestRecordedAt) {
        throw new Error("system clock moved backwards relative to persisted backup state");
      }
      current = Object.freeze({
        ...current,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        lastAttemptAt: startedAt,
      });
      writeBackupState(config.backupDirectory, current);
      recoveredTemporaryFiles = operations.recover(config.backupDirectory);
    } catch (error) {
      const failedAt = Math.max(Date.now(), startedAt);
      current = Object.freeze({
        ...current,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        lastAttemptAt: startedAt,
        lastErrorAt: failedAt,
        lastErrorStage: "state",
      });
      writeBackupState(config.backupDirectory, current);
      throw asBackupError("state", error);
    }

    try {
      cycleSignal.throwIfAborted();
      let backup: LocalBackup;
      try {
        backup = await operations.create(config, {
          now: startedAt,
          signal: cycleSignal,
          ...(current.instanceId === null
            ? {}
            : { expectedInstanceId: current.instanceId }),
        });
      } catch (error) {
        throw asBackupError("database_backup", error);
      }
      cycleSignal.throwIfAborted();
      if (current.instanceId !== null && backup.instanceId !== current.instanceId) {
        throw asBackupError("verification", new Error("application instance identity changed"));
      }
      let verified: LocalBackup;
      try {
        verified = operations.inspect(
          config.backupDirectory,
          backup.name,
          Math.max(Date.now(), startedAt),
        );
      } catch (error) {
        throw asBackupError("verification", error);
      }
      if (
        verified.name !== backup.name ||
        verified.sha256 !== backup.sha256 ||
        verified.sizeBytes !== backup.sizeBytes ||
        verified.schemaVersion !== backup.schemaVersion ||
        verified.instanceId !== backup.instanceId
      ) {
        throw asBackupError(
          "verification",
          new Error("backup repository verification does not match the new recovery point"),
        );
      }
      const succeededAt = Date.now();
      if (succeededAt < startedAt) {
        throw asBackupError("state", new Error("system clock moved backwards during backup"));
      }
      // Persist the new recovery point before retention. A crash or retention
      // failure can leave extra old backups, but can never lose the new one.
      current = Object.freeze({
        version: BACKUP_STATE_VERSION,
        intervalMilliseconds: config.intervalMilliseconds,
        keepCount: config.keepCount,
        lastAttemptAt: startedAt,
        lastSuccessAt: succeededAt,
        lastErrorAt: succeededAt,
        lastErrorStage: "retention",
        backupName: backup.name,
        backupRequired: false,
        backupSha256: backup.sha256,
        backupSizeBytes: backup.sizeBytes,
        instanceId: backup.instanceId,
        schemaVersion: backup.schemaVersion,
        retainedCount: Math.min(4_096, (current.retainedCount ?? 0) + 1),
      });
      writeBackupState(config.backupDirectory, current);
      let retention;
      try {
        retention = operations.prune(
          config.backupDirectory,
          config.keepCount,
          Math.max(Date.now(), startedAt),
          backup.name,
          backup.instanceId,
          backup.sha256,
          backup.sizeBytes,
        );
      } catch (error) {
        throw asBackupError("retention", error);
      }
      deletedBackups += retention.deleted.length;
      if (retention.blocked.length > 0) {
        current = Object.freeze({
          ...current,
          retainedCount: retention.retainedCount,
        });
        writeBackupState(config.backupDirectory, current);
        throw asBackupError(
          "retention",
          new Error("backup retention contains files requiring explicit cleanup"),
        );
      }
      current = Object.freeze({
        ...current,
        backupRequired: false,
        lastErrorAt: null,
        lastErrorStage: null,
        retainedCount: retention.retainedCount,
      });
      writeBackupState(config.backupDirectory, current);
      return Object.freeze({
        backup,
        deletedBackups,
        recoveredTemporaryFiles: recoveredTemporaryFiles.length,
        verifiedAt: succeededAt,
      });
    } catch (error) {
      const failedAt = Math.max(Date.now(), startedAt);
      current = Object.freeze({
        ...current,
        lastAttemptAt: startedAt,
        lastErrorAt: failedAt,
        lastErrorStage: error instanceof BackupCycleError ? error.stage : "unknown",
      });
      writeBackupState(config.backupDirectory, current);
      throw error;
    }
  });
}

function backupCommandAction(command: string): string {
  const actions: Record<string, string> = { schedule: "backup.scheduler", "run-once": "backup.run_once", health: "backup.health",
    restore: "backup.restore", "delete-backup-file": "backup.delete", "clear-lock": "backup.lock.clear",
    "clear-stale-publication-lock": "maintenance.publication_lock.clear", "list-backups": "backup.list",
    "list-backup-files": "backup.files.list", "inspect-lock": "backup.lock.inspect", "inspect-publication-lock": "maintenance.publication_lock.inspect" };
  return actions[command] ?? "backup.command.invalid";
}

export function inspectBackupHealth(
  config: {
    readonly backupDirectory?: string | undefined;
    readonly dataDirectory?: string | undefined;
    readonly intervalMilliseconds: number;
    readonly keepCount?: number | undefined;
  },
  now: number,
): BackupHealth {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("backup health clock is invalid");
  }
  const backupDirectory = config.backupDirectory ?? config.dataDirectory;
  if (backupDirectory === undefined) throw new TypeError("backup directory is required");
  const state = readBackupState(backupDirectory);
  const interval = state.intervalMilliseconds ?? config.intervalMilliseconds;
  const keepCount = state.keepCount ?? config.keepCount ?? null;
  const grace = Math.max(15 * 60 * 1_000, Math.floor(interval / 10));
  const maximumAge = interval + grace;
  const configurationMismatch =
    (state.intervalMilliseconds !== null &&
      state.intervalMilliseconds !== config.intervalMilliseconds) ||
    (config.keepCount !== undefined &&
      state.keepCount !== null &&
      state.keepCount !== config.keepCount);
  const latestRecordedAt = latestStateTimestamp(state);
  const clockMovedBackwards = latestRecordedAt !== null && now < latestRecordedAt;
  const age = state.lastSuccessAt === null ? null : now - state.lastSuccessAt;
  const recentFailure =
    state.lastErrorAt !== null &&
    (state.lastSuccessAt === null || state.lastErrorAt >= state.lastSuccessAt);
  const backupAvailable = inspectLastBackupAvailability(backupDirectory, state);
  // A valid, fresh cycle lock means a .creating-* or state staging file is
  // part of a live operation. Only treat such files as recovery evidence once
  // the owner is gone (or its six-hour execution window has elapsed).
  const lock = inspectBackupLock({ backupDirectory }, now);
  const backupInProgress = lock.status === "active";
  const lockRequiresRecovery = lock.status !== "missing" && lock.status !== "active";
  const recoveryRequired = lockRequiresRecovery ||
    (hasInterruptedBackupFiles(backupDirectory) && !backupInProgress);
  const ok =
    age !== null &&
    age >= 0 &&
    age <= maximumAge &&
    !recentFailure &&
    !clockMovedBackwards &&
    !configurationMismatch &&
    !state.backupRequired &&
    !recoveryRequired &&
    backupAvailable;
  return Object.freeze({
    ok,
    status: ok ? "healthy" : "unhealthy",
    last_attempt_at: state.lastAttemptAt,
    last_success_at: state.lastSuccessAt,
    last_error_at: state.lastErrorAt,
    last_error_stage: state.lastErrorStage,
    backup_name: state.backupName,
    backup_sha256: state.backupSha256,
    backup_size_bytes: state.backupSizeBytes,
    instance_id: state.instanceId,
    schema_version: state.schemaVersion,
    interval_milliseconds: interval,
    keep_count: keepCount,
    retained_count: state.retainedCount,
    maximum_age_milliseconds: maximumAge,
    backup_required: state.backupRequired,
    backup_in_progress: backupInProgress,
    backup_available: backupAvailable,
    recovery_required: recoveryRequired,
    clock_moved_backwards: clockMovedBackwards,
    configuration_mismatch: configurationMismatch,
  });
}

export function inspectPersistedBackupHealth(
  backupDirectory: string,
  now: number,
): BackupHealth {
  const state = readBackupState(backupDirectory);
  if (state.intervalMilliseconds === null) {
    throw new Error("backup state has no scheduling policy");
  }
  return inspectBackupHealth({
    backupDirectory,
    intervalMilliseconds: state.intervalMilliseconds,
    ...(state.keepCount === null ? {} : { keepCount: state.keepCount }),
  }, now);
}

function readBackupState(backupDirectory: string): BackupState {
  const path = backupStatePath(backupDirectory);
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 16 * 1024
    ) {
      throw new Error("backup state must be a small ordinary file");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("backup state permissions are too broad");
    }
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return emptyBackupState;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("backup state is unreadable", { cause: error });
  }
  if (!isBackupState(parsed)) throw new Error("backup state is invalid");
  return Object.freeze(parsed);
}

/** A damaged metadata file must not make an explicitly selected SQLite copy unrecoverable. */
function readBackupStateForRestore(
  backupDirectory: string,
  allowRebuild: boolean,
): BackupState | null {
  let state: BackupState;
  try {
    state = readBackupState(backupDirectory);
  } catch (error) {
    const path = backupStatePath(backupDirectory);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw error;
    } catch (statError) {
      if (isFileSystemError(statError, "ENOENT")) return emptyBackupState;
      throw statError;
    }
    if (!allowRebuild) {
      throw new Error(
        "backup state is damaged; repeat restore with --rebuild-state after checking the selected backup",
        { cause: error },
      );
    }
    return null;
  }
  if (state.backupName === null && hasPublishedBackupFiles(backupDirectory)) {
    if (!allowRebuild) {
      throw new Error(
        "backup state is missing; repeat restore with --rebuild-state after checking the selected backup",
      );
    }
    return null;
  }
  return state;
}

function restoredBackupState(
  config: BackupConfig,
  backup: LocalBackup,
  now: number,
  failed: boolean,
): BackupState {
  return Object.freeze({
    version: BACKUP_STATE_VERSION,
    intervalMilliseconds: config.intervalMilliseconds,
    keepCount: config.keepCount,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastErrorAt: failed ? now : null,
    lastErrorStage: failed ? "restore" : null,
    backupName: backup.name,
    backupRequired: true,
    backupSha256: backup.sha256,
    backupSizeBytes: backup.sizeBytes,
    instanceId: backup.instanceId,
    schemaVersion: backup.schemaVersion,
    retainedCount: 1,
  });
}

function writeBackupState(backupDirectory: string, state: BackupState): void {
  if (!isBackupState(state)) throw new TypeError("backup state is invalid");
  const directory = ensurePrivateDirectory(backupDirectory);
  const path = backupStatePath(directory);
  const temporary = join(directory, `.perpay-local-backup-state-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const handle = openSync(temporary, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, path);
    hardenExistingPrivateFile(path);
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isBackupState(value: unknown): value is BackupState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== BACKUP_STATE_KEYS.join(",")) return false;
  if (
    record.version !== BACKUP_STATE_VERSION ||
    typeof record.backupRequired !== "boolean" ||
    !isNullableBackupInterval(record.intervalMilliseconds) ||
    !isNullableKeepCount(record.keepCount) ||
    !isNullableTimestamp(record.lastAttemptAt) ||
    !isNullableTimestamp(record.lastSuccessAt) ||
    !isNullableTimestamp(record.lastErrorAt) ||
    !isNullableFailureStage(record.lastErrorStage) ||
    !isNullableBackupName(record.backupName) ||
    !isNullableFingerprint(record.backupSha256) ||
    !isNullablePositiveInteger(record.backupSizeBytes, Number.MAX_SAFE_INTEGER) ||
    !isNullableInstanceId(record.instanceId) ||
    !isNullablePositiveInteger(record.retainedCount, 4_096) ||
    !(record.schemaVersion === null ||
      (Number.isSafeInteger(record.schemaVersion) && Number(record.schemaVersion) >= 1))
  ) {
    return false;
  }
  const hasSuccess = record.lastSuccessAt !== null;
  const hasBackup =
    record.backupName !== null &&
    record.backupSha256 !== null &&
    record.backupSizeBytes !== null &&
    record.instanceId !== null &&
    record.schemaVersion !== null &&
    record.retainedCount !== null;
  if (hasSuccess !== hasBackup) return false;
  if ((record.lastErrorAt === null) !== (record.lastErrorStage === null)) return false;
  return true;
}

function inspectLastBackupAvailability(directoryInput: string, state: BackupState): boolean {
  if (
    state.backupName === null ||
    state.backupSha256 === null ||
    state.backupSizeBytes === null
  ) return false;
  const directory = resolve(directoryInput);
  const path = resolve(directory, state.backupName);
  if (basename(state.backupName) !== state.backupName || dirname(path) !== directory) return false;
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== state.backupSizeBytes ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) return false;
    // Content verification is performed by the asynchronous health provider
    // (and by every backup cycle) rather than on the HTTP request path. A
    // bounded identity check here keeps probes responsive for large SQLite
    // files; the persisted digest remains the evidence the provider compares.
    return true;
  } catch {
    return false;
  }
}

async function withBackupLock<T>(
  config: BackupConfig,
  operation: string,
  signal: AbortSignal | undefined,
  action: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  ensurePrivateDirectory(config.backupDirectory);
  const lock = acquireBackupLock(config, operation, Date.now());
  const timeout = AbortSignal.timeout(BACKUP_CYCLE_TIMEOUT_MILLISECONDS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await action(combined);
  } catch (error) {
    primaryError = error;
  }
  try {
    lock.release();
  } catch (error) {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], "backup operation and lock release failed");
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

function asBackupError(stage: BackupFailureStage, error: unknown): BackupCycleError {
  return error instanceof BackupCycleError ? error : new BackupCycleError(stage, error);
}

function backupStatePath(backupDirectory: string): string {
  return join(resolve(backupDirectory), "perpay-local-backup-state.json");
}

function latestStateTimestamp(state: BackupState): number | null {
  const timestamps = [state.lastAttemptAt, state.lastSuccessAt, state.lastErrorAt]
    .filter((value): value is number => value !== null);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

function serializeResult(result: BackupCycleResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    backup: serializeBackup(result.backup),
    verified_at: result.verifiedAt,
    deleted_backups: result.deletedBackups,
    recovered_temporary_files: result.recoveredTemporaryFiles,
  });
}

function serializeBackup(backup: LocalBackup): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: backup.name,
    sha256: backup.sha256,
    size_bytes: backup.sizeBytes,
    created_at: backup.createdAt,
    schema_version: backup.schemaVersion,
    instance_id: backup.instanceId,
  });
}

function serializeBackupArtifact(
  artifact: LocalBackupArtifact,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: artifact.name,
    created_at: artifact.createdAt,
    status: artifact.status,
    sha256: artifact.sha256,
    size_bytes: artifact.sizeBytes,
    schema_version: artifact.schemaVersion,
    instance_id: artifact.instanceId,
    error: artifact.error,
  });
}

function isNullableTimestamp(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isNullableBackupInterval(value: unknown): boolean {
  return value === null || (
    Number.isSafeInteger(value) &&
    Number(value) >= 60 * 60 * 1_000 &&
    Number(value) <= 7 * 24 * 60 * 60 * 1_000
  );
}

function isNullableKeepCount(value: unknown): boolean {
  return value === null || (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= 365
  );
}

function isNullablePositiveInteger(value: unknown, maximum: number): boolean {
  return value === null || (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= maximum
  );
}

function isNullableBackupName(value: unknown): boolean {
  return value === null || (
    typeof value === "string" &&
    value.length <= 255 &&
    LOCAL_BACKUP_NAME_PATTERN.test(value)
  );
}

function isNullableFailureStage(value: unknown): value is BackupFailureStage | null {
  return value === null ||
    (typeof value === "string" && BACKUP_FAILURE_STAGES.has(value as BackupFailureStage));
}

function isNullableFingerprint(value: unknown): boolean {
  return value === null || (typeof value === "string" && SHA256_PATTERN.test(value));
}

function isNullableInstanceId(value: unknown): boolean {
  return value === null || (typeof value === "string" && INSTANCE_ID_PATTERN.test(value));
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
  });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runBackupCommand(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        error: "backup_runner_failed",
        stage: error instanceof BackupCycleError ? error.stage : "startup",
        ...backupErrorDetails(error),
      })}\n`);
      process.exitCode = 1;
    },
  );
}
