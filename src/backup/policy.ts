import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_BACKUP_INTERVAL_SECONDS,
  DEFAULT_BACKUP_KEEP_COUNT,
} from "../settings/model.ts";

export interface BackupPolicy {
  readonly intervalMilliseconds: number;
  readonly keepCount: number;
}

/** Reads the administrator-controlled policy without taking the application lease. */
export function readBackupPolicy(dataDirectory: string): BackupPolicy {
  const databasePath = resolve(dataDirectory, "perpay.sqlite3");
  if (!existsSync(databasePath)) return defaults();
  const connection = new DatabaseSync(databasePath, {
    readOnly: true,
    readBigInts: true,
    timeout: 5_000,
  });
  try {
    const row = connection.prepare(
      `SELECT backup_interval_seconds, backup_keep_count
         FROM runtime_configuration WHERE singleton_key = 1`,
    ).get() as {
      readonly backup_interval_seconds: bigint | number;
      readonly backup_keep_count: bigint | number;
    } | undefined;
    if (!row) return defaults();
    const intervalSeconds = Number(row.backup_interval_seconds);
    const keepCount = Number(row.backup_keep_count);
    if (
      !Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds < 3_600 ||
      intervalSeconds > 604_800 ||
      !Number.isSafeInteger(keepCount) ||
      keepCount < 1 ||
      keepCount > 365
    ) {
      throw new Error("backup policy in runtime configuration is invalid");
    }
    return Object.freeze({
      intervalMilliseconds: intervalSeconds * 1_000,
      keepCount,
    });
  } finally {
    connection.close();
  }
}

function defaults(): BackupPolicy {
  return Object.freeze({
    intervalMilliseconds: DEFAULT_BACKUP_INTERVAL_SECONDS * 1_000,
    keepCount: DEFAULT_BACKUP_KEEP_COUNT,
  });
}
