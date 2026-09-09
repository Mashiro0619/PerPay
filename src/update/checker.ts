import { APP_VERSION } from "../version.ts";

const RELEASE_API = "https://api.github.com/repos/Mashiro0619/PerPay/releases/latest";
const RELEASE_PAGE = "https://github.com/Mashiro0619/PerPay/releases/tag/v";
const SUCCESS_CACHE_MILLISECONDS = 5 * 60_000;
const FAILURE_CACHE_MILLISECONDS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface OfficialUpdate {
  readonly status: "update_available" | "up_to_date" | "ahead";
  readonly current_version: string;
  readonly latest_version: string;
  readonly release_url: string;
  readonly published_at: string;
  readonly checked_at: string;
}

export class UpdateCheckUnavailable extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("暂时无法检查官方更新，请稍后重试。此检查不影响收款。");
    this.name = "UpdateCheckUnavailable";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string) => {
    if (value.length > 64 || value.trim() !== value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
      throw new Error("Invalid stable release version");
    }
    return value.split(".").map(BigInt);
  };
  const first = parse(left), second = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (first[index]! < second[index]!) return -1;
    if (first[index]! > second[index]!) return 1;
  }
  return 0;
}

/** Only public release metadata is fetched; never send instance data or credentials. */
export class OfficialUpdateChecker {
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #timeoutMilliseconds: number;
  #cache: { checkedAt: number; expiresAt: number; result: OfficialUpdate | null } | undefined;
  #pending: Promise<OfficialUpdate> | undefined;

  constructor(options: { fetch?: typeof fetch; clock?: () => number; timeoutMilliseconds?: number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
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

  async #load(): Promise<OfficialUpdate> {
    try {
      const signal = AbortSignal.timeout(this.#timeoutMilliseconds);
      const response = await this.#fetch(RELEASE_API, {
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
      if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        await response.body?.cancel();
        throw new Error("Official release is unavailable");
      }
      const raw = await readRelease(response, signal);
      const release = raw as Record<string, unknown> | null;
      if (!release || typeof release !== "object" || release.draft !== false || release.prerelease !== false ||
          typeof release.tag_name !== "string" || !release.tag_name.startsWith("v") ||
          typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) {
        throw new Error("Invalid official release metadata");
      }
      const version = release.tag_name.slice(1);
      const comparison = compareReleaseVersions(APP_VERSION, version);
      const releaseUrl = RELEASE_PAGE + version;
      if (release.html_url !== releaseUrl) throw new Error("Unexpected official release URL");
      signal.throwIfAborted();
      const checkedAt = this.#clock();
      const result: OfficialUpdate = Object.freeze({
        status: comparison < 0 ? "update_available" : comparison === 0 ? "up_to_date" : "ahead",
        current_version: APP_VERSION,
        latest_version: version,
        release_url: releaseUrl,
        published_at: new Date(release.published_at).toISOString(),
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

async function readRelease(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
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
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Official release response is too large");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
