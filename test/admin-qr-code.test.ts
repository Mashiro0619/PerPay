import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encode } from "uqr";

import {
  decodeQrPixels,
  MAX_QR_IMAGE_BYTES,
  MAX_QR_CANVAS_EDGE,
  validateQrImage,
} from "../web/admin/qr-code.ts";

describe("administrator collection-code image parsing", () => {
  it("accepts supported local image formats within the size limit", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      assert.doesNotThrow(() => validateQrImage(type, MAX_QR_IMAGE_BYTES));
    }
    assert.equal(MAX_QR_IMAGE_BYTES, 10 * 1024 * 1024);
    assert.equal(MAX_QR_CANVAS_EDGE, 4096);
  });

  it("rejects unsupported or oversized files before decoding", () => {
    for (const type of ["image/gif", "image/svg+xml", "application/octet-stream", ""]) {
      assert.throws(() => validateQrImage(type, 100), /PNG、JPG 或 WebP/);
    }
    assert.throws(() => validateQrImage("image/png", MAX_QR_IMAGE_BYTES + 1), /10 MB/);
  });

  it("returns null when pixels do not contain a QR code", () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    assert.equal(decodeQrPixels(pixels, 32, 32), null);
  });

  it("decodes a valid QR image to its original text", () => {
    const expected = "https://qr.example.test/collection-code";
    const qr = encode(expected, { ecc: "M", border: 4 });
    const scale = 5;
    const side = qr.size * scale;
    const pixels = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const dark = qr.data[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
        const color = dark ? 0 : 255;
        const offset = (y * side + x) * 4;
        pixels[offset] = color;
        pixels[offset + 1] = color;
        pixels[offset + 2] = color;
        pixels[offset + 3] = 255;
      }
    }
    assert.equal(decodeQrPixels(pixels, side, side), expected);
  });
});
