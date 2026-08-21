import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

import { HTTP_ERROR_CODES } from "../src/http/error-codes.ts";

const openapi = parse(
  readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"),
);

test("OpenAPI error envelope covers every HTTP error code", () => {
  const errorCode = openapi.components?.schemas?.ErrorCode;
  assert.deepEqual(errorCode, {
    type: "string",
    enum: [...HTTP_ERROR_CODES],
  });

  const code = openapi.components?.schemas?.ErrorEnvelope?.properties?.error?.properties?.code;
  assert.deepEqual(code, { $ref: "#/components/schemas/ErrorCode" });
});
