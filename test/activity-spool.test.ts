// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { ActivityRecorder, ACTIVITY_RETENTION_MILLISECONDS } from "../src/audit/activity.ts";
import { ActivitySpoolImporter, ActivitySpoolWriter, activitySpoolPath } from "../src/audit/spool.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "perpay-activity-spool-"));
  const database = await AppDatabase.open(join(root, "data", "perpay.sqlite3"));
  const state = { now: Date.now() };
  const backupDirectory = join(root, "backups");
  mkdirSync(backupDirectory);
  const recorder = new ActivityRecorder({ database, clock: () => state.now });
  const importer = new ActivitySpoolImporter({ database, recorder, backupDirectory, clock: () => state.now });
  const writer = new ActivitySpoolWriter({ backupDirectory, kind: "maintenance", clock: () => state.now });
  return { root, database, state, backupDirectory, recorder, importer, writer, async close() {
    writer.close(); await importer.stop(); recorder.stop(); database.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/"));
    rmSync(root, { recursive: true, force: true });
  } };
}

function publishedFiles(backupDirectory: string): string[] {
  const root = activitySpoolPath(backupDirectory);
  return readdirSync(root).flatMap(source => readdirSync(join(root, source)).filter(file => file.startsWith("event-")).map(file => join(root, source, file)));
}

describe("independent backup and maintenance activity spool", () => {
  it("cleans an inactive unclosed producer without rewriting its state and accepts its later wakeup", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.before_crash" });
      const root = activitySpoolPath(f.backupDirectory), sourceId = readdirSync(root)[0]!, directory = join(root, sourceId);
      const stateBefore = readFileSync(join(directory, "source.json"), "utf8");
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      const cleaner = new ActivitySpoolWriter({ backupDirectory: f.backupDirectory, kind: "backup", clock: () => f.state.now });
      cleaner.prune();
      assert.equal(publishedFiles(f.backupDirectory).length, 0);
      assert.equal(readFileSync(join(directory, "source.json"), "utf8"), stateBefore);
      assert.ok(readdirSync(directory).some(file => file.startsWith("retention-")));
      await f.importer.poll();
      assert.equal(f.recorder.status().spoolGapCount, 1);
      f.writer.record({ action: "backup.after_wakeup" });
      assert.equal(JSON.parse(readFileSync(join(directory, "source.json"), "utf8")).closedAt, null);
      await f.importer.poll();
      assert.equal(Number(f.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE action = 'backup.after_wakeup'").get()!.n)), 1);
      assert.equal(f.recorder.status().spoolGapCount, 1);
      assert.equal(Number(f.database.read(db => db.prepare("SELECT last_sequence FROM activity_import_sources WHERE source_id = ?").get(sourceId)!.last_sequence)), 2);
      cleaner.close();
    } finally { await f.close(); }
  });

  it("keeps intact events importable when cleanup stops after publishing its independent watermark", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore" }, { permanent: true });
      const file = publishedFiles(f.backupDirectory)[0]!, root = activitySpoolPath(f.backupDirectory), sourceId = readdirSync(root)[0]!;
      const directory = join(root, sourceId), stateBefore = readFileSync(join(directory, "source.json"), "utf8");
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      const cleaner = new ActivitySpoolWriter({ backupDirectory: f.backupDirectory, kind: "backup", clock: () => f.state.now });
      const remove = fs.rmSync;
      const fault = t.mock.method(fs, "rmSync", (target: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
        if (String(target) === file) throw new Error("cleanup interrupted");
        return remove(target, options);
      });
      syncBuiltinESMExports();
      try { cleaner.prune(); } finally { fault.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(existsSync(file), true);
      assert.ok(readdirSync(directory).some(name => name.startsWith("retention-")));
      assert.equal(readFileSync(join(directory, "source.json"), "utf8"), stateBefore);
      await f.importer.poll();
      assert.equal(Number(f.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get()!.n)), 1);
      assert.equal(f.recorder.status().spoolGapCount, 0);
      cleaner.prune();
      assert.equal(existsSync(file), false);
      await f.importer.poll();
      assert.equal(f.recorder.status().spoolGapCount, 0);
      cleaner.close();
    } finally { await f.close(); }
  });

  it("imports older spool records that predate firstOccurredAt", async () => {
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.legacy" }); f.writer.close();
      const file = publishedFiles(f.backupDirectory)[0]!, event = JSON.parse(readFileSync(file, "utf8"));
      delete event.activity.firstOccurredAt;
      writeFileSync(file, JSON.stringify(event), { mode: 0o600 });
      await f.importer.poll();
      const row = f.database.read(db => db.prepare("SELECT occurred_at, first_occurred_at, last_occurred_at FROM activity_events WHERE action = 'backup.legacy'").get())!;
      assert.equal(row.first_occurred_at, row.occurred_at);
      assert.equal(row.last_occurred_at, row.occurred_at);
    } finally { await f.close(); }
  });

  it("imports later files from a still-running producer using its persisted numeric cursor", async () => {
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.first" });
      await f.importer.poll();
      f.writer.record({ action: "backup.second" });
      await f.importer.poll();
      const rows = f.database.read(db => db.prepare("SELECT action FROM activity_events ORDER BY sequence").all()) as { action: string }[];
      assert.deepEqual(rows.map(row => row.action), ["backup.first", "backup.second"]);
      assert.equal(f.recorder.status().spoolFailures, 0);
    } finally { await f.close(); }
  });

  it("reports a failed final producer write as one gap without hiding a successful command", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.first" });
      assert.equal(f.writer.record({ action: "invalid action" }), false);
      f.writer.close();
      await f.importer.poll(); await f.importer.poll();
      assert.equal(f.recorder.status().spoolGapCount, 1);
    } finally { await f.close(); }
  });

  it("recovers a durable event whose producer died before metadata publication", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore" }, { permanent: true });
      const root = activitySpoolPath(f.backupDirectory), sourceId = readdirSync(root)[0]!;
      rmSync(join(root, sourceId, "source.json"));
      await f.importer.poll();
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get() as { n: number }).n)), 1);
      assert.equal(f.recorder.status().lastErrorCode, "activity_spool_metadata_missing");
      assert.equal(f.recorder.status().state, "degraded");
      f.writer.close();
      await f.importer.poll();
      assert.equal(f.recorder.status().lastErrorCode, null);
      assert.equal(f.recorder.status().state, "healthy");
    } finally { await f.close(); }
  });

  it("rejects an empty backup directory without creating a relative spool", t => {
    t.mock.method(console, "error", () => {});
    const writer = new ActivitySpoolWriter({ backupDirectory: "  ", kind: "maintenance" });
    assert.equal(writer.record({ action: "backup.command.invalid" }), false);
    assert.doesNotThrow(() => writer.close());
  });

  it("imports atomic event files read-only and deduplicates across importer restarts", async () => {
    const f = await fixture();
    try {
      assert.equal(f.writer.record({ action: "backup.cycle", details: { pages: 3 } }), true);
      f.writer.close();
      const files = publishedFiles(f.backupDirectory);
      const originals = files.map(file => readFileSync(file, "utf8"));
      await f.importer.poll();
      await f.importer.poll();
      const restarted = new ActivitySpoolImporter({ database: f.database, recorder: f.recorder, backupDirectory: f.backupDirectory });
      await restarted.poll(); await restarted.stop();
      const rows = f.database.read(db => db.prepare("SELECT * FROM activity_events").all()) as Record<string, unknown>[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, "backup.cycle");
      assert.equal(rows[0]!.actor_type, "SYSTEM");
      assert.equal(rows[0]!.source_address, null);
      assert.equal(rows[0]!.user_agent, null);
      assert.deepEqual(files.map(file => readFileSync(file, "utf8")), originals);
      assert.notEqual(f.recorder.status().spoolLastImportAt, null);
    } finally { await f.close(); }
  });

  it("retains imported high-risk core facts and receipts after all source files expire", async () => {
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore", details: { restored_schema: 39 } }, { permanent: true, instanceId: f.database.instanceId() });
      f.writer.record({ action: "backup.cycle" });
      f.writer.close();
      await f.importer.poll();
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      f.writer.prune();
      assert.equal(publishedFiles(f.backupDirectory).length, 0);
      await f.importer.poll();
      f.recorder.prune();
      const audits = f.database.read(db => db.prepare("SELECT action FROM audit_events WHERE action = 'backup.restore'").all());
      const receipts = f.database.read(db => db.prepare("SELECT core_event_id FROM activity_external_receipts WHERE core_event_id IS NOT NULL").all());
      assert.equal(audits.length, 1);
      assert.equal(receipts.length, 1);
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE action = 'backup.restore'").get() as { n: number }).n)), 0);
      assert.equal(f.recorder.status().spoolGapCount, 0);
      const restarted = new ActivitySpoolImporter({ database: f.database, recorder: f.recorder, backupDirectory: f.backupDirectory, clock: () => f.state.now });
      await restarted.poll(); await restarted.stop();
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get() as { n: number }).n)), 1);
    } finally { await f.close(); }
  });

  it("reports unimported maintenance sources that expired once without inventing permanent facts", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore" }, { permanent: true });
      f.writer.record({ action: "backup.cycle" });
      f.writer.record({ action: "backup.health" });
      f.writer.close();
      const boundaryTime = f.state.now;
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      f.writer.prune();
      await f.importer.poll();
      await f.importer.poll();
      const gaps = f.database.read(db => db.prepare("SELECT details_json FROM activity_events WHERE action = 'activity.capture_gap'").all()) as { details_json: string }[];
      assert.equal(gaps.length, 1);
      const details = JSON.parse(gaps[0]!.details_json);
      assert.equal(details.error_code, "source_retention_gap");
      assert.equal(details.missing_events, 3);
      assert.equal(details.through_sequence, 3);
      assert.equal(details.pruned_through_at, boundaryTime);
      assert.equal(f.recorder.status().spoolGapCount, 3);
      assert.equal(Number(f.database.read(db => db.prepare("SELECT last_sequence FROM activity_import_sources").get()!.last_sequence)), 3);
      assert.equal(Number(f.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get()!.n)), 0);
    } finally { await f.close(); }
  });

  it("still imports an intact maintenance event below a published retention boundary", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore" }, { permanent: true });
      f.writer.record({ action: "backup.cycle" });
      f.writer.close();
      const file = publishedFiles(f.backupDirectory).sort()[0]!, original = readFileSync(file);
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      f.writer.prune();
      // Simulate a producer dying after metadata publication but before unlinking this intact file.
      writeFileSync(file, original, { mode: 0o600 });
      await f.importer.poll();
      assert.equal(Number(f.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get()!.n)), 1);
      assert.equal(f.recorder.status().spoolGapCount, 1);
    } finally { await f.close(); }
  });

  it("does not report retention as data loss after the source was imported", async () => {
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.cycle" });
      await f.importer.poll();
      f.state.now += ACTIVITY_RETENTION_MILLISECONDS + 1;
      f.writer.prune();
      const restarted = new ActivitySpoolImporter({ database: f.database, recorder: f.recorder, backupDirectory: f.backupDirectory, clock: () => f.state.now });
      await restarted.poll(); await restarted.stop();
      assert.equal(f.recorder.status().spoolGapCount, 0);
      assert.equal(Number(f.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE action = 'activity.capture_gap'").get()!.n)), 0);
    } finally { await f.close(); }
  });

  it("records one visible gap for a missing event and continues importing later files", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.first" });
      f.writer.record({ action: "backup.second" });
      f.writer.record({ action: "backup.third" });
      f.writer.close();
      const files = publishedFiles(f.backupDirectory).sort();
      rmSync(files[1]!);
      await f.importer.poll(); f.recorder.flush();
      assert.equal(f.recorder.status().spoolGapCount, 1);
      assert.equal(f.recorder.status().state, "degraded");
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE action LIKE 'backup.%'").get() as { n: number }).n)), 2);
      await f.importer.poll();
      assert.equal(f.recorder.status().spoolGapCount, 1);
    } finally { await f.close(); }
  });

  it("does not change a successful command when its spool cannot be written", async t => {
    t.mock.method(console, "error", () => {});
    const root = mkdtempSync(join(tmpdir(), "perpay-activity-blocked-"));
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    try {
      const writer = new ActivitySpoolWriter({ backupDirectory: blocked, kind: "backup" });
      assert.equal(await writer.run("backup.cycle", {}, async () => "completed"), "completed");
      assert.doesNotThrow(() => writer.close());
      assert.equal(readFileSync(blocked, "utf8"), "not a directory");
    } finally { assert.equal(existsSync(blocked), true); rmSync(blocked); rmdirSync(root); }
  });

  it("rolls back an imported core event with its receipt and safely retries", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "maintenance.restore" }, { permanent: true });
      f.writer.close();
      let fail = true;
      const importer = new ActivitySpoolImporter({ recorder: f.recorder, backupDirectory: f.backupDirectory,
        database: { read: operation => f.database.read(operation), instanceId: () => f.database.instanceId(),
          write: operation => f.database.write(db => { const result = operation(db); if (fail && db.prepare("SELECT 1 FROM activity_external_receipts").get()) throw new Error("commit failed"); return result; }) } });
      await importer.poll();
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'maintenance.restore'").get() as { n: number }).n)), 0);
      fail = false;
      await importer.poll(); await importer.stop();
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'maintenance.restore'").get() as { n: number }).n)), 1);
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM activity_external_receipts").get() as { n: number }).n)), 1);
    } finally { await f.close(); }
  });

  it("does not import events attributed to a different database instance", async t => {
    t.mock.method(console, "error", () => {});
    const f = await fixture();
    try {
      f.writer.record({ action: "backup.restore" }, { permanent: true, instanceId: "0".repeat(32) });
      f.writer.close();
      await f.importer.poll();
      assert.equal(Number(f.database.read(db => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get() as { n: number }).n)), 0);
      assert.equal(f.recorder.status().spoolGapCount, 1);
    } finally { await f.close(); }
  });
});
