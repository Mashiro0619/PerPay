import { performance } from "node:perf_hooks";

/** One bounded snapshot for public probes only; never use for financial admission. */
export class HealthProbeCache<T> {
  #entry: { key: string; at: number; value: T } | null = null;

  read(key: string, load: () => T): T {
    const now = performance.now();
    const entry = this.#entry;
    if (entry && entry.key === key && now >= entry.at && now - entry.at < 1_000) {
      return entry.value;
    }
    // Clear first: a failed refresh must never resurrect a previous success.
    this.#entry = null;
    const value = load();
    this.#entry = { key, at: now, value };
    return value;
  }

  replace(key: string, value: T): void {
    this.#entry = { key, at: performance.now(), value };
  }

  clear(): void { this.#entry = null; }
}
