import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { compareReleaseVersions, OfficialUpdateChecker, UpdateCheckUnavailable } from "../src/update/checker.ts";
import { APP_VERSION } from "../src/version.ts";

const parts = APP_VERSION.split(".");
const nextVersion = [parts[0], parts[1], String(BigInt(parts[2]!) + 1n)].join(".");
const now = Date.UTC(2026, 8, 10);
function release(version = nextVersion, overrides: Record<string, unknown> = {}) {
  return { tag_name: "v" + version, html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + version,
    draft: false, prerelease: false, published_at: "2026-09-09T12:00:00Z", ...overrides };
}

describe("official update checks", () => {
  it("compares canonical numeric versions without lexical or numeric-precision errors", () => {
    assert.equal(compareReleaseVersions("0.2.9", "0.2.10"), -1);
    assert.equal(compareReleaseVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareReleaseVersions("0.2.0", "0.2.0"), 0);
    assert.equal(compareReleaseVersions("0.2.9007199254740992", "0.2.9007199254740993"), -1);
    for (const invalid of ["v0.2.0", "0.2", "00.2.0", "0.2.0-beta.1", "0.2.0+build", "0.2.0\n", "1".repeat(70) + ".0.0"]) {
      assert.throws(() => compareReleaseVersions(invalid, APP_VERSION));
      assert.throws(() => compareReleaseVersions(APP_VERSION, invalid));
    }
  });

  it("only requests the official HTTPS endpoint without credentials or instance data", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ clock: () => now, fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.github.com/repos/Mashiro0619/PerPay/releases/latest");
      assert.equal(options?.method, "GET");
      assert.equal(options?.body, undefined);
      assert.equal(options?.redirect, "error");
      assert.equal(options?.credentials, "omit");
      assert.ok(options?.signal instanceof AbortSignal);
      assert.deepEqual(options?.headers, { accept: "application/vnd.github+json", "user-agent": "PerPay-update-check", "x-github-api-version": "2022-11-28" });
      return Response.json(release(nextVersion, { body: "untrusted release HTML must not be returned", assets: [{ browser_download_url: "https://evil.invalid" }] }));
    } });
    assert.equal(calls, 0);
    const result = await checker.check();
    assert.deepEqual(result, { status: "update_available", current_version: APP_VERSION, latest_version: nextVersion,
      release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + nextVersion,
      published_at: "2026-09-09T12:00:00.000Z", checked_at: new Date(now).toISOString() });
    assert.equal(calls, 1);
    assert.equal(Object.isFrozen(result), true);
  });

  it("distinguishes the current stable release from a newer local build", async () => {
    for (const [version, status] of [[APP_VERSION, "up_to_date"], ["0.0.0", "ahead"]]) {
      const checker = new OfficialUpdateChecker({ fetch: async () => Response.json(release(version)) });
      assert.equal((await checker.check()).status, status);
    }
  });

  it("coalesces concurrent checks and reuses the true check time for five minutes", async () => {
    let clock = now;
    let calls = 0;
    let resolve!: (response: Response) => void;
    const checker = new OfficialUpdateChecker({ clock: () => clock, fetch: async () => {
      calls++;
      if (calls === 1) return new Promise<Response>(done => { resolve = done; });
      return Response.json(release());
    } });
    const first = checker.check(), second = checker.check();
    assert.equal(calls, 1);
    resolve(Response.json(release()));
    const result = await first;
    assert.equal(await second, result);
    clock += 299_999;
    assert.equal(await checker.check(), result);
    assert.equal(calls, 1);
    clock += 1;
    assert.equal((await checker.check()).checked_at, new Date(clock).toISOString());
    assert.equal(calls, 2);
  });

  it("replaces expired success with a bounded failure cooldown and can recover", async () => {
    let clock = now, calls = 0, fail = false;
    const checker = new OfficialUpdateChecker({ clock: () => clock, fetch: async () => {
      calls++;
      if (fail) throw new Error("sensitive upstream diagnostics");
      return Response.json(release(APP_VERSION));
    } });
    assert.equal((await checker.check()).status, "up_to_date");
    clock += 300_000; fail = true;
    await assert.rejects(checker.check(), error => error instanceof UpdateCheckUnavailable && !error.message.includes("sensitive"));
    clock += 30_000;
    await assert.rejects(checker.check(), error => error instanceof UpdateCheckUnavailable && error.retryAfterSeconds === 30);
    assert.equal(calls, 2);
    clock += 30_000; fail = false;
    assert.equal((await checker.check()).checked_at, new Date(clock).toISOString());
    assert.equal(calls, 3);
    clock -= 1_000;
    await checker.check();
    assert.equal(calls, 4, "clock rollback must not extend the cached result indefinitely");
  });

  for (const [name, response] of [
    ["missing release", () => new Response("not found", { status: 404 })],
    ["rate limit", () => new Response("rate limited", { status: 403 })],
    ["too many requests", () => new Response("limited", { status: 429 })],
    ["server failure", () => new Response("failed", { status: 503 })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.invalid/" } })],
    ["HTML", () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } })],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["draft", () => Response.json(release(nextVersion, { draft: true }))],
    ["prerelease", () => Response.json(release(nextVersion, { prerelease: true }))],
    ["noncanonical tag", () => Response.json(release(nextVersion + "-beta.1"))],
    ["missing metadata", () => Response.json({ tag_name: "v" + nextVersion })],
    ["null", () => Response.json(null)],
    ["other repository", () => Response.json(release(nextVersion, { html_url: "https://github.com/another/project/releases/tag/v" + nextVersion }))],
    ["unsafe URL", () => Response.json(release(nextVersion, { html_url: "javascript:alert(1)" }))],
    ["invalid timestamp", () => Response.json(release(nextVersion, { published_at: "invalid" }))],
    ["oversized declared response", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "262145" } })],
  ] as const) {
    it("rejects " + name + " without claiming the instance is up to date", async () => {
      const checker = new OfficialUpdateChecker({ fetch: async () => response() });
      await assert.rejects(checker.check(), UpdateCheckUnavailable);
    });
  }

  it("bounds chunked response size and closes the response stream", async () => {
    let cancelled = false;
    const checker = new OfficialUpdateChecker({ fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(262145)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    assert.equal(cancelled, true);
  });

  it("aborts slow checks without returning an old green result", async () => {
    let signal: AbortSignal | null | undefined;
    const checker = new OfficialUpdateChecker({ timeoutMilliseconds: 5, fetch: async (_url, options) => {
      signal = options?.signal;
      await delay(15);
      signal?.throwIfAborted();
      return Response.json(release());
    } });
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    assert.equal(signal?.aborted, true);
  });
});
