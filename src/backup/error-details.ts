// SPDX-License-Identifier: MIT

export interface BackupErrorDetails {
  readonly message: string;
  readonly error_type: string;
  readonly error_code?: string;
}

const UNKNOWN_MESSAGE = "Backup operation failed; inspect the reported stage and local service configuration.";
const ISOLATION_REQUIRED = "application database is unreadable; explicit isolation is required after stopping all writers";
const SAFE_MESSAGES = new Set([
  "expected backup SHA-256 must be 64 lowercase hexadecimal characters",
  "backup name is invalid",
  "operational backup name is invalid",
  "backup SHA-256 does not match the expected value",
  "operational backup SHA-256 does not match the expected value",
  "backup artifact SHA-256 does not match the expected value",
  "published backup SHA-256 differs from the online backup result",
  "backup belongs to another application instance",
  "application instance identity changed",
  "backup repository verification does not match the new recovery point",
  "PERPAY_MASTER_KEY does not match this database or its key guard is damaged",
  "deployment master key is required to restore a backup",
  "deployment master key is required to restore a backup; set PERPAY_MASTER_KEY or PERPAY_SECRETS_DIR/master-key",
  "restore master key must contain exactly 32 bytes",
  "selected backup does not contain a runtime master key guard",
  "selected backup is missing its runtime master key guard",
  "selected backup is missing a valid instance identity",
  "backup restore configuration validation failed: PERPAY_MASTER_KEY must contain 64 hexadecimal characters",
  "backup restore configuration validation failed: secrets/master-key is missing",
  "backup restore configuration validation failed: secrets/master-key must be a private ordinary file",
  "backup restore configuration validation failed: secrets/master-key must contain 64 hexadecimal characters",
  "restore configuration validation failed: set PERPAY_MASTER_KEY or PERPAY_SECRETS_DIR/master-key",
  "restore configuration validation failed: secrets/master-key is missing",
  "restore configuration validation failed: secrets/master-key must be a private ordinary file",
  "restore configuration validation failed: secrets/master-key must contain 64 hexadecimal characters",
  "application database is still owned; stop the app service before restore",
  "another process already owns the database lease",
  "application database contains a live application lease",
  "operational backup contains a live application lease",
  "application database WAL could not be checkpointed",
  "application database could not enter a self-contained journal mode",
  "backup policy in runtime configuration is invalid",
  "backup state is unreadable",
  "backup state is invalid",
  "backup state is damaged; repeat restore with --rebuild-state after checking the selected backup",
  "backup state is missing; repeat restore with --rebuild-state after checking the selected backup",
  "backup state permissions are too broad",
  "backup state must be a small ordinary file",
  "backup must use self-contained DELETE journal mode",
  "backup is not a self-contained SQLite database",
  "backup contains an application lease",
  "system clock moved backwards relative to persisted backup state",
  "system clock moved backwards during backup",
  "backup retention contains files requiring explicit cleanup",
  "the state-referenced backup is missing from the backup directory",
  "another backup operation is already running",
  "backup lock is unreadable",
  "backup lock token does not match",
  "backup lock is not older than the seven-hour safety interval",
  "clearing a backup lock requires explicit process-stop confirmation",
  "database maintenance lock already exists; another maintenance operation may be running",
  "database maintenance lock already exists and is unreadable; stop all maintenance processes and clear it explicitly",
  "database maintenance lock token does not match",
  "database restore failed during cleanup",
  "database restore failed while releasing maintenance locks",
  "database restore failed while releasing the publication lock",
  "unreadable database isolation or publication failed; preserve original files, quarantine directory, and maintenance lock before recovery",
  "application database and sidecars must be ordinary files with one link",
  "application database or sidecar identity changed during restore",
  "application database or sidecar appeared during restore",
  "application database or sidecar bytes changed during restore",
  "isolated database or sidecar bytes changed during restore",
  "restored database staging bytes differ from the selected backup",
  "operational backup changed after source preflight",
  "backup configuration validation failed: data and backup directories must be separate",
  "backup configuration validation failed: PERPAY_BACKUP_DIR must not be empty",
]);
const NATIVE_MESSAGES = new Map([
  ["ENOENT", "A required file or directory does not exist."],
  ["EACCES", "File access was denied; check directory ownership and permissions."],
  ["EPERM", "File access was denied; check directory ownership and permissions."],
  ["ENOSPC", "There is not enough disk space for the backup or restore operation."],
  ["EDQUOT", "The storage quota is exhausted; free space or raise the quota."],
  ["EROFS", "The target filesystem is read-only."],
  ["EBUSY", "A required file or device is busy; stop conflicting processes before retrying."],
  ["EEXIST", "A required destination or lock already exists; inspect it before retrying."],
  ["EIO", "The storage device reported an input/output failure."],
  ["EMFILE", "The process has too many open files."],
  ["ENFILE", "The system has too many open files."],
  ["ETIMEDOUT", "The storage operation timed out."],
  ["ABORT_ERR", "The backup operation was cancelled or exceeded its time limit."],
  ["ERR_SQLITE_ERROR", "SQLite could not complete the operation; inspect database health and maintenance locks."],
]);
const CONFIGURATION_FIELDS = [
  "PERPAY_DATA_DIR", "PERPAY_BACKUP_DIR", "PERPAY_BACKUP_INTERVAL_SECONDS", "PERPAY_BACKUP_KEEP_COUNT",
  "PERPAY_MASTER_KEY", "PERPAY_SECRETS_DIR",
];
const SAFE_ERROR_NAMES = new Set(["BackupCycleError", "StorageCapacityError", "MaintenanceLeaseClaimedError", "AbortError", "TimeoutError"]);

/** Emits only reviewed local messages and fixed diagnostics, never arbitrary error text or paths. */
export function backupErrorDetails(error: unknown): BackupErrorDetails {
  try {
    return collectBackupErrorDetails(error);
  } catch {
    // Proxy traps and revoked proxies can throw even during type checks.
    return { message: UNKNOWN_MESSAGE, error_type: "unknown_error" };
  }
}

function collectBackupErrorDetails(error: unknown): BackupErrorDetails {
  const queue: unknown[] = [error];
  const visited = new Set<Error>();
  const messages = new Set<string>();
  let errorCode: string | undefined;
  for (let inspected = 0; queue.length > 0 && inspected < 16; inspected++) {
    const current = queue.shift();
    if (!(current instanceof Error) || visited.has(current)) continue;
    visited.add(current);
    const code = ownData(current, "code");
    if (typeof code === "string" && NATIVE_MESSAGES.has(code)) errorCode ??= code;
    const message = summarize(current);
    if (message && messages.size < 4) messages.add(message);
    const cause = ownData(current, "cause");
    if (cause !== undefined) queue.push(cause);
    const children = ownData(current, "errors");
    if (Array.isArray(children)) {
      const count = ownData(children, "length");
      if (typeof count === "number") {
        for (let index = 0; index < Math.min(count, 8); index++) queue.push(ownData(children, String(index)));
      }
    }
  }
  return {
    message: (messages.size ? [...messages].join("; ") : UNKNOWN_MESSAGE).slice(0, 1024),
    error_type: safeErrorType(error),
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
  };
}

function summarize(error: Error): string | undefined {
  const message = ownData(error, "message");
  if (typeof message === "string") {
    if (SAFE_MESSAGES.has(message)) return message;
    if (message === ISOLATION_REQUIRED) return `${ISOLATION_REQUIRED}; use --quarantine-unreadable-current only after preserving recovery evidence`;
    if (message.startsWith("usage: backup-runner <")) return "Invalid backup command or arguments; check the maintenance guide for required arguments and confirmation flags.";
    if (/^(?:backup |backup restore |restore )configuration validation failed:/.test(message)) {
      const fields = CONFIGURATION_FIELDS.filter(field => message.includes(field));
      return `Backup configuration is invalid; check ${fields.length ? fields.join(", ") : "the configured directories, backup policy and restore master key"}.`;
    }
    if (message.startsWith("insufficient storage headroom:")) return "Insufficient storage headroom; free space for a complete database copy and its safety reserve.";
    if (/^(?:backup|operational backup|application database|migration backup|restore quarantine) failed application integrity checks:/.test(message)) {
      return "The database failed application integrity checks; preserve the database and select a verified compatible backup.";
    }
    if (/^backup schema \d+ is outside application compatibility \d+-\d+$/.test(message)) {
      return "The backup schema is incompatible with this application; use a matching application version.";
    }
    if (/^(?:backup|database maintenance) lock (?:already exists and )?is stale;/.test(message)) {
      return "A stale maintenance lock requires inspection; stop all writers and use the documented lock inspection and cleanup commands.";
    }
  }
  const code = ownData(error, "code");
  if (typeof code === "string" && NATIVE_MESSAGES.has(code)) {
    if (code === "ERR_SQLITE_ERROR") {
      const sqliteCode = ownData(error, "errcode");
      const primary = typeof sqliteCode === "number" && Number.isSafeInteger(sqliteCode) && sqliteCode > 0 ? sqliteCode & 0xff : 0;
      if (primary === 5 || primary === 6) return "SQLite database is busy or locked; stop conflicting writers before retrying.";
      if (primary === 11 || primary === 26) return "SQLite data is corrupt or is not a database; preserve the original files and verify the selected backup.";
      if (primary === 14) return "SQLite could not open the database; check that its files and directories exist with the required permissions.";
      if (primary === 13) return NATIVE_MESSAGES.get("ENOSPC");
    }
    return NATIVE_MESSAGES.get(code);
  }
  if (error instanceof SyntaxError) return "Backup JSON or structured metadata is invalid; inspect the protected source file locally.";
  return undefined;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const name = ownData(error, "name");
  if (typeof name === "string" && SAFE_ERROR_NAMES.has(name)) return name;
  if (error instanceof AggregateError) return "AggregateError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  return "Error";
}

function ownData(value: object, key: string): unknown {
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && "value" in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}
