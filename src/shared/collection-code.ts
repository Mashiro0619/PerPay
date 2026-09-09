/** Shared by the settings API and admin UI; never verifies the recipient account. */
export const MAX_COLLECTION_CODE_PAYLOAD_BYTES = 2_331;

export function collectionCodeError(value: string): string | null {
  if (new TextEncoder().encode(value).length > MAX_COLLECTION_CODE_PAYLOAD_BYTES) {
    return "经营码内容不能超过 2331 个 UTF-8 字节。";
  }
  // Alipay's original QR links may use uppercase characters or HTTP. Preserve
  // the payload exactly; do not turn arbitrary URLs or app-launch links into codes.
  if (/[\ud800-\udfff]/u.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value) ||
      !/^https?:\/\/qr\.alipay\.com\/[A-Za-z0-9_-]+(?:\?[^#]*)?$/i.test(value)) {
    return "请使用支付宝经营码，内容应为 qr.alipay.com 开头的完整收款链接。";
  }
  return null;
}
