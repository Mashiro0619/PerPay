import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderAdminPage } from "../src/http/web/admin.ts";
import { WEB_ASSET_URLS } from "../src/http/web/assets.ts";

describe("admin page renderer", () => {
  it("renders a minimal same-origin React entry with the CSP nonce", () => {
    const html = renderAdminPage("login", "unique-nonce-value");

    assert.match(html, /id="perpay-admin-root" data-mode="login"/);
    assert.match(html, /<meta name="csp-nonce" content="unique-nonce-value">/);
    assert.match(html, new RegExp(`src="${escapeRegExp(WEB_ASSET_URLS.adminScript)}" defer`));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
    assert.doesNotMatch(html, /\sstyle=/i);
  });

  it("selects the application shell without server-rendering credentials", () => {
    const html = renderAdminPage("application", "application-nonce");

    assert.match(html, /data-mode="application"/);
    assert.doesNotMatch(html, /name="password"|autocomplete="current-password"/);
  });

  it("selects first-time password setup without a setup code or username", () => {
    const html = renderAdminPage("setup", "setup-nonce");

    assert.match(html, /data-mode="setup"/);
    assert.doesNotMatch(html, /setup-code|setup-token|login-username/i);
  });

  it("escapes a nonce before placing it in HTML", () => {
    const html = renderAdminPage("login", `nonce\"><script>`);

    assert.match(html, /content="nonce&quot;&gt;&lt;script&gt;"/);
    assert.doesNotMatch(html, /<meta[^>]+><script>/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
