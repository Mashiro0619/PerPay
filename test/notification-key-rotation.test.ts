import { configureTestSiteNotifications } from "./site-notification-fixture.ts";
import type { SiteStore } from "../src/sites/store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { RuntimeSettingsService } from "../src/settings/index.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const origin = "http://localhost:6190";
const endpoint = "/api/admin/v1/sites/default/secrets/webhook_secret/actions/rotate";
const audit = { actorId: "admin", requestId: "rotation-test", remoteAddressHash: "0".repeat(64) };
async function fixture(run: (f: Awaited<ReturnType<typeof createConfiguredHttpServices>>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-notification-rotation-"));
  const f = await createConfiguredHttpServices({ directory, apiSecret: Buffer.alloc(32, 42).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/notification-rotation", publicUrl: origin });
  try { await run(f); } finally {
    f.database.close();
    assert.equal(resolve(directory, ".."), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), "perpay-notification-rotation-")));
    rmSync(directory, { recursive: true, force: true });
  }
}
async function enable(sites: SiteStore) {
  return configureTestSiteNotifications(sites, "default", { enabled: true, allowed_origin: "https://business.example", timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600 }, audit);
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrf_token: string } };
  return { "content-type": "application/json", origin, cookie: response.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; "), "x-csrf-token": body.data.csrf_token };
}
describe("notification key rotation", () => {
  it("requires authentication, same origin and CSRF; generates missing keys and rejects stale revisions", async () => fixture(async f => {
    const app = createApp({ ...f, startedAt: new Date(0) });
    const headers = await login(app);
    const post = (h: Record<string,string>, body: unknown) => app.request(endpoint, { method: "POST", headers: h, body: JSON.stringify(body) });
    const before = f.sites.get("default")!;
    assert.equal((await post({ "content-type": "application/json", origin }, { revision: before.revision })).status, 401);
    assert.equal((await post({ ...headers, origin: "https://evil.example" }, { revision: before.revision })).status, 403);
    assert.equal((await post({ ...headers, "x-csrf-token": "invalid" }, { revision: before.revision })).status, 403);
    assert.equal((await post(headers, {})).status, 422);
    assert.equal((await post(headers, { revision: before.revision })).status, 200);
    await enable(f.sites);
    const configured = f.sites.get("default")!;
    assert.equal((await post(headers, { revision: before.revision })).status, 409);
    assert.deepEqual(f.sites.get("default"), configured);
  }));

  it("returns one new secret, encrypts and audits it, preserves settings and refuses replay", async () => fixture(async f => {
    await enable(f.sites);
    const before = f.sites.get("default")!;
    const snapshot = f.settings.instanceSnapshot();
    const oldSecret = f.sites.notificationSecret("default");
    const oldApi = f.sites.credential("default");
    const app = createApp({ ...f, startedAt: new Date(0) });
    const headers = await login(app);
    const rotate = () => app.request(endpoint, { method: "POST", headers, body: JSON.stringify({ revision: before.revision }) });
    const [response, replay] = await Promise.all([rotate(), rotate()]);
    assert.deepEqual([response.status, replay.status].sort(), [200, 409]);
    const created = response.status === 200 ? response : replay;
    assert.equal(created.headers.get("cache-control"), "no-store");
    const { data } = await created.json() as { data: { secret: string; site: { revision: number; configuration: typeof before.configuration } } };
    assert.match(data.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(data.secret, oldSecret);
    assert.equal(data.site.revision, before.revision + 1);
    assert.deepEqual(data.site.configuration, before.configuration);
    assert.deepEqual(f.settings.instanceSnapshot(), snapshot);
    assert.deepEqual(f.sites.credential("default"), oldApi);
    const read = await app.request("/api/admin/v1/settings", { headers });
    assert.equal((await read.text()).includes(data.secret), false);
    assert.equal(JSON.stringify(data.site).includes(data.secret), false);
    const stored = f.database.read(db => db.prepare("SELECT ciphertext FROM site_secrets WHERE client_id = 'default' AND secret_name = 'webhook_secret'").get() as { ciphertext: Uint8Array });
    assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(data.secret)), false);
    const logs = f.database.read(db => db.prepare("SELECT action, details_json FROM audit_events WHERE action = 'site.secret_rotated' AND json_extract(details_json, '$.purpose') = 'webhook_secret'").all());
    assert.equal(logs.length, 2);
    assert.equal(JSON.stringify(logs).includes(data.secret), false);
    const reveal = await app.request("/api/admin/v1/sites/default/secrets/webhook_secret/actions/view", { method: "POST", headers, body: "{}" });
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json() as { data: { secret: string } }).data.secret, data.secret);
    assert.equal(f.database.integrityCheck().ok, true);
  }));

  it("supports rotation while disabled without turning notifications on", async () => fixture(async f => {
    await enable(f.sites);
    configureTestSiteNotifications(f.sites, "default", { enabled: false }, audit);
    const before = f.sites.get("default")!;
    const instance = f.settings.instanceSnapshot();
    const result = f.sites.rotateSecret("default", "webhook_secret", before.revision, audit);
    assert.deepEqual(result.site.configuration, before.configuration);
    assert.equal(result.site.configuration.notifications_enabled, false);
    assert.deepEqual(f.settings.instanceSnapshot(), instance);
  }));

  it("does not rebuild the shared runtime and keeps a committed key readable after a stale retry", async () => fixture(async f => {
    await enable(f.sites);
    const before = f.sites.get("default")!;
    let calls = 0;
    const settings = new RuntimeSettingsService({ store: f.settingsStore, onApplied: async () => { calls++; throw new Error("must not rebuild"); } });
    const unchanged = settings.instanceSnapshot();
    const result = f.sites.rotateSecret("default", "webhook_secret", before.revision, audit);
    assert.throws(() => f.sites.rotateSecret("default", "webhook_secret", before.revision, audit));
    assert.equal(calls, 0);
    assert.deepEqual(settings.instanceSnapshot(), unchanged);
    assert.equal(f.sites.revealSecret("default", "webhook_secret", audit), result.secret);
  }));
});
