import { isValidWebhookDnsHostname } from "../infrastructure/network/public-address.ts";
import { MAX_RETURN_URL_BYTES } from "./model.ts";

const controlCharacterPattern = /\p{Cc}/u;

export type ReturnUrlErrorCode = "return_url_invalid" | "return_url_not_allowed";

export class ReturnUrlError extends Error {
  readonly code: ReturnUrlErrorCode;

  constructor(code: ReturnUrlErrorCode) {
    super(code);
    this.name = "ReturnUrlError";
    this.code = code;
  }
}

/**
 * Normalizes a browser return target and pins it to the configured merchant
 * origin. The returned value is safe to render as an escaped anchor href.
 */
export function prepareReturnUrl(value: string, allowedOrigin: string | null): string {
  if (
    value !== value.trim() ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RETURN_URL_BYTES ||
    controlCharacterPattern.test(value)
  ) {
    throw new ReturnUrlError("return_url_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReturnUrlError("return_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#") ||
    value.endsWith("?") ||
    url.hash !== "" ||
    !isValidWebhookDnsHostname(url.hostname) ||
    allowedOrigin === null ||
    url.origin !== allowedOrigin ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(`${url.pathname}${url.search}`)
  ) {
    throw new ReturnUrlError("return_url_not_allowed");
  }
  const normalized = url.toString();
  if (Buffer.byteLength(normalized, "utf8") > MAX_RETURN_URL_BYTES) {
    throw new ReturnUrlError("return_url_invalid");
  }
  return normalized;
}
