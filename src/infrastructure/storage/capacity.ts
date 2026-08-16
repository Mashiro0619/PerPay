import { lstatSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MINIMUM_RUNTIME_FREE_BYTES = 64n * 1024n * 1024n;
export const BACKUP_WRITE_RESERVE_BYTES = 16n * 1024n * 1024n;

export interface StorageHeadroom {
  readonly availableBytes: bigint;
  readonly requiredBytes: bigint;
  readonly sufficient: boolean;
}

export class StorageCapacityError extends Error {
  readonly availableBytes: bigint;
  readonly requiredBytes: bigint;

  constructor(availableBytes: bigint, requiredBytes: bigint) {
    super(
      `insufficient storage headroom: ${availableBytes} bytes available, ` +
      `${requiredBytes} bytes required`,
    );
    this.name = "StorageCapacityError";
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
  }
}

export function requiredRuntimeFreeBytes(databaseBytes: bigint): bigint {
  requireNonNegative(databaseBytes, "database size");
  const backupHeadroom = databaseBytes + BACKUP_WRITE_RESERVE_BYTES;
  return backupHeadroom > MINIMUM_RUNTIME_FREE_BYTES
    ? backupHeadroom
    : MINIMUM_RUNTIME_FREE_BYTES;
}

export function databaseStorageFootprintBytes(databasePath: string): bigint {
  const path = resolve(databasePath);
  return ordinaryFileSize(path, "database") +
    optionalOrdinaryFileSize(`${path}-wal`, "database WAL") +
    optionalOrdinaryFileSize(`${path}-journal`, "database rollback journal");
}

export function inspectDatabaseStorageHeadroom(databasePath: string): StorageHeadroom {
  const path = resolve(databasePath);
  const databaseBytes = databaseStorageFootprintBytes(path);
  return inspectStorageHeadroom(dirname(path), requiredRuntimeFreeBytes(databaseBytes));
}

export function assertBackupStorageHeadroom(sourcePath: string, targetDirectory: string): void {
  const sourceBytes = databaseStorageFootprintBytes(resolve(sourcePath));
  const headroom = inspectStorageHeadroom(
    resolve(targetDirectory),
    sourceBytes + BACKUP_WRITE_RESERVE_BYTES,
  );
  if (!headroom.sufficient) {
    throw new StorageCapacityError(headroom.availableBytes, headroom.requiredBytes);
  }
}

export function inspectStorageHeadroom(path: string, requiredBytes: bigint): StorageHeadroom {
  requireNonNegative(requiredBytes, "required storage");
  const stats = statfsSync(resolve(path), { bigint: true });
  if (stats.bsize <= 0n || stats.bavail < 0n) {
    throw new Error("filesystem capacity information is invalid");
  }
  const availableBytes = stats.bsize * stats.bavail;
  return Object.freeze({
    availableBytes,
    requiredBytes,
    sufficient: availableBytes >= requiredBytes,
  });
}

function ordinaryFileSize(path: string, label: string): bigint {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size < 0n) {
    throw new Error(`${label} must be an ordinary file with one link`);
  }
  return stats.size;
}

function optionalOrdinaryFileSize(path: string, label: string): bigint {
  try {
    return ordinaryFileSize(path, label);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return 0n;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function requireNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new RangeError(`${label} must not be negative`);
}
