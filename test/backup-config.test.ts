import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadBackupConfig } from "../src/backup/config.ts";

describe("backup configuration", () => {
  it("loads the separate backup directory and bounded retention policy", () => {
    const config = loadBackupConfig({
      PERPAY_DATA_DIR: "./data",
      PERPAY_BACKUP_DIR: "./backups",
      PERPAY_BACKUP_INTERVAL_SECONDS: "7200",
      PERPAY_BACKUP_KEEP_COUNT: "14",
    });
    assert.equal(config.intervalMilliseconds, 7_200_000);
    assert.equal(config.keepCount, 14);
    assert.notEqual(config.dataDirectory, config.backupDirectory);
  });

  it("uses simple deployment defaults", () => {
    const config = loadBackupConfig({});
    assert.equal(config.intervalMilliseconds, 86_400_000);
    assert.equal(config.keepCount, 7);
    assert.match(config.dataDirectory, /[\\/]data$/u);
    assert.match(config.backupDirectory, /[\\/]backups$/u);
  });

  it("rejects overlapping live-data and backup storage", () => {
    for (const [dataDirectory, backupDirectory] of [
      ["./data", "./data"],
      ["./data", "./data/backups"],
      ["./backups/data", "./backups"],
      ["./data", "./data/..backups"],
    ] as const) {
      assert.throws(
        () => loadBackupConfig({
          PERPAY_DATA_DIR: dataDirectory,
          PERPAY_BACKUP_DIR: backupDirectory,
        }),
        /must be separate/u,
      );
    }
  });

  it("resolves existing parent links before checking storage separation", () => {
    const root = mkdtempSync(join(tmpdir(), "perpay-backup-config-paths-"));
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.throws(
        () => loadBackupConfig({
          PERPAY_DATA_DIR: join(alias, "future-data"),
          PERPAY_BACKUP_DIR: join(actual, "future-data", "backups"),
        }),
        /must be separate/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds the interval and keep count", () => {
    for (const environment of [
      { PERPAY_BACKUP_INTERVAL_SECONDS: "3599" },
      { PERPAY_BACKUP_INTERVAL_SECONDS: String(7 * 24 * 60 * 60 + 1) },
      { PERPAY_BACKUP_KEEP_COUNT: "0" },
      { PERPAY_BACKUP_KEEP_COUNT: "366" },
    ]) {
      assert.throws(
        () => loadBackupConfig({
          PERPAY_DATA_DIR: "./data",
          PERPAY_BACKUP_DIR: "./backups",
          ...environment,
        }),
        /backup configuration validation failed/u,
      );
    }
  });
});
