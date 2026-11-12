import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  inspectBackupHealth,
  type BackupHealth,
} from "./runner.ts";
import { readBackupPolicy } from "./policy.ts";

/** Status metadata is refreshed independently of the full content check. */
export const DEFAULT_BACKUP_HEALTH_CACHE_TTL_MILLISECONDS = 5_000;
export const BACKUP_CONTENT_VERIFICATION_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;

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
  /** Check content on startup and then hourly, independently of HTTP requests. */
  readonly start: (onError: (error: unknown) => void) => void;
  readonly stop: () => Promise<void>;
};

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
  readonly changedAtNanoseconds: bigint;
}

interface CachedHealth {
  readonly value: BackupHealth;
  readonly observedAt: number;
  readonly expiresAt: number;
}

interface ContentVerification {
  readonly path: string;
  readonly expectedSha256: string;
  readonly identity: FileIdentity;
  readonly checkedAt: number;
  readonly valid: boolean;
}

interface InspectedHealth {
  readonly health: BackupHealth;
  readonly verification: ContentVerification | null;
}

interface ContentCheck {
  readonly path: string;
  readonly expectedSha256: string;
  readonly identity: FileIdentity;
  readonly promise: Promise<ContentVerification | null>;
}

type VerifyContent = (path: string, expectedSha256: string, before: FileIdentity) => Promise<ContentVerification | null>;

/**
 * Creates the provider used by the HTTP status endpoint.
 *
 * Unchanged files reuse their content check for one hour. New files and
 * changed file identities are checked on the next metadata refresh.
 * Concurrent callers share one probe.
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
  let verification: ContentVerification | null = null;
  let inFlight: Promise<BackupHealth> | null = null;
  let contentCheck: ContentCheck | null = null;
  let periodicCheck: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let generation = 0;

  const verifyContent: VerifyContent = (path, expectedSha256, before) => {
    if (contentCheck !== null && contentCheck.path === path &&
      contentCheck.expectedSha256 === expectedSha256 && sameIdentity(contentCheck.identity, before)) {
      return contentCheck.promise;
    }
    const promise = hashBackupContent(path, expectedSha256, before, clock).finally(() => {
      if (contentCheck?.promise === promise) contentCheck = null;
    });
    contentCheck = { path, expectedSha256, identity: before, promise };
    return promise;
  };

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
      .then(async () => {
        const inspected = await inspectAndVerify(config, now, verification, verifyContent, running);
        if (generation === probeGeneration) verification = inspected.verification;
        return inspected.health;
      })
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
      verification = null;
      inFlight = null;
    },
    writable: false,
  });
  Object.defineProperty(provider, "start", {
    value: (onError: (error: unknown) => void) => {
      if (running) return;
      running = true;
      const check = () => {
        timer = null;
        const probeGeneration = generation;
        periodicCheck = Promise.resolve()
          .then(() => inspectAndVerify(config, clock(), null, verifyContent, false))
          .then((inspected) => {
            if (generation !== probeGeneration) return;
            generation += 1;
            verification = inspected.verification;
            cached = null;
            inFlight = null;
          })
          .catch((error: unknown) => {
            if (generation === probeGeneration) {
              generation += 1;
              verification = null;
              cached = null;
              inFlight = null;
            }
            onError(error);
          })
          .finally(() => {
            periodicCheck = null;
            if (running) {
              timer = setTimeout(check, BACKUP_CONTENT_VERIFICATION_INTERVAL_MILLISECONDS);
              timer.unref();
            }
          });
      };
      check();
    },
  });
  Object.defineProperty(provider, "stop", {
    value: async () => {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await periodicCheck;
    },
  });
  return provider;
}

async function inspectAndVerify(
  config: AsyncBackupHealthConfig,
  now: number,
  previousVerification: ContentVerification | null,
  verifyContent: VerifyContent,
  reuseUntilScheduledCheck: boolean,
): Promise<InspectedHealth> {
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
    return { health: metadata, verification: null };
  }

  const path = safeBackupPath(config.backupDirectory, metadata.backup_name);
  if (path === null) return { health: markUnavailable(metadata), verification: null };
  const verification = await verifyBackupDigest(
    path,
    metadata.backup_size_bytes,
    metadata.backup_sha256,
    previousVerification,
    now,
    verifyContent,
    reuseUntilScheduledCheck,
  );
  return {
    health: verification?.valid
      ? { ...metadata, content_verified_at: verification.checkedAt }
      : markUnavailable(metadata),
    verification,
  };
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
  previous: ContentVerification | null,
  now: number,
  verifyContent: VerifyContent,
  reuseUntilScheduledCheck: boolean,
): Promise<ContentVerification | null> {
  try {
    const before = await inspectFile(path);
    if (before.size !== BigInt(expectedSize)) return null;
    if (previous !== null && previous.path === path && previous.expectedSha256 === expectedSha256 &&
      sameIdentity(previous.identity, before) && now >= previous.checkedAt &&
      (reuseUntilScheduledCheck || now - previous.checkedAt < BACKUP_CONTENT_VERIFICATION_INTERVAL_MILLISECONDS)) {
      return previous;
    }
    return await verifyContent(path, expectedSha256, before);
  } catch {
    return null;
  }
}

async function hashBackupContent(
  path: string,
  expectedSha256: string,
  before: FileIdentity,
  clock: () => number,
): Promise<ContentVerification | null> {
  try {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: STREAM_HIGH_WATER_MARK_BYTES });
    for await (const chunk of stream) hash.update(chunk);
    const digest = hash.digest("hex");
    const after = await inspectFile(path);
    if (!sameIdentity(before, after)) return null;
    return { path, expectedSha256, identity: after, checkedAt: clock(), valid: digest === expectedSha256 };
  } catch {
    return null;
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
    changedAtNanoseconds: stat.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.changedAtNanoseconds === right.changedAtNanoseconds;
}

function markUnavailable(health: BackupHealth): BackupHealth {
  return Object.freeze({
    ...health,
    ok: false,
    status: "unhealthy" as const,
    backup_available: false,
    content_verified_at: null,
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
    content_verified_at: null,
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
