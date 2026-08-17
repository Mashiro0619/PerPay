import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createAsyncBackupHealthProvider,
  DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS,
} from "../src/backup/health.ts";

const NOW = Date.UTC(2026, 7, 17, 8, 0, 0);
const INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const BACKUP_NAME =
  "perpay.sqlite3.backup-2026-08-17T08-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3";
const INSTANCE_ID = "a".repeat(32);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("asynchronous backup health provider", () => {
  it("streams and verifies the state-referenced backup", async () => {
    const fixture = createFixture(Buffer.alloc(2 * 1_024 * 1_024, 0x61));
    const provider = createAsyncBackupHealthProvider(fixture.config, {
      clock: () => NOW,
    });

    const pending = provider();
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    assert.equal(settled, false);

    const health = await pending;
    assert.equal(health.ok, true);
    assert.equal(health.status, "healthy");
    assert.equal(health.backup_available, true);
    assert.equal(health.backup_name, BACKUP_NAME);
    assert.equal(health.backup_sha256, fixture.sha256);
  });

  it("shares an in-flight probe and refreshes only after the five-second snapshot expires", async () => {
    const bytes = Buffer.alloc(4 * 1_024 * 1_024, 0x62);
    const fixture = createFixture(bytes);
    let now = NOW;
    const provider = createAsyncBackupHealthProvider(fixture.config, {
      clock: () => now,
    });

    const first = provider();
    const concurrent = provider();
    assert.strictEqual(concurrent, first);
    const healthy = await first;

    writeFileSync(fixture.backupPath, Buffer.alloc(bytes.byteLength, 0x63), { mode: 0o600 });
    now += DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS - 1;
    assert.strictEqual(await provider(), healthy);

    now += 1;
    const refreshed = await provider();
    assert.equal(refreshed.ok, false);
    assert.equal(refreshed.status, "unhealthy");
    assert.equal(refreshed.backup_available, false);
  });

  it("degrades a stale snapshot on metadata errors and can be explicitly invalidated", async () => {
    const fixture = createFixture(Buffer.from("verified-backup"));
    let now = NOW;
    const provider = createAsyncBackupHealthProvider(fixture.config, {
      clock: () => now,
    });
    const healthy = await provider();
    assert.equal(healthy.ok, true);

    writeFileSync(fixture.statePath, "{not-json}\n", { mode: 0o600 });
    now += DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS;
    const degraded = await provider();
    assert.equal(degraded.ok, false);
    assert.equal(degraded.status, "unhealthy");
    assert.equal(degraded.backup_available, false);
    assert.equal(degraded.last_error_at, now);
    assert.equal(degraded.last_error_stage, "state");

    provider.invalidate();
    await assert.rejects(provider(), /backup state is unreadable/u);
  });

  it("rejects an unbounded cache policy", () => {
    const fixture = createFixture(Buffer.from("verified-backup"));
    assert.throws(
      () =>
        createAsyncBackupHealthProvider(fixture.config, {
          cacheTtlMilliseconds: 60_001,
        }),
      /cache TTL/u,
    );
  });
});

function createFixture(bytes: Buffer): Readonly<{
  backupPath: string;
  config: Readonly<{
    backupDirectory: string;
    intervalMilliseconds: number;
    keepCount: number;
  }>;
  sha256: string;
  statePath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "perpay-async-backup-health-"));
  directories.push(root);
  const backupDirectory = join(root, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const backupPath = join(backupDirectory, BACKUP_NAME);
  writeFileSync(backupPath, bytes, { mode: 0o600 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const statePath = join(backupDirectory, "perpay-local-backup-state.json");
  writeFileSync(statePath, `${JSON.stringify({
    version: 2,
    intervalMilliseconds: INTERVAL_MILLISECONDS,
    keepCount: 7,
    lastAttemptAt: NOW,
    lastSuccessAt: NOW,
    lastErrorAt: null,
    lastErrorStage: null,
    backupName: BACKUP_NAME,
    backupRequired: false,
    backupSha256: sha256,
    backupSizeBytes: bytes.byteLength,
    instanceId: INSTANCE_ID,
    schemaVersion: 13,
    retainedCount: 1,
  })}\n`, { mode: 0o600 });
  return Object.freeze({
    backupPath,
    config: Object.freeze({
      backupDirectory,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
      keepCount: 7,
    }),
    sha256,
    statePath,
  });
}
