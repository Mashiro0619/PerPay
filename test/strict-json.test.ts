import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseStrictJson, StrictJsonError } from "../src/http/strict-json.ts";

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

describe("strict JSON parsing", () => {
  it("accepts ordinary JSON without requiring canonical whitespace or key order", () => {
    assert.deepEqual(parseStrictJson(bytes(' { "b": 2, "a": [true, null] }\n')), {
      b: 2,
      a: [true, null],
    });
  });

  it("rejects duplicate decoded keys at every object depth", () => {
    for (const input of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"outer":{"x":1,"x":2}}',
      '[{"x":1,"x":2}]',
    ]) {
      assert.throws(
        () => parseStrictJson(bytes(input)),
        (error: unknown) => error instanceof StrictJsonError && error.code === "DUPLICATE_KEY",
      );
    }
  });

  it("handles escaped quotes and backslashes without inventing duplicate boundaries", () => {
    assert.deepEqual(parseStrictJson(bytes('{"a\\\"b":1,"a\\\\b":2}')), {
      'a"b': 1,
      "a\\b": 2,
    });
  });

  it("rejects invalid UTF-8, invalid syntax, and excessive nesting", () => {
    assert.throws(
      () => parseStrictJson(new Uint8Array([0xff])),
      (error: unknown) => error instanceof StrictJsonError && error.code === "INVALID_UTF8",
    );
    assert.throws(
      () => parseStrictJson(bytes('{"a":}')),
      (error: unknown) => error instanceof StrictJsonError && error.code === "INVALID_JSON",
    );
    assert.throws(
      () => parseStrictJson(bytes('[[[0]]]'), 2),
      (error: unknown) => error instanceof StrictJsonError && error.code === "TOO_DEEP",
    );
  });
});
