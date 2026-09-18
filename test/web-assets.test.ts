import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  WEB_ASSET_PATHS,
  WEB_ASSET_URLS,
  webAsset,
} from "../src/http/web/assets.ts";
function text(path: string): string {
  const asset = webAsset(path);
  assert.ok(asset);
  return typeof asset.body === "string"
    ? asset.body
    : Buffer.from(asset.body).toString("utf8");
}
describe("web asset build manifest", () => {
  it("serves only registered, fingerprinted assets with complete SHA-256 ETags", () => {
    assert.ok(WEB_ASSET_PATHS.length >= 3);
    assert.equal(new Set(WEB_ASSET_PATHS).size, WEB_ASSET_PATHS.length);
    for (const path of WEB_ASSET_PATHS) {
      assert.match(
        path,
        /^\/assets\/(?:app\/[0-9a-f]{64}\/alipay\.png|checkout\/(?:assets\/[\w.-]+-[\w-]+\.(?:js|css|woff2)|theme-[0-9a-f]+\.js))$/,
      );
      const asset = webAsset(path);
      assert.ok(asset);
      assert.equal(
        asset.etag,
        '"' + createHash("sha256").update(asset.body).digest("base64url") + '"',
      );
    }
  });
  it("never publishes the private SSR renderer, source files, source maps or build manifests", () => {
    for (const path of [
      "/assets/checkout/renderer.cjs",
      "/assets/checkout/checkout-ssr/renderer.cjs",
      "/assets/checkout/.vite/manifest.json",
      "/assets/checkout/src/checkout/entry-server.tsx",
      WEB_ASSET_URLS.checkoutScript + ".map",
      "/assets/vendor/legacy/legacy.min.css",
      "/assets/app/checkout.js",
      "/assets/app/checkout.css",
    ])
      assert.equal(webAsset(path), null, path);
    assert.ok(
      WEB_ASSET_PATHS.every((path) => !/\.(?:cjs|map|tsx?|json)$/.test(path)),
    );
  });
  it("retains the original content-addressed icon without unrelated image changes", () => {
    const asset = webAsset(WEB_ASSET_URLS.alipayIcon);
    assert.ok(asset);
    assert.equal(asset.contentType, "image/png");
    assert.ok(asset.body instanceof Uint8Array);
    assert.deepEqual(
      [...asset.body.slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.ok(asset.body.byteLength < 16 * 1024);
  });
  it("builds official theme styles with a no-JavaScript dark fallback", () => {
    const css = text(WEB_ASSET_URLS.checkoutStylesheet);
    assert.match(css, /prefers-color-scheme:dark|prefers-color-scheme: dark/);
    assert.match(css, /:root:not\(\[data-theme\]\)/);
    assert.match(css, /--background/);
    assert.doesNotMatch(css, /checkout-receipt-body|data-palette/);
  });
  it("keeps the checkout client independent from administration and secret workflows", () => {
    const scripts = WEB_ASSET_PATHS.filter(
      (path) => path.startsWith("/assets/checkout/") && path.endsWith(".js"),
    )
      .map(text)
      .join("\n");
    assert.doesNotMatch(
      scripts,
      /\/api\/admin|refund_mark|provider_private_key|rotateApiClientSecret|sourceMappingURL/,
    );
    assert.match(scripts, /pagehide/);
    assert.match(scripts, /visibilitychange/);
  });
  it("bundles the SSR runtime instead of requiring pruned frontend development dependencies", () => {
    const ssr = readFileSync(
      new URL("../web-dist/checkout-ssr/renderer.cjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      ssr,
      /require\(["'](?:react(?:-dom)?(?:\/[^"']*)?|@base-ui\/react(?:\/[^"']*)?)["']\)/,
    );
  });
});
