import { lstatSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readAdminAccess } from "../settings/admin-access.ts";
import { inspectDatabaseIntegrity } from "../database/database.ts";
import {
  ADMIN_USERNAME,
  appendAuditEvent,
} from "../database/identity-store.ts";
import { acquireDatabaseMaintenanceLock } from "../database/maintenance-lock.ts";
import {
  hardenExistingPrivateDirectory,
  hardenProcessFileCreation,
  hardenSqliteArtifacts,
} from "../infrastructure/storage/permissions.ts";

import {
  AdminRecoveryError,
  assertRecoverable,
  inspectFile,
  assertSameFile,
} from "./recovery.ts";

/** Offline only. Does not open AppDatabase, migrate, initialize keys, or run jobs. */
export async function disableAdministratorAllowlist(input: {
  dataDirectory: string;
  confirmed: boolean;
}): Promise<void> {
  if (!input.confirmed)
    throw new AdminRecoveryError("未确认关闭白名单，数据库未修改。");
  const directory = resolve(input.dataDirectory);
  const databasePath = join(directory, "perpay.sqlite3");
  let identity: BigIntStats;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("not an ordinary directory");
    identity = inspectFile(databasePath);
  } catch {
    throw new AdminRecoveryError(
      "找不到已有数据库，或数据路径不是普通文件。请核对 PERPAY_DATA_DIR；不会创建新实例。",
    );
  }
  // Refuse a live instance before holding the maintenance lock.
  const probe = new DatabaseSync(databasePath, {
    readOnly: true,
    readBigInts: true,
    defensive: true,
    timeout: 5_000,
  });
  try {
    assertAllowlistRecoverable(probe);
  } finally {
    probe.close();
  }
  hardenProcessFileCreation();
  hardenExistingPrivateDirectory(directory);
  const lock = acquireDatabaseMaintenanceLock(
    databasePath,
    "admin-allowlist-recovery",
    Date.now(),
  );
  let database: DatabaseSync | undefined;
  try {
    assertSameFile(databasePath, identity);
    hardenSqliteArtifacts(databasePath);
    database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      readBigInts: true,
      defensive: true,
      timeout: 5_000,
    });
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    assertSameFile(databasePath, identity);
    assertAllowlistRecoverable(database);
    const now = Date.now();
    const row = database
      .prepare(
        "SELECT admin_access FROM runtime_configuration WHERE singleton_key = 1",
      )
      .get() as { admin_access: string };
    const access = JSON.parse(row.admin_access);
    database
      .prepare(
        "UPDATE runtime_configuration SET admin_access = ?, revision = revision + 1, updated_at = ? WHERE singleton_key = 1",
      )
      .run(JSON.stringify({ ...access, enabled: false }), now);
    appendAuditEvent(database, {
      occurredAt: now,
      actorType: "SYSTEM",
      actorId: "offline-recovery",
      action: "admin.allowlist_disabled",
      outcome: "SUCCESS",
      subjectType: "administrator",
      subjectId: ADMIN_USERNAME,
      details: { enabled: false },
    });
    if (!inspectDatabaseIntegrity(database).ok)
      throw new AdminRecoveryError(
        "恢复后的完整性检查失败，已回滚白名单修改。",
      );
    assertSameFile(databasePath, identity);
    database.exec("COMMIT");
  } finally {
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
      database?.close();
    } finally {
      lock.release();
    }
  }
}

function assertAllowlistRecoverable(database: DatabaseSync): void {
  assertRecoverable(database);
  try {
    readAdminAccess(database);
  } catch {
    throw new AdminRecoveryError(
      "白名单配置无效或数据库版本不支持白名单。请使用匹配实例的镜像版本，未作修改。",
    );
  }
}
