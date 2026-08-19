import jsQrPackage from "jsqr";

type JsQrDecoder = typeof import("jsqr").default;

// jsQR is CommonJS. Bundlers expose the callable directly, while NodeNext's
// type model wraps it in a default export.
const jsQR = (typeof jsQrPackage === "function"
  ? jsQrPackage
  : (jsQrPackage as unknown as { readonly default: JsQrDecoder }).default) as JsQrDecoder;

export const MAX_QR_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_QR_CANVAS_EDGE = 4096;

const QR_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function validateQrImage(type: string, size: number): void {
  if (!QR_IMAGE_TYPES.has(type)) throw new Error("请选择 PNG、JPG 或 WebP 图片。");
  if (size > MAX_QR_IMAGE_BYTES) throw new Error("二维码图片不能超过 10 MB。");
}

export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return result?.data.trim() || null;
}
