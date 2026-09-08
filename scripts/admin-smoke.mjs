import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function listAdminAssets(directory = resolve("web-dist/admin/assets")) {
  return readdirSync(directory).filter((name) => /\.(?:js|css)$/.test(name)).map((name) => `/admin/assets/${name}`);
}

export async function runAdminSmoke({ baseUrl, password, initialize = false, isolated = false, assets = [], request = fetch }) {
  const origin = new URL(baseUrl);
  assert.equal(isolated, true, "admin smoke requires an explicitly isolated instance");
  assert.ok(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "admin smoke only accepts loopback HTTP");
  assert.ok(typeof password === "string" && password.length >= 24, "provide a random temporary administrator password");
  const send = (path, options = {}) => request(new URL(path, origin).href, { redirect: "error", signal: AbortSignal.timeout(15000), ...options });
  const jsonHeaders = { "content-type": "application/json", origin: origin.origin };
  const checkedAssets = new Set(["/admin/theme.js", "/admin/favicon.svg", ...assets]);
  let entryHtml = "";
  for (const path of ["/admin", "/admin/orders", "/admin/settings/security", "/admin/reconciliation", "/admin/notifications"]) {
    const response = await send(path);
    assert.equal(response.status, 200, `${path} must load`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src-attr 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    const html = await response.text();
    assert.doesNotMatch(html, /__PERPAY_INITIALIZED__|<script(?![^>]*\bsrc=)/);
    assert.match(html, /src="\/admin\/theme\.js"/);
    for (const match of html.matchAll(/(?:src|href)="(\/admin\/[^"?#]+\.(?:js|css|svg))"/g)) checkedAssets.add(match[1]);
    if (path === "/admin") entryHtml = html;
  }
  for (const path of checkedAssets) {
    const response = await send(path);
    assert.equal(response.status, 200, `${path} must be in the image`);
    assert.match(response.headers.get("content-type") ?? "", path.endsWith(".js") ? /javascript/ : path.endsWith(".css") ? /text\/css/ : /image\/svg/);
    assert.match(response.headers.get("cache-control") ?? "", path.startsWith("/admin/assets/") ? /immutable/ : /must-revalidate/);
    assert.doesNotMatch(await response.text(), /a-secure-local-password|browser-fixture-only|Isolated synthetic admin fixtures/);
    assert.equal((await send(path, { headers: { "if-none-match": response.headers.get("etag") } })).status, 304);
  }
  for (const path of ["/admin/assets/missing.js", "/admin/src/main.tsx", "/admin/theme.js.map", "/admin/package.json"]) {
    assert.equal((await send(path)).status, 404);
  }
  assert.equal((await send("/api/admin/v1/orders")).status, 401);
  if (initialize) {
    assert.match(entryHtml, /name="perpay-initialized" content="false"/, "refusing to initialize an existing administrator");
    const setup = await send("/api/admin/v1/setup", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ password }) });
    assert.equal(setup.status, 204);
    assert.equal(setup.headers.getSetCookie().length, 0);
    const repeated = await send("/api/admin/v1/setup", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ password }) });
    assert.equal(repeated.status, 409);
  } else {
    assert.match(entryHtml, /name="perpay-initialized" content="true"/);
  }
  const login = await send("/api/admin/v1/session/login", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => /^perpay_session=/.test(cookie) && /httponly/i.test(cookie)));
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = cookies.find((value) => value.startsWith("perpay_csrf="))?.split(";", 1)[0]?.slice("perpay_csrf=".length);
  assert.ok(csrf);
  const headers = { ...jsonHeaders, cookie, "x-csrf-token": decodeURIComponent(csrf) };
  assert.equal((await send("/api/admin/v1/session", { headers })).status, 200);
  const status = await send("/api/admin/v1/system/status", { headers });
  assert.equal(status.status, 200);
  const instanceId = (await status.json()).data.instance_id;
  for (const path of ["/api/admin/v1/orders", "/api/admin/v1/work-items", "/api/admin/v1/system/analytics?range=30"]) {
    const response = await send(path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    if (path.includes("analytics")) {
      assert.equal(payload.data.daily.length, 30);
      assert.match(payload.data.from, /T16:00:00\.000Z$/);
      assert.match(payload.data.to, /T16:00:00\.000Z$/);
      assert.equal(Date.parse(payload.data.to) - Date.parse(payload.data.from), 30 * 86_400_000);
      assert.ok(payload.data.daily.every((day) => day.orders_created === 0 && day.confirmed_amount_cents === 0));
    } else assert.deepEqual(payload.data, []);
  }
  const settingsResponse = await send("/api/admin/v1/settings", { headers });
  assert.equal(settingsResponse.status, 200);
  const settings = (await settingsResponse.json()).data;
  const backup = { revision: settings.revision, interval_seconds: 3600, keep_count: 3 };
  if (initialize) {
    const unprotected = await send("/api/admin/v1/settings/backup", { method: "PUT", headers: { ...jsonHeaders, cookie }, body: JSON.stringify(backup) });
    assert.equal(unprotected.status, 403);
    const wrongOrigin = await send("/api/admin/v1/settings/backup", { method: "PUT", headers: { ...headers, origin: "https://invalid.example" }, body: JSON.stringify(backup) });
    assert.equal(wrongOrigin.status, 403);
    const save = await send("/api/admin/v1/settings/backup", { method: "PUT", headers, body: JSON.stringify(backup) });
    assert.equal(save.status, 200);
    const saved = (await save.json()).data;
    assert.ok(saved.revision > settings.revision);
    assert.deepEqual(saved.backup, { interval_seconds: 3600, keep_count: 3 });
    const stale = await send("/api/admin/v1/settings/backup", { method: "PUT", headers, body: JSON.stringify(backup) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "settings_revision_conflict");
  } else {
    assert.deepEqual(settings.backup, { interval_seconds: 3600, keep_count: 3 }, "saved configuration must survive restart and restore");
  }
  const logout = await send("/api/admin/v1/session/logout", { method: "POST", headers, body: "{}" });
  assert.equal(logout.status, 204);
  assert.equal((await send("/api/admin/v1/session", { headers })).status, 401);
  assert.equal((await send("/healthz")).status, 200);
  return { instanceId, assetsChecked: checkedAssets.size, mode: initialize ? "initialize" : "verify" };
}

if (process.argv[1] === "-" || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  const mode = process.argv[2];
  assert.ok(mode === "initialize" || mode === "verify", "usage: node scripts/admin-smoke.mjs initialize|verify");
  for (const path of ["test", "web", "src", "scripts"]) assert.equal(existsSync(path), false, `${path} must not ship in the runtime image`);
  const result = await runAdminSmoke({
    baseUrl: process.env.PERPAY_PUBLIC_URL ?? "http://localhost:6190",
    password: process.env.PERPAY_SMOKE_PASSWORD,
    isolated: process.env.PERPAY_SMOKE_ISOLATED === "1",
    initialize: mode === "initialize",
    assets: listAdminAssets(),
  });
  console.log(JSON.stringify({ adminSmoke: "passed", ...result }));
}
