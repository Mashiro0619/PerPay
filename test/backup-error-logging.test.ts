import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { runBackupCommand } from "../src/backup/runner.ts";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

const syntheticSecret = "synthetic-private-configuration-value";

function directories(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "perpay-backup-error-log-"));
  const data = join(root, "data"), backups = join(root, "backups");
  mkdirSync(data); mkdirSync(backups);
  context.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("perpay-backup-error-log-"));
    rmSync(root, { recursive: true, force: true });
  });
  return { data, backups };
}

it("the backup process reports invalid configuration without echoing its value", context => {
  const { data, backups } = directories(context);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/backup/runner.ts", "run-once"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, PERPAY_DATA_DIR: data, PERPAY_BACKUP_DIR: backups, PERPAY_BACKUP_KEEP_COUNT: syntheticSecret },
  });
  assert.equal(result.status, 1);
  const log = result.stderr.split(/\r?\n/u).filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line)).find(entry => entry.error === "backup_runner_failed");
  assert.ok(log);
  assert.equal(log.stage, "startup");
  assert.match(log.message, /PERPAY_BACKUP_KEEP_COUNT/u);
  assert.equal(result.stderr.includes(syntheticSecret), false);
});

it("scheduled retention and backup failures expose protected metadata reasons", { timeout: 10_000 }, async context => {
  const { data, backups } = directories(context);
  const key = Buffer.alloc(32, 0x54);
  const database = await AppDatabase.open(join(data, "perpay.sqlite3"), { masterKey: key });
  try { new RuntimeSettingsStore(database, key).initialize(); } finally { database.close(); }
  writeFileSync(join(backups, "perpay-local-backup-state.json"), `{${syntheticSecret}`, { mode: 0o600 });
  const logs: Record<string, unknown>[] = [];
  context.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    const log = JSON.parse(String(chunk)) as Record<string, unknown>;
    logs.push(log);
    if (log.event === "backup_cycle_failed") process.emit("SIGTERM");
    return true;
  });
  assert.equal(await runBackupCommand(["schedule"], { PERPAY_DATA_DIR: data, PERPAY_BACKUP_DIR: backups }), 0);
  for (const event of ["backup_retention_recovery_failed", "backup_cycle_failed"]) {
    const log = logs.find(entry => entry.event === event);
    assert.ok(log, event);
    assert.match(String(log.message), /backup state is unreadable/u);
    assert.match(String(log.message), /JSON|metadata/u);
  }
  assert.equal(JSON.stringify(logs).includes(syntheticSecret), false);
});
