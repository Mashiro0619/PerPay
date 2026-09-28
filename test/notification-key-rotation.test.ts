import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { RuntimeSettingsService } from "../src/settings/index.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const origin = "http://localhost:6190";
const endpoint = "/api/admin/v1/settings/notification-key/actions/rotate";
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
async function enable(settings: RuntimeSettingsService) {
  return settings.saveWebhook({ revision: settings.view().revision, enabled: true, allowed_origin: "https://business.example", timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600 }, audit);
}
async function login(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrf_token: string } };
  return { "content-type": "application/json", origin, cookie: response.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; "), "x-csrf-token": body.data.csrf_token };
}
describe("notification key rotation", () => {
  it("requires authentication, same origin and CSRF; rejects missing keys and stale revisions", async () => fixture(async f => {
    const app = createApp({ ...f, startedAt: new Date(0) });
    const headers = await login(app);
    const post = (h: Record<string,string>, body: unknown) => app.request(endpoint, { method: "POST", headers: h, body: JSON.stringify(body) });
    const before = f.settings.view();
    assert.equal((await post({ "content-type": "application/json", origin }, { revision: before.revision })).status, 401);
    assert.equal((await post({ ...headers, origin: "https://evil.example" }, { revision: before.revision })).status, 403);
    assert.equal((await post({ ...headers, "x-csrf-token": "invalid" }, { revision: before.revision })).status, 403);
    assert.equal((await post(headers, {})).status, 422);
    assert.equal((await post(headers, { revision: before.revision })).status, 404);
    assert.deepEqual(f.settings.view(), before);
    await enable(f.settings);
    const configured = f.settings.view();
    assert.equal((await post(headers, { revision: before.revision })).status, 409);
    assert.deepEqual(f.settings.view(), configured);
  }));

  it("returns one new secret, encrypts and audits it, preserves settings and refuses replay", async () => fixture(async f => {
    await enable(f.settings);
    const before = f.settings.view();
    const snapshot = f.settings.snapshot();
    const app = createApp({ ...f, startedAt: new Date(0) });
    const headers = await login(app);
    const rotate = () => app.request(endpoint, { method: "POST", headers, body: JSON.stringify({ revision: before.revision }) });
    const [response, replay] = await Promise.all([rotate(), rotate()]);
    assert.deepEqual([response.status, replay.status].sort(), [201, 409]);
    const created = response.status === 201 ? response : replay;
    assert.equal(created.headers.get("cache-control"), "no-store");
    const { data } = await created.json() as { data: Awaited<ReturnType<RuntimeSettingsService["rotateWebhookSecret"]>> };
    assert.match(data.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(data.secret, snapshot.webhook.secret);
    assert.equal(data.settings.revision, before.revision + 1);
    assert.equal(data.settings.payment_revision, before.payment_revision);
    assert.equal(data.settings.secrets.webhook_secret.version, before.secrets.webhook_secret.version! + 1);
    for (const key of ["provider", "collection", "notifications", "backup", "advanced", "pending_application_key"] as const) assert.deepEqual(data.settings[key], before[key]);
    assert.equal(f.settings.snapshot().apiSecret, snapshot.apiSecret);
    const read = await app.request("/api/admin/v1/settings", { headers });
    assert.equal((await read.text()).includes(data.secret), false);
    assert.equal(JSON.stringify(data.settings).includes(data.secret), false);
    const stored = f.database.read(db => db.prepare("SELECT ciphertext FROM runtime_secrets WHERE secret_name = 'webhook_secret'").get() as { ciphertext: Uint8Array });
    assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(data.secret)), false);
    const logs = f.database.read(db => db.prepare("SELECT action, details_json FROM audit_events WHERE action = 'settings.webhook_secret_rotated'").all());
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes(data.secret), false);
    const reveal = await app.request("/api/admin/v1/settings/secrets/webhook_secret/actions/reveal", { method: "POST", headers, body: "{}" });
    assert.equal(reveal.status, 200);
    assert.equal((await reveal.json() as { data: { value: string } }).data.value, data.secret);
    assert.equal(f.database.integrityCheck().ok, true);
  }));

  it("supports rotation while disabled without turning notifications on", async () => fixture(async f => {
    await enable(f.settings);
    await f.settings.saveWebhook({ revision: f.settings.view().revision, ...f.settings.view().notifications, enabled: false, allowed_origin: undefined }, audit);
    const before = f.settings.view();
    const result = await f.settings.rotateWebhookSecret(before.revision, audit);
    assert.deepEqual(result.settings.notifications, before.notifications);
    assert.equal(result.settings.notifications.enabled, false);
    assert.equal(result.settings.payment_revision, before.payment_revision);
  }));

  it("keeps a committed key recoverable after runtime apply fails, and does not rotate it again on retry", async () => fixture(async f => {
    await enable(f.settings);
    const before = f.settings.view();
    let fail = true;
    let calls = 0;
    const settings = new RuntimeSettingsService({ store: f.settingsStore, onApplied: async () => { calls++; if (fail) throw new Error("synthetic apply failure"); } });
    await assert.rejects(settings.rotateWebhookSecret(before.revision, audit));
    assert.equal(calls, 2);
    const committed = settings.view();
    assert.equal(committed.revision, before.revision + 1);
    assert.notEqual(committed.secrets.webhook_secret.fingerprint, before.secrets.webhook_secret.fingerprint);
    fail = false;
    await assert.rejects(settings.rotateWebhookSecret(before.revision, audit));
    assert.deepEqual(settings.view(), committed);
    assert.equal(calls, 2);
    assert.match(settings.revealSecret("webhook_secret", audit), /^[A-Za-z0-9_-]{43}$/);
  }));
});
