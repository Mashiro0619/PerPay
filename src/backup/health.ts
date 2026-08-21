import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  inspectBackupHealth,
  type BackupHealth,
} from "./runner.ts";
import { readBackupPolicy } from "./policy.ts";

/**
 * Health probing intentionally has a short, fixed cache. The persisted backup
 * state is authoritative, while the digest check is allowed to run off the
 * HTTP request's synchronous path.
 */
export const DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS = 5_000;

const MAX_CACHE_TTL_MILLISECONDS = 60_000;
const STREAM_HIGH_WATER_MARK_BYTES = 256 * 1_024;

export interface AsyncBackupHealthConfig {
  readonly backupDirectory: string;
  readonly dataDirectory?: string | undefined;
  readonly intervalMilliseconds: number;
  readonly keepCount?: number | undefined;
}

export interface AsyncBackupHealthProviderOptions {
  /** Cache duration. The production default is five seconds. */
  readonly cacheTtlMilliseconds?: number | undefined;
  /** Injectable clock for deterministic tests and callers with a shared clock. */
  readonly clock?: (() => number) | undefined;
}

export type AsyncBackupHealthProvider = (() => Promise<BackupHealth>) & {
  /** Discard a cached snapshot and force the next call to inspect immediately. */
  readonly invalidate: () => void;
};

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
}

interface CachedHealth {
  readonly value: BackupHealth;
  readonly observedAt: number;
  readonly expiresAt: number;
}

/**
 * Creates the provider used by the HTTP status endpoint.
 *
 * The metadata probe is intentionally delegated to the runner's existing
 * bounded state/identity check. Only the content digest is expensive; it is
 * streamed asynchronously and never read synchronously on the request path.
 * Calls made while a probe is running share the exact same Promise.
 */
export function createAsyncBackupHealthProvider(
  config: AsyncBackupHealthConfig,
  options: AsyncBackupHealthProviderOptions = {},
): AsyncBackupHealthProvider {
  const cacheTtlMilliseconds = validateCacheTtl(
    options.cacheTtlMilliseconds ?? DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS,
  );
  const clock = options.clock ?? Date.now;
  let cached: CachedHealth | null = null;
  let inFlight: Promise<BackupHealth> | null = null;
  let generation = 0;

  const provider = (() => {
    if (inFlight !== null) return inFlight;
    let now: number;
    try {
      now = clock();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      return Promise.reject(new RangeError("backup health clock is invalid"));
    }
    if (cached !== null && now >= cached.observedAt && now < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    const probeGeneration = generation;
    const fallback = cached;

    // Starting from a microtask means a caller never performs even the small
    // metadata read while constructing the HTTP response synchronously.
    const pending = Promise.resolve()
      .then(() => inspectAndVerify(config, now))
      .catch((error: unknown) => {
        if (fallback === null) throw error;
        return degradedSnapshot(fallback.value, now);
      })
      .then((value) => {
        if (generation === probeGeneration) {
          cached = {
            value,
            observedAt: now,
            expiresAt: cacheExpiry(value, now, cacheTtlMilliseconds),
          };
        }
        return value;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  }) as AsyncBackupHealthProvider;

  Object.defineProperty(provider, "invalidate", {
    configurable: false,
    enumerable: false,
    value: () => {
      generation += 1;
      cached = null;
      inFlight = null;
    },
    writable: false,
  });
  return provider;
}

async function inspectAndVerify(
  config: AsyncBackupHealthConfig,
  now: number,
): Promise<BackupHealth> {
  const policy = config.dataDirectory === undefined ? null : readBackupPolicy(config.dataDirectory);
  const metadata = inspectBackupHealth({
    ...config,
    ...(policy ?? {}),
  }, now);
  if (
    !metadata.backup_available ||
    metadata.backup_name === null ||
    metadata.backup_sha256 === null ||
    metadata.backup_size_bytes === null
  ) {
    return metadata;
  }

  const path = safeBackupPath(config.backupDirectory, metadata.backup_name);
  if (path === null) return markUnavailable(metadata);
  const verified = await verifyBackupDigest(
    path,
    metadata.backup_size_bytes,
    metadata.backup_sha256,
  );
  return verified ? metadata : markUnavailable(metadata);
}

function safeBackupPath(directoryInput: string, name: string): string | null {
  const directory = resolve(directoryInput);
  const path = resolve(directory, name);
  return basename(name) === name && dirname(path) === directory ? path : null;
}

async function verifyBackupDigest(
  path: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<boolean> {
  let before: FileIdentity;
  try {
    before = await inspectFile(path);
    if (before.size !== BigInt(expectedSize)) return false;
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: STREAM_HIGH_WATER_MARK_BYTES });
    for await (const chunk of stream) hash.update(chunk);
    const digest = hash.digest("hex");
    const after = await inspectFile(path);
    return sameIdentity(before, after) && digest === expectedSha256;
  } catch {
    return false;
  }
}

async function inspectFile(path: string): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size < 1n ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    throw new Error("backup must be a private ordinary file with one link");
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNanoseconds: stat.mtimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds;
}

function markUnavailable(health: BackupHealth): BackupHealth {
  return Object.freeze({
    ...health,
    ok: false,
    status: "unhealthy" as const,
    backup_available: false,
  });
}

function degradedSnapshot(health: BackupHealth, now: number): BackupHealth {
  return Object.freeze({
    ...health,
    ok: false,
    status: "unhealthy" as const,
    last_error_at: now,
    last_error_stage: "state" as const,
    backup_available: false,
  });
}

function cacheExpiry(health: BackupHealth, observedAt: number, ttl: number): number {
  let expiresAt = observedAt + ttl;
  if (!Number.isSafeInteger(expiresAt)) expiresAt = Number.MAX_SAFE_INTEGER;
  if (
    health.ok &&
    health.last_success_at !== null &&
    health.maximum_age_milliseconds !== null
  ) {
    const freshnessExpiry = health.last_success_at + health.maximum_age_milliseconds + 1;
    if (Number.isSafeInteger(freshnessExpiry)) expiresAt = Math.min(expiresAt, freshnessExpiry);
  }
  return Math.max(observedAt, expiresAt);
}

function validateCacheTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CACHE_TTL_MILLISECONDS
  ) {
    throw new RangeError(
      `backup health cache TTL must be an integer from 0 to ${MAX_CACHE_TTL_MILLISECONDS} milliseconds`,
    );
  }
  return value;
}
