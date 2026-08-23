import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { pathsOverlap } from "../infrastructure/storage/path-separation.ts";

const rawBackupConfigSchema = z.object({
  PERPAY_DATA_DIR: z.string().trim().min(1).default("/data"),
  PERPAY_BACKUP_DIR: z.string().trim().min(1).default("/backups"),
  PERPAY_SECRETS_DIR: z.string().trim().min(1).optional(),
  // Only maintenance restores should provide this value.  The scheduled
  // backup runner does not need access to the deployment master key.
  PERPAY_MASTER_KEY: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/u).optional(),
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

  const masterKey = parsed.data.PERPAY_MASTER_KEY === undefined
    ? readMasterKey(parsed.data.PERPAY_SECRETS_DIR)
    : Buffer.from(parsed.data.PERPAY_MASTER_KEY, "hex");

  return Object.freeze({
    dataDirectory,
    backupDirectory,
    ...(masterKey === null ? {} : { masterKey }),
    intervalMilliseconds: parsed.data.PERPAY_BACKUP_INTERVAL_SECONDS * 1_000,
    keepCount: parsed.data.PERPAY_BACKUP_KEEP_COUNT,
  });
}

function readMasterKey(secretsDirectory: string | undefined): Buffer | null {
  if (secretsDirectory === undefined) return null;
  const path = resolve(secretsDirectory, "master-key");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("backup configuration validation failed: master-key must be a private ordinary file");
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error("backup configuration validation failed: master-key file must contain 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}
