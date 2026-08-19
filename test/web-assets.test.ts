import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { WEB_ASSET_PATHS, WEB_ASSET_URLS, webAsset } from "../src/http/web/assets.ts";
import { mergeTestPaymentOrder, testPaymentTerminal } from "../web/admin/test-payment.ts";

describe("web asset manifest", () => {
  it("binds every immutable URL to the complete SHA-256 digest of its content", () => {
    assert.equal(WEB_ASSET_PATHS.length, 3);
    assert.equal(new Set(WEB_ASSET_PATHS).size, WEB_ASSET_PATHS.length);

    for (const path of Object.values(WEB_ASSET_URLS)) {
      const match = /^\/assets\/app\/([0-9a-f]{64})\/[^/]+$/.exec(path);
      assert.ok(match, `asset path is not content addressed: ${path}`);
      const asset = webAsset(path);
      assert.ok(asset);
      assert.equal(match[1], createHash("sha256").update(asset.body, "utf8").digest("hex"));
    }
  });

  it("does not serve former version-only or vendor paths", () => {
    assert.equal(webAsset("/assets/app/v0.1.0/admin.js"), null);
    assert.equal(webAsset("/assets/vendor/legacy/legacy.min.css"), null);
  });

  it("bundles the complete MUI admin workflows", () => {
    const script = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(script);
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
    ]) assert.ok(script.includes(expected), `admin bundle is missing ${expected}`);
    assert.doesNotMatch(script, /模拟到账|模拟确认/);
  });

  it("keeps a final not-found checkout inert across browser lifecycle events", () => {
    const checkoutScript = webAsset(WEB_ASSET_URLS.checkoutScript)?.body;
    assert.ok(checkoutScript);

    class FakeHTMLElement {
      readonly dataset: Record<string, string> = {
        checkoutApiUrl: "", checkoutQrUrl: "", initialState: "NOT_FOUND",
        refundStatus: "NONE", retryAfterSeconds: "",
      };
      querySelector(): null { return null; }
    }
    class FakeHTMLDialogElement extends FakeHTMLElement {}
    class FakeHTMLImageElement extends FakeHTMLElement {}
    class FakeHTMLTimeElement extends FakeHTMLElement {}
    class FakeHTMLAnchorElement extends FakeHTMLElement {}

    const root = new FakeHTMLElement();
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
