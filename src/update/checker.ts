import { APP_VERSION } from "../version.ts";
import { compareReleaseVersions, isPrereleaseVersion, parseReleaseVersion } from "../shared/release-version.ts";
export { compareReleaseVersions } from "../shared/release-version.ts";

const RELEASES_API = "https://api.github.com/repos/Mashiro0619/PerPay/releases";
const RELEASE_API = RELEASES_API + "/latest";
const RELEASE_PAGE = "https://github.com/Mashiro0619/PerPay/releases/tag/v";
const SUCCESS_CACHE_MILLISECONDS = 5 * 60_000;
const FAILURE_CACHE_MILLISECONDS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 5;

export interface OfficialUpdate {
  readonly status: "update_available" | "up_to_date" | "ahead";
  readonly current_version: string;
  readonly latest_version: string;
  readonly release_url: string;
  readonly published_at: string;
  readonly checked_at: string;
}

interface PublishedRelease {
  readonly version: string;
  readonly url: string;
  readonly publishedAt: string;
}

export class UpdateCheckUnavailable extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("暂时无法检查官方更新，请稍后重试。此检查不影响收款。");
    this.name = "UpdateCheckUnavailable";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function publishedRelease(raw: unknown, includePrereleases: boolean): PublishedRelease | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const release = raw as Record<string, unknown>;
  if (release.draft !== false || typeof release.prerelease !== "boolean" ||
      typeof release.tag_name !== "string" || !release.tag_name.startsWith("v") ||
      typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) return null;
  const version = release.tag_name.slice(1);
  const parsed = parseReleaseVersion(version);
  if (!parsed || release.prerelease !== (parsed.prerelease.length > 0) ||
      (!includePrereleases && release.prerelease)) return null;
  const url = RELEASE_PAGE + version;
  if (release.html_url !== url) return null;
  return { version, url, publishedAt: new Date(release.published_at).toISOString() };
}

/** Only public release metadata is fetched; never send instance data or credentials. */
export class OfficialUpdateChecker {
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #timeoutMilliseconds: number;
  readonly #currentVersion: string;
  #cache: { checkedAt: number; expiresAt: number; result: OfficialUpdate | null } | undefined;
  #pending: Promise<OfficialUpdate> | undefined;

  constructor(options: { fetch?: typeof fetch; clock?: () => number; timeoutMilliseconds?: number; currentVersion?: string } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
    this.#currentVersion = options.currentVersion ?? APP_VERSION;
  }

  async check(): Promise<OfficialUpdate> {
    const now = this.#clock();
    const cache = this.#cache;
    if (cache && now >= cache.checkedAt && now < cache.expiresAt) {
      if (cache.result) return cache.result;
      throw new UpdateCheckUnavailable(Math.max(1, Math.ceil((cache.expiresAt - now) / 1_000)));
    }
    if (this.#pending) return this.#pending;
    this.#pending = this.#load().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #request(url: string, signal: AbortSignal, allowMissing = false): Promise<Response | null> {
    const response = await this.#fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "PerPay-update-check",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel();
      throw new Error("Official release is unavailable");
    }
    return response;
  }

  async #latest(signal: AbortSignal, includePrereleases: boolean): Promise<PublishedRelease | null> {
    // Before the first stable release GitHub returns 404, but previews can still update.
    const stableResponse = await this.#request(RELEASE_API, signal, includePrereleases);
    let latest: PublishedRelease | null = null;
    if (stableResponse) {
      latest = publishedRelease(await readRelease(stableResponse, signal), false);
      if (!latest) throw new Error("Invalid official stable release metadata");
    }
    if (!includePrereleases) return latest;
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      // Never follow Link URLs supplied by the response. Every request stays on this repository.
      const response = await this.#request(RELEASES_API + "?per_page=" + RELEASE_PAGE_SIZE + "&page=" + page, signal);
      if (!response) throw new Error("Official release list is unavailable");
      const releases = await readRelease(response, signal, MAX_RELEASE_LIST_BYTES);
      if (!Array.isArray(releases) || releases.length > RELEASE_PAGE_SIZE) throw new Error("Invalid official release list");
      for (const raw of releases) {
        const release = publishedRelease(raw, true);
        // Drafts and noncanonical/mislabeled releases are never update candidates.
        if (release && (!latest || compareReleaseVersions(release.version, latest.version) > 0)) latest = release;
      }
      const hasNext = /;\s*rel="next"/i.test(response.headers.get("link") ?? "");
      if (releases.length < RELEASE_PAGE_SIZE && !hasNext) return latest;
    }
    // A truncated list cannot establish "latest", even if the current page has an update.
    throw new Error("Official release list exceeds the bounded lookup");
  }

  async #load(): Promise<OfficialUpdate> {
    try {
      if (!parseReleaseVersion(this.#currentVersion)) throw new Error("Invalid current version");
      const signal = AbortSignal.timeout(this.#timeoutMilliseconds);
      const release = await this.#latest(signal, isPrereleaseVersion(this.#currentVersion));
      if (!release) throw new Error("No official release is available");
      const comparison = compareReleaseVersions(this.#currentVersion, release.version);
      signal.throwIfAborted();
      const checkedAt = this.#clock();
      const result: OfficialUpdate = Object.freeze({
        status: comparison < 0 ? "update_available" : comparison === 0 ? "up_to_date" : "ahead",
        current_version: this.#currentVersion,
        latest_version: release.version,
        release_url: release.url,
        published_at: release.publishedAt,
        checked_at: new Date(checkedAt).toISOString(),
      });
      this.#cache = { checkedAt, expiresAt: checkedAt + SUCCESS_CACHE_MILLISECONDS, result };
      return result;
    } catch {
      const checkedAt = this.#clock();
      // A failed refresh replaces old success; callers must never infer "up to date" from it.
      this.#cache = { checkedAt, expiresAt: checkedAt + FAILURE_CACHE_MILLISECONDS, result: null };
      throw new UpdateCheckUnavailable(FAILURE_CACHE_MILLISECONDS / 1_000);
    }
  }
}

async function readRelease(response: Response, signal: AbortSignal, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
    await response.body?.cancel();
    throw new Error("Official release response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty official release response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Official release response is too large");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
