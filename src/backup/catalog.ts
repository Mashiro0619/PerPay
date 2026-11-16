import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { LOCAL_BACKUP_NAME_PATTERN, RESTORE_SAFETY_BACKUP_SUFFIX } from "./repository.ts";

const MAXIMUM_BACKUP_FILES = 4_096;
const MAXIMUM_DIRECTORY_ENTRIES = 16_384;

export interface BackupCatalogItem {
  readonly name: string;
  readonly created_at: string;
  readonly size_bytes: number | null;
  readonly sha256: string | null;
  readonly safety_backup: boolean;
}

export interface BackupCatalog {
  readonly items: readonly BackupCatalogItem[];
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FileFingerprint {
  readonly identity: string;
  readonly sha256: string;
}

/** Hash each published file once; changed files are checked again on the next read. */
export function createBackupCatalogProvider(backupDirectory: string): () => Promise<BackupCatalog> {
  const directory = resolve(backupDirectory);
  const fingerprints = new Map<string, FileFingerprint>();
  let inFlight: Promise<BackupCatalog> | null = null;
  return () => {
    if (inFlight !== null) return inFlight;
    const pending: Promise<BackupCatalog> = readCatalog(directory, fingerprints).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  };
}

async function readCatalog(directory: string, fingerprints: Map<string, FileFingerprint>): Promise<BackupCatalog> {
  let identity: DirectoryIdentity;
  try {
    identity = await inspectDirectory(directory);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return Object.freeze({ items: Object.freeze([]) });
    throw error;
  }

  const entries = await opendir(directory);
  const items: BackupCatalogItem[] = [];
  const names = new Set<string>();
  let inspectedEntries = 0;
  try {
    await assertDirectoryIdentity(directory, identity);
    for await (const entry of entries) {
      if (++inspectedEntries > MAXIMUM_DIRECTORY_ENTRIES) throw new Error("too many backup directory entries");
      const match = LOCAL_BACKUP_NAME_PATTERN.exec(entry.name);
      if (match?.[1] === undefined || names.has(entry.name)) continue;
      names.add(entry.name);
      if (names.size > MAXIMUM_BACKUP_FILES) throw new Error("too many backup files");
      const createdAt = filenameTimestamp(match[1]);
      if (createdAt === null) continue;
      const path = resolve(directory, entry.name);
      if (basename(entry.name) !== entry.name || dirname(path) !== directory) {
        throw new Error("backup path is outside the catalog directory");
      }
      let size: number | null = null;
      let sha256: string | null = null;
      let safetyBackup = false;
      try {
        const stat = await lstat(path, { bigint: true });
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
          stat.size > 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
          size = Number(stat.size);
          const identity = fileIdentity(stat);
          const cached = fingerprints.get(entry.name);
          sha256 = await hasSqliteSidecars(path) ? null : cached?.identity === identity ? cached.sha256 : await hashBackup(path, identity);
          if (sha256 !== null) fingerprints.set(entry.name, { identity, sha256 });
          else fingerprints.delete(entry.name);
          try {
            const marker = await lstat(`${path}${RESTORE_SAFETY_BACKUP_SUFFIX}`);
            safetyBackup = marker.isFile() && !marker.isSymbolicLink();
          } catch (error) { if (!isFileSystemError(error, "ENOENT")) throw error; }
        } else {
          fingerprints.delete(entry.name);
        }
      } catch (error) {
        fingerprints.delete(entry.name);
        sha256 = null;
        // Retention can remove a published file between enumeration and lstat.
        if (isFileSystemError(error, "ENOENT")) continue;
      }
      items.push(Object.freeze({ name: entry.name, created_at: createdAt, size_bytes: size, sha256, safety_backup: safetyBackup }));
    }
  } finally {
    // Iteration closes the handle; an error before iteration must also close it.
    await entries.close().catch((error: unknown) => {
      if (!isFileSystemError(error, "ERR_DIR_CLOSED")) throw error;
    });
  }
  await assertDirectoryIdentity(directory, identity);
  for (const name of fingerprints.keys()) if (!names.has(name)) fingerprints.delete(name);
  items.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) ||
    (left.name < right.name ? 1 : left.name > right.name ? -1 : 0));
  return Object.freeze({ items: Object.freeze(items) });
}

function fileIdentity(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function hashBackup(path: string, identity: string): Promise<string | null> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const after = await lstat(path, { bigint: true });
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1n && fileIdentity(after) === identity && !await hasSqliteSidecars(path)
    ? hash.digest("hex") : null;
}

async function hasSqliteSidecars(path: string): Promise<boolean> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await lstat(`${path}${suffix}`); return true; }
    catch (error) { if (!isFileSystemError(error, "ENOENT")) throw error; }
  }
  return false;
}

async function inspectDirectory(directory: string): Promise<DirectoryIdentity> {
  const stat = await lstat(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("backup directory must be an ordinary directory");
  return { device: stat.dev, inode: stat.ino };
}

async function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): Promise<void> {
  const current = await inspectDirectory(directory);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error("backup directory changed while reading the catalog");
  }
}

function filenameTimestamp(value: string): string | null {
  const iso = value.replace(/T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/u, "T$1:$2:$3.$4Z");
  const timestamp = Date.parse(iso);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  const canonical = new Date(timestamp).toISOString();
  return canonical.replaceAll(":", "-") === value ? canonical : null;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
