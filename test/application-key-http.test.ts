import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { AlipayAccountService, type AlipayAccountView } from "../src/alipay-accounts/index.ts";
import { RuntimeSettingsService, SettingsError } from "../src/settings/index.ts";
import { nextPlatformPem, platformPem } from "./application-key-fixture.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const origin = "http://localhost:6190";
const accountPath = "/api/admin/v1/alipay-accounts/default";
const base = accountPath + "/application-key/";

async function withFixture(test: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await test(f); }
  finally {
    f.database.close();
    assert.equal(dirname(resolve(f.directory)), resolve(tmpdir()));
    assert.ok(f.directory.split(/[\\/]/).at(-1)!.startsWith("perpay-key-http-"));
    rmSync(f.directory, { recursive: true, force: true });
  }
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-key-http-"));
  const services = await createConfiguredHttpServices({ directory, apiSecret: Buffer.alloc(32, 0x63).toString("base64url"),
    collectionCodePayload: "https://qr.alipay.com/key-http", publicUrl: origin });
  const probe = { calls: 0, fail: false, publicKeys: [] as string[] };
  const accounts = new AlipayAccountService({
    store: services.settingsStore.accountStore()!,
    verifyProviderApplicationKey: async provider => {
      probe.calls++;
      probe.publicKeys.push(provider.publicKeyPem);
      if (probe.fail) throw new SettingsError("provider_application_key_verification_failed", "测试验证未通过，当前密钥未更换。");
    },
  });
  const ledger = new LedgerStore(services.database);
  const settings = new RuntimeSettingsService({ store: services.settingsStore, alipayAccounts: accounts });
  const app = createApp({ ...services, settings, alipayAccounts: accounts, ledger, startedAt: new Date(0) });
  const login = await app.request("/api/admin/v1/session/login", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const body = await login.json() as { data: { csrf_token: string } };
  const headers = { "content-type": "application/json", origin,
    cookie: login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; "), "x-csrf-token": body.data.csrf_token };
  const post = (action: string, payload: unknown, requestHeaders: Record<string, string> = headers) =>
    app.request(base + action, { method: "POST", headers: requestHeaders, body: JSON.stringify(payload) });
  const account = () => accounts.get("default");
  const request = () => ({ revision: account().revision, change_id: randomUUID(), base_fingerprint: account().application_key_fingerprint! });
  return { ...services, directory, settings, accounts, account, probe, app, headers, post, request };
}

describe("administrator account key rotation HTTP contract", () => {
  it("requires administrator authentication, CSRF and trusted origin for every action", async () => {
    await withFixture(async f => {
      const before = f.account();
      for (const action of ["regenerate", "activate", "discard"]) {
        const payload = action === "regenerate" ? f.request() : { revision: before.revision, change_id: randomUUID(),
          ...(action === "activate" ? { platform_public_key: nextPlatformPem } : {}) };
        assert.equal((await f.post(action, payload, { "content-type": "application/json", origin })).status, 401);
        assert.equal((await f.post(action, payload, { ...f.headers, "x-csrf-token": "invalid" })).status, 403);
        assert.equal((await f.post(action, payload, { ...f.headers, origin: "https://untrusted.test" })).status, 403);
        assert.equal((await f.post(action, { ...payload, unexpected: true })).status, 422);
      }
      const retired = await f.app.request("/api/admin/v1/settings/provider/application-key/actions/regenerate", {
        method: "POST", headers: f.headers, body: JSON.stringify(f.request()),
      });
      assert.equal(retired.status, 410);
      assert.equal((await retired.json() as {error:{code:string}}).error.code, "alipay_settings_moved");
      assert.deepEqual(f.account(), before);
      assert.equal(f.probe.calls, 0);
    });
  });

  it("rejects missing or blank Alipay public keys without probing or replacing saved keys", async () => {
    await withFixture(async f => {
      const request = f.request();
      assert.equal((await f.post("regenerate", request)).status, 200);
      const before = f.accounts.store().snapshot("default");
      const pending = f.account().pending_application_key;
      for (const value of [undefined, null, "", "   ", "\n\t ", 123]) {
        const response = await f.post("activate", { revision: before.revision, change_id: request.change_id,
          ...(value === undefined ? {} : { platform_public_key: value }) });
        assert.equal(response.status, 422);
        const envelope = await response.json() as { error: { code: string; message: string } };
        assert.equal(envelope.error.code, "validation_failed");
        assert.equal(envelope.error.message, "请求字段校验失败");
        assert.deepEqual(f.accounts.store().snapshot("default"), before);
        assert.deepEqual(f.account().pending_application_key, pending);
        assert.equal(f.probe.calls, 0);
      }
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("exposes durable pending public data and only activates after successful verification", async () => {
    await withFixture(async f => {
      const before = f.account();
      const instanceRevision = f.settings.instanceView().payment_revision;
      const order = f.orders.create({ idempotency_key: "key-rotation-open-order", merchant_order_no: "key-rotation-open-order",
        amount_cents: 100, product_name: "rotation fixture", note: null }).order;
      const orderRow = () => f.database.read(db => db.prepare("SELECT * FROM payment_orders WHERE order_id=?").get(order.orderId));
      const originalOrder = orderRow();
      const request = f.request();
      const generated = await f.post("regenerate", request);
      assert.equal(generated.status, 200);
      assert.equal(generated.headers.get("cache-control"), "no-store");
      const data = (await generated.json() as { data: AlipayAccountView }).data;
      const pending = f.account();
      assert.ok(data.pending_application_key);
      assert.equal(data.application_public_key, before.application_public_key);
      assert.equal(data.provider_account_key, before.provider_account_key);
      assert.equal(f.probe.calls, 0);
      const replay = await f.post("regenerate", request);
      assert.equal(replay.status, 200);
      assert.equal(JSON.stringify(await replay.json()).includes("PRIVATE KEY"), false);
      assert.deepEqual(f.account(), pending);
      const accountResponse = await f.app.request(accountPath, { headers: f.headers });
      assert.equal(accountResponse.status, 200);
      assert.equal(accountResponse.headers.get("cache-control"), "no-store");
      assert.equal((await accountResponse.json() as {data:AlipayAccountView}).data.pending_application_key!.change_id, request.change_id);
      const activate = { revision: data.revision, change_id: request.change_id, platform_public_key: nextPlatformPem };
      const wrongKey = await f.post("activate", { ...activate, platform_public_key: data.pending_application_key.public_key });
      assert.equal(wrongKey.status, 422);
      assert.ok((await wrongKey.json() as {error:{fields:Record<string,string>}}).error.fields.platform_public_key);
      assert.equal(f.probe.calls, 0);
      f.probe.fail = true;
      const failure = await f.post("activate", activate);
      assert.equal(failure.status, 422);
      assert.equal((await failure.json() as {error:{code:string}}).error.code, "provider_application_key_verification_failed");
      assert.deepEqual(f.account(), pending);
      f.probe.fail = false;
      const activated = await f.post("activate", activate);
      assert.equal(activated.status, 200);
      assert.equal(activated.headers.get("cache-control"), "no-store");
      const activatedView = (await activated.json() as {data:AlipayAccountView}).data;
      assert.equal(activatedView.application_public_key, data.pending_application_key.public_key);
      assert.equal(activatedView.pending_application_key, null);
      assert.equal(activatedView.platform_public_key, nextPlatformPem.trim());
      assert.equal(data.platform_public_key, before.platform_public_key);
      assert.notEqual(activatedView.platform_public_key, before.platform_public_key);
      assert.equal(activatedView.revision, data.revision + 1);
      assert.equal(f.settings.instanceView().payment_revision, instanceRevision);
      assert.equal(activatedView.provider_account_key, before.provider_account_key);
      assert.deepEqual(orderRow(), originalOrder);
      assert.equal((await f.post("activate", activate)).status, 200);
      assert.equal((await f.post("activate", { ...activate, platform_public_key: platformPem })).status, 409);
      assert.equal(f.probe.calls, 2);
      assert.deepEqual(f.probe.publicKeys, [nextPlatformPem.trim(), nextPlatformPem.trim()]);
      assert.equal(f.accounts.store().snapshot("default").provider!.publicKeyPem, nextPlatformPem.trim());
      assert.equal(f.database.integrityCheck().ok, true);
    });
  });

  it("discards only the selected pending key and refuses an obsolete activation", async () => {
    await withFixture(async f => {
      const original = f.account();
      const instanceRevision = f.settings.instanceView().payment_revision;
      const first = f.request();
      assert.equal((await f.post("regenerate", first)).status, 200);
      const discard = { revision: f.account().revision, change_id: first.change_id };
      assert.equal((await f.post("discard", discard)).status, 200);
      assert.equal((await f.post("discard", discard)).status, 200);
      const next = f.request();
      assert.equal((await f.post("regenerate", next)).status, 200);
      assert.equal((await f.post("activate", { revision: f.account().revision, change_id: first.change_id, platform_public_key: nextPlatformPem })).status, 409);
      assert.equal(f.account().pending_application_key!.change_id, next.change_id);
      assert.equal(f.account().application_public_key, original.application_public_key);
      assert.equal(f.settings.instanceView().payment_revision, instanceRevision);
      assert.equal(f.probe.calls, 0);
    });
  });
});
