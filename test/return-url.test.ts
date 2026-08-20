import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareReturnUrl, ReturnUrlError } from "../src/orders/return-url.ts";

const ALLOWED_ORIGIN = "https://shop.example.com";

describe("merchant return URL", () => {
  it("normalizes a URL under the configured HTTPS origin", () => {
    assert.equal(
      prepareReturnUrl("https://shop.example.com/orders/paid?source=perpay", ALLOWED_ORIGIN),
      "https://shop.example.com/orders/paid?source=perpay",
    );
    assert.equal(
      prepareReturnUrl("https://shop.example.com", ALLOWED_ORIGIN),
      "https://shop.example.com/",
    );
  });

  it("rejects open redirects and unsafe URL forms", () => {
    for (const value of [
      "https://other.example.com/paid",
      "http://shop.example.com/paid",
      "https://shop.example.com/paid#fragment",
      "https://user:pass@shop.example.com/paid",
      "https://shop.example.com/paid?next=%00",
    ]) {
      assert.throws(
        () => prepareReturnUrl(value, ALLOWED_ORIGIN),
        (error: unknown) => error instanceof ReturnUrlError && error.code === "return_url_not_allowed",
      );
    }
  });

  it("requires a configured merchant origin", () => {
    assert.throws(
      () => prepareReturnUrl("https://shop.example.com/paid", null),
      (error: unknown) => error instanceof ReturnUrlError && error.code === "return_url_not_allowed",
    );
  });
});
