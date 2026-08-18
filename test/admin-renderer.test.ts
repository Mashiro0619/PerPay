import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderAdminPage } from "../src/http/web/admin.ts";
import { WEB_ASSET_URLS } from "../src/http/web/assets.ts";

describe("admin page renderer", () => {
  it("uses a POST fallback for credentials and only same-origin external scripts", () => {
    const html = renderAdminPage("login");

    assert.match(
      html,
      /<form[^>]*id="login-form"[^>]*action="\/api\/admin\/v1\/session\/login"[^>]*method="post"/,
    );
    assert.match(html, new RegExp(`src="${escapeRegExp(WEB_ASSET_URLS.adminScript)}" defer`));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });

  it("renders the application shell separately from the login form", () => {
    const html = renderAdminPage("application");

    assert.match(html, /data-perpay-admin-page="application"/);
    assert.match(html, /id="admin-main"/);
    assert.match(html, /id="step-up-dialog"/);
    assert.doesNotMatch(html, /id="login-form"/);
  });

  it("renders first-time password setup without a setup code or username", () => {
    const html = renderAdminPage("setup");

    assert.match(html, /data-perpay-admin-page="setup"/);
    assert.match(html, /id="setup-password"/);
    assert.match(html, /id="setup-password-confirmation"/);
    assert.doesNotMatch(html, /setup-code|setup-token|login-username/i);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
