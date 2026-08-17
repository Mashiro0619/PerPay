import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const POSIX_MODE_MASK = 0o777;

/** Keeps newly created sensitive files private without weakening a stricter umask. */
export function hardenProcessFileCreation(): void {
  if (process.platform === "win32") return;
  const current = process.umask();
  process.umask(current | 0o077);
}

export function ensurePrivateDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  hardenExistingPrivateDirectory(directory);
  return directory;
}

export function hardenExistingPrivateDirectory(path: string): string {
  const directory = resolve(path);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("sensitive data directory must be an ordinary directory");
  }
  if (
    process.platform !== "win32" &&
    (stat.mode & POSIX_MODE_MASK) !== PRIVATE_DIRECTORY_MODE
  ) {
    chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
  return directory;
}

/** Returns false for a missing path and rejects links or non-files before chmod. */
export function hardenExistingPrivateFile(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("sensitive data file must be an ordinary file");
  }
  if (
    process.platform !== "win32" &&
    (stat.mode & POSIX_MODE_MASK) !== PRIVATE_FILE_MODE
  ) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
  return true;
}

export function hardenSqliteArtifacts(databasePath: string): void {
  const resolvedPath = resolve(databasePath);
  const directory = dirname(resolvedPath);
  const databaseName = basename(resolvedPath);
  for (const entry of readdirSync(directory)) {
    if (
      entry !== databaseName &&
      !entry.startsWith(`${databaseName}.`) &&
      !entry.startsWith(`${databaseName}-`) &&
      !entry.startsWith(`.${databaseName}.`)
    ) {
      continue;
    }
    hardenExistingPrivateFile(join(directory, entry));
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
