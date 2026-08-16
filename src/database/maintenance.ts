import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  createVerifiedDatabaseBackup,
  inspectDatabaseIntegrity,
} from "./database.ts";
import {
  acquireDatabaseMaintenanceLock,
  assertDatabaseMaintenanceIdle,
  forceClearUnreadableDatabaseMaintenanceLock,
  forceReleaseDatabaseMaintenanceLock,
  readDatabaseMaintenanceLock,
  syncDirectory,
  type DatabaseMaintenanceLockRecord,
} from "./maintenance-lock.ts";
import {
  hardenExistingPrivateDirectory,
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
  hardenSqliteArtifacts,
} from "../infrastructure/storage/permissions.ts";

const DATABASE_NAME = "perpay.sqlite3";
const BACKUP_NAME_PATTERN =
  /^perpay\.sqlite3\.pre-migration-v(0|[1-9]\d*)-to-v([1-9]\d*)\.sqlite3$/;
const OPERATIONAL_BACKUP_NAME_PATTERN =
  /^perpay\.sqlite3\.backup-(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite3$/u;
const RESTORE_STAGING_NAME_PATTERN =
  /^\.perpay\.sqlite3\.restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SQLITE_TIMEOUT_MILLISECONDS = 5_000;
const RESTORE_CONFIRMATION_ARGUMENT = "--confirm-replace-current-database";

class MaintenanceLeaseClaimedError extends Error {
  readonly leaseClaimed = true;

  constructor(cause: unknown) {
    super("database maintenance lease was claimed but quiescing did not finish", { cause });
  }
}

export interface MigrationBackup {
  readonly name: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export interface RestoreMigrationBackupOptions {
  readonly dataDirectory: string;
  readonly backupName: string;
  readonly confirmReplaceCurrentDatabase: boolean;
  readonly now?: number | undefined;
}

export interface RestoreMigrationBackupResult {
  readonly backupName: string;
  readonly restoredSchemaVersion: number;
  readonly quarantinedDatabaseName: string;
}

export interface RestoreOperationalBackupOptions {
  readonly dataDirectory: string;
  readonly backupName: string;
  readonly expectedSha256: string;
  readonly confirmReplaceCurrentDatabase: boolean;
  readonly now?: number | undefined;
}

export interface RestoreOperationalBackupResult {
  readonly backupName: string;
  readonly restoredSchemaVersion: number;
  readonly sha256: string;
  readonly quarantinedDatabaseName: string | null;
}

export interface CreateOperationalBackupOptions {
  readonly dataDirectory: string;
  readonly now?: number | undefined;
}

export interface OperationalBackupResult {
  readonly name: string;
  readonly schemaVersion: number;
  readonly pages: number;
  readonly sha256: string;
}

export interface ClearStaleMaintenanceLockOptions {
  readonly dataDirectory: string;
  readonly lockToken?: string | undefined;
  readonly confirmNoMaintenanceProcess: boolean;
  readonly forceAbandonMaintenanceLease?: boolean | undefined;
  readonly finalizeInterruptedFreshRestore?: boolean | undefined;
  readonly forceUnreadableLock?: boolean | undefined;
  readonly now?: number | undefined;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
}

export function listMigrationBackups(dataDirectory: string): readonly MigrationBackup[] {
  const directory = inspectDataDirectory(dataDirectory);
  const backups: MigrationBackup[] = [];
  for (const name of readdirSync(directory)) {
    const parsed = parseMigrationBackupName(name);
    if (parsed === null) continue;
    const path = join(directory, name);
    inspectOrdinaryFile(path, "migration backup");
    assertSelfContainedSqlite(path, "migration backup");
    backups.push(parsed);
  }
  return Object.freeze(backups.sort((left, right) =>
    left.toVersion - right.toVersion || left.fromVersion - right.fromVersion ||
    left.name.localeCompare(right.name)
  ));
}

/** Creates and verifies a current-state online backup while the application may be running. */
export async function createOperationalBackup(
  options: CreateOperationalBackupOptions,
): Promise<OperationalBackupResult> {
  const now = options.now ?? Date.now();
  const timestamp = new Date(now);
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(timestamp.getTime())) {
    throw new RangeError("maintenance clock is invalid");
  }
  const directory = inspectDataDirectory(options.dataDirectory);
  const source = resolve(directory, DATABASE_NAME);
  const sourceIdentity = inspectOrdinaryFile(source, "application database");
  assertDatabaseMaintenanceIdle(source);

  const name = `${DATABASE_NAME}.backup-${timestamp.toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite3`;
  const target = resolve(directory, name);
  const database = new DatabaseSync(source, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  let databaseClosed = false;
  try {
    const backup = await createVerifiedDatabaseBackup(database, source, target);
    database.close();
    databaseClosed = true;
    inspectOrdinaryFile(target, "operational backup");
    assertSelfContainedSqlite(target, "operational backup");
    const schemaVersion = inspectDatabase(target, now, true, "operational backup");
    assertDatabaseMaintenanceIdle(source);
    assertFilePathIdentity(source, sourceIdentity, "application database");
    return Object.freeze({
      name,
      schemaVersion,
      pages: backup.pages,
      sha256: backup.sha256,
    });
  } catch (error) {
    removeSqliteArtifacts(target);
    throw error;
  } finally {
    if (!databaseClosed) database.close();
  }
}

export function inspectMaintenanceLock(
  dataDirectory: string,
): DatabaseMaintenanceLockRecord {
  const directory = inspectDataDirectory(dataDirectory);
  return readDatabaseMaintenanceLock(resolve(directory, DATABASE_NAME));
}

export function clearStaleMaintenanceLock(
  options: ClearStaleMaintenanceLockOptions,
): DatabaseMaintenanceLockRecord {
  if (!options.confirmNoMaintenanceProcess) {
    throw new Error("clearing a maintenance lock requires explicit process-stop confirmation");
  }
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("maintenance clock is invalid");
  }
  const directory = inspectDataDirectory(options.dataDirectory);
  const target = resolve(directory, DATABASE_NAME);
  if (
    options.finalizeInterruptedFreshRestore &&
    (options.forceAbandonMaintenanceLease || options.forceUnreadableLock)
  ) {
    throw new Error(
      "interrupted fresh restore finalization cannot be combined with another force option",
    );
  }
  let record: DatabaseMaintenanceLockRecord;
  try {
    record = readDatabaseMaintenanceLock(target);
  } catch (error) {
    if (!options.forceUnreadableLock || options.lockToken !== undefined) throw error;
    assertNoLiveApplicationLease(target, now);
    if (!pathEntryExists(target)) {
      assertSelfContainedSqlite(target, "missing application database");
    }
    forceClearUnreadableDatabaseMaintenanceLock(target);
    return Object.freeze({
      formatVersion: 1,
      token: "unreadable-lock-cleared",
      operation: "unreadable-lock-cleared",
      createdAt: new Date(now).toISOString(),
    });
  }
  if (options.lockToken === undefined || record.token !== options.lockToken) {
    throw new Error("database maintenance lock token does not match");
  }

  if (options.finalizeInterruptedFreshRestore) {
    finalizeInterruptedFreshRestorePublication(directory, target, record, now);
  }

  if (!pathEntryExists(target)) {
    assertSelfContainedSqlite(target, "missing application database");
  } else {
    inspectOrdinaryFile(target, "application database");
    const database = new DatabaseSync(target, {
      enableForeignKeyConstraints: true,
      timeout: SQLITE_TIMEOUT_MILLISECONDS,
      readBigInts: true,
      defensive: true,
    });
    try {
      if (tableExists(database, "app_lease")) {
        const lease = database
          .prepare("SELECT owner_token, expires_at FROM app_lease WHERE lease_key = 1")
          .get() as { owner_token: string; expires_at: bigint | number } | undefined;
        if (lease !== undefined) {
          const expectedMaintenanceToken = maintenanceLeaseToken(record.token);
          if (lease.owner_token === expectedMaintenanceToken) {
            if (
              Number(lease.expires_at) > now &&
              !options.forceAbandonMaintenanceLease
            ) {
              throw new Error(
                "maintenance lease is still live; verify the process is stopped and use the explicit abandon flag",
              );
            }
            deleteMaintenanceLease(database, record.token);
          } else if (Number(lease.expires_at) > now) {
            throw new Error("a live application lease prevents clearing the maintenance lock");
          } else if (lease.owner_token.startsWith("maintenance:")) {
            throw new Error("database maintenance lease token does not match the lock file");
          }
        }
      }
    } finally {
      database.close();
    }
  }
  return forceReleaseDatabaseMaintenanceLock(target, options.lockToken);
}

/** Restores a verified migration backup. The application service must be stopped first. */
export function restoreMigrationBackup(
  options: RestoreMigrationBackupOptions,
): RestoreMigrationBackupResult {
  if (!options.confirmReplaceCurrentDatabase) {
    throw new Error(
      "restoring replaces the active database; explicit replacement confirmation is required",
    );
  }
  const now = options.now ?? Date.now();
  const timestamp = new Date(now);
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(timestamp.getTime())) {
    throw new RangeError("maintenance clock is invalid");
  }

  const directory = inspectDataDirectory(options.dataDirectory);
  const parsedName = parseMigrationBackupName(options.backupName);
  if (parsedName === null || basename(options.backupName) !== options.backupName) {
    throw new TypeError("migration backup name is invalid");
  }
  const source = resolve(directory, options.backupName);
  const target = resolve(directory, DATABASE_NAME);
  if (dirname(source) !== directory || source === target) {
    throw new Error("migration backup escaped the data directory");
  }

  const lock = acquireDatabaseMaintenanceLock(
    target,
    `restore-migration-backup:${parsedName.name}`,
    now,
  );
  let maintenanceLeaseClaimed = false;
  let targetReplaced = false;
  let replacementDurable = false;
  let retainMaintenanceLock = false;
  const transactionId = randomUUID();
  const staging = join(directory, `.${DATABASE_NAME}.restore-${transactionId}.tmp`);
  const quarantine = join(
    directory,
    `${DATABASE_NAME}.before-restore-${timestamp.toISOString().replaceAll(":", "-")}-${transactionId}`,
  );
  const quarantineStaging = `${quarantine}.staging`;

  try {
    inspectOrdinaryFile(target, "application database");
    maintenanceLeaseClaimed = claimAndQuiesceApplicationDatabase(target, now, lock.token);
    assertSelfContainedSqlite(target, "application database");

    const sourceIdentity = inspectOrdinaryFile(source, "migration backup");
    assertSelfContainedSqlite(source, "migration backup");
    const backupSchemaVersion = inspectDatabase(source, now, true);
    if (backupSchemaVersion !== parsedName.fromVersion) {
      throw new Error("migration backup schema does not match its filename");
    }
    const sourceHash = sha256File(source);
    const targetHash = sha256File(target);

    copyFileSync(source, staging, fsConstants.COPYFILE_EXCL);
    hardenExistingPrivateFile(staging);
    assertFileIdentity(source, sourceIdentity, "migration backup");
    assertSelfContainedSqlite(source, "migration backup");
    assertSelfContainedSqlite(staging, "restored database staging file");
    if (sha256File(staging) !== sourceHash) {
      throw new Error("restored database staging bytes differ from the selected backup");
    }
    const stagedSchemaVersion = inspectDatabase(staging, now, true);
    if (stagedSchemaVersion !== backupSchemaVersion) {
      throw new Error("restored database staging schema changed while copying");
    }
    assertSelfContainedSqlite(staging, "restored database staging file");
    syncFile(staging);

    copyFileSync(target, quarantineStaging, fsConstants.COPYFILE_EXCL);
    hardenExistingPrivateFile(quarantineStaging);
    inspectOrdinaryFile(quarantineStaging, "quarantined application database staging file");
    if (sha256File(quarantineStaging) !== targetHash) {
      throw new Error("quarantined application database bytes differ from the active database");
    }
    syncFile(quarantineStaging);
    renameSync(quarantineStaging, quarantine);
    inspectOrdinaryFile(quarantine, "quarantined application database");
    syncDirectory(directory);

    // rename() atomically replaces the old path on supported filesystems.
    // The verified quarantine copy already preserves the displaced database.
    renameSync(staging, target);
    targetReplaced = true;
    syncDirectory(directory);
    replacementDurable = true;

    return Object.freeze({
      backupName: parsedName.name,
      restoredSchemaVersion: backupSchemaVersion,
      quarantinedDatabaseName: basename(quarantine),
    });
  } catch (error) {
    if (error instanceof MaintenanceLeaseClaimedError) {
      maintenanceLeaseClaimed = true;
    }
    const cleanupErrors: unknown[] = [];
    try {
      removeSqliteArtifacts(staging);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      removeSqliteArtifacts(quarantineStaging);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!targetReplaced && maintenanceLeaseClaimed) {
      try {
        releaseMaintenanceLease(target, lock.token);
      } catch (releaseError) {
        retainMaintenanceLock = true;
        cleanupErrors.push(releaseError);
      }
    }
    if (targetReplaced && !replacementDurable) {
      retainMaintenanceLock = true;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "database restore failed during cleanup");
    }
    throw error;
  } finally {
    if (!retainMaintenanceLock && (!targetReplaced || replacementDurable)) {
      lock.release();
    }
  }
}

/** Restores a current-state online backup. The application service must be stopped first. */
export function restoreOperationalBackup(
  options: RestoreOperationalBackupOptions,
): RestoreOperationalBackupResult {
  if (!options.confirmReplaceCurrentDatabase) {
    throw new Error(
      "restoring replaces the active database; explicit replacement confirmation is required",
    );
  }
  if (!SHA256_PATTERN.test(options.expectedSha256)) {
    throw new TypeError("expected backup SHA-256 must be 64 lowercase hexadecimal characters");
  }
  const now = options.now ?? Date.now();
  const timestamp = new Date(now);
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(timestamp.getTime())) {
    throw new RangeError("maintenance clock is invalid");
  }

  const directory = inspectDataDirectory(options.dataDirectory);
  if (
    basename(options.backupName) !== options.backupName ||
    !OPERATIONAL_BACKUP_NAME_PATTERN.test(options.backupName)
  ) {
    throw new TypeError("operational backup name is invalid");
  }
  const source = resolve(directory, options.backupName);
  const target = resolve(directory, DATABASE_NAME);
  if (dirname(source) !== directory || source === target) {
    throw new Error("operational backup escaped the data directory");
  }

  const lock = acquireDatabaseMaintenanceLock(
    target,
    `restore-backup:${options.backupName}`,
    now,
  );
  let maintenanceLeaseClaimed = false;
  let targetPublished = false;
  let replacementDurable = false;
  let retainMaintenanceLock = false;
  const transactionId = randomUUID();
  const staging = join(directory, `.${DATABASE_NAME}.restore-${transactionId}.tmp`);
  const quarantine = join(
    directory,
    `${DATABASE_NAME}.before-restore-${timestamp.toISOString().replaceAll(":", "-")}-${transactionId}`,
  );
  const quarantineStaging = `${quarantine}.staging`;
  let quarantinedDatabaseName: string | null = null;
  let targetIdentity: FileIdentity | null = null;

  try {
    if (pathEntryExists(target)) {
      inspectOrdinaryFile(target, "application database");
      maintenanceLeaseClaimed = claimAndQuiesceApplicationDatabase(target, now, lock.token);
      targetIdentity = inspectOrdinaryFile(target, "application database");
      assertSelfContainedSqlite(target, "application database");
    } else {
      try {
        assertSelfContainedSqlite(target, "fresh restore target");
      } catch (error) {
        // Do not release the lock while orphaned SQLite state remains beside a
        // missing main file: a subsequent application start could pair the new
        // database with that unrelated WAL/SHM/journal.  Leave the exact lock
        // and sidecars for an operator to inspect and clear explicitly.
        retainMaintenanceLock = true;
        throw error;
      }
    }

    const sourceIdentity = inspectOrdinaryFile(source, "operational backup");
    assertSelfContainedSqlite(source, "operational backup");
    const sourceHash = sha256File(source);
    if (sourceHash !== options.expectedSha256) {
      throw new Error("operational backup SHA-256 does not match the expected value");
    }
    const backupSchemaVersion = inspectDatabase(source, now, true, "operational backup");

    copyFileSync(source, staging, fsConstants.COPYFILE_EXCL);
    hardenExistingPrivateFile(staging);
    assertFileIdentity(source, sourceIdentity, "operational backup");
    assertSelfContainedSqlite(source, "operational backup");
    assertSelfContainedSqlite(staging, "restored database staging file");
    if (sha256File(staging) !== options.expectedSha256) {
      throw new Error("restored database staging bytes differ from the selected backup");
    }
    const stagedSchemaVersion = inspectDatabase(
      staging,
      now,
      true,
      "restored database staging file",
    );
    if (stagedSchemaVersion !== backupSchemaVersion) {
      throw new Error("restored database staging schema changed while copying");
    }
    assertSelfContainedSqlite(staging, "restored database staging file");
    syncFile(staging);

    if (targetIdentity !== null) {
      assertFileIdentity(target, targetIdentity, "application database");
      const targetHash = sha256File(target);

      copyFileSync(target, quarantineStaging, fsConstants.COPYFILE_EXCL);
      hardenExistingPrivateFile(quarantineStaging);
      assertFileIdentity(target, targetIdentity, "application database");
      inspectOrdinaryFile(quarantineStaging, "quarantined application database staging file");
      if (sha256File(quarantineStaging) !== targetHash) {
        throw new Error("quarantined application database bytes differ from the active database");
      }
      syncFile(quarantineStaging);
      renameSync(quarantineStaging, quarantine);
      inspectOrdinaryFile(quarantine, "quarantined application database");
      syncDirectory(directory);
      quarantinedDatabaseName = basename(quarantine);
    }

    if (targetIdentity !== null) {
      assertFileIdentity(target, targetIdentity, "application database");
      assertSelfContainedSqlite(target, "application database");
      // Replacing an existing path is atomic; its verified quarantine copy is durable first.
      renameSync(staging, target);
      targetPublished = true;
      syncDirectory(directory);
    } else {
      // link() provides atomic no-replace publication on the data volume. It
      // cannot silently overwrite a database created after the initial check.
      try {
        assertSelfContainedSqlite(target, "fresh restore target");
      } catch (error) {
        retainMaintenanceLock = true;
        throw error;
      }
      linkSync(staging, target);
      targetPublished = true;
      syncDirectory(directory);
      rmSync(staging);
      syncDirectory(directory);
    }
    replacementDurable = true;

    return Object.freeze({
      backupName: options.backupName,
      restoredSchemaVersion: backupSchemaVersion,
      sha256: options.expectedSha256,
      quarantinedDatabaseName,
    });
  } catch (error) {
    if (error instanceof MaintenanceLeaseClaimedError) {
      maintenanceLeaseClaimed = true;
    }
    const cleanupErrors: unknown[] = [];
    try {
      removeSqliteArtifacts(staging);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      removeSqliteArtifacts(quarantineStaging);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!targetPublished && maintenanceLeaseClaimed) {
      try {
        releaseMaintenanceLease(target, lock.token);
      } catch (releaseError) {
        retainMaintenanceLock = true;
        cleanupErrors.push(releaseError);
      }
    }
    if (targetPublished && !replacementDurable) {
      retainMaintenanceLock = true;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "database restore failed during cleanup");
    }
    throw error;
  } finally {
    if (!retainMaintenanceLock && (!targetPublished || replacementDurable)) {
      lock.release();
    }
  }
}

function inspectDataDirectory(input: string): string {
  hardenProcessFileCreation();
  const directory = resolve(input);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("data directory must be an ordinary directory");
  }
  hardenExistingPrivateDirectory(directory);
  hardenSqliteArtifacts(join(directory, DATABASE_NAME));
  return directory;
}

function inspectOrdinaryFile(path: string, label: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1n || stat.nlink !== 1n) {
    throw new Error(`${label} must be a non-empty ordinary file with one link`);
  }
  hardenExistingPrivateFile(path);
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNanoseconds: stat.mtimeNs,
  });
}

function assertFileIdentity(path: string, expected: FileIdentity, label: string): void {
  const actual = inspectOrdinaryFile(path, label);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.size !== expected.size ||
    actual.modifiedAtNanoseconds !== expected.modifiedAtNanoseconds
  ) {
    throw new Error(`${label} changed while it was being copied`);
  }
}

function assertFilePathIdentity(path: string, expected: FileIdentity, label: string): void {
  const actual = inspectOrdinaryFile(path, label);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label} path identity changed while the online backup was being created`);
  }
}

function finalizeInterruptedFreshRestorePublication(
  directory: string,
  target: string,
  record: DatabaseMaintenanceLockRecord,
  now: number,
): void {
  const operationPrefix = "restore-backup:";
  if (!record.operation.startsWith(operationPrefix)) {
    throw new Error("maintenance lock does not describe a fresh operational backup restore");
  }
  const backupName = record.operation.slice(operationPrefix.length);
  if (!OPERATIONAL_BACKUP_NAME_PATTERN.test(backupName)) {
    throw new Error("maintenance lock contains an invalid operational backup name");
  }

  const targetIdentity = inspectLinkedRestoreFile(target, "interrupted restored database");
  const stagingNames = readdirSync(directory).filter((name) =>
    RESTORE_STAGING_NAME_PATTERN.test(name)
  );
  if (stagingNames.length !== 1 || stagingNames[0] === undefined) {
    throw new Error("interrupted fresh restore staging file is missing or ambiguous");
  }
  const staging = join(directory, stagingNames[0]);
  const stagingIdentity = inspectLinkedRestoreFile(
    staging,
    "interrupted fresh restore staging file",
  );
  if (
    stagingIdentity.device !== targetIdentity.device ||
    stagingIdentity.inode !== targetIdentity.inode
  ) {
    throw new Error("interrupted fresh restore staging file is not linked to the active database");
  }

  const source = join(directory, backupName);
  const sourceIdentity = inspectOrdinaryFile(source, "operational backup");
  assertSelfContainedSqlite(source, "operational backup");
  assertSelfContainedSqlite(target, "interrupted restored database");
  assertSelfContainedSqlite(staging, "interrupted fresh restore staging file");
  const sourceHash = sha256File(source);
  if (sha256File(target) !== sourceHash) {
    throw new Error("interrupted restored database bytes differ from the selected backup");
  }
  const sourceSchemaVersion = inspectDatabase(source, now, true, "operational backup");
  const targetSchemaVersion = inspectDatabase(
    target,
    now,
    true,
    "interrupted restored database",
  );
  if (targetSchemaVersion !== sourceSchemaVersion) {
    throw new Error("interrupted restored database schema differs from the selected backup");
  }

  assertFileIdentity(source, sourceIdentity, "operational backup");
  assertLinkedRestoreIdentity(target, targetIdentity, "interrupted restored database");
  assertLinkedRestoreIdentity(
    staging,
    stagingIdentity,
    "interrupted fresh restore staging file",
  );
  unlinkSync(staging);
  syncDirectory(directory);

  inspectOrdinaryFile(target, "application database");
  assertSelfContainedSqlite(target, "application database");
  if (sha256File(target) !== sourceHash) {
    throw new Error("finalized application database bytes differ from the selected backup");
  }
  if (inspectDatabase(target, now, true, "application database") !== sourceSchemaVersion) {
    throw new Error("finalized application database schema differs from the selected backup");
  }
}

function inspectLinkedRestoreFile(path: string, label: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1n || stat.nlink !== 2n) {
    throw new Error(`${label} must be a non-empty ordinary file with exactly two links`);
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNanoseconds: stat.mtimeNs,
  });
}

function assertLinkedRestoreIdentity(
  path: string,
  expected: FileIdentity,
  label: string,
): void {
  const actual = inspectLinkedRestoreFile(path, label);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.size !== expected.size ||
    actual.modifiedAtNanoseconds !== expected.modifiedAtNanoseconds
  ) {
    throw new Error(`${label} changed while the interrupted restore was being finalized`);
  }
}

function assertSelfContainedSqlite(path: string, label: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    if (pathEntryExists(`${path}${suffix}`)) {
      throw new Error(`${label} is not self-contained because ${suffix} exists`);
    }
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseMigrationBackupName(name: string): MigrationBackup | null {
  const match = BACKUP_NAME_PATTERN.exec(name);
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  const fromVersion = Number(match[1]);
  const toVersion = Number(match[2]);
  if (
    !Number.isSafeInteger(fromVersion) ||
    !Number.isSafeInteger(toVersion) ||
    fromVersion >= toVersion
  ) {
    return null;
  }
  return Object.freeze({ name, fromVersion, toVersion });
}

function inspectDatabase(
  path: string,
  now: number,
  requireReleasedLease: boolean,
  label = "migration backup",
): number {
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  try {
    const journal = database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (journal?.journal_mode.toLowerCase() !== "delete") {
      throw new Error(`${label} must use self-contained DELETE journal mode`);
    }
    const integrity = inspectDatabaseIntegrity(database);
    if (!integrity.ok) {
      throw new Error(
        `${label} failed application integrity checks: ` +
        `quick_check=${integrity.quickCheck}, ` +
        `foreign_key_violations=${integrity.foreignKeyViolations}, ` +
        `domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`,
      );
    }
    const row = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
      | { version: bigint | number | null }
      | undefined;
    const version = Number(row?.version ?? Number.NaN);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`${label} schema version is invalid`);
    }
    if (requireReleasedLease && hasLiveLease(database, now)) {
      throw new Error(`${label} contains a live application lease`);
    }
    return version;
  } finally {
    database.close();
  }
}

function claimAndQuiesceApplicationDatabase(path: string, now: number, token: string): boolean {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  let claimed = false;
  try {
    if (tableExists(database, "app_lease")) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (hasLiveLease(database, now)) {
          throw new Error("application database is still owned; stop the app service before restore");
        }
        const maintenanceToken = maintenanceLeaseToken(token);
        const expiresAt = now + 24 * 60 * 60 * 1_000;
        if (!Number.isSafeInteger(expiresAt)) {
          throw new RangeError("maintenance lease expiration is outside the safe integer range");
        }
        const existing = database
          .prepare("SELECT 1 AS present FROM app_lease WHERE lease_key = 1")
          .get();
        if (existing === undefined) {
          database.prepare(
            `INSERT INTO app_lease(
               lease_key, owner_token, owner_pid, owner_host, acquired_at, expires_at
             ) VALUES (1, ?, ?, 'maintenance', ?, ?)`,
          ).run(maintenanceToken, process.pid, now, expiresAt);
        } else {
          database.prepare(
            `UPDATE app_lease
                SET owner_token = ?, owner_pid = ?, owner_host = 'maintenance',
                    acquired_at = ?, expires_at = ?
              WHERE lease_key = 1`,
          ).run(maintenanceToken, process.pid, now, expiresAt);
        }
        database.exec("COMMIT");
        claimed = true;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    }

    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy: bigint | number }
      | undefined;
    if (checkpoint === undefined || Number(checkpoint.busy) !== 0) {
      throw new Error("application database WAL could not be checkpointed");
    }
    const journal = database.prepare("PRAGMA journal_mode = DELETE").get() as
      | { journal_mode: string }
      | undefined;
    if (journal?.journal_mode.toLowerCase() !== "delete") {
      throw new Error("application database could not enter a self-contained journal mode");
    }
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
    return claimed;
  } catch (error) {
    if (claimed) {
      throw new MaintenanceLeaseClaimedError(error);
    }
    throw error;
  } finally {
    database.close();
  }
}

function releaseMaintenanceLease(path: string, token: string): void {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  try {
    deleteMaintenanceLease(database, token);
  } finally {
    database.close();
  }
}

function deleteMaintenanceLease(database: DatabaseSync, token: string): void {
  if (!tableExists(database, "app_lease")) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare(
      "DELETE FROM app_lease WHERE lease_key = 1 AND owner_token = ?",
    ).run(maintenanceLeaseToken(token));
    if (Number(result.changes) !== 1) {
      throw new Error("database maintenance lease ownership changed before it was released");
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function maintenanceLeaseToken(lockToken: string): string {
  return `maintenance:${lockToken}`;
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function hasLiveLease(database: DatabaseSync, now: number): boolean {
  if (!tableExists(database, "app_lease")) return false;
  const row = database
    .prepare("SELECT expires_at FROM app_lease WHERE lease_key = 1")
    .get() as { expires_at: bigint | number } | undefined;
  return row !== undefined && Number(row.expires_at) > now;
}

function assertNoLiveApplicationLease(path: string, now: number): void {
  if (!pathEntryExists(path)) return;
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  try {
    if (hasLiveLease(database, now)) {
      throw new Error("a live application lease prevents clearing the maintenance lock");
    }
  } finally {
    database.close();
  }
}

function syncFile(path: string): void {
  const handle = openSync(path, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function removeSqliteArtifacts(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-journal`, { force: true });
}

async function runCommand(arguments_: readonly string[]): Promise<void> {
  hardenProcessFileCreation();
  const dataDirectory = process.env.PERPAY_DATA_DIR ?? "/data";
  if (arguments_.length === 1 && arguments_[0] === "inspect-maintenance-lock") {
    process.stdout.write(`${JSON.stringify(inspectMaintenanceLock(dataDirectory))}\n`);
    return;
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "clear-stale-maintenance-lock" &&
    arguments_[1] !== undefined &&
    arguments_[2] === "--confirm-no-maintenance-process"
  ) {
    process.stdout.write(`${JSON.stringify(clearStaleMaintenanceLock({
      dataDirectory,
      lockToken: arguments_[1],
      confirmNoMaintenanceProcess: true,
      forceAbandonMaintenanceLease: false,
    }))}\n`);
    return;
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "clear-stale-maintenance-lock" &&
    arguments_[1] !== undefined &&
    arguments_[2] === "--confirm-no-maintenance-process" &&
    arguments_[3] === "--force-abandon-maintenance-lease"
  ) {
    process.stdout.write(`${JSON.stringify(clearStaleMaintenanceLock({
      dataDirectory,
      lockToken: arguments_[1],
      confirmNoMaintenanceProcess: true,
      forceAbandonMaintenanceLease: true,
    }))}\n`);
    return;
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "clear-stale-maintenance-lock" &&
    arguments_[1] !== undefined &&
    arguments_[2] === "--confirm-no-maintenance-process" &&
    arguments_[3] === "--finalize-interrupted-fresh-restore"
  ) {
    process.stdout.write(`${JSON.stringify(clearStaleMaintenanceLock({
      dataDirectory,
      lockToken: arguments_[1],
      confirmNoMaintenanceProcess: true,
      finalizeInterruptedFreshRestore: true,
    }))}\n`);
    return;
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "clear-stale-maintenance-lock" &&
    arguments_[1] === "--force-unreadable-lock" &&
    arguments_[2] === "--confirm-no-maintenance-process"
  ) {
    process.stdout.write(`${JSON.stringify(clearStaleMaintenanceLock({
      dataDirectory,
      confirmNoMaintenanceProcess: true,
      forceUnreadableLock: true,
    }))}\n`);
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "create-backup") {
    process.stdout.write(`${JSON.stringify(await createOperationalBackup({ dataDirectory }))}\n`);
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "list-migration-backups") {
    process.stdout.write(`${JSON.stringify({ backups: listMigrationBackups(dataDirectory) })}\n`);
    return;
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "restore-migration-backup" &&
    arguments_[1] !== undefined &&
    arguments_[2] === RESTORE_CONFIRMATION_ARGUMENT
  ) {
    process.stdout.write(`${JSON.stringify(restoreMigrationBackup({
      dataDirectory,
      backupName: arguments_[1],
      confirmReplaceCurrentDatabase: true,
    }))}\n`);
    return;
  }
  if (
    arguments_.length === 4 &&
    arguments_[0] === "restore-backup" &&
    arguments_[1] !== undefined &&
    arguments_[2] !== undefined &&
    arguments_[3] === RESTORE_CONFIRMATION_ARGUMENT
  ) {
    process.stdout.write(`${JSON.stringify(restoreOperationalBackup({
      dataDirectory,
      backupName: arguments_[1],
      expectedSha256: arguments_[2],
      confirmReplaceCurrentDatabase: true,
    }))}\n`);
    return;
  }
  throw new Error(
    `usage: maintenance <create-backup|list-migration-backups|inspect-maintenance-lock|` +
    `clear-stale-maintenance-lock LOCK_TOKEN --confirm-no-maintenance-process ` +
    `[--force-abandon-maintenance-lease|--finalize-interrupted-fresh-restore]|` +
    `clear-stale-maintenance-lock --force-unreadable-lock --confirm-no-maintenance-process|` +
    `restore-backup BACKUP_NAME EXPECTED_SHA256 ${RESTORE_CONFIRMATION_ARGUMENT}|` +
    `restore-migration-backup BACKUP_NAME ${RESTORE_CONFIRMATION_ARGUMENT}>`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "maintenance command failed";
    process.stderr.write(`${JSON.stringify({ error: "maintenance_failed", message })}\n`);
    process.exitCode = 1;
  });
}
