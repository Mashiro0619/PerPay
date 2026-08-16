import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import {
  ensurePrivateDirectory,
  hardenExistingPrivateFile,
  hardenProcessFileCreation,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from "../src/infrastructure/storage/permissions.ts";

const POSIX_MODE_MASK = 0o777;

describe("sensitive storage permissions", () => {
  it("does not weaken an existing umask and adds all group and other restrictions", {
    skip: process.platform === "win32",
  }, () => {
    const original = process.umask();
    try {
      process.umask(0o701);
      hardenProcessFileCreation();
      assert.equal(process.umask(), 0o777);
    } finally {
      process.umask(original);
    }
  });

  it("repairs existing directory and file modes on POSIX", {
    skip: process.platform === "win32",
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "perpay-permissions-"));
    const directory = join(root, "data");
    const file = join(directory, "evidence.sqlite3");
    try {
      ensurePrivateDirectory(directory);
      const handle = openSync(file, "wx", 0o666);
      closeSync(handle);
      chmodSync(directory, 0o755);
      chmodSync(file, 0o644);

      ensurePrivateDirectory(directory);
      assert.equal(hardenExistingPrivateFile(file), true);
      assert.equal(lstatSync(directory).mode & POSIX_MODE_MASK, PRIVATE_DIRECTORY_MODE);
      assert.equal(lstatSync(file).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);
      assert.equal(hardenExistingPrivateFile(join(directory, "missing")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the database, WAL, SHM, backup, and their directories private on POSIX", {
    skip: process.platform === "win32",
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "perpay-sqlite-permissions-"));
    const dataDirectory = join(root, "data");
    const databasePath = join(dataDirectory, "perpay.sqlite3");
    const existingBackupPath = join(
      dataDirectory,
      "perpay.sqlite3.backup-2026-08-16T00-00-00.000Z-existing.sqlite3",
    );
    const backupDirectory = join(root, "backups");
    const backupPath = join(backupDirectory, "perpay.sqlite3");
    const original = process.umask();
    try {
      process.umask(0o000);
      ensurePrivateDirectory(dataDirectory);
      closeSync(openSync(existingBackupPath, "wx", 0o666));
      chmodSync(dataDirectory, 0o755);
      chmodSync(existingBackupPath, 0o644);
      const database = await AppDatabase.open(databasePath);
      try {
        assert.equal(lstatSync(dataDirectory).mode & POSIX_MODE_MASK, PRIVATE_DIRECTORY_MODE);
        assert.equal(lstatSync(databasePath).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);
        assert.equal(lstatSync(`${databasePath}-wal`).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);
        assert.equal(lstatSync(`${databasePath}-shm`).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);
        assert.equal(lstatSync(existingBackupPath).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);

        await database.backupDetailed(backupPath);
        assert.equal(lstatSync(backupDirectory).mode & POSIX_MODE_MASK, PRIVATE_DIRECTORY_MODE);
        assert.equal(lstatSync(backupPath).mode & POSIX_MODE_MASK, PRIVATE_FILE_MODE);
      } finally {
        database.close();
      }
    } finally {
      process.umask(original);
      rmSync(root, { recursive: true, force: true });
    }
  });

});
