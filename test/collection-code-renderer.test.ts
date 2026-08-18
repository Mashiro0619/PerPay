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
