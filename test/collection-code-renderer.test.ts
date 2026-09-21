import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CollectionCodeSvgCache,
  renderCollectionCodeSvg,
} from "../src/http/web/collection-code.ts";
import { MAX_COLLECTION_CODE_PAYLOAD_BYTES } from "../src/orders/collection-profile.ts";

describe("collection code renderer", () => {
  it("renders the tested ECC M byte-capacity boundary", () => {
    const asciiBoundary = "a".repeat(MAX_COLLECTION_CODE_PAYLOAD_BYTES);
    const mixedBoundary = "收".repeat(777);

    assert.equal(Buffer.byteLength(asciiBoundary, "utf8"), MAX_COLLECTION_CODE_PAYLOAD_BYTES);
    assert.equal(Buffer.byteLength(mixedBoundary, "utf8"), MAX_COLLECTION_CODE_PAYLOAD_BYTES);
    assert.match(renderCollectionCodeSvg(asciiBoundary), /^<svg/);
    assert.match(renderCollectionCodeSvg(mixedBoundary), /^<svg/);
  });

  it("includes exactly four white modules around small and dense QR symbols", () => {
    for (const payload of ["https://qr.alipay.com/example", "a".repeat(1800)]) {
      const svg = renderCollectionCodeSvg(payload);
      const dimensions = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      assert.ok(dimensions);
      const width = Number(dimensions[1]);
      assert.equal(width, Number(dimensions[2]));
      const modules = [...svg.matchAll(/M(\d+),(\d+)h(\d+)v(\d+)h-\d+z/g)]
        .map((match) => ({ x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) }));
      assert.ok(modules.length > 0);
      assert.ok(modules.every((module) => module.size === 8));
      assert.equal(Math.min(...modules.map((module) => module.x)), 4 * 8);
      assert.equal(Math.min(...modules.map((module) => module.y)), 4 * 8);
      assert.equal(Math.max(...modules.map((module) => module.x + module.size)), width - 4 * 8);
      assert.equal(Math.max(...modules.map((module) => module.y + module.size)), width - 4 * 8);
      assert.match(svg, /<rect fill="#ffffff"/);
    }
  });

  it("turns an oversized or malformed payload into a bounded renderer error", () => {
    assert.throws(
      () => renderCollectionCodeSvg("a".repeat(MAX_COLLECTION_CODE_PAYLOAD_BYTES + 1)),
      { name: "CollectionCodeRenderError" },
    );
    assert.throws(
      () => renderCollectionCodeSvg(`valid-prefix-${"\ud800"}`),
      { name: "CollectionCodeRenderError" },
    );
  });

  it("reuses rendered SVGs and evicts the least recently used payload", () => {
    let renderCount = 0;
    const cache = new CollectionCodeSvgCache(2, (payload) => {
      renderCount += 1;
      return `<svg data-payload="${payload}"></svg>`;
    });

    assert.equal(cache.render("first"), '<svg data-payload="first"></svg>');
    assert.equal(cache.render("second"), '<svg data-payload="second"></svg>');
    assert.equal(cache.render("first"), '<svg data-payload="first"></svg>');
    assert.equal(renderCount, 2);

    cache.render("third");
    cache.render("second");
    assert.equal(renderCount, 4);
  });
});
