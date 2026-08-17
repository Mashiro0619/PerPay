import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { BackupConfig } from "./config.ts";
import { syncDirectory } from "../database/maintenance-lock.ts";
import {
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
} from "../infrastructure/storage/permissions.ts";

const LOCK_FORMAT_VERSION = 1;
export const BACKUP_CYCLE_TIMEOUT_MILLISECONDS = 6 * 60 * 60 * 1_000;
/** A lock is only eligible for explicit operator cleanup after this interval. */
export const BACKUP_LOCK_STALE_MILLISECONDS = BACKUP_CYCLE_TIMEOUT_MILLISECONDS + 60 * 60 * 1_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CREATE_TEMP_PATTERN = new RegExp(
  `^\\.perpay-local-backup-lock-${UUID_PATTERN}\\.tmp$`,
  "u",
);
const RECLAIM_TEMP_PATTERN = new RegExp(
  `^perpay-local-backup-lock-reclaim-${UUID_PATTERN}\\.tmp$`,
  "u",
);

export interface BackupLockRecord {
  readonly formatVersion: 1;
  readonly token: string;
  readonly operation: string;
  readonly createdAt: string;
}

export type BackupLockStatus =
  | "missing"
  | "active"
  | "expired"
  | "stale"
  | "future"
  | "unreadable";

export interface BackupLockInspection {
  readonly status: BackupLockStatus;
  readonly record: BackupLockRecord | null;
  readonly ageMilliseconds: number | null;
  readonly cleanupEligible: boolean;
}

export interface BackupLock {
  readonly path: string;
  readonly record: BackupLockRecord;
  /** Kept for API compatibility; stale locks are never reclaimed implicitly. */
  readonly reclaimed: BackupLockRecord | null;
  release(): void;
}

export interface ClearBackupLockOptions {
  readonly expectedToken?: string | undefined;
  readonly confirmNoBackupProcess: boolean;
  readonly forceUnreadableLock?: boolean | undefined;
  readonly now: number;
}

export function backupLockPath(config: Pick<BackupConfig, "backupDirectory">): string {
  return join(resolve(config.backupDirectory), "perpay-local-backup.lock");
}

export function acquireBackupLock(
  config: BackupConfig,
  operation: string,
  now: number,
): BackupLock {
  hardenProcessFileCreation();
  validateOperation(operation);
  validateClock(now);

  const path = backupLockPath(config);
  recoverInterruptedLockArtifacts(path);
  try {
    return createLock(path, operation, now);
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
    let existing: BackupLockRecord;
    try {
      existing = readBackupLock(config);
    } catch (readError) {
      throw new Error(
        "backup lock is unreadable; stop all backup processes and use clear-lock " +
        "with --force-unreadable-lock after the seven-hour safety interval",
        { cause: readError },
      );
    }
    const createdAt = Date.parse(existing.createdAt);
    if (now < createdAt) {
      throw new Error("backup lock clock is ahead of the current clock");
    }
    if (now - createdAt <= BACKUP_LOCK_STALE_MILLISECONDS) {
      throw new Error("another backup operation is already running");
    }
    throw new Error(
      `backup lock is stale; stop all backup processes and clear it explicitly with token ${existing.token}`,
    );
  }
}

/**
 * Clears a lock only after an operator has stopped every backup process and
 * supplied the exact token. No process ever deletes a lock solely because it
 * is old; this avoids a stale-reclaimer race with a still-running owner.
 */
export function clearStaleBackupLock(
  config: BackupConfig,
  options: ClearBackupLockOptions,
): BackupLockRecord {
  if (!options.confirmNoBackupProcess) {
    throw new Error("clearing a backup lock requires explicit process-stop confirmation");
  }
  validateClock(options.now);
  const path = backupLockPath(config);
  recoverInterruptedLockArtifacts(path);

  if (options.forceUnreadableLock) {
    if (options.expectedToken !== undefined) {
      throw new Error("an unreadable backup lock cannot be cleared with a token");
    }
    const identity = inspectLockIdentity(path);
    const age = options.now - identity.modifiedAtMilliseconds;
    if (age < 0) throw new Error("backup lock clock is ahead of the file clock");
    if (age <= BACKUP_LOCK_STALE_MILLISECONDS) {
      throw new Error("an unreadable backup lock must be older than seven hours before clearing");
    }
    removePathWithIdentity(path, identity);
    return Object.freeze({
      formatVersion: 1,
      token: "unreadable-lock-cleared",
      operation: "unreadable-lock-cleared",
      createdAt: new Date(identity.modifiedAtMilliseconds).toISOString(),
    });
  }

  if (options.expectedToken === undefined) {
    throw new Error("clearing a readable backup lock requires its exact token");
  }
  const record = readBackupLock(config);
  if (record.token !== options.expectedToken) {
    throw new Error("backup lock token does not match");
  }
  const createdAt = Date.parse(record.createdAt);
  if (options.now < createdAt) {
    throw new Error("backup lock clock is ahead of the current clock");
  }
  if (options.now - createdAt <= BACKUP_LOCK_STALE_MILLISECONDS) {
    throw new Error("backup lock is not older than the seven-hour safety interval");
  }
  removeExactLock(config, record.token);
  return record;
}

export function readBackupLock(config: BackupConfig): BackupLockRecord {
  const path = backupLockPath(config);
  recoverInterruptedLockArtifacts(path);
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 4 * 1024
  ) {
    throw new Error("backup lock must be a small ordinary file");
  }
  hardenExistingPrivateFile(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("backup lock is unreadable", { cause: error });
  }
  return parseLockRecord(value);
}

/**
 * Inspects a lock without repairing, chmodding, or deleting any artifact.
 * Health probes and operators use the same bounded classification so an
 * expired, future-dated, or unreadable lock cannot be mistaken for no lock.
 */
export function inspectBackupLock(
  config: Pick<BackupConfig, "backupDirectory">,
  now: number,
): BackupLockInspection {
  validateClock(now);
  const path = backupLockPath(config);
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return Object.freeze({
        status: "missing",
        record: null,
        ageMilliseconds: null,
        cleanupEligible: false,
      });
    }
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > 4 * 1024 ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    return unreadableInspection(now, Number(before.mtimeMs));
  }
  try {
    const record = readBackupLockByPath(path);
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      return unreadableInspection(now, Number(after.mtimeMs));
    }
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isSafeInteger(createdAt)) {
      return unreadableInspection(now, Number(after.mtimeMs));
    }
    const ageMilliseconds = now - createdAt;
    const status: BackupLockStatus = ageMilliseconds < 0
      ? "future"
      : ageMilliseconds <= BACKUP_CYCLE_TIMEOUT_MILLISECONDS
        ? "active"
        : ageMilliseconds <= BACKUP_LOCK_STALE_MILLISECONDS
          ? "expired"
          : "stale";
    return Object.freeze({
      status,
      record,
      ageMilliseconds,
      cleanupEligible: status === "stale",
    });
  } catch {
    return unreadableInspection(now, Number(before.mtimeMs));
  }
}

export function isBackupLockActive(
  config: Pick<BackupConfig, "backupDirectory">,
  now: number,
): boolean {
  return inspectBackupLock(config, now).status === "active";
}

function unreadableInspection(now: number, modifiedAt: number): BackupLockInspection {
  const ageMilliseconds = Number.isFinite(modifiedAt) && modifiedAt >= 0
    ? now - modifiedAt
    : null;
  return Object.freeze({
    status: "unreadable",
    record: null,
    ageMilliseconds,
    cleanupEligible:
      ageMilliseconds !== null && ageMilliseconds > BACKUP_LOCK_STALE_MILLISECONDS,
  });
}

function createLock(path: string, operation: string, now: number): BackupLock {
  const token = randomUUID();
  const record: BackupLockRecord = Object.freeze({
    formatVersion: LOCK_FORMAT_VERSION,
    token,
    operation,
    createdAt: new Date(now).toISOString(),
  });
  const temporary = join(dirname(path), `.perpay-local-backup-lock-${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  let closed = false;
  let unpublishedIdentity: LockStat | null = null;
  try {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(handle, bytes, offset, bytes.byteLength - offset);
      if (written < 1) throw new Error("backup lock write made no progress");
      offset += written;
    }
    fsyncSync(handle);
    closeSync(handle);
    closed = true;
    hardenExistingPrivateFile(temporary);
    unpublishedIdentity = inspectLockIdentity(temporary);

    // A fully written file is published with link()'s no-replace semantics.
    // If the process dies before unlinking the temporary name, the next
    // acquisition repairs the exact two-link pair without trusting contents.
    linkSync(temporary, path);
    syncDirectory(dirname(path));
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      // A concurrent reader may have repaired our completed two-link
      // publication. Only accept that outcome when the public name is still
      // this exact inode and contains this acquisition's token.
      inspectOwnedPublishedLock(path, unpublishedIdentity, token);
    }
    syncDirectory(dirname(path));
  } catch (error) {
    if (!closed) closeSync(handle);
    try {
      unlinkSync(temporary);
      syncDirectory(dirname(path));
    } catch {
      // Preserve the original error; the exact temporary name is recoverable.
    }
    throw error;
  }

  if (unpublishedIdentity === null) {
    throw new Error("backup lock publication identity is unavailable");
  }
  const identity = inspectOwnedPublishedLock(path, unpublishedIdentity, token);
  let released = false;
  return Object.freeze({
    path,
    record,
    reclaimed: null,
    release(): void {
      if (released) return;
      const stat = lstatSync(path, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.dev !== identity.device ||
        stat.ino !== identity.inode
      ) {
        throw new Error("backup lock identity changed while it was held");
      }
      const current = readBackupLockByPath(path);
      if (current.token !== token) throw new Error("backup lock token changed while it was held");
      unlinkSync(path);
      syncDirectory(dirname(path));
      released = true;
    },
  });
}

function removeExactLock(config: BackupConfig, expectedToken: string): void {
  const path = backupLockPath(config);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error("backup lock must be an ordinary file");
  }
  const record = readBackupLock(config);
  if (record.token !== expectedToken) throw new Error("backup lock changed while reclaiming it");

  // Freeze the old inode with a private hard link before unlinking the public
  // name. If the owner releases or a replacement appears during the race, the
  // identity checks fail and no unrelated lock is removed.
  const tombstone = join(
    dirname(path),
    `perpay-local-backup-lock-reclaim-${randomUUID()}.tmp`,
  );
  let linked = false;
  try {
    linkSync(path, tombstone);
    linked = true;
    const held = lstatSync(path, { bigint: true });
    const heldTombstone = lstatSync(tombstone, { bigint: true });
    if (
      !sameIdentity(held, before) ||
      !sameIdentity(heldTombstone, before) ||
      held.nlink !== 2n ||
      heldTombstone.nlink !== 2n
    ) {
      throw new Error("backup lock identity changed while reclaiming it");
    }
    if (readBackupLockByPath(path).token !== expectedToken) {
      throw new Error("backup lock token changed while reclaiming it");
    }
    unlinkSync(path);
    syncDirectory(dirname(path));
    unlinkSync(tombstone);
    syncDirectory(dirname(path));
  } catch (error) {
    if (linked) {
      try {
        unlinkSync(tombstone);
        syncDirectory(dirname(path));
      } catch {
        // Leave a recoverable tombstone rather than touching a replacement.
      }
    }
    throw error;
  }
}

function recoverInterruptedLockArtifacts(path: string): void {
  const directory = dirname(path);
  let changed = false;
  for (const name of readdirSync(directory)) {
    const isCreate = CREATE_TEMP_PATTERN.test(name);
    const isReclaim = RECLAIM_TEMP_PATTERN.test(name);
    if (!isCreate && !isReclaim) continue;
    const temporary = join(directory, name);
    const temporaryStat = lstatSync(temporary, { bigint: true });
    if (
      temporaryStat.isSymbolicLink() ||
      !temporaryStat.isFile() ||
      (temporaryStat.nlink !== 1n && temporaryStat.nlink !== 2n)
    ) {
      throw new Error("backup lock temporary artifact must be an ordinary file");
    }
    let publicStat: ReturnType<typeof lstatSync> | null = null;
    try {
      publicStat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    if (publicStat !== null &&
        publicStat.isFile() &&
        !publicStat.isSymbolicLink() &&
        sameIdentity(publicStat, temporaryStat)) {
      if (publicStat.nlink !== 2n || temporaryStat.nlink !== 2n) {
        throw new Error("backup lock temporary link count is invalid");
      }
      // The public lock is complete; only the staging/reclaim name remains.
      unlinkSync(temporary);
      changed = true;
      continue;
    }
    if (isCreate) {
      // A one-link creation artifact may still be owned by a publisher that
      // has not reached link() yet. Unique names make it harmless to leave in
      // place; deleting it would race and abort that live acquisition.
      if (temporaryStat.nlink !== 1n) {
        throw new Error("backup lock creation artifact has an unexpected hard link");
      }
      continue;
    }
    // An unlinked public name or a temp belonging to a replaced lock is safe
    // to remove for reclaim tombstones. Never unlink the public path here.
    unlinkSync(temporary);
    changed = true;
  }
  if (changed) syncDirectory(directory);
}

interface LockStat {
  readonly device: bigint;
  readonly inode: bigint;
  readonly modifiedAtMilliseconds: number;
}

function inspectLockIdentity(path: string): LockStat {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new Error("backup lock must be an ordinary file");
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    modifiedAtMilliseconds: Number(stat.mtimeMs),
  });
}

function inspectOwnedPublishedLock(
  path: string,
  expected: LockStat,
  expectedToken: string,
): LockStat {
  const before = inspectLockIdentity(path);
  if (before.device !== expected.device || before.inode !== expected.inode) {
    throw new Error("backup lock identity changed while it was being published");
  }
  if (readBackupLockByPath(path).token !== expectedToken) {
    throw new Error("backup lock token changed while it was being published");
  }
  const after = inspectLockIdentity(path);
  if (
    after.device !== expected.device ||
    after.inode !== expected.inode ||
    after.device !== before.device ||
    after.inode !== before.inode
  ) {
    throw new Error("backup lock identity changed while it was being published");
  }
  return after;
}

function removePathWithIdentity(path: string, expected: LockStat): void {
  const tombstone = join(
    dirname(path),
    `perpay-local-backup-lock-reclaim-${randomUUID()}.tmp`,
  );
  let linked = false;
  try {
    linkSync(path, tombstone);
    linked = true;
    const current = lstatSync(path, { bigint: true });
    const held = lstatSync(tombstone, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== expected.device ||
      current.ino !== expected.inode ||
      !sameIdentity(current, held) ||
      current.nlink !== 2n ||
      held.nlink !== 2n
    ) {
      throw new Error("backup lock identity changed while clearing an unreadable lock");
    }
    unlinkSync(path);
    syncDirectory(dirname(path));
    unlinkSync(tombstone);
    syncDirectory(dirname(path));
  } catch (error) {
    if (linked) {
      try {
        unlinkSync(tombstone);
        syncDirectory(dirname(path));
      } catch {
        // Leave a recoverable tombstone rather than touching a replacement.
      }
    }
    throw error;
  }
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseLockRecord(value: unknown): BackupLockRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup lock has an invalid shape");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "createdAt,formatVersion,operation,token" ||
    record.formatVersion !== LOCK_FORMAT_VERSION ||
    typeof record.token !== "string" ||
    !new RegExp(`^${UUID_PATTERN}$`, "u").test(record.token) ||
    typeof record.operation !== "string" ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new Error("backup lock has invalid fields");
  }
  validateOperation(record.operation);
  return Object.freeze({
    formatVersion: 1,
    token: record.token,
    operation: record.operation,
    createdAt: record.createdAt,
  });
}

function readBackupLockByPath(path: string): BackupLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("backup lock is unreadable", { cause: error });
  }
  return parseLockRecord(value);
}

function validateOperation(operation: string): void {
  if (operation.length < 1 || operation.length > 64 || /[\u0000-\u001f\u007f]/u.test(operation)) {
    throw new TypeError("backup lock operation is invalid");
  }
}

function validateClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(new Date(now).getTime())) {
    throw new RangeError("backup lock clock is invalid");
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
