import { validateHeaderValue as validateNodeHeaderValue } from "node:http";

import type { V3Headers } from "./types.ts";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024;
const MAX_HEADER_FIELDS = 128;

interface NormalizeV3HeadersOptions {
  readonly allowArrays?: boolean;
}

/** Validate, lowercase, defensively copy, and deeply freeze HTTP headers. */
export function normalizeV3Headers(
  value: unknown,
  options: { readonly allowArrays: false },
): Readonly<Record<string, string>>;
export function normalizeV3Headers(
  value: unknown,
  options?: NormalizeV3HeadersOptions,
): V3Headers;
export function normalizeV3Headers(
  value: unknown,
  options: NormalizeV3HeadersOptions = {},
): V3Headers {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("headers must be an object");
  }
  const normalized = Object.create(null) as Record<string, string | readonly string[]>;
  let totalBytes = 2; // The empty line terminating the HTTP/1 header block.
  let fieldCount = 0;
  for (const [originalName, originalValue] of Object.entries(value)) {
    const name = originalName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(originalName) || normalized[name] !== undefined) {
      throw new TypeError("header names must be unique valid HTTP tokens");
    }
    if (typeof originalValue === "string") {
      ({ fieldCount, totalBytes } = accountHeaderField(name, originalValue, fieldCount, totalBytes));
      normalized[name] = originalValue;
    } else {
      if (!Array.isArray(originalValue) || originalValue.length === 0) {
        throw new TypeError("header values must be strings or non-empty string arrays");
      }
      if (options.allowArrays === false) {
        throw new TypeError("header arrays are not allowed");
      }
      if (originalValue.length > MAX_HEADER_FIELDS - fieldCount) {
        throw new TypeError("headers contain too many fields");
      }
      const values = originalValue.map((item) => {
        if (typeof item !== "string") {
          throw new TypeError("header array values must be strings");
        }
        ({ fieldCount, totalBytes } = accountHeaderField(name, item, fieldCount, totalBytes));
        return item;
      });
      normalized[name] = Object.freeze(values);
    }
  }
  return Object.freeze(normalized);
}

function accountHeaderField(
  name: string,
  value: string,
  currentFieldCount: number,
  currentTotalBytes: number,
): { readonly fieldCount: number; readonly totalBytes: number } {
  validateNodeHeaderValue(name, value);
  const valueBytes = Buffer.byteLength(value, "latin1");
  if (valueBytes > MAX_HEADER_VALUE_BYTES) {
    throw new TypeError("header value exceeds the supported size");
  }
  const fieldCount = currentFieldCount + 1;
  if (fieldCount > MAX_HEADER_FIELDS) throw new TypeError("headers contain too many fields");

  // `name: value\r\n`, with token names restricted to single-byte ASCII.
  const totalBytes = currentTotalBytes + name.length + 2 + valueBytes + 2;
  if (totalBytes > MAX_HEADERS_BYTES) throw new TypeError("headers exceed the supported size");
  return { fieldCount, totalBytes };
}
