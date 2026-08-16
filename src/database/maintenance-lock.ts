import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
} from "../infrastructure/storage/permissions.ts";

const LOCK_SUFFIX = ".maintenance-lock";
const LOCK_FORMAT_VERSION = 1;

interface LockIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DatabaseMaintenanceLockRecord {
  readonly formatVersion: 1;
  readonly token: string;
  readonly operation: string;
  readonly createdAt: string;
}

export interface DatabaseMaintenanceLock {
  readonly path: string;
  readonly token: string;
  release(): void;
}

export function databaseMaintenanceLockPath(databasePath: string): string {
  return `${resolve(databasePath)}${LOCK_SUFFIX}`;
}

/** Returns true for any lock directory entry, including malformed or replaced locks. */
export function hasDatabaseMaintenanceLock(databasePath: string): boolean {
  const path = databaseMaintenanceLockPath(databasePath);
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

export function assertDatabaseMaintenanceIdle(databasePath: string): void {
  if (!hasDatabaseMaintenanceLock(databasePath)) return;
  throw new Error(
    "database maintenance is in progress; the application will not start until it finishes",
  );
}

export function acquireDatabaseMaintenanceLock(
  databasePath: string,
  operation: string,
  now: number,
): DatabaseMaintenanceLock {
  hardenProcessFileCreation();
  if (operation.length < 1 || operation.length > 128 || /[\u0000-\u001f\u007f]/u.test(operation)) {
    throw new TypeError("database maintenance operation is invalid");
  }
  const createdAt = new Date(now);
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(createdAt.getTime())) {
    throw new RangeError("maintenance clock is invalid");
  }

  const path = databaseMaintenanceLockPath(databasePath);
  const token = randomUUID();
  let handle: number;
  try {
    handle = openSync(path, "wx", 0o600);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      throw new Error(
        "database maintenance lock already exists; another maintenance operation may be running",
      );
    }
    throw error;
  }

  let identity: LockIdentity;
  try {
    const record: DatabaseMaintenanceLockRecord = Object.freeze({
      formatVersion: LOCK_FORMAT_VERSION,
      token,
      operation,
      createdAt: createdAt.toISOString(),
    });
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(handle, bytes, offset, bytes.byteLength - offset);
      if (written < 1) throw new Error("database maintenance lock write made no progress");
      offset += written;
    }
    fsyncSync(handle);
    const stat = fstatSync(handle, { bigint: true });
    identity = { device: stat.dev, inode: stat.ino };
  } catch (error) {
    closeSync(handle);
    try {
      unlinkSync(path);
      syncDirectory(dirname(path));
    } catch {
      // Preserve the original creation failure.
    }
    throw error;
  }
  closeSync(handle);
  hardenExistingPrivateFile(path);
  syncDirectory(dirname(path));

  let released = false;
  return Object.freeze({
    path,
    token,
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
        throw new Error("database maintenance lock identity changed while it was held");
      }
      const record = readDatabaseMaintenanceLock(databasePath);
      if (record.token !== token) {
        throw new Error("database maintenance lock token changed while it was held");
      }
      const finalStat = lstatSync(path, { bigint: true });
      if (
        finalStat.isSymbolicLink() ||
        !finalStat.isFile() ||
        finalStat.nlink !== 1n ||
        finalStat.dev !== identity.device ||
        finalStat.ino !== identity.inode
      ) {
        throw new Error("database maintenance lock identity changed while it was released");
      }
      unlinkSync(path);
      syncDirectory(dirname(path));
      released = true;
    },
  });
}

export function readDatabaseMaintenanceLock(
  databasePath: string,
): DatabaseMaintenanceLockRecord {
  const path = databaseMaintenanceLockPath(databasePath);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.nlink !== 1) {
    throw new Error("database maintenance lock is not an ordinary file");
  }
  hardenExistingPrivateFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("database maintenance lock is unreadable");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "createdAt,formatVersion,operation,token"
  ) {
    throw new Error("database maintenance lock has an invalid shape");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.formatVersion !== LOCK_FORMAT_VERSION ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.token,
    ) ||
    typeof value.operation !== "string" ||
    value.operation.length < 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("database maintenance lock has invalid fields");
  }
  return Object.freeze({
    formatVersion: 1,
    token: value.token,
    operation: value.operation,
    createdAt: value.createdAt,
  });
}

/** Removes a stale lock only when the caller supplies its exact recorded token. */
export function forceReleaseDatabaseMaintenanceLock(
  databasePath: string,
  expectedToken: string,
): DatabaseMaintenanceLockRecord {
  const before = lstatSync(databaseMaintenanceLockPath(databasePath), { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error("database maintenance lock is not an ordinary file");
  }
  const record = readDatabaseMaintenanceLock(databasePath);
  if (record.token !== expectedToken) {
    throw new Error("database maintenance lock token does not match");
  }
  const path = databaseMaintenanceLockPath(databasePath);
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new Error("database maintenance lock is not an ordinary file");
  }
  if (stat.dev !== before.dev || stat.ino !== before.ino) {
    throw new Error("database maintenance lock identity changed while it was being cleared");
  }
  unlinkSync(path);
  syncDirectory(dirname(path));
  return record;
}

/**
 * Clears a lock whose record could not be completed (for example, a process
 * died between creating the file and writing its JSON). The caller must have
 * independently verified that no maintenance process remains.
 */
export function forceClearUnreadableDatabaseMaintenanceLock(
  databasePath: string,
): void {
  const path = databaseMaintenanceLockPath(databasePath);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error("database maintenance lock is not an ordinary file");
  }
  try {
    readDatabaseMaintenanceLock(databasePath);
  } catch {
    const after = lstatSync(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("database maintenance lock identity changed while it was being cleared");
    }
    unlinkSync(path);
    syncDirectory(dirname(path));
    return;
  }
  throw new Error("database maintenance lock is readable; use its exact token to clear it");
}

export function syncDirectory(directory: string): void {
  try {
    const handle = openSync(directory, "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      (isFileSystemError(error, "EACCES") ||
        isFileSystemError(error, "EBADF") ||
        isFileSystemError(error, "EINVAL") ||
        isFileSystemError(error, "EPERM"))
    ) {
      return;
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
