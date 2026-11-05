import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ActivityRecorder } from "../src/audit/activity.ts";
import { ActivitySpoolImporter, activitySpoolPath, type ActivitySpoolEvent } from "../src/audit/spool.ts";
import { queryAuditEvent } from "../src/audit/query.ts";
import { runBackupCommand, type BackupOperations } from "../src/backup/runner.ts";
import { acquireBackupLock } from "../src/backup/lock.ts";
import { AppDatabase } from "../src/database/database.ts";
import { acquireDatabaseMaintenanceLock } from "../src/database/maintenance-lock.ts";
import { listPreRestoreQuarantines, runMaintenanceCommand } from "../src/database/maintenance.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";
import { auditQueryFixture } from "./audit-query-fixture.ts";

const roots: string[] = [];
const instanceId = "c".repeat(32), sha256 = "d".repeat(64), masterKey = "42".repeat(32);
const backupName = "perpay.sqlite3.backup-2026-08-17T00-00-00.000Z-12345678-1234-4123-8123-123456789abc.sqlite3";
const backup = { name: backupName, sha256, sizeBytes: 15, createdAt: "2026-08-17T00:00:00.000Z", schemaVersion: DATABASE_COMPATIBILITY.maximum, instanceId };
afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("perpay-maint-audit-"));
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "perpay-maint-audit-")); roots.push(root);
  const dataDirectory = join(root, "data"), backupDirectory = join(root, "backups");
  mkdirSync(dataDirectory); mkdirSync(backupDirectory);
  return { dataDirectory, backupDirectory, env: { PERPAY_DATA_DIR: dataDirectory, PERPAY_BACKUP_DIR: backupDirectory, PERPAY_MASTER_KEY: masterKey } };
}
function events(directory: string): ActivitySpoolEvent[] {
  const root = activitySpoolPath(directory);
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry =>
    readdirSync(join(root, entry.name)).filter(name => name.startsWith("event-")).map(name =>
      JSON.parse(readFileSync(join(root, entry.name, name), "utf8")) as ActivitySpoolEvent));
}
function operations(overrides: Partial<BackupOperations> = {}): BackupOperations {
  const unexpected = () => { throw new Error("unexpected operation"); };
  return { create: unexpected, inspect: () => backup, list: () => [], listArtifacts: () => [], prune: unexpected, recover: () => [],
    deleteArtifact: () => ({ ...backup, status: "verified", error: null }),
    restore: () => ({ backupName, sha256, restoredSchemaVersion: backup.schemaVersion, quarantinedDatabaseName: "preserved-current-database" }), ...overrides };
}
async function imported(directory: string, expectedInstanceId: string) {
  const test = auditQueryFixture();
  const database = { ...test.database, instanceId: () => expectedInstanceId };
  const recorder = new ActivityRecorder({ database });
  const importer = new ActivitySpoolImporter({ database, recorder, backupDirectory: directory });
  try {
    await importer.poll();
    const ids = test.connection.prepare("SELECT event_id FROM audit_events ORDER BY sequence").all();
    return ids.map(row => queryAuditEvent(database, "core", String(row.event_id)));
  } finally { await importer.stop(); recorder.stop(); test.close(); }
}

describe("verified maintenance audit targets", () => {
  it("preserves restore and foreign-backup deletion identities through permanent import without copying arguments", async () => {
    const test = fixture();
    await runBackupCommand(["delete-backup-file", backupName, sha256, "--confirm-delete-backup-file"], test.env, operations({
      deleteArtifact: () => ({ ...backup, instanceId: "f".repeat(32), status: "verified", error: "private diagnostic is not projected" }),
    }));
    await runBackupCommand(["restore", backupName, sha256, "--confirm-replace-current-database"], test.env, operations());
    const spool = events(test.backupDirectory);
    assert.equal(spool.length, 2);
    for (const event of spool) {
      assert.equal(event.permanent, true);
      assert.equal(event.activity.subjectId, backupName);
      const details = JSON.parse(event.activity.detailsJson);
      assert.equal(details.backup_name, backupName); assert.equal(details.backup_sha256, sha256);
      assert.equal(JSON.stringify(event).includes(masterKey), false);
      assert.equal(JSON.stringify(event).includes("private diagnostic"), false);
    }
    assert.equal(spool.find(event => event.activity.action === "backup.restore")?.instanceId, instanceId);
    assert.equal(spool.find(event => event.activity.action === "backup.delete")?.instanceId, null);
    const records = await imported(test.backupDirectory, instanceId);
    assert.equal(records.length, 2);
    const restored = records.find(event => event.action === "backup.restore")!;
    assert.equal(restored.subject_id, backupName);
    assert.equal(restored.details.quarantined_database_name, "preserved-current-database");
    assert.equal(restored.details.restore_completed, true);
    assert.equal(records.find(event => event.action === "backup.delete")?.details.instance_id, "f".repeat(32));
  });

  it("does not invent a target before validation and retains a verified selection if replacement fails", async () => {
    const test = fixture();
    await assert.rejects(runBackupCommand(["restore", "unverified-secret-name", "bad-hash", "--confirm-replace-current-database"], test.env, operations()));
    let spool = events(test.backupDirectory);
    assert.equal(spool[0]?.activity.subjectId, null);
    assert.equal(JSON.stringify(spool).includes("unverified-secret-name"), false);
    await assert.rejects(runBackupCommand(["restore", backupName, sha256, "--confirm-replace-current-database"], test.env,
      operations({ restore: () => { throw new Error("replacement failed"); } })));
    spool = events(test.backupDirectory);
    const selected = spool.find(event => event.activity.subjectId === backupName)!;
    assert.equal(selected.activity.outcome, "FAILURE");
    assert.equal(JSON.parse(selected.activity.detailsJson).backup_sha256, sha256);
    assert.equal(JSON.parse(selected.activity.detailsJson).restore_completed, undefined);
  });

  it("records exact cleared lock fingerprints while excluding ownership tokens and free-form operations", async () => {
    const test = fixture();
    const old = Date.now() - 8 * 3_600_000;
    const publication = acquireDatabaseMaintenanceLock(join(test.backupDirectory, ".perpay-source-publication"), "secret-operation-text", old);
    await runMaintenanceCommand(["clear-stale-publication-lock", publication.token, "--confirm-no-maintenance-process"], test.env);
    const backupLock = acquireBackupLock({ dataDirectory: test.dataDirectory, backupDirectory: test.backupDirectory, intervalMilliseconds: 86400000, keepCount: 7 }, "secret-operation-text", old);
    await runBackupCommand(["clear-lock", backupLock.record.token, "--confirm-no-backup-process"], test.env, operations());
    const records = await imported(test.backupDirectory, instanceId);
    assert.equal(records.length, 2);
    for (const [action, token, kind] of [["maintenance.publication_lock.clear", publication.token, "publication"], ["backup.lock.clear", backupLock.record.token, "backup"]]) {
      const event = records.find(event => event.action === action)!;
      const fingerprint = createHash("sha256").update(token!).digest("hex");
      assert.equal(event.details.lock_fingerprint, fingerprint);
      assert.equal(event.subject_id, kind + ":" + fingerprint);
      assert.equal(JSON.stringify(event).includes(token!), false);
      assert.equal(JSON.stringify(event).includes("secret-operation-text"), false);
    }
  });

  it("identifies an explicitly deleted damaged quarantine by its verified name and digest", async () => {
    const test = fixture();
    const name = `perpay.sqlite3.before-restore-2026-08-17T00-00-00.000Z-${randomUUID()}`;
    const bytes = "damaged quarantine with private contents";
    writeFileSync(join(test.dataDirectory, name), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await runMaintenanceCommand(["delete-pre-restore-quarantine", name, hash, "--confirm-delete-pre-restore-quarantine"], test.env);
    const records = await imported(test.backupDirectory, instanceId);
    assert.equal(records[0]?.subject_id, name);
    assert.equal(records[0]?.details.quarantine_sha256, hash);
    assert.equal(JSON.stringify(records).includes(bytes), false);
  });

  it("identifies the restored migration backup and every pruned quarantine from completed results", async () => {
    const test = fixture(), databasePath = join(test.dataDirectory, "perpay.sqlite3");
    const database = await AppDatabase.open(databasePath);
    new RuntimeSettingsStore(database, Buffer.from(masterKey, "hex")).initialize();
    const targetInstance = database.instanceId();
    const name = `perpay.sqlite3.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum + 1}.sqlite3`;
    await database.backupDetailed(join(test.dataDirectory, name));
    database.close();
    const hash = createHash("sha256").update(readFileSync(join(test.dataDirectory, name))).digest("hex");
    await runMaintenanceCommand(["restore-migration-backup", name, "--confirm-replace-current-database"], test.env);
    for (const day of [15, 16]) copyFileSync(join(test.dataDirectory, name), join(test.dataDirectory,
      `perpay.sqlite3.before-restore-2026-08-${day}T00-00-00.000Z-${randomUUID()}`));
    const before = listPreRestoreQuarantines(test.dataDirectory);
    await runMaintenanceCommand(["prune-pre-restore-quarantines", "1", "--confirm-prune-pre-restore-quarantines"], test.env);
    const records = await imported(test.backupDirectory, targetInstance);
    const restored = records.find(event => event.action === "maintenance.restore")!;
    assert.equal(restored.subject_id, name); assert.equal(restored.details.backup_sha256, hash);
    assert.equal(restored.details.instance_id, targetInstance);
    assert.match(String(restored.details.quarantined_database_name), /^perpay.sqlite3.before-restore-/);
    const pruned = records.filter(event => event.action === "maintenance.quarantine.prune");
    assert.deepEqual(pruned.map(event => event.subject_id).sort(), before.slice(1).map(item => item.name).sort());
    assert.equal(new Set(pruned.map(event => event.details.operation_id)).size, 1);
    assert.ok(pruned.every(event => event.details.deleted_count === 2 && event.details.quarantine_sha256));
  });
});
