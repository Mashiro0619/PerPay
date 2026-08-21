import { resolve } from "node:path";

import { z } from "zod";

import { pathsOverlap } from "../infrastructure/storage/path-separation.ts";

const rawBackupConfigSchema = z.object({
  PERPAY_DATA_DIR: z.string().trim().min(1).default("/data"),
  PERPAY_BACKUP_DIR: z.string().trim().min(1).default("/backups"),
  // Compatibility fallback for direct runner invocation; production Compose
  // leaves policy ownership to runtime_configuration.
  PERPAY_BACKUP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(7 * 24 * 60 * 60)
    .default(24 * 60 * 60),
  PERPAY_BACKUP_KEEP_COUNT: z.coerce.number().int().min(1).max(365).default(7),
});

export interface BackupConfig {
  readonly dataDirectory: string;
  readonly backupDirectory: string;
  readonly intervalMilliseconds: number;
  readonly keepCount: number;
}

export function loadBackupConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BackupConfig {
  const parsed = rawBackupConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`backup configuration validation failed: ${z.prettifyError(parsed.error)}`);
  }

  const dataDirectory = resolve(parsed.data.PERPAY_DATA_DIR);
  const backupDirectory = resolve(parsed.data.PERPAY_BACKUP_DIR);
  if (pathsOverlap(dataDirectory, backupDirectory)) {
    throw new Error(
      "backup configuration validation failed: data and backup directories must be separate",
    );
  }

  return Object.freeze({
    dataDirectory,
    backupDirectory,
    intervalMilliseconds: parsed.data.PERPAY_BACKUP_INTERVAL_SECONDS * 1_000,
    keepCount: parsed.data.PERPAY_BACKUP_KEEP_COUNT,
  });
}
