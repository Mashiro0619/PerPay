import { lstatSync, readFileSync } from "node:fs";
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
  /** A key supplied explicitly for restore-time guard verification. */
  readonly masterKey?: Buffer;
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

/** Loads the deployment key only for an explicitly requested restore. */
export function loadBackupRestoreMasterKey(
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  const configured = environment.PERPAY_MASTER_KEY?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!/^[0-9a-fA-F]{64}$/u.test(configured)) {
      throw new Error(
        "backup restore configuration validation failed: PERPAY_MASTER_KEY must contain 64 hexadecimal characters",
      );
    }
    return Buffer.from(configured, "hex");
  }
  const secretsDirectory = environment.PERPAY_SECRETS_DIR?.trim();
  if (secretsDirectory === undefined || secretsDirectory.length === 0) {
    throw new Error(
      "deployment master key is required to restore a backup; set PERPAY_MASTER_KEY or PERPAY_SECRETS_DIR/master-key",
    );
  }
  const path = resolve(secretsDirectory, "master-key");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new Error(
        "backup restore configuration validation failed: secrets/master-key is missing",
        { cause: error },
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      "backup restore configuration validation failed: secrets/master-key must be a private ordinary file",
    );
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(
      "backup restore configuration validation failed: secrets/master-key must contain 64 hexadecimal characters",
    );
  }
  return Buffer.from(value, "hex");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
