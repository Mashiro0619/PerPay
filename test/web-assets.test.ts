import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  WEB_ASSET_PATHS,
  WEB_ASSET_URLS,
  webAsset,
} from "../src/http/web/assets.ts";

describe("web asset manifest", () => {
  it("binds every immutable URL to the complete SHA-256 digest of its content", () => {
    assert.equal(WEB_ASSET_PATHS.length, 6);
    assert.equal(new Set(WEB_ASSET_PATHS).size, WEB_ASSET_PATHS.length);

    for (const path of Object.values(WEB_ASSET_URLS)) {
      const match = /^\/assets\/(?:app|vendor\/usuzumi)\/([0-9a-f]{64})\/[^/]+$/.exec(path);
      assert.ok(match, `asset path is not content addressed: ${path}`);
      const asset = webAsset(path);
      assert.ok(asset);
      assert.equal(
        match[1],
        createHash("sha256").update(asset.body, "utf8").digest("hex"),
      );
    }
  });

  it("does not serve the former version-only immutable paths", () => {
    assert.equal(webAsset("/assets/app/v0.1.0/admin.js"), null);
    assert.equal(webAsset("/assets/vendor/usuzumi/2.3.0/usuzumi.min.css"), null);
  });

  it("exposes the advanced checkout settings form through the admin asset", () => {
    const adminScript = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(adminScript);
    assert.match(adminScript, /settings-advanced-form/);
    assert.match(adminScript, /\/settings\/advanced/);
    assert.match(adminScript, /checkout_key_rotation_days/);
    assert.match(adminScript, /checkout_terminal_observation_seconds/);
  });

  it("keeps a final not-found checkout inert across browser lifecycle events", () => {
    const checkoutScript = webAsset(WEB_ASSET_URLS.checkoutScript)?.body;
    assert.ok(checkoutScript);

    class FakeHTMLElement {
      readonly dataset: Record<string, string> = {
        checkoutApiUrl: "",
        checkoutQrUrl: "",
        initialState: "NOT_FOUND",
        refundStatus: "NONE",
        retryAfterSeconds: "",
      };

      querySelector(): null {
        return null;
      }
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
      activeElement: null,
      hidden: false,
      title: "",
      querySelector(selector: string) {
        return selector === "[data-checkout-root]" ? root : null;
      },
      addEventListener(name: string, listener: () => void) {
        documentListeners.set(name, listener);
      },
    };
    const window = {
      location: { origin: "https://checkout.example.test" },
      addEventListener(name: string, listener: () => void) {
        windowListeners.set(name, listener);
      },
      setInterval() { return 1; },
      clearInterval() {},
      setTimeout() { return 1; },
      clearTimeout() {},
      requestAnimationFrame(callback: () => void) {
        callback();
        return 1;
      },
    };

    runInNewContext(checkoutScript, {
      AbortController,
      Date,
      HTMLAnchorElement: FakeHTMLAnchorElement,
      HTMLDialogElement: FakeHTMLDialogElement,
      HTMLElement: FakeHTMLElement,
      HTMLImageElement: FakeHTMLImageElement,
      HTMLTimeElement: FakeHTMLTimeElement,
      Math,
      Number,
      Object,
      Promise,
      String,
      URL,
      document,
      fetch() {
        fetchCount += 1;
        return new Promise(() => undefined);
      },
      navigator: { onLine: true },
      window,
    });

    documentListeners.get("visibilitychange")?.();
    windowListeners.get("online")?.();
    assert.equal(fetchCount, 0);
  });
});
