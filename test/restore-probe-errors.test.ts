import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { createOperationalBackup, publicationLockPath, restoreOperationalBackup } from "../src/database/maintenance.ts";
import { databaseMaintenanceLockPath } from "../src/database/maintenance-lock.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

const masterKey = Buffer.alloc(32, 0x64);
const sqliteSuffixes = ["", "-wal", "-shm", "-journal"] as const;

async function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "perpay-restore-probe-error-"));
  const data = join(root, "data"), backups = join(root, "backups");
  mkdirSync(data, { mode: 0o700 }); mkdirSync(backups, { mode: 0o700 });
  context.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("perpay-restore-probe-error-"));
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(data, "perpay.sqlite3");
  const database = await AppDatabase.open(path, { masterKey });
  let backup;
  try {
    new RuntimeSettingsStore(database, masterKey).initialize();
    backup = await createOperationalBackup({ dataDirectory: data, backupDirectory: backups });
  } finally { database.close(); }
  chmodSync(path, 0o640);
  const artifacts = sqliteSuffixes.filter(suffix => existsSync(path + suffix)).map(suffix => ({
    suffix, bytes: readFileSync(path + suffix), mode: lstatSync(path + suffix).mode,
  }));
  return { data, backups, path, backup, artifacts };
}

for (const [name, errcode] of [
  ["SQLITE_BUSY", 5], ["SQLITE_LOCKED", 6], ["SQLITE_READONLY", 8],
  ["SQLITE_IOERR", 10], ["SQLITE_CANTOPEN", 14], ["unknown error", null],
] as const) {
  it(`does not classify ${name} during the probe as database corruption`, async context => {
    const f = await fixture(context);
    const injected = errcode === null
      ? new Error("synthetic corruption-looking message without a SQLite result code")
      : Object.assign(new Error("synthetic " + name), { code: "ERR_SQLITE_ERROR", errcode });
    const originalPrepare = DatabaseSync.prototype.prepare;
    let injectedInProbe = false;
    const hookedPrepare = function (this: DatabaseSync, sql: string) {
      const locations = Reflect.apply(originalPrepare, this, ["PRAGMA database_list"]).all();
      const file = locations.find(row => row.name === "main")?.file;
      if (typeof file === "string" && basename(dirname(file)).startsWith(".perpay-unreadable-probe-")) {
        injectedInProbe = true;
        throw injected;
      }
      return Reflect.apply(originalPrepare, this, [sql]);
    } as typeof DatabaseSync.prototype.prepare;
    assert.equal(Reflect.set(DatabaseSync.prototype, "prepare", hookedPrepare), true);
    try {
      assert.throws(() => restoreOperationalBackup({
        dataDirectory: f.data, backupDirectory: f.backups,
        backupName: f.backup.name, expectedSha256: f.backup.sha256,
        masterKey, confirmReplaceCurrentDatabase: true, quarantineUnreadableCurrent: true,
      }), error => error === injected);
    } finally {
      assert.equal(Reflect.set(DatabaseSync.prototype, "prepare", originalPrepare), true);
    }
    assert.equal(injectedInProbe, true);
    for (const suffix of sqliteSuffixes) {
      const original = f.artifacts.find(artifact => artifact.suffix === suffix);
      assert.equal(existsSync(f.path + suffix), original !== undefined);
      if (original) {
        assert.deepEqual(readFileSync(f.path + suffix), original.bytes);
        assert.equal(lstatSync(f.path + suffix).mode, original.mode, "probe must not chmod original evidence");
      }
    }
    assert.equal(readdirSync(f.data).some(name => name.includes("unreadable")), false);
    assert.equal(existsSync(databaseMaintenanceLockPath(f.path)), false);
    assert.equal(existsSync(publicationLockPath(f.backups)), false);
  });
}
