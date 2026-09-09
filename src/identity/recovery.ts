import { lstatSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { inspectDatabaseIntegrity } from "../database/database.ts";
import { ADMIN_USERNAME, IdentityReadTransaction, appendAuditEvent } from "../database/identity-store.ts";
import { acquireDatabaseMaintenanceLock } from "../database/maintenance-lock.ts";
import { hardenExistingPrivateDirectory, hardenProcessFileCreation, hardenSqliteArtifacts } from "../infrastructure/storage/permissions.ts";
import { hashPassword } from "./crypto.ts";
import { assertNewPasswordLength } from "./service.ts";

export class AdminRecoveryError extends Error {}

/** Offline only. Does not open AppDatabase, migrate, initialize keys, or run jobs. */
export async function recoverAdministratorPassword(input: {
  dataDirectory: string;
  password: string;
  confirmed: boolean;
}): Promise<{ sessionGeneration: number; revokedSessions: number }> {
  if (!input.confirmed) throw new AdminRecoveryError("未确认重设，数据库未修改。");
  assertNewPasswordLength(input.password);
  const directory = resolve(input.dataDirectory);
  const databasePath = join(directory, "perpay.sqlite3");
  let identity: BigIntStats;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("not an ordinary directory");
    identity = inspectFile(databasePath);
  } catch {
    throw new AdminRecoveryError("找不到已有数据库，或数据路径不是普通文件。请核对 PERPAY_DATA_DIR；不会创建新实例。");
  }
  // Refuse a live instance before any password work or maintenance lock is held.
  const probe = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true, defensive: true, timeout: 5_000 });
  try { assertRecoverable(probe); } finally { probe.close(); }
  const passwordHash = await hashPassword(input.password);
  hardenProcessFileCreation();
  hardenExistingPrivateDirectory(directory);
  const lock = acquireDatabaseMaintenanceLock(databasePath, "admin-password-recovery", Date.now());
  let database: DatabaseSync | undefined;
  try {
    assertSameFile(databasePath, identity);
    hardenSqliteArtifacts(databasePath);
    database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readBigInts: true, defensive: true, timeout: 5_000 });
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    assertSameFile(databasePath, identity);
    assertRecoverable(database);
    const admin = new IdentityReadTransaction(database).adminIdentity()!;
    const sessionGeneration = admin.sessionGeneration + 1;
    if (!Number.isSafeInteger(sessionGeneration)) throw new AdminRecoveryError("会话版本超出有效范围，数据库未修改。");
    const now = Date.now();
    database.prepare(
      `UPDATE admin_identity SET password_hash = ?, session_generation = ?, password_changed_at = ?, updated_at = ?
        WHERE singleton_key = 1 AND username = ?`,
    ).run(passwordHash, sessionGeneration, now, now, ADMIN_USERNAME);
    const revoked = database.prepare(
      "UPDATE admin_sessions SET revoked_at = ?, revoke_reason = 'offline_password_recovery' WHERE revoked_at IS NULL",
    ).run(now);
    database.exec("DELETE FROM admin_auth_limits");
    // Invalidate an expired owner's token as well; it must not resume writing.
    database.exec("DELETE FROM app_lease");
    appendAuditEvent(database, {
      occurredAt: now, actorType: "SYSTEM", actorId: "offline-recovery",
      action: "admin.password_recover", outcome: "SUCCESS", subjectType: "administrator", subjectId: ADMIN_USERNAME,
      details: { session_generation: sessionGeneration, revoked_count: Number(revoked.changes) },
    });
    if (!inspectDatabaseIntegrity(database).ok) throw new AdminRecoveryError("恢复后的完整性检查失败，已回滚密码修改。");
    assertSameFile(databasePath, identity);
    database.exec("COMMIT");
    return { sessionGeneration, revokedSessions: Number(revoked.changes) };
  } finally {
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
      database?.close();
    } finally { lock.release(); }
  }
}

function assertRecoverable(database: DatabaseSync): void {
  const hasLease = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'app_lease'").get();
  if (!hasLease) throw new AdminRecoveryError("数据库不是可恢复的 PerPay 实例，未作修改。");
  const lease = database.prepare("SELECT expires_at FROM app_lease WHERE lease_key = 1").get() as { expires_at: bigint } | undefined;
  if (lease && Number(lease.expires_at) > Date.now()) throw new AdminRecoveryError("应用仍持有数据库租约。请先停止 app 和 backup；异常退出后等待 30 秒再试。");
  if (!inspectDatabaseIntegrity(database).ok) throw new AdminRecoveryError("数据库版本不匹配或完整性检查失败。请使用与实例一致的镜像版本，未作修改。");
  const admin = new IdentityReadTransaction(database).adminIdentity();
  if (!admin || admin.username !== ADMIN_USERNAME) throw new AdminRecoveryError("管理员尚未初始化，请从首次初始化页面设置密码。");
}

function inspectFile(file: string): BigIntStats {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size === 0n) throw new Error("not an ordinary database file");
  return stat;
}
function assertSameFile(file: string, expected: BigIntStats): void {
  const current = inspectFile(file);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new AdminRecoveryError("数据库文件在恢复期间发生变化，已停止操作。");
}
