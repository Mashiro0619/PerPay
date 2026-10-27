import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createOperationalBackup, restoreOperationalBackup } from "../src/database/maintenance.ts";
import { databaseMaintenanceLockPath } from "../src/database/maintenance-lock.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { runBackupCommand } from "../src/backup/runner.ts";

const masterKey = Buffer.alloc(32, 0x63);
type RestoreOptions = Parameters<typeof restoreOperationalBackup>[0] & { quarantineUnreadableCurrent?: boolean };

async function fixture(context: TestContext, keepOpen = false) {
  const root = mkdtempSync(join(tmpdir(), "perpay-unreadable-restore-"));
  const data = join(root, "data"), backups = join(root, "backups");
  mkdirSync(data, { mode: 0o700 }); mkdirSync(backups, { mode: 0o700 });
  const path = join(data, "perpay.sqlite3");
  const database = await AppDatabase.open(path, { masterKey });
  new RuntimeSettingsStore(database, masterKey).initialize();
  let closed = false;
  const close = () => { if (!closed) { database.close(); closed = true; } };
  context.after(() => {
    close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("perpay-unreadable-restore-"));
    rmSync(root, { recursive: true, force: true });
  });
  const backup = await createOperationalBackup({ dataDirectory: data, backupDirectory: backups });
  if (!keepOpen) close();
  const options: RestoreOptions = { dataDirectory: data, backupDirectory: backups, backupName: backup.name,
    expectedSha256: backup.sha256, masterKey, confirmReplaceCurrentDatabase: true, quarantineUnreadableCurrent: true };
  return { root, data, backups, path, options, database, close };
}

function damage(path: string, empty = false) {
  const artifacts = new Map([
    ["", empty ? Buffer.alloc(0) : Buffer.from("synthetic unreadable SQLite database")],
    ["-wal", Buffer.from("synthetic WAL evidence")],
    ["-shm", Buffer.from("synthetic SHM evidence")],
    ["-journal", Buffer.from("synthetic rollback journal evidence")],
  ]);
  for (const [suffix, bytes] of artifacts) writeFileSync(path + suffix, bytes, { mode: 0o600 });
  return artifacts;
}

for (const empty of [false, true]) {
  it(`quarantines every original SQLite artifact before restoring a ${empty ? "zero-byte" : "corrupt"} database`, async context => {
    const f = await fixture(context);
    const artifacts = damage(f.path, empty);
    const result = restoreOperationalBackup(f.options);
    assert.ok(result.quarantinedDatabaseName);
    const quarantine = join(f.data, result.quarantinedDatabaseName);
    assert.equal(fs.lstatSync(quarantine).isDirectory(), true);
    for (const [suffix, bytes] of artifacts) {
      assert.deepEqual(readFileSync(join(quarantine, "perpay.sqlite3" + suffix)), bytes);
      if (suffix) assert.equal(existsSync(f.path + suffix), false);
    }
    assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), false);
    const restored = await AppDatabase.open(f.path, { masterKey });
    try { assert.equal(restored.integrityCheck().ok, true); } finally { restored.close(); }
  });
}

it("preserves original evidence through the real restore command and repository", async context => {
  const f = await fixture(context);
  const artifacts = damage(f.path);
  let output = "";
  context.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  context.mock.method(process.stderr, "write", () => true);
  assert.equal(await runBackupCommand([
    "restore", f.options.backupName, f.options.expectedSha256,
    "--confirm-replace-current-database", "--quarantine-unreadable-current", "--rebuild-state",
  ], { PERPAY_DATA_DIR: f.data, PERPAY_BACKUP_DIR: f.backups, PERPAY_MASTER_KEY: masterKey.toString("hex") }), 0);
  const result = JSON.parse(output) as { quarantinedDatabaseName: string };
  assert.ok(result.quarantinedDatabaseName.includes("unreadable"));
  for (const [suffix, bytes] of artifacts) {
    assert.deepEqual(readFileSync(join(f.data, result.quarantinedDatabaseName, "perpay.sqlite3" + suffix)), bytes);
  }
});

it("leaves all original artifacts intact when the restore command has no isolation flag", async context => {
  const f = await fixture(context);
  const artifacts = damage(f.path);
  context.mock.method(process.stderr, "write", () => true);
  await assert.rejects(runBackupCommand([
    "restore", f.options.backupName, f.options.expectedSha256,
    "--confirm-replace-current-database", "--rebuild-state",
  ], { PERPAY_DATA_DIR: f.data, PERPAY_BACKUP_DIR: f.backups, PERPAY_MASTER_KEY: masterKey.toString("hex") }));
  for (const [suffix, bytes] of artifacts) assert.deepEqual(readFileSync(f.path + suffix), bytes);
  assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
});

it("requires explicit isolation and leaves the damaged files in place without it", async context => {
  const f = await fixture(context);
  const artifacts = damage(f.path);
  const options: RestoreOptions = { ...f.options, quarantineUnreadableCurrent: false };
  assert.throws(() => restoreOperationalBackup(options));
  for (const [suffix, bytes] of artifacts) assert.deepEqual(readFileSync(f.path + suffix), bytes);
  assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
});

for (const invalid of ["hash", "key"] as const) {
  it(`rejects an invalid backup ${invalid} before isolating any current file`, async context => {
    const f = await fixture(context);
    const artifacts = damage(f.path);
    const options = { ...f.options, ...(invalid === "hash" ? { expectedSha256: "0".repeat(64) } : { masterKey: Buffer.alloc(32, 0x64) }) };
    assert.throws(() => restoreOperationalBackup(options));
    for (const [suffix, bytes] of artifacts) assert.deepEqual(readFileSync(f.path + suffix), bytes);
    assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
    assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), false);
  });
}

it("refuses a readable active application lease even with isolation requested", async context => {
  const f = await fixture(context, true);
  assert.throws(() => restoreOperationalBackup(f.options), /owned|lease/u);
  assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
  assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), false);
});

it("refuses a linked sidecar instead of moving an unrelated file", async context => {
  const f = await fixture(context);
  damage(f.path);
  const other = join(f.root, "other-file");
  writeFileSync(other, "unrelated synthetic data");
  rmSync(f.path + "-wal");
  fs.linkSync(other, f.path + "-wal");
  assert.throws(() => restoreOperationalBackup(f.options), /ordinary|link/u);
  assert.equal(readFileSync(other, "utf8"), "unrelated synthetic data");
  assert.equal(fs.lstatSync(other).nlink, 2);
  assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
});

it("retains the maintenance barrier and all evidence after a partial isolation failure", async context => {
  const f = await fixture(context);
  const artifacts = damage(f.path);
  const originalRename = fs.renameSync;
  let attempts = 0;
  const hookedRename = ((from: fs.PathLike, to: fs.PathLike) => {
    if (dirname(String(from)) === f.data && basename(dirname(String(to))).includes("unreadable")) {
      attempts++;
      if (attempts === 2) throw new Error("injected second isolation move failure");
    }
    return originalRename(from, to);
  }) as typeof fs.renameSync;
  Reflect.set(fs, "renameSync", hookedRename); syncBuiltinESMExports();
  try {
    assert.throws(() => restoreOperationalBackup(f.options), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /preserve original files, quarantine directory, and maintenance lock/u);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, "injected second isolation move failure");
      return true;
    });
  }
  finally { Reflect.set(fs, "renameSync", originalRename); syncBuiltinESMExports(); }
  assert.equal(attempts, 2);
  assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), true);
  const quarantine = readdirSync(f.data).find(name => name.includes("unreadable"));
  assert.ok(quarantine);
  let moved = 0;
  for (const [suffix, bytes] of artifacts) {
    const original = f.path + suffix;
    const isolated = join(f.data, quarantine, "perpay.sqlite3" + suffix);
    assert.notEqual(existsSync(original), existsSync(isolated), "exactly one preserved location per artifact");
    if (existsSync(isolated)) moved++;
    assert.deepEqual(readFileSync(existsSync(original) ? original : isolated), bytes);
  }
  assert.equal(moved, 1);
  await assert.rejects(AppDatabase.open(f.path, { masterKey }), /maintenance/u);
});

it("rejects current file changes between the probe and replacement", async context => {
  const f = await fixture(context);
  damage(f.path);
  const replacement = Buffer.from("synthetic replacement after probe");
  const originalCopy = fs.copyFileSync;
  let changed = false;
  const hookedCopy = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
    originalCopy(from, to, mode);
    if (String(from) === join(f.backups, f.options.backupName) && basename(String(to)).startsWith(".perpay.sqlite3.restore-")) {
      writeFileSync(f.path, replacement);
      changed = true;
    }
  }) as typeof fs.copyFileSync;
  Reflect.set(fs, "copyFileSync", hookedCopy); syncBuiltinESMExports();
  try { assert.throws(() => restoreOperationalBackup(f.options), /changed|identity/u); }
  finally { Reflect.set(fs, "copyFileSync", originalCopy); syncBuiltinESMExports(); }
  assert.equal(changed, true);
  assert.deepEqual(readFileSync(f.path), replacement);
  assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
});
