import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OfficialUpdateChecker, UpdateCheckUnavailable } from "../src/update/checker.ts";
import { APP_VERSION } from "../src/version.ts";
import { isPrereleaseVersion } from "../src/shared/release-version.ts";

const root = "https://api.github.com/repos/Mashiro0619/PerPay/releases";
function release(version: string, extra: Record<string, unknown> = {}) {
  return { tag_name: "v" + version, html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + version,
    draft: false, prerelease: isPrereleaseVersion(version), published_at: "2026-09-20T00:00:00Z", ...extra };
}
function fixture(current: string, versions: string[], stable: string | null = "0.2.2") {
  const calls: string[] = [];
  const checker = new OfficialUpdateChecker({ currentVersion: current, fetch: async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.body, undefined);
    if (url === root + "/latest") return stable ? Response.json(release(stable)) : new Response(null, { status: 404 });
    assert.equal(url, root + "?per_page=100&page=1");
    return Response.json(versions.map(version => release(version)));
  } });
  return { checker, calls };
}

describe("prerelease-aware official updates", () => {
  it("keeps stable installations on the stable endpoint only", async () => {
    const { checker, calls } = fixture("0.2.2", ["0.3.0-rc.1"], "0.2.3");
    assert.equal((await checker.check()).latest_version, "0.2.3");
    assert.deepEqual(calls, [root + "/latest"]);
  });

  for (const [current, versions, stable, latest, status] of [
    ["0.3.0-alpha.1", ["0.3.0-rc.2", "0.3.0-beta.11", "0.3.0-rc.10", "0.3.0-alpha.2"], "0.2.2", "0.3.0-rc.10", "update_available"],
    ["0.3.0-rc.1", ["0.3.0-rc.2"], "0.3.0", "0.3.0", "update_available"],
    ["0.3.0-rc.1", ["0.3.0", "0.3.0-rc.1"], "0.2.3", "0.3.0", "update_available"],
    ["0.3.0-rc.1", ["0.3.0-rc.1"], "0.2.2", "0.3.0-rc.1", "up_to_date"],
    ["0.3.0-rc.10", ["0.3.0-rc.2"], "0.2.2", "0.3.0-rc.2", "ahead"],
    ["0.3.0-rc.1", ["0.3.0-rc.1", "0.4.0-alpha.1"], "0.3.0", "0.4.0-alpha.1", "update_available"],
    ["0.3.0-alpha.1", ["0.3.0-alpha.2"], null, "0.3.0-alpha.2", "update_available"],
  ] as const) {
    it("selects " + latest + " for " + current + " (" + status + ")", async () => {
      const { checker, calls } = fixture(current, [...versions], stable);
      const result = await checker.check();
      assert.equal(result.current_version, current);
      assert.equal(result.latest_version, latest);
      assert.equal(result.status, status);
      assert.equal(result.release_url, "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest);
      assert.equal(calls.length, 2);
    });
  }

  it("ignores drafts, mismatched prerelease flags, invalid tags and off-repository links", async () => {
    const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-alpha.1", fetch: async url => {
      if (url === root + "/latest") return Response.json(release("0.2.2"));
      return Response.json([
        release("0.3.0-beta.1", { published_at: "2020-01-01T00:00:00Z" }),
        release("0.3.0-alpha.2", { published_at: "2026-12-31T00:00:00Z" }),
        release("9.0.0", { draft: true }), release("9.0.0-rc.1", { prerelease: false }),
        release("9.0.0", { prerelease: true }), release("9.0.0-rc.01"), release("9.0.0+build"),
        release("9.0.0-rc.1", { html_url: "https://evil.invalid" }), release("9.0.0", { published_at: "invalid" }),
        null, { tag_name: "v9.0.0" },
      ]);
    } });
    assert.equal((await checker.check()).latest_version, "0.3.0-beta.1");
  });

  it("checks later pages and never assumes GitHub date order equals version order", async () => {
    const calls: string[] = [];
    const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-alpha.1", fetch: async url => {
      calls.push(String(url));
      if (url === root + "/latest") return Response.json(release("0.2.2"));
      if (url === root + "?per_page=100&page=1") return Response.json(Array.from({ length: 100 }, () => release("0.3.0-alpha.2")));
      assert.equal(url, root + "?per_page=100&page=2");
      return Response.json([release("0.3.0-rc.1")]);
    } });
    assert.equal((await checker.check()).latest_version, "0.3.0-rc.1");
    assert.equal(calls.length, 3);
  });

  it("constructs trusted pagination URLs instead of following upstream Link URLs", async () => {
    const calls: string[] = [];
    const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-alpha.1", fetch: async url => {
      calls.push(String(url));
      if (url === root + "/latest") return new Response(null, { status: 404 });
      if (url === root + "?per_page=100&page=1") return Response.json([release("0.3.0-alpha.2")], { headers: { link: '<https://evil.invalid/steal>; rel="next"' } });
      assert.equal(url, root + "?per_page=100&page=2");
      return Response.json([release("0.3.0-rc.1")]);
    } });
    assert.equal((await checker.check()).latest_version, "0.3.0-rc.1");
    assert.equal(calls.some(url => url.includes("evil.invalid")), false);
  });

  it("fails closed on a truncated list instead of claiming it found the latest version", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-alpha.1", fetch: async url => {
      calls++;
      return Response.json(url === root + "/latest" ? release("0.2.2") : Array.from({ length: 100 }, () => release("0.3.0-rc.1")));
    } });
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    assert.equal(calls, 6);
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    assert.equal(calls, 6, "failure must also be cached");
  });

  for (const [name, response] of [
    ["bad list shape", () => Response.json({ tag_name: "v0.3.0" })],
    ["too many list items", () => Response.json(Array.from({ length: 101 }, () => release("0.3.0")))],
    ["oversized list", () => new Response("[]", { headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) } })],
    ["failed list read", () => new Response(null, { status: 503 })],
  ] as const) {
    it("rejects " + name + " even when a stable response was available", async () => {
      const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-rc.1", fetch: async url =>
        url === root + "/latest" ? Response.json(release("0.3.0")) : response() });
      await assert.rejects(checker.check(), UpdateCheckUnavailable);
    });
  }

  it("coalesces and caches all channel requests and replaces success after a failed refresh", async () => {
    let clock = 1_000, fail = false, calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.3.0-rc.1", clock: () => clock, fetch: async url => {
      calls++;
      if (url === root + "/latest") return Response.json(release("0.2.2"));
      if (fail) throw new Error("upstream private error");
      return Response.json([release("0.3.0-rc.1")]);
    } });
    const results = await Promise.all([checker.check(), checker.check()]);
    assert.equal(results[0], results[1]);
    assert.equal(calls, 2);
    assert.equal(await checker.check(), results[0]);
    clock += 300_000; fail = true;
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    await assert.rejects(checker.check(), UpdateCheckUnavailable);
    assert.equal(calls, 4);
    clock += 60_000; fail = false;
    assert.equal((await checker.check()).status, "up_to_date");
    assert.equal(calls, 6);
  });

  it("uses the actual application version by default, including prerelease builds", async () => {
    const checker = new OfficialUpdateChecker({ fetch: async url => {
      if (url === root + "/latest") return isPrereleaseVersion(APP_VERSION) ? new Response(null, { status: 404 }) : Response.json(release(APP_VERSION));
      return Response.json([release(APP_VERSION)]);
    } });
    assert.equal((await checker.check()).current_version, APP_VERSION);
    assert.equal((await checker.check()).status, "up_to_date");
  });

  it("does not treat an invalid local version or an empty release catalog as up to date", async () => {
    const invalid = new OfficialUpdateChecker({ currentVersion: "0.3.0-rc.01", fetch: async () => { throw new Error("must not fetch"); } });
    await assert.rejects(invalid.check(), UpdateCheckUnavailable);
    await assert.rejects(fixture("0.3.0-alpha.1", [], null).checker.check(), UpdateCheckUnavailable);
  });
});
