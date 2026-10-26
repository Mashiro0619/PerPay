import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

async function fixture(demoMode = false, trustedProxy = "") {
  const directory = mkdtempSync(join(tmpdir(), "perpay-session-http-"));
  const services = await createConfiguredHttpServices({
    directory,
    apiSecret: null,
    collectionCodePayload: "https://qr.alipay.com/session-test",
    environment: { PERPAY_TRUSTED_PROXY_CIDRS: trustedProxy },
  });
  const app = createApp({ ...services, demoMode, startedAt: new Date() });
  async function login(userAgent: string, network?: { peer: string; forwardedFor: string }) {
    const response = await app.request("/api/admin/v1/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: services.config.publicOrigin, "user-agent": userAgent,
        ...(network ? { "x-forwarded-for": network.forwardedFor } : {}) },
      body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD, remember_me: true }),
    }, network ? { incoming: { socket: { remoteAddress: network.peer, remotePort: 12345, remoteFamily: "IPv4" } } } : undefined);
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const body = await response.json() as { data: { csrf_token: string } };
    const headers = {
      cookie,
      "content-type": "application/json",
      origin: services.config.publicOrigin,
      "x-csrf-token": body.data.csrf_token,
    };
    return { cookie, headers };
  }
  return {
    ...services, app, login,
    close() { services.database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

interface ListedSession {
  session_id: string;
  is_current: boolean;
  user_agent: string | null;
  ip_address: string | null;
  auth_method: "password";
  last_seen_at: string;
  expires_at: string;
}

describe("administrator session management HTTP", () => {
  it("captures the normalized login IP only through trusted peers and preserves it on later requests", async () => {
    for (const trusted of [false, true]) {
      const test = await fixture(false, trusted ? "127.0.0.1/32,10.0.0.0/8" : "");
      try {
        const current = await test.login("Original login UA", {
          peer: "::ffff:127.0.0.1", forwardedFor: "2001:0db8:0:0:0:0:0:7, 10.0.0.4",
        });
        const response = await test.app.request("/api/admin/v1/sessions", {
          headers: { cookie: current.cookie, "user-agent": "Later request UA", "x-forwarded-for": "198.51.100.99" },
        }, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" } } });
        assert.equal(response.status, 200);
        const { data } = await response.json() as { data: ListedSession[] };
        assert.equal(data.length, 1);
        assert.equal(data[0]!.is_current, true);
        assert.equal(data[0]!.user_agent, "Original login UA");
        assert.equal(data[0]!.ip_address, trusted ? "2001:db8::7" : "127.0.0.1");
      } finally {
        test.close();
      }
    }
  });

  it("lists sessions and revokes one, others, and the current session while preserving cookie semantics", async () => {
    const test = await fixture();
    try {
      const current = await test.login("Chrome Windows");
      const second = await test.login("Chrome Android");
      const third = await test.login("Safari iOS");
      assert.equal((await test.app.request("/api/admin/v1/sessions")).status, 401);
      const listed = await test.app.request("/api/admin/v1/sessions", { headers: { cookie: current.cookie } });
      assert.equal(listed.status, 200);
      assert.equal(listed.headers.get("cache-control"), "no-store");
      const { data } = await listed.json() as { data: ListedSession[] };
      assert.equal(data.length, 3);
      assert.deepEqual(Object.keys(data[0]!).sort(), [
        "auth_method", "expires_at", "ip_address", "is_current", "last_seen_at", "session_id", "user_agent",
      ]);
      assert.equal(data[0]!.is_current, true);
      assert.equal(data[0]!.user_agent, "Chrome Windows");
      assert.equal(data[0]!.ip_address, null);
      assert.equal(data[0]!.auth_method, "password");
      assert.ok(Number.isFinite(Date.parse(data[0]!.last_seen_at)));
      assert.ok(Number.isFinite(Date.parse(data[0]!.expires_at)));
      const secondId = data.find((entry) => entry.user_agent === "Chrome Android")!.session_id;
      const revokePath = `/api/admin/v1/sessions/${secondId}/revoke`;
      const revoked = await test.app.request(revokePath, { method: "POST", headers: current.headers, body: "{}" });
      assert.equal(revoked.status, 204);
      assert.deepEqual(revoked.headers.getSetCookie(), []);
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: second.cookie } })).status, 401);
      assert.equal((await test.app.request(revokePath, { method: "POST", headers: current.headers, body: "{}" })).status, 204);
      assert.equal((await test.app.request("/api/admin/v1/sessions/00000000-0000-4000-8000-000000000000/revoke", {
        method: "POST", headers: current.headers, body: "{}",
      })).status, 204);

      const others = await test.app.request("/api/admin/v1/sessions/revoke-others", {
        method: "POST", headers: current.headers, body: "{}",
      });
      assert.equal(others.status, 200);
      assert.deepEqual(await others.json(), { data: { revoked_sessions: 1 } });
      assert.deepEqual(others.headers.getSetCookie(), []);
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: third.cookie } })).status, 401);
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: current.cookie } })).status, 200);
      const repeated = await test.app.request("/api/admin/v1/sessions/revoke-others", {
        method: "POST", headers: current.headers, body: "{}",
      });
      assert.deepEqual(await repeated.json(), { data: { revoked_sessions: 0 } });
      const self = await test.app.request(`/api/admin/v1/sessions/${data[0]!.session_id.toUpperCase()}/revoke`, {
        method: "POST", headers: current.headers, body: "{}",
      });
      assert.equal(self.status, 204);
      assert.equal(self.headers.getSetCookie().length, 2);
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: current.cookie } })).status, 401);
    } finally {
      test.close();
    }
  });

  it("rejects cross-origin, CSRF-free and malformed revocations without changing sessions", async () => {
    const test = await fixture();
    try {
      const current = await test.login("Current");
      const other = await test.login("Other");
      const listed = await test.app.request("/api/admin/v1/sessions", { headers: { cookie: current.cookie } });
      const sessions = (await listed.json() as { data: ListedSession[] }).data;
      const target = sessions.find((entry) => !entry.is_current)!.session_id;
      for (const path of [`/api/admin/v1/sessions/${target}/revoke`, "/api/admin/v1/sessions/revoke-others"]) {
        const noCsrf = { ...current.headers };
        delete (noCsrf as Partial<typeof noCsrf>)["x-csrf-token"];
        for (const headers of [noCsrf, { ...current.headers, origin: "https://untrusted.example" }]) {
          assert.equal((await test.app.request(path, { method: "POST", headers, body: "{}" })).status, 403);
        }
        assert.equal((await test.app.request(path, { method: "POST", headers: current.headers, body: '{"unexpected":true}' })).status, 422);
      }
      const invalid = await test.app.request("/api/admin/v1/sessions/not-a-uuid/revoke", {
        method: "POST", headers: current.headers, body: "{}",
      });
      assert.equal(invalid.status, 422);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, "validation_failed");
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: other.cookie } })).status, 200);
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: current.cookie } })).status, 200);
    } finally {
      test.close();
    }
  });

  it("allows session reads in a demo and rejects both new revocation actions", async () => {
    const test = await fixture(true);
    try {
      const current = await test.login("Current");
      const listed = await test.app.request("/api/admin/v1/sessions", { headers: { cookie: current.cookie } });
      assert.equal(listed.status, 200);
      const currentId = (await listed.json() as { data: ListedSession[] }).data[0]!.session_id;
      for (const path of [`/api/admin/v1/sessions/${currentId}/revoke`, "/api/admin/v1/sessions/revoke-others"]) {
        const response = await test.app.request(path, { method: "POST", headers: current.headers, body: "{}" });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "demo_read_only");
      }
      assert.equal((await test.app.request("/api/admin/v1/session", { headers: { cookie: current.cookie } })).status, 200);
    } finally {
      test.close();
    }
  });
});
