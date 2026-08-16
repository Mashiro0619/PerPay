import { performance } from "node:perf_hooks";
import { isIP } from "node:net";

export interface PublicCheckoutRateLimiterOptions {
  readonly sourceBurst: number;
  readonly sourceRequestsPerSecond: number;
  readonly globalBurst: number;
  readonly globalRequestsPerSecond: number;
  readonly maximumTrackedSources: number;
  readonly sourceIdleTtlMilliseconds: number;
  readonly cleanupIntervalMilliseconds: number;
}

export const defaultPublicCheckoutRateLimiterOptions = Object.freeze({
  sourceBurst: 120,
  sourceRequestsPerSecond: 20,
  globalBurst: 1_200,
  globalRequestsPerSecond: 200,
  maximumTrackedSources: 4_096,
  sourceIdleTtlMilliseconds: 10 * 60_000,
  cleanupIntervalMilliseconds: 60_000,
}) satisfies PublicCheckoutRateLimiterOptions;

interface SourceBucket {
  readonly budget: FixedTokenBucket;
  lastSeenAt: number;
}

export class PublicCheckoutRateLimiter {
  readonly #options: PublicCheckoutRateLimiterOptions;
  readonly #globalBudget: FixedTokenBucket;
  readonly #sourceBuckets = new Map<string, SourceBucket>();
  #lastCleanupAt: number | undefined;

  constructor(options: Partial<PublicCheckoutRateLimiterOptions> = {}) {
    this.#options = Object.freeze({
      ...defaultPublicCheckoutRateLimiterOptions,
      ...options,
    });
    validateOptions(this.#options);
    this.#globalBudget = new FixedTokenBucket(
      this.#options.globalBurst,
      this.#options.globalRequestsPerSecond,
    );
  }

  get trackedSourceCount(): number {
    return this.#sourceBuckets.size;
  }

  take(sourceAddress: string, now = performance.now()): boolean {
    if (!Number.isFinite(now) || now < 0) {
      throw new TypeError("rate-limit time must be a non-negative finite number");
    }
    this.#cleanupExpiredSources(now);

    const sourceKey = aggregateSourceAddress(sourceAddress);
    let source = this.#sourceBuckets.get(sourceKey);
    if (source) {
      source.lastSeenAt = now;
    } else {
      if (this.#sourceBuckets.size >= this.#options.maximumTrackedSources) {
        this.#evictLeastRecentlySeenSource();
      }
      source = {
        budget: new FixedTokenBucket(
          this.#options.sourceBurst,
          this.#options.sourceRequestsPerSecond,
        ),
        lastSeenAt: now,
      };
      this.#sourceBuckets.set(sourceKey, source);
    }

    if (!source.budget.take(now)) return false;
    return this.#globalBudget.take(now);
  }

  #evictLeastRecentlySeenSource(): void {
    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [sourceKey, source] of this.#sourceBuckets) {
      if (source.lastSeenAt < oldestSeenAt) {
        oldestKey = sourceKey;
        oldestSeenAt = source.lastSeenAt;
      }
    }
    if (oldestKey === undefined) {
      throw new Error("tracked source capacity is inconsistent");
    }
    this.#sourceBuckets.delete(oldestKey);
  }

  #cleanupExpiredSources(now: number): void {
    const previousCleanupAt = this.#lastCleanupAt;
    if (
      previousCleanupAt !== undefined &&
      now >= previousCleanupAt &&
      now - previousCleanupAt < this.#options.cleanupIntervalMilliseconds
    ) {
      return;
    }
    this.#lastCleanupAt = now;
    for (const [sourceAddress, source] of this.#sourceBuckets) {
      if (
        now >= source.lastSeenAt &&
        now - source.lastSeenAt >= this.#options.sourceIdleTtlMilliseconds
      ) {
        this.#sourceBuckets.delete(sourceAddress);
      }
    }
  }
}

function aggregateSourceAddress(sourceAddress: string): string {
  if (isIP(sourceAddress) !== 6) return sourceAddress;
  const groups = parseIpv6Groups(sourceAddress);
  if (groups === undefined) return sourceAddress;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return [
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff,
    ].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

function parseIpv6Groups(address: string): readonly number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? "");
  const right = parseIpv6Half(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIpv6Half(value: string): readonly number[] | undefined {
  if (value === "") return [];
  const groups: number[] = [];
  for (const part of value.split(":")) {
    if (part.includes(".")) {
      const octets = part.split(".").map(Number);
      if (
        octets.length !== 4 ||
        octets.some((octet) => !Number.isSafeInteger(octet) || octet < 0 || octet > 255)
      ) {
        return undefined;
      }
      groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

class FixedTokenBucket {
  readonly #capacity: number;
  readonly #refillPerMillisecond: number;
  #tokens: number;
  #lastRefillAt: number | undefined;

  constructor(capacity: number, refillPerSecond: number) {
    this.#capacity = capacity;
    this.#tokens = capacity;
    this.#refillPerMillisecond = refillPerSecond / 1000;
  }

  take(now: number): boolean {
    const previousRefillAt = this.#lastRefillAt;
    if (previousRefillAt === undefined) {
      this.#lastRefillAt = now;
    } else {
      const elapsed = Math.max(0, now - previousRefillAt);
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + elapsed * this.#refillPerMillisecond,
      );
      this.#lastRefillAt = now;
    }
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

function validateOptions(options: PublicCheckoutRateLimiterOptions): void {
  for (const [name, value] of [
    ["sourceBurst", options.sourceBurst],
    ["globalBurst", options.globalBurst],
    ["maximumTrackedSources", options.maximumTrackedSources],
    ["sourceIdleTtlMilliseconds", options.sourceIdleTtlMilliseconds],
    ["cleanupIntervalMilliseconds", options.cleanupIntervalMilliseconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  for (const [name, value] of [
    ["sourceRequestsPerSecond", options.sourceRequestsPerSecond],
    ["globalRequestsPerSecond", options.globalRequestsPerSecond],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
  if (options.cleanupIntervalMilliseconds > options.sourceIdleTtlMilliseconds) {
    throw new TypeError("cleanupIntervalMilliseconds cannot exceed sourceIdleTtlMilliseconds");
  }
}
