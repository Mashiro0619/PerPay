import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { OfficialUpdateChecker, UpdateCheckRateLimited, UpdateCheckUnavailable } from "../src/update/checker.ts";

const initialTime = Date.UTC(2026, 9, 31, 8);
const releasesApi = "https://api.github.com/repos/Mashiro0619/PerPay/releases";
function release(version = "0.2.3") {
  return { tag_name: "v" + version, html_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + version,
    draft: false, prerelease: version.includes("-"), published_at: "2026-10-30T00:00:00Z" };
}

describe("manual official update refreshes", () => {
  it("requires a real check after 60 seconds and keeps early rejections out of the five-minute cache", async () => {
    let clock = initialTime, calls = 0, latest = "0.2.3";
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async () => {
      calls++;
      return Response.json(release(latest));
    } });
    const original = await checker.check("stable");
    assert.equal(checker.refreshAfterSeconds("stable"), 60);
    clock += 30_000;
    latest = "0.2.4";
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(checker.check("stable", { refresh: true }),
        error => error instanceof UpdateCheckRateLimited && error.retryAfterSeconds === 30);
    }
    assert.equal(await checker.check("stable", { refresh: false }), original);
    assert.equal(checker.refreshAfterSeconds("stable"), 30);
    clock += 29_999;
    await assert.rejects(checker.check("stable", { refresh: true }),
      error => error instanceof UpdateCheckRateLimited && error.retryAfterSeconds === 1);
    assert.equal(calls, 1);
    clock++;
    assert.equal(checker.refreshAfterSeconds("stable"), 0);
    const refreshed = await checker.check("stable", { refresh: true });
    assert.equal(refreshed.latest_version, latest);
    assert.equal(refreshed.checked_at, new Date(clock).toISOString());
    assert.equal(calls, 2);
    clock += 299_999;
    assert.equal(await checker.check("stable"), refreshed);
    assert.equal(calls, 2);
    clock++;
    await checker.check("stable");
    assert.equal(calls, 3);
  });

  it("lets a manual request join a cold automatic check without another request", async () => {
    let calls = 0;
    let resolve!: (response: Response) => void;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", fetch: async () => {
      calls++;
      return new Promise<Response>(done => { resolve = done; });
    } });
    const automatic = checker.check("stable");
    const manual = checker.check("stable", { refresh: true });
    resolve(Response.json(release()));
    assert.equal(await automatic, await manual);
    assert.equal(calls, 1);
  });

  it("joins an in-flight manual refresh before returning an older automatic cache", async () => {
    let clock = initialTime, calls = 0;
    let resolve!: (response: Response) => void;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(release()) : new Promise<Response>(done => { resolve = done; });
    } });
    const previous = await checker.check("stable");
    clock += 60_000;
    const manual = checker.check("stable", { refresh: true });
    const automatic = checker.check("stable");
    const anotherManual = checker.check("stable", { refresh: true });
    resolve(Response.json(release("0.2.4")));
    const current = await manual;
    assert.notEqual(current, previous);
    assert.equal(current.latest_version, "0.2.4");
    assert.equal(await automatic, current);
    assert.equal(await anotherManual, current);
    assert.equal(calls, 2);
  });

  it("keeps manual success intervals scoped to the selected channel", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => initialTime, fetch: async url => {
      calls++;
      return Response.json(url === releasesApi + "/latest" ? release() : [release("0.3.0-rc.1")]);
    } });
    await checker.check("prerelease", { refresh: true });
    assert.equal(checker.refreshAfterSeconds("stable"), 0);
    assert.equal((await checker.check("stable", { refresh: true })).latest_version, "0.2.3");
    assert.equal(calls, 3);
  });

  it("replaces a still-fresh success after a manual network failure and recovers after its cooldown", async () => {
    let clock = initialTime, calls = 0, unavailable = false;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async () => {
      calls++;
      if (unavailable) throw new Error("private upstream network diagnostics");
      return Response.json(release());
    } });
    await checker.check("stable");
    clock += 60_000;
    unavailable = true;
    await assert.rejects(checker.check("stable", { refresh: true }),
      error => error instanceof UpdateCheckUnavailable && error.reason === "network" &&
        error.retryAfterSeconds === 60 && !error.message.includes("private"));
    await assert.rejects(checker.check("stable"), UpdateCheckUnavailable);
    clock += 59_999;
    await assert.rejects(checker.check("stable", { refresh: true }),
      error => error instanceof UpdateCheckUnavailable && error.retryAfterSeconds === 1);
    assert.equal(calls, 2);
    clock++;
    unavailable = false;
    assert.equal((await checker.check("stable", { refresh: true })).checked_at, new Date(clock).toISOString());
    assert.equal(calls, 3);
  });

  it("rejects non-boolean refresh options before consulting cache or network", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", fetch: async () => {
      calls++;
      return Response.json(release());
    } });
    await checker.check("stable");
    for (const refresh of ["true", 1, null]) {
      await assert.rejects(checker.check("stable", { refresh: refresh as unknown as boolean }), RangeError);
    }
    assert.equal(calls, 1);
  });

  it("retains a safe timeout reason throughout the failure cooldown", async () => {
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", timeoutMilliseconds: 5, fetch: async (_url, options) => {
      await delay(15);
      options?.signal?.throwIfAborted();
      return Response.json(release());
    } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(checker.check("stable"),
        error => error instanceof UpdateCheckUnavailable && error.reason === "timeout" && error.message.includes("超时"));
    }
  });
});

describe("GitHub update cooldowns", () => {
  const nextHour = String(initialTime / 1_000 + 3_600);
  const cases: Array<{ name: string; status?: number; headers: Record<string, string>; seconds: number }> = [
    { name: "Retry-After seconds", headers: { "retry-after": "3600" }, seconds: 3_600 },
    { name: "Retry-After HTTP date", headers: { "retry-after": "Sat, 31 Oct 2026 09:00:00 GMT" }, seconds: 3_600 },
    { name: "obsolete HTTP date", headers: { "retry-after": "Saturday, 31-Oct-26 09:00:00 GMT" }, seconds: 3_600 },
    { name: "asctime HTTP date in UTC", headers: { "retry-after": "Sat Oct 31 09:00:00 2026" }, seconds: 3_600 },
    { name: "quota reset", status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour }, seconds: 3_600 },
    { name: "longer quota reset", headers: { "retry-after": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour }, seconds: 3_600 },
    { name: "longer Retry-After", headers: { "retry-after": "7200", "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour }, seconds: 7_200 },
    { name: "secondary 403 limit", status: 403, headers: { "retry-after": "120" }, seconds: 120 },
    { name: "429 without hints", headers: {}, seconds: 60 },
    { name: "zero Retry-After", headers: { "retry-after": "0" }, seconds: 60 },
    { name: "past HTTP date", headers: { "retry-after": "Sat, 31 Oct 2026 07:00:00 GMT" }, seconds: 60 },
    { name: "fractional Retry-After", headers: { "retry-after": "1.5" }, seconds: 60 },
    { name: "negative Retry-After", headers: { "retry-after": "-1" }, seconds: 60 },
    { name: "unsafe numeric Retry-After", headers: { "retry-after": "99999999999999999999999999" }, seconds: 60 },
    { name: "non-HTTP date", headers: { "retry-after": "2026-11-01" }, seconds: 60 },
    { name: "invalid HTTP date", headers: { "retry-after": "Sat, 99 Oct 2026 09:00:00 GMT" }, seconds: 60 },
    { name: "reset without exhausted quota", headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": nextHour }, seconds: 60 },
    { name: "invalid reset", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "tomorrow" }, seconds: 60 },
    { name: "unsafe reset", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999999999999999999" }, seconds: 60 },
    { name: "past reset", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(initialTime / 1_000 - 1) }, seconds: 60 },
  ];
  for (const { name, status = 429, headers, seconds } of cases) {
    it("shares " + name + " across channels and permits a check only after the deadline", async () => {
      let clock = initialTime, calls = 0, limited = true;
      const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async () => {
        calls++;
        return limited ? new Response("private rate-limit diagnostics", { status, headers }) : Response.json(release());
      } });
      await assert.rejects(checker.check("stable"),
        error => error instanceof UpdateCheckUnavailable && error.reason === "rate_limited" &&
          error.retryAfterSeconds === seconds && !error.message.includes("private"));
      assert.equal(checker.refreshAfterSeconds("prerelease"), seconds);
      await assert.rejects(checker.check("prerelease", { refresh: true }),
        error => error instanceof UpdateCheckUnavailable && error.retryAfterSeconds === seconds);
      clock += seconds * 1_000 - 1;
      await assert.rejects(checker.check("stable", { refresh: true }),
        error => error instanceof UpdateCheckUnavailable && error.retryAfterSeconds === 1);
      assert.equal(calls, 1);
      clock++;
      limited = false;
      await checker.check("stable", { refresh: true });
      assert.equal(calls, 2);
    });
  }

  it("preserves another channel's valid automatic cache while blocking its manual refresh", async () => {
    let clock = initialTime, calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(release()) : new Response(null, { status: 429, headers: { "retry-after": "3600" } });
    } });
    const stable = await checker.check("stable");
    clock += 20_000;
    await assert.rejects(checker.check("prerelease"), UpdateCheckUnavailable);
    assert.equal(await checker.check("stable"), stable);
    assert.equal(checker.refreshAfterSeconds("stable"), 3_600);
    await assert.rejects(checker.check("stable", { refresh: true }),
      error => error instanceof UpdateCheckUnavailable && error.reason === "rate_limited" && error.retryAfterSeconds === 3_600);
    assert.equal(calls, 2);
  });

  it("does not let an in-flight success clear another channel's new cooldown", async () => {
    let calls = 0;
    let resolve!: (response: Response) => void;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => initialTime, fetch: async () => {
      calls++;
      return calls === 1 ? new Promise<Response>(done => { resolve = done; })
        : new Response(null, { status: 429, headers: { "retry-after": "3600" } });
    } });
    const stable = checker.check("stable");
    await assert.rejects(checker.check("prerelease"), UpdateCheckUnavailable);
    resolve(Response.json(release()));
    const success = await stable;
    assert.equal(await checker.check("stable"), success);
    assert.equal(checker.refreshAfterSeconds("stable"), 3_600);
    await assert.rejects(checker.check("stable", { refresh: true }), UpdateCheckUnavailable);
    assert.equal(calls, 2);
  });

  it("never shortens an existing global cooldown when another in-flight request fails", async () => {
    let clock = initialTime;
    const responses: Array<(response: Response) => void> = [];
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock,
      fetch: async () => new Promise<Response>(resolve => responses.push(resolve)) });
    const stable = checker.check("stable"), prerelease = checker.check("prerelease");
    responses[1]!(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    await assert.rejects(prerelease, UpdateCheckUnavailable);
    clock += 30_000;
    responses[0]!(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    await assert.rejects(stable, error => error instanceof UpdateCheckUnavailable && error.retryAfterSeconds === 3_570);
    assert.equal(checker.refreshAfterSeconds("prerelease"), 3_570);
  });

  it("stops before the next prerelease page when a successful response exhausts the quota", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => initialTime, fetch: async () => {
      calls++;
      return Response.json(release(), { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour } });
    } });
    await assert.rejects(checker.check("prerelease"),
      error => error instanceof UpdateCheckUnavailable && error.reason === "rate_limited" && error.retryAfterSeconds === 3_600);
    assert.equal(calls, 1);
    await assert.rejects(checker.check("stable"), UpdateCheckUnavailable);
    assert.equal(calls, 1);
  });

  it("keeps a quota-exhausting stable success and advertises the full upstream wait", async () => {
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => initialTime,
      fetch: async () => Response.json(release(), { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour } }) });
    assert.equal((await checker.check("stable")).status, "update_available");
    assert.equal(checker.refreshAfterSeconds("stable"), 3_600);
  });

  it("stops after a quota-exhausting missing stable release before fetching prereleases", async () => {
    let clock = initialTime, calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => clock, fetch: async url => {
      calls++;
      if (calls === 1) return new Response(null, {
        status: 404, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": nextHour },
      });
      return Response.json(url === releasesApi + "/latest" ? release() : [release("0.3.0-rc.1")]);
    } });
    await assert.rejects(checker.check("prerelease"),
      error => error instanceof UpdateCheckUnavailable && error.reason === "rate_limited" && error.retryAfterSeconds === 3_600);
    assert.equal(calls, 1, "the exhausted quota must stop the following release-list request");
    assert.equal(checker.refreshAfterSeconds("stable"), 3_600);
    await assert.rejects(checker.check("stable", { refresh: true }), UpdateCheckUnavailable);
    clock += 3_600_000;
    assert.equal((await checker.check("prerelease")).latest_version, "0.3.0-rc.1");
    assert.equal(calls, 3);
  });

  it("does not classify an ordinary forbidden response as a shared GitHub rate limit", async () => {
    let calls = 0;
    const checker = new OfficialUpdateChecker({ currentVersion: "0.2.2", clock: () => initialTime, fetch: async url => {
      calls++;
      if (calls === 1) return new Response(null, { status: 403 });
      return Response.json(url === releasesApi + "/latest" ? release() : [release()]);
    } });
    await assert.rejects(checker.check("stable"),
      error => error instanceof UpdateCheckUnavailable && error.reason === "unavailable");
    assert.equal(checker.refreshAfterSeconds("prerelease"), 0);
    assert.equal((await checker.check("prerelease")).latest_version, "0.2.3");
    assert.equal(calls, 3);
  });
});
