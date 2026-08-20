import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BackupConfig } from "./config.ts";
import {
  createOperationalBackup,
  restoreOperationalBackup,
  type RestoreOperationalBackupResult,
} from "../database/maintenance.ts";
import { syncDirectory } from "../database/maintenance-lock.ts";
import { inspectDatabaseIntegrity } from "../database/database.ts";
import {
  ensurePrivateDirectory,
  hardenExistingPrivateDirectory,
  hardenExistingPrivateFile,
} from "../infrastructure/storage/permissions.ts";
import { DATABASE_COMPATIBILITY } from "../version.ts";

const MAXIMUM_BACKUPS = 4_096;
const MAXIMUM_ARTIFACT_ERROR_LENGTH = 256;
const SQLITE_TIMEOUT_MILLISECONDS = 5_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const LOCAL_BACKUP_NAME_PATTERN = new RegExp(
  `^perpay\\.sqlite3\\.backup-((?:\\d{4}|[+-]\\d{6})-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z)-${UUID_PATTERN}\\.sqlite3$`,
  "u",
);
const TEMPORARY_BACKUP_PATTERN = new RegExp(
  `^\\.(?:backup|creating)-${UUID_PATTERN}\\.tmp(?:-(?:wal|shm)|-journal)?$`,
  "u",
);
const TEMPORARY_STATE_PATTERN = new RegExp(
  `^\\.perpay-local-backup-state-${UUID_PATTERN}\\.tmp$`,
  "u",
);

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
}

export interface LocalBackup {
  readonly name: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly instanceId: string;
}

export interface LocalBackupReference {
  readonly name: string;
  readonly createdAt: string;
}

export interface LocalBackupRetentionResult {
  readonly kept: readonly LocalBackupReference[];
  readonly deleted: readonly LocalBackup[];
  /** Recognized old files retained because they could not be safely verified. */
  readonly blocked: readonly LocalBackupReference[];
  readonly retainedCount: number;
}

export interface LocalBackupArtifact {
  readonly name: string;
  readonly createdAt: string;
  readonly status: "verified" | "invalid";
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly schemaVersion: number | null;
  readonly instanceId: string | null;
  readonly error: string | null;
}

export interface CreateLocalBackupOptions {
  readonly now?: number | undefined;
  readonly expectedInstanceId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function createLocalBackup(
  config: BackupConfig,
  options: CreateLocalBackupOptions = {},
): Promise<LocalBackup> {
  const now = inspectClock(options.now ?? Date.now());
  options.signal?.throwIfAborted();
  if (
    options.expectedInstanceId !== undefined &&
    !INSTANCE_ID_PATTERN.test(options.expectedInstanceId)
  ) {
    throw new TypeError("expected application instance ID is invalid");
  }
  ensureBackupDirectory(config.backupDirectory);
  const created = await createOperationalBackup({
    dataDirectory: config.dataDirectory,
    backupDirectory: config.backupDirectory,
    now,
    signal: options.signal,
  });
  let keep = false;
  const path = resolveBackupPath(config.backupDirectory, created.name);
  try {
    options.signal?.throwIfAborted();
    const inspected = inspectLocalBackup(config.backupDirectory, created.name, now);
    if (inspected.sha256 !== created.sha256) {
      throw new Error("published backup SHA-256 differs from the online backup result");
    }
    if (inspected.schemaVersion !== created.schemaVersion) {
      throw new Error("published backup schema differs from the online backup result");
    }
    if (
      options.expectedInstanceId !== undefined &&
      inspected.instanceId !== options.expectedInstanceId
    ) {
      throw new Error("application instance identity changed");
    }
    options.signal?.throwIfAborted();
    keep = true;
    return inspected;
  } finally {
    if (!keep) {
      rmSync(path, { force: true });
      removeSqliteSidecars(path);
      syncDirectory(resolve(config.backupDirectory));
    }
  }
}

export function listLocalBackups(
  backupDirectory: string,
  now: number = Date.now(),
): readonly LocalBackup[] {
  const clock = inspectClock(now);
  const directory = ensureBackupDirectory(backupDirectory);
  const names = readdirSync(directory)
    .filter((name) => LOCAL_BACKUP_NAME_PATTERN.test(name));
  if (names.length > MAXIMUM_BACKUPS) {
    throw new Error(`backup directory contains more than ${MAXIMUM_BACKUPS} backups`);
  }
  return Object.freeze(
    names
      .map((name) => inspectLocalBackup(directory, name, clock))
      .sort(compareBackupsNewestFirst),
  );
}

/** Lists recognized files even when one damaged SQLite payload cannot be opened. */
export function listLocalBackupArtifacts(
  backupDirectory: string,
  now: number = Date.now(),
): readonly LocalBackupArtifact[] {
  const clock = inspectClock(now);
  const directory = ensureBackupDirectory(backupDirectory);
  const references = listLocalBackupReferences(directory, clock, true);
  return Object.freeze(references.map((reference) => {
    try {
      const backup = inspectLocalBackup(directory, reference.name, clock);
      return Object.freeze({
        name: backup.name,
        createdAt: backup.createdAt,
        status: "verified" as const,
        sha256: backup.sha256,
        sizeBytes: backup.sizeBytes,
        schemaVersion: backup.schemaVersion,
        instanceId: backup.instanceId,
        error: null,
      });
    } catch (error) {
      let sha256: string | null = null;
      let sizeBytes: number | null = null;
      const errors = [formatArtifactError(error)];
      try {
        const path = resolveBackupPath(directory, reference.name);
        assertNoSqliteSidecars(path);
        const identity = inspectOrdinaryFile(path, "backup artifact");
        sizeBytes = Number(identity.size);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
          throw new Error("backup artifact size is outside the safe integer range");
        }
        sha256 = sha256File(path);
        assertFileIdentity(path, identity, "backup artifact");
      } catch (inspectionError) {
        errors.push(formatArtifactError(inspectionError));
        sha256 = null;
      }
      return Object.freeze({
        name: reference.name,
        createdAt: reference.createdAt,
        status: "invalid" as const,
        sha256,
        sizeBytes,
        schemaVersion: null,
        instanceId: null,
        error: errors.join("; ").slice(0, MAXIMUM_ARTIFACT_ERROR_LENGTH),
      });
    }
  }));
}

/** Deletes one exact recognized file after an operator supplies its digest. */
export function deleteLocalBackupArtifact(
  backupDirectory: string,
  backupName: string,
  expectedSha256: string,
  protectedBackupName?: string,
): LocalBackupArtifact {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new TypeError("expected backup SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (
    basename(backupName) !== backupName ||
    !LOCAL_BACKUP_NAME_PATTERN.test(backupName)
  ) {
    throw new TypeError("backup name is invalid");
  }
  if (backupName === protectedBackupName) {
    throw new Error("the state-referenced backup cannot be deleted");
  }
  const directory = ensureBackupDirectory(backupDirectory);
  const path = resolveBackupPath(directory, backupName);
  assertNoSqliteSidecars(path);
  const identity = inspectOrdinaryFile(path, "backup artifact");
  const sizeBytes = Number(identity.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error("backup artifact size is outside the safe integer range");
  }
  const sha256 = sha256File(path);
  if (sha256 !== expectedSha256) {
    throw new Error("backup artifact SHA-256 does not match the expected value");
  }
  let inspected: LocalBackup | null = null;
  let inspectionError: string | null = null;
  try {
    inspected = inspectLocalBackup(directory, backupName, Date.now());
  } catch (error) {
    inspectionError = formatArtifactError(error);
  }
  assertNoSqliteSidecars(path);
  assertFileIdentity(path, identity, "backup artifact");
  const createdAt = backupCreatedAt(backupName);
  unlinkSync(path);
  syncDirectory(directory);
  return Object.freeze({
    name: backupName,
    createdAt,
    status: inspected === null ? "invalid" : "verified",
    sha256,
    sizeBytes,
    schemaVersion: inspected?.schemaVersion ?? null,
    instanceId: inspected?.instanceId ?? null,
    error: inspectionError,
  });
}

function listLocalBackupReferences(
  backupDirectory: string,
  now: number,
  allowFutureTimestamp = false,
): readonly LocalBackupReference[] {
  const directory = ensureBackupDirectory(backupDirectory);
  const names = readdirSync(directory)
    .filter((name) => LOCAL_BACKUP_NAME_PATTERN.test(name));
  if (names.length > MAXIMUM_BACKUPS) {
    throw new Error(`backup directory contains more than ${MAXIMUM_BACKUPS} backups`);
  }
  return Object.freeze(names.map((name) => {
    const match = LOCAL_BACKUP_NAME_PATTERN.exec(name);
    if (match === null || match[1] === undefined || basename(name) !== name) {
      throw new TypeError("backup name is invalid");
    }
    const createdAt = parseFilenameTimestamp(match[1]);
    if (!allowFutureTimestamp && createdAt > now) {
      throw new Error("backup timestamp is ahead of the current clock");
    }
    return Object.freeze({ name, createdAt: new Date(createdAt).toISOString() });
  }).sort(compareBackupsNewestFirst));
}

export function pruneLocalBackups(
  backupDirectory: string,
  keepCount: number,
  now: number = Date.now(),
  protectedBackupName?: string,
  expectedInstanceId?: string,
  expectedSha256?: string,
  expectedSizeBytes?: number,
): LocalBackupRetentionResult {
  if (!Number.isSafeInteger(keepCount) || keepCount < 1 || keepCount > 365) {
    throw new RangeError("backup keep count must be an integer from 1 to 365");
  }
  if (expectedInstanceId !== undefined && !INSTANCE_ID_PATTERN.test(expectedInstanceId)) {
    throw new TypeError("expected application instance ID is invalid");
  }
  if (expectedSha256 !== undefined && !SHA256_PATTERN.test(expectedSha256)) {
    throw new TypeError("expected protected backup SHA-256 is invalid");
  }
  if (
    expectedSizeBytes !== undefined &&
    (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1)
  ) {
    throw new TypeError("expected protected backup size is invalid");
  }
  const clock = inspectClock(now);
  const directory = ensureBackupDirectory(backupDirectory);
  // Classify every recognized file before choosing the retention set. Invalid,
  // future-dated, changing, or foreign-instance files are preserved for exact
  // operator cleanup, but must never consume a slot that protects a verified
  // recovery point.
  const backups = listLocalBackupReferences(directory, clock, true);
  const protectedBackup = protectedBackupName === undefined
    ? undefined
    : backups.find((backup) => backup.name === protectedBackupName);
  if (protectedBackupName !== undefined && protectedBackup === undefined) {
    throw new Error("the state-referenced backup is missing from the backup directory");
  }
  const verified: Array<Readonly<{
    backup: LocalBackup;
    identity: FileIdentity;
  }>> = [];
  const blocked: LocalBackupReference[] = [];
  for (const reference of backups) {
    try {
      const inspected = inspectLocalBackupWithIdentity(directory, reference.name, clock);
      if (
        expectedInstanceId !== undefined &&
        inspected.backup.instanceId !== expectedInstanceId
      ) {
        blocked.push(reference);
        continue;
      }
      if (
        reference.name === protectedBackupName &&
        ((expectedSha256 !== undefined && inspected.backup.sha256 !== expectedSha256) ||
          (expectedSizeBytes !== undefined && inspected.backup.sizeBytes !== expectedSizeBytes))
      ) {
        blocked.push(reference);
        continue;
      }
      verified.push(inspected);
    } catch {
      // Unknown, damaged, or concurrently changing files are preserved for an
      // explicit name-and-digest cleanup operation. They must not prevent a
      // newly verified recovery point from being published.
      blocked.push(reference);
    }
  }

  const protectedVerified = protectedBackupName === undefined
    ? undefined
    : verified.find((entry) => entry.backup.name === protectedBackupName);
  const initialKept = verified.slice(0, keepCount);
  const keptEntries = protectedVerified === undefined ||
      initialKept.some((entry) => entry.backup.name === protectedVerified.backup.name)
    ? initialKept
    : [
        ...initialKept.slice(0, Math.max(0, keepCount - 1)),
        protectedVerified,
      ].sort((left, right) => compareBackupsNewestFirst(left.backup, right.backup));
  const keptNames = new Set(keptEntries.map((entry) => entry.backup.name));
  const verifiedForDeletion = verified.filter((entry) => !keptNames.has(entry.backup.name));
  const kept = keptEntries.map((entry) => Object.freeze({
    name: entry.backup.name,
    createdAt: entry.backup.createdAt,
  }));

  for (const entry of verifiedForDeletion) {
    assertFileIdentity(
      resolveBackupPath(directory, entry.backup.name),
      entry.identity,
      "backup",
    );
  }
  for (const entry of verifiedForDeletion) {
    const path = resolveBackupPath(directory, entry.backup.name);
    assertFileIdentity(path, entry.identity, "backup");
    unlinkSync(path);
  }
  if (verifiedForDeletion.length > 0) syncDirectory(directory);
  return Object.freeze({
    kept: Object.freeze(kept),
    deleted: Object.freeze(verifiedForDeletion.map((entry) => entry.backup)),
    blocked: Object.freeze(blocked),
    retainedCount: kept.length + blocked.length,
  });
}

export function restoreLocalBackup(
  config: BackupConfig,
  backupName: string,
  expectedSha256: string,
  expectedInstanceId?: string,
  now: number = Date.now(),
): RestoreOperationalBackupResult {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new TypeError("expected backup SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (expectedInstanceId !== undefined && !INSTANCE_ID_PATTERN.test(expectedInstanceId)) {
    throw new TypeError("expected application instance ID is invalid");
  }
  const clock = inspectClock(now);
  const backup = inspectLocalBackup(config.backupDirectory, backupName, clock);
  if (backup.sha256 !== expectedSha256) {
    throw new Error("backup SHA-256 does not match the expected value");
  }
  if (expectedInstanceId !== undefined && backup.instanceId !== expectedInstanceId) {
    throw new Error("backup belongs to another application instance");
  }
  const result = restoreOperationalBackup({
    dataDirectory: config.dataDirectory,
    backupDirectory: config.backupDirectory,
    backupName,
    expectedSha256,
    confirmReplaceCurrentDatabase: true,
    now: clock,
  });
  if (result.restoredSchemaVersion !== DATABASE_COMPATIBILITY.maximum) {
    throw new Error("restored database schema is outside this release's compatibility range");
  }
  return result;
}

export function recoverInterruptedBackupFiles(backupDirectory: string): readonly string[] {
  const directory = ensureBackupDirectory(backupDirectory);
  const removed: string[] = [];
  const names = readdirSync(directory);
  const finalNames = names.filter((name) => LOCAL_BACKUP_NAME_PATTERN.test(name));
  for (const name of names) {
    if (!TEMPORARY_BACKUP_PATTERN.test(name) && !TEMPORARY_STATE_PATTERN.test(name)) continue;
    const path = resolve(directory, name);
    if (dirname(path) !== directory || basename(name) !== name) {
      throw new Error("temporary backup path escaped the backup directory");
    }
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.nlink !== 1n && stat.nlink !== 2n)) {
      throw new Error("temporary backup artifact must be an ordinary file with one or two links");
    }
    if (stat.nlink === 2n) {
      const linkedFinals = finalNames.filter((finalName) => {
        try {
          const finalStat = lstatSync(resolve(directory, finalName), { bigint: true });
          return !finalStat.isSymbolicLink() &&
            finalStat.isFile() &&
            finalStat.nlink === 2n &&
            finalStat.dev === stat.dev &&
            finalStat.ino === stat.ino;
        } catch {
          return false;
        }
      });
      if (linkedFinals.length !== 1) {
        throw new Error("temporary backup has two links but no unique published backup");
      }
    }
    rmSync(path);
    removed.push(name);
  }
  if (removed.length > 0) syncDirectory(directory);
  return Object.freeze(removed.sort(compareCodeUnits));
}

export function hasInterruptedBackupFiles(backupDirectory: string): boolean {
  const directory = ensureBackupDirectory(backupDirectory);
  return readdirSync(directory).some((name) =>
    TEMPORARY_BACKUP_PATTERN.test(name) || TEMPORARY_STATE_PATTERN.test(name));
}

export function hasPublishedBackupFiles(backupDirectory: string): boolean {
  return readdirSync(resolve(backupDirectory)).some((name) =>
    LOCAL_BACKUP_NAME_PATTERN.test(name));
}

export function inspectLocalBackup(
  backupDirectory: string,
  backupName: string,
  now: number = Date.now(),
): LocalBackup {
  return inspectLocalBackupWithIdentity(backupDirectory, backupName, now).backup;
}

function inspectLocalBackupWithIdentity(
  backupDirectory: string,
  backupName: string,
  now: number = Date.now(),
): Readonly<{ backup: LocalBackup; identity: FileIdentity }> {
  const clock = inspectClock(now);
  const directory = ensureBackupDirectory(backupDirectory);
  const parsed = LOCAL_BACKUP_NAME_PATTERN.exec(backupName);
  if (parsed === null || parsed[1] === undefined || basename(backupName) !== backupName) {
    throw new TypeError("backup name is invalid");
  }
  const createdAt = parseFilenameTimestamp(parsed[1]);
  if (createdAt > clock) throw new Error("backup timestamp is ahead of the current clock");
  const path = resolveBackupPath(directory, backupName);
  assertNoSqliteSidecars(path);
  const identity = inspectOrdinaryFile(path, "backup");
  const sha256 = sha256File(path);
  const database = new DatabaseSync(path, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    timeout: SQLITE_TIMEOUT_MILLISECONDS,
    readBigInts: true,
    defensive: true,
  });
  let schemaVersion: number;
  let instanceId: string;
  try {
    const journal = database.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (journal?.journal_mode.toLowerCase() !== "delete") {
      throw new Error("backup must use self-contained DELETE journal mode");
    }
    const integrity = inspectDatabaseIntegrity(database);
    if (!integrity.ok) {
      throw new Error(
        `backup failed application integrity checks: quick_check=${integrity.quickCheck}, ` +
        `foreign_key_violations=${integrity.foreignKeyViolations}, ` +
        `domain_violations=${integrity.domainViolations}, schema=${integrity.schema}`,
      );
    }
    const schema = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as
      | { version: bigint | number | null }
      | undefined;
    schemaVersion = Number(schema?.version ?? Number.NaN);
    if (
      schemaVersion < DATABASE_COMPATIBILITY.minimum ||
      schemaVersion > DATABASE_COMPATIBILITY.maximum
    ) {
      throw new Error(
        `backup schema ${schemaVersion} is outside application compatibility ` +
        `${DATABASE_COMPATIBILITY.minimum}-${DATABASE_COMPATIBILITY.maximum}`,
      );
    }
    const instance = database
      .prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'")
      .get() as { value: string } | undefined;
    instanceId = instance?.value ?? "";
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new Error("backup application instance ID is invalid");
    }
    const lease = database.prepare("SELECT COUNT(*) AS count FROM app_lease").get() as
      | { count: bigint | number }
      | undefined;
    if (Number(lease?.count ?? -1) !== 0) {
      throw new Error("backup contains an application lease");
    }
  } finally {
    database.close();
  }
  assertNoSqliteSidecars(path);
  assertFileIdentity(path, identity, "backup");
  const sizeBytes = Number(identity.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error("backup size is outside the safe integer range");
  }
  return Object.freeze({
    identity,
    backup: Object.freeze({
      name: backupName,
      sha256,
      sizeBytes,
      createdAt: new Date(createdAt).toISOString(),
      schemaVersion,
      instanceId,
    }),
  });
}

function ensureBackupDirectory(path: string): string {
  const directory = ensurePrivateDirectory(path);
  return hardenExistingPrivateDirectory(directory);
}

function resolveBackupPath(directoryInput: string, name: string): string {
  const directory = resolve(directoryInput);
  const path = resolve(directory, name);
  if (basename(name) !== name || dirname(path) !== directory) {
    throw new Error("backup path escaped the backup directory");
  }
  return path;
}

function inspectOrdinaryFile(path: string, label: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || stat.size < 1n) {
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
    throw new Error(`${label} identity changed while it was being inspected`);
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = readSync(handle, buffer, 0, buffer.byteLength, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function assertNoSqliteSidecars(path: string): void {
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (existsSync(sidecar)) throw new Error("backup is not a self-contained SQLite database");
  }
}

function removeSqliteSidecars(path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-journal`, { force: true });
}

function parseFilenameTimestamp(value: string): number {
  const iso = value.replace(
    /T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/u,
    "T$1:$2:$3.$4Z",
  );
  const timestamp = Date.parse(iso);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("backup timestamp is invalid");
  }
  if (new Date(timestamp).toISOString().replaceAll(":", "-") !== value) {
    throw new Error("backup timestamp is not canonical");
  }
  return timestamp;
}

function backupCreatedAt(name: string): string {
  const match = LOCAL_BACKUP_NAME_PATTERN.exec(name);
  if (match === null || match[1] === undefined) {
    throw new TypeError("backup name is invalid");
  }
  return new Date(parseFilenameTimestamp(match[1])).toISOString();
}

function formatArtifactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, MAXIMUM_ARTIFACT_ERROR_LENGTH);
}

function compareBackupsNewestFirst(
  left: LocalBackupReference,
  right: LocalBackupReference,
): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    compareCodeUnits(right.name, left.name);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function inspectClock(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || Number.isNaN(new Date(now).getTime())) {
    throw new RangeError("backup clock is invalid");
  }
  return now;
}
