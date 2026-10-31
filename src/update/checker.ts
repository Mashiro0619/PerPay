import { APP_VERSION } from "../version.ts";
import { compareReleaseVersions, parseReleaseVersion } from "../shared/release-version.ts";
export { compareReleaseVersions } from "../shared/release-version.ts";

const RELEASES_API = "https://api.github.com/repos/Mashiro0619/PerPay/releases";
const RELEASE_API = RELEASES_API + "/latest";
const RELEASE_PAGE = "https://github.com/Mashiro0619/PerPay/releases/tag/v";
const SUCCESS_CACHE_MILLISECONDS = 5 * 60_000;
const MANUAL_REFRESH_MILLISECONDS = 60_000;
const FAILURE_CACHE_MILLISECONDS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 5;

export type OfficialUpdateChannel = "stable" | "prerelease";

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

type UpdateFailureReason = "unavailable" | "rate_limited" | "timeout" | "network" | "invalid_response";

const failureMessages: Record<UpdateFailureReason, string> = {
  unavailable: "暂时无法检查官方更新，请稍后重试。此检查不影响收款。",
  rate_limited: "官方更新源暂时限制了请求频率，请等待后重试。此检查不影响收款。",
  timeout: "连接官方更新源超时，请稍后重试。此检查不影响收款。",
  network: "暂时无法连接官方更新源，请稍后重试。此检查不影响收款。",
  invalid_response: "官方版本信息暂时无法验证，请稍后重试。此检查不影响收款。",
};

export class UpdateCheckUnavailable extends Error {
  readonly retryAfterSeconds: number;
  readonly reason: UpdateFailureReason;

  constructor(retryAfterSeconds: number, reason: UpdateFailureReason = "unavailable") {
    super(failureMessages[reason]);
    this.name = "UpdateCheckUnavailable";
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}

export class UpdateCheckRateLimited extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("刚刚已检查过官方更新，请等待后再检查。");
    this.name = "UpdateCheckRateLimited";
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
  readonly #cache = new Map<OfficialUpdateChannel, {
    checkedAt: number; expiresAt: number; result: OfficialUpdate | null; failureReason?: UpdateFailureReason;
  }>();
  readonly #pending = new Map<OfficialUpdateChannel, Promise<OfficialUpdate>>();
  #githubRetryAt = 0;

  constructor(options: { fetch?: typeof fetch; clock?: () => number; timeoutMilliseconds?: number; currentVersion?: string } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
    this.#currentVersion = options.currentVersion ?? APP_VERSION;
  }

  async check(channel: OfficialUpdateChannel = "prerelease", options: { refresh?: boolean } = {}): Promise<OfficialUpdate> {
    if (channel !== "stable" && channel !== "prerelease") throw new RangeError("Invalid update channel");
    if (options.refresh !== undefined && typeof options.refresh !== "boolean") throw new RangeError("Invalid update refresh option");
    // A manual request can share a real check, but must never report cached data as a fresh check.
    const pending = this.#pending.get(channel);
    if (pending) return pending;
    const now = this.#clock();
    const cache = this.#cache.get(channel);
    const cached = cache && now >= cache.checkedAt && now < cache.expiresAt;
    if (!options.refresh && cached && cache.result) return cache.result;
    this.#requireGitHubAvailable(now);
    if (cached && !cache.result) {
      throw new UpdateCheckUnavailable(Math.max(1, Math.ceil((cache.expiresAt - now) / 1_000)), cache.failureReason);
    }
    if (options.refresh && cache?.result && now >= cache.checkedAt && now < cache.checkedAt + MANUAL_REFRESH_MILLISECONDS) {
      throw new UpdateCheckRateLimited(Math.ceil((cache.checkedAt + MANUAL_REFRESH_MILLISECONDS - now) / 1_000));
    }
    const request = this.#load(channel).finally(() => { this.#pending.delete(channel); });
    this.#pending.set(channel, request);
    return request;
  }

  refreshAfterSeconds(channel: OfficialUpdateChannel = "prerelease"): number {
    if (channel !== "stable" && channel !== "prerelease") throw new RangeError("Invalid update channel");
    const now = this.#clock();
    const cache = this.#cache.get(channel);
    const channelRetryAt = cache && now >= cache.checkedAt
      ? cache.result ? cache.checkedAt + MANUAL_REFRESH_MILLISECONDS : cache.expiresAt
      : 0;
    return Math.max(0, Math.ceil((Math.max(channelRetryAt, this.#githubRetryAt) - now) / 1_000));
  }

  #requireGitHubAvailable(now = this.#clock()): void {
    if (now < this.#githubRetryAt) {
      throw new UpdateCheckUnavailable(Math.ceil((this.#githubRetryAt - now) / 1_000), "rate_limited");
    }
  }

  async #request(url: string, signal: AbortSignal, allowMissing = false): Promise<Response | null> {
    this.#requireGitHubAvailable();
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.#fetch(url, {
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
    } catch {
      throw new UpdateCheckUnavailable(FAILURE_CACHE_MILLISECONDS / 1_000, signal.aborted ? "timeout" : "network");
    }
    const now = this.#clock();
    const retryAt = retryAfterDeadline(response.headers.get("retry-after"), now);
    const exhausted = response.headers.get("x-ratelimit-remaining")?.trim() === "0";
    const resetAt = exhausted ? rateLimitResetDeadline(response.headers.get("x-ratelimit-reset"), now) : null;
    const rateLimited = response.status === 429 || (response.status === 403 && (exhausted || retryAt !== null));
    if (rateLimited || (exhausted && resetAt !== null)) {
      this.#githubRetryAt = Math.max(this.#githubRetryAt, now + FAILURE_CACHE_MILLISECONDS, retryAt ?? 0, resetAt ?? 0);
    }
    if (rateLimited) {
      await response.body?.cancel();
      throw new UpdateCheckUnavailable(Math.ceil((this.#githubRetryAt - now) / 1_000), "rate_limited");
    }
    if (allowMissing && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new UpdateCheckUnavailable(Math.ceil((Math.max(now + FAILURE_CACHE_MILLISECONDS, retryAt ?? 0) - now) / 1_000));
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      await response.body?.cancel();
      throw new UpdateCheckUnavailable(FAILURE_CACHE_MILLISECONDS / 1_000, "invalid_response");
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

  async #load(channel: OfficialUpdateChannel): Promise<OfficialUpdate> {
    let signal: AbortSignal | undefined;
    try {
      if (!parseReleaseVersion(this.#currentVersion)) throw new Error("Invalid current version");
      signal = AbortSignal.timeout(this.#timeoutMilliseconds);
      const release = await this.#latest(signal, channel === "prerelease");
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
      this.#cache.set(channel, { checkedAt, expiresAt: checkedAt + SUCCESS_CACHE_MILLISECONDS, result });
      return result;
    } catch (error) {
      const checkedAt = this.#clock();
      const reason = signal?.aborted ? "timeout" : error instanceof UpdateCheckUnavailable ? error.reason : "invalid_response";
      const retryAfter = error instanceof UpdateCheckUnavailable ? error.retryAfterSeconds * 1_000 : FAILURE_CACHE_MILLISECONDS;
      const expiresAt = Math.max(checkedAt + FAILURE_CACHE_MILLISECONDS, checkedAt + retryAfter, this.#githubRetryAt);
      // A failed refresh replaces old success; callers must never infer "up to date" from it.
      this.#cache.set(channel, { checkedAt, expiresAt, result: null, failureReason: reason });
      throw new UpdateCheckUnavailable(Math.max(1, Math.ceil((expiresAt - checkedAt) / 1_000)), reason);
    }
  }
}

const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const time = "[0-2][0-9]:[0-5][0-9]:[0-5][0-9]";
const httpDatePattern = new RegExp("^(?:" +
  day + ", [0-3][0-9] " + month + " [0-9]{4} " + time + " GMT|" +
  "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-3][0-9]-" + month + "-[0-9]{2} " + time + " GMT|" +
  day + " " + month + " (?: [1-9]|[0-3][0-9]) " + time + " [0-9]{4})$");

function retryAfterDeadline(value: string | null, now: number): number | null {
  if (value === null) return null;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const milliseconds = Number(raw) * 1_000;
    return Number.isSafeInteger(milliseconds) && Number.isSafeInteger(now + milliseconds) ? now + milliseconds : null;
  }
  if (!httpDatePattern.test(raw)) return null;
  const deadline = Date.parse(raw.endsWith(" GMT") ? raw : raw + " GMT");
  return Number.isFinite(deadline) ? Math.max(now, deadline) : null;
}

function rateLimitResetDeadline(value: string | null, now: number): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const deadline = Number(value.trim()) * 1_000;
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : null;
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
