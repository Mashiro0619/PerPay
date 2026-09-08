import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { loadAdminFrontend } from "../src/http/web/admin.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

describe("administrator frontend delivery", () => {
  it("loads only build assets and emits a non-secret initialization flag", () => {
    const frontend = loadAdminFrontend();
    assert.ok(frontend, "run npm run build:admin before this test");
    assert.match(frontend.render(false), /name="perpay-initialized" content="false"/);
    assert.match(frontend.render(true), /name="perpay-initialized" content="true"/);
    assert.doesNotMatch(frontend.render(true), /__PERPAY_INITIALIZED__|<script(?![^>]*\bsrc=)/);
    assert.ok(frontend.assets.has("/admin/favicon.svg"));
    assert.ok(frontend.assets.has("/admin/theme.js"));
    const html = frontend.render(true);
    assert.ok(html.indexOf('src="/admin/theme.js"') < html.indexOf('<script type="module"'));
    assert.ok([...frontend.assets.keys()].some((path) => /^\/admin\/assets\/.+\.js$/.test(path)));
    assert.ok([...frontend.assets.keys()].every((path) => !path.endsWith(".map") && !path.includes("..")));
  });

  it("handles a missing frontend build without breaking the API module", () => {
    assert.equal(loadAdminFrontend(new URL("./missing-admin-build/", import.meta.url)), null);
  });

  it("serves deep links and immutable assets without weakening CSP or exposing files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-admin-frontend-"));
    const apiSecret = Buffer.alloc(32, 0xa7).toString("base64url");
    const services = await createConfiguredHttpServices({ directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/frontend-test" });
    try {
      const app = createApp({ ...services, startedAt: new Date() });
      for (const path of ["/admin", "/admin/", "/admin/orders", "/admin/settings/security"]) {
        const response = await app.request(path);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const policy = response.headers.get("content-security-policy") ?? "";
        assert.match(policy, /script-src 'self'/);
        assert.match(policy, /style-src-attr 'none'/);
        assert.match(policy, /frame-ancestors 'none'/);
        assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
        assert.doesNotMatch(await response.text(), new RegExp(apiSecret));
      }
      const frontend = loadAdminFrontend();
      assert.ok(frontend);
      const path = [...frontend.assets.keys()].find((asset) => asset.startsWith("/admin/assets/") && asset.endsWith(".js"));
      assert.ok(path);
      const asset = await app.request(path);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);
      assert.equal((await app.request(path, { headers: { "if-none-match": asset.headers.get("etag")! } })).status, 304);
      const theme = await app.request("/admin/theme.js");
      assert.equal(theme.status, 200);
      assert.equal(theme.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      assert.match(theme.headers.get("content-type") ?? "", /javascript/);
      for (const missing of ["/admin/assets/missing.js", "/admin/src/main.tsx", "/admin/assets/%2e%2e%2fpackage.json", "/admin/assets/missing.js.map"]) {
        assert.equal((await app.request(missing)).status, 404);
      }
      assert.equal((await app.request("/api/admin/v1/orders")).status, 401);
      assert.equal((await app.request("/healthz")).status, 200);
    } finally {
      services.database.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("perpay-admin-frontend-"));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
