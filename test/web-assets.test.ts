import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { WEB_ASSET_PATHS, WEB_ASSET_URLS, webAsset } from "../src/http/web/assets.ts";
import { mergeTestPaymentOrder, testPaymentTerminal } from "../web/admin/test-payment.ts";

describe("web asset manifest", () => {
  it("binds every immutable URL to the complete SHA-256 digest of its content", () => {
    assert.equal(WEB_ASSET_PATHS.length, 4);
    assert.equal(new Set(WEB_ASSET_PATHS).size, WEB_ASSET_PATHS.length);

    for (const path of Object.values(WEB_ASSET_URLS)) {
      const match = /^\/assets\/app\/([0-9a-f]{64})\/[^/]+$/.exec(path);
      assert.ok(match, `asset path is not content addressed: ${path}`);
      const asset = webAsset(path);
      assert.ok(asset);
      assert.equal(match[1], createHash("sha256").update(asset.body).digest("hex"));
    }
  });

  it("does not serve former version-only or vendor paths", () => {
    assert.equal(webAsset("/assets/app/v0.1.0/admin.js"), null);
    assert.equal(webAsset("/assets/vendor/legacy/legacy.min.css"), null);
  });

  it("serves the optimized Alipay icon as a content-addressed PNG", () => {
    const icon = webAsset(WEB_ASSET_URLS.alipayIcon);
    assert.ok(icon);
    assert.equal(icon.contentType, "image/png");
    assert.ok(icon.body instanceof Uint8Array);
    assert.deepEqual([...icon.body.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(icon.body.byteLength < 16 * 1024);
  });

  it("ships system theme tokens and a mobile-first checkout payment order", () => {
    const stylesheet = webAsset(WEB_ASSET_URLS.checkoutStylesheet)?.body;
    assert.equal(typeof stylesheet, "string");
    if (typeof stylesheet !== "string") return;
    assert.match(stylesheet, /@media \(prefers-color-scheme: dark\)/);
    assert.match(stylesheet, /color-scheme: light dark/);
    assert.match(stylesheet, /grid-template-areas:\s*"summary"\s*"payment"\s*"details"/);
    assert.match(stylesheet, /@media \(min-width: 801px\)[\s\S]*grid-template-areas:\s*"summary payment"\s*"details payment"/);
    assert.match(stylesheet, /\.checkout-manual-refresh\s*\{[^}]*min-height: 44px/s);
    assert.match(stylesheet, /@media \(max-width: 560px\)[\s\S]*\.checkout-code-figure img\s*\{[^}]*232px/s);
    assert.match(stylesheet, /env\(safe-area-inset-top\)/);
    assert.match(stylesheet, /env\(safe-area-inset-bottom\)/);
  });

  it("bundles the complete MUI admin workflows", () => {
    const script = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.equal(typeof script, "string");
    if (typeof script !== "string") return;
    for (const expected of [
      "/settings/provider/application-key/actions/generate",
      "/settings/advanced",
      "/settings/api-key/actions/rotate",
      "/test-payments",
      "/reconciliation/settlements/manual",
      "/actions/reverse",
      "/actions/redeliver",
      "生成应用密钥",
      "复制应用公钥",
      "这是实际到账测试",
      "最终应付金额",
      "继续上次测试",
      "/admin/integration",
      "网站接入",
      "PERPAY-HMAC-SHA256",
      "/api/v1/orders",
      "x-perpay-webhook-signature",
      "event_id",
    ]) assert.ok(script.includes(expected), `admin bundle is missing ${expected}`);
    assert.doesNotMatch(script, /模拟到账|模拟确认/);
  });

  it("keeps administrator navigation, password fields, and settings sections client-side", () => {
    const script = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.equal(typeof script, "string");
    if (typeof script !== "string") return;
    for (const expected of [
      "pushState",
      "popstate",
      "data-page-title",
      "admin-login-password",
      "current-password",
      "admin-setup-password",
      "password_confirmation",
      "admin-new-password",
      "new_password_confirmation",
      "/admin/settings?section=",
      "collection",
      "provider",
      "api",
      "notifications",
      "advanced",
      "secrets",
      "image/png,image/jpeg,image/webp",
    ]) assert.ok(script.includes(expected), `admin bundle is missing ${expected}`);
    assert.doesNotMatch(script, /location\.reload|image\/gif|再次输入管理员密码|step_up_required|session\/step-up/);
  });

  it("keeps a final not-found checkout inert across browser lifecycle events", () => {
    const checkoutScript = webAsset(WEB_ASSET_URLS.checkoutScript)?.body;
    assert.equal(typeof checkoutScript, "string");
    if (typeof checkoutScript !== "string") return;

    class FakeHTMLElement {
      readonly dataset: Record<string, string> = {
        checkoutApiUrl: "", checkoutQrUrl: "", initialState: "NOT_FOUND",
        refundStatus: "NONE", retryAfterSeconds: "",
      };
      readonly children = new Map<string, FakeHTMLElement>();
      hidden = false;
      textContent = "";
      querySelector(selector: string): FakeHTMLElement | null {
        return this.children.get(selector) ?? null;
      }
    }
    class FakeHTMLDialogElement extends FakeHTMLElement {}
    class FakeHTMLImageElement extends FakeHTMLElement {}
    class FakeHTMLTimeElement extends FakeHTMLElement {}
    class FakeHTMLAnchorElement extends FakeHTMLElement {}

    const root = new FakeHTMLElement();
    const routeError = new FakeHTMLElement();
    const routeErrorTitle = new FakeHTMLElement();
    routeErrorTitle.textContent = "找不到这个订单";
    routeError.children.set("[data-route-error-title]", routeErrorTitle);
    root.children.set("[data-route-error]", routeError);
    const documentListeners = new Map<string, () => void>();
    const windowListeners = new Map<string, () => void>();
    let fetchCount = 0;
    const document = {
      activeElement: null, hidden: false, title: "",
      querySelector: (selector: string) => selector === "[data-checkout-root]" ? root : null,
      addEventListener: (name: string, listener: () => void) => documentListeners.set(name, listener),
    };
    const window = {
      location: { origin: "https://checkout.example.test" },
      addEventListener: (name: string, listener: () => void) => windowListeners.set(name, listener),
      setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
      requestAnimationFrame(callback: () => void) { callback(); return 1; },
    };
    runInNewContext(checkoutScript, {
      AbortController, Date, HTMLAnchorElement: FakeHTMLAnchorElement,
      HTMLDialogElement: FakeHTMLDialogElement, HTMLElement: FakeHTMLElement,
      HTMLImageElement: FakeHTMLImageElement, HTMLTimeElement: FakeHTMLTimeElement,
      Math, Number, Object, Promise, String, URL, document,
      fetch() { fetchCount += 1; return new Promise(() => undefined); },
      navigator: { onLine: true }, window,
    });
    documentListeners.get("visibilitychange")?.();
    windowListeners.get("online")?.();
    assert.equal(fetchCount, 0);
    assert.equal(routeErrorTitle.textContent, "找不到这个订单");
  });

  it("coalesces repeated manual checkout status checks", () => {
    const checkoutScript = webAsset(WEB_ASSET_URLS.checkoutScript)?.body;
    assert.equal(typeof checkoutScript, "string");
    if (typeof checkoutScript !== "string") return;

    class FakeHTMLElement {
      readonly dataset: Record<string, string> = {};
      readonly listeners = new Map<string, () => void>();
      readonly attributes = new Map<string, string>();
      hidden = false;
      disabled = false;
      textContent = "";
      querySelector(_selector: string): FakeHTMLElement | null { return null; }
      addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
      setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
      toggleAttribute(name: string, force: boolean): void {
        if (force) this.attributes.set(name, "");
        else this.attributes.delete(name);
      }
      click(): void { this.listeners.get("click")?.(); }
    }
    class FakeHTMLDialogElement extends FakeHTMLElement {}
    class FakeHTMLImageElement extends FakeHTMLElement {}
    class FakeHTMLTimeElement extends FakeHTMLElement {}
    class FakeHTMLAnchorElement extends FakeHTMLElement {}

    const label = new FakeHTMLElement();
    label.textContent = "立即检查支付状态";
    const button = new FakeHTMLElement();
    button.querySelector = (selector: string) =>
      selector === "[data-checkout-refresh-label]" ? label : null;
    const content = new FakeHTMLElement();
    const root = new FakeHTMLElement();
    root.dataset.checkoutApiUrl = "/api/public/v1/checkouts/pct1_manual";
    root.dataset.initialState = "UNPAID";
    root.dataset.refundStatus = "NONE";
    root.dataset.retryAfterSeconds = "";
    root.querySelector = (selector: string) => {
      if (selector === "[data-checkout-content]") return content;
      if (selector === "[data-checkout-refresh]") return button;
      return null;
    };

    let fetchCount = 0;
    const document = {
      activeElement: null, hidden: false, title: "",
      querySelector: (selector: string) => selector === "[data-checkout-root]" ? root : null,
      addEventListener() {},
    };
    const window = {
      location: { origin: "https://checkout.example.test" },
      addEventListener() {},
      setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
      requestAnimationFrame(callback: () => void) { callback(); return 1; },
    };
    runInNewContext(checkoutScript, {
      AbortController, Date, HTMLAnchorElement: FakeHTMLAnchorElement,
      HTMLDialogElement: FakeHTMLDialogElement, HTMLElement: FakeHTMLElement,
      HTMLImageElement: FakeHTMLImageElement, HTMLTimeElement: FakeHTMLTimeElement,
      Math, Number, Object, Promise, String, URL, document,
      fetch() { fetchCount += 1; return new Promise(() => undefined); },
      navigator: { onLine: true }, window,
    });

    button.click();
    button.click();

    assert.equal(fetchCount, 1);
    assert.equal(button.disabled, true);
    assert.equal(button.attributes.get("aria-busy"), "true");
    assert.equal(button.attributes.has("data-loading"), true);
    assert.equal(label.textContent, "正在检查");
  });
});

describe("administrator test-payment browser state", () => {
  it("preserves checkout credentials while applying administrator status refreshes", () => {
    const created = {
      order_id: "12345678-1234-4123-8123-123456789abc",
      checkout: {
        status: "OPEN",
        token: "pct1_test-token",
        state_url: "https://pay.example.test/api/public/v1/checkouts/pct1_test-token",
        checkout_url: "https://pay.example.test/checkout/pct1_test-token",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
      payment: { status: "UNPAID" },
    };
    const refreshed = {
      order_id: created.order_id,
      checkout: { status: "OPEN", expires_at: "2030-01-01T00:00:00.000Z" },
      payment: { status: "UNPAID" },
      version: 2,
    };

    const merged = mergeTestPaymentOrder(created, refreshed);
    assert.equal(merged.checkout.token, created.checkout.token);
    assert.equal(merged.checkout.state_url, created.checkout.state_url);
    assert.equal(merged.checkout.checkout_url, created.checkout.checkout_url);
    assert.equal(merged.version, 2);
    assert.equal(testPaymentTerminal(merged), false);
  });

  it("treats refreshed payment and checkout terminal states as terminal", () => {
    assert.equal(testPaymentTerminal({ payment: { status: "CONFIRMED" }, checkout: { status: "OPEN" } }), true);
    assert.equal(testPaymentTerminal({ payment: { status: "UNPAID" }, checkout: { status: "EXPIRED" } }), true);
  });
});
