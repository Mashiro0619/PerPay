import { isUtf8 } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  createVerify,
  KeyObject,
  randomUUID,
  sign,
  type KeyLike,
} from "node:crypto";

import {
  AlipayProviderError,
  getHeader,
} from "./errors.ts";
import { normalizeV3Headers } from "./headers.ts";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  type RawV3Response,
  type SignedV3Request,
  type V3Headers,
  type V3HttpMethod,
} from "./types.ts";

export interface V3RequestInput {
  readonly method: V3HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly body?: string | Uint8Array;
  readonly requestId?: string | undefined;
  readonly appAuthToken?: string | undefined;
}

export interface V3SignerOptions {
  readonly appId: string;
  readonly privateKey: KeyLike | string;
  readonly appCertSn?: string | undefined;
  readonly alipayRootCertSn?: string | undefined;
  readonly clock?: (() => number) | undefined;
  readonly nonceFactory?: (() => string) | undefined;
  readonly userAgent?: string | undefined;
}

export interface VerifiedV3Response {
  readonly body: string;
  readonly bodyBytes: Buffer;
  readonly headers: V3Headers;
  readonly status: number;
  readonly traceId: string;
  readonly signatureVerified: true;
}

/**
 * Build the exact V3 request string and Authorization header.
 *
 * The resulting `path` is the path that must be sent by the transport. Any
 * transport that changes query ordering or decodes the body after this point
 * would invalidate the signature and is therefore outside this contract.
 */
export function signV3Request(input: V3RequestInput, options: V3SignerOptions): SignedV3Request {
  const method = input.method.toUpperCase() as V3HttpMethod;
  const path = canonicalPath(input.path, input.query);
  const body = normalizeRequestBody(input.body);
  if ((method === "GET" || method === "HEAD") && body !== "") {
    throw signingError("GET and HEAD requests cannot carry a body");
  }
  const appId = requireSafeAuthPart(options.appId, "appId");
  const nonce = requireSafeAuthPart(options.nonceFactory?.() ?? randomUUID(), "nonce");
  const timestamp = options.clock?.() ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw signingError("clock must return a non-negative safe integer");
  }
  const authParts = [`app_id=${appId}`];
  if (options.appCertSn !== undefined) {
    authParts.push(`app_cert_sn=${requireSafeAuthPart(options.appCertSn, "appCertSn")}`);
  }
  authParts.push(`nonce=${nonce}`, `timestamp=${timestamp}`);
  const authString = authParts.join(",");
  const appAuthToken = input.appAuthToken;
  if (appAuthToken !== undefined && /[\r\n]/.test(appAuthToken)) {
    throw signingError("appAuthToken must not contain line breaks");
  }
  let signingString = `${authString}\n${method}\n${path}\n${body}\n`;
  if (appAuthToken !== undefined) signingString += `${appAuthToken}\n`;

  let signature: string;
  try {
    const privateKey = requireRsaKey(options.privateKey, "private");
    signature = sign("RSA-SHA256", Buffer.from(signingString, "utf8"), privateKey).toString("base64");
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "request_signing_failed",
      message: "provider request signing configuration is invalid",
      cause: error,
    });
  }

  const requestId = input.requestId ?? randomUUID();
  if (!requestId || /[\r\n]/.test(requestId)) {
    throw signingError("requestId must be a non-empty value without line breaks");
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `ALIPAY-SHA256withRSA ${authString},sign=${signature}`,
    "alipay-request-id": requestId,
    "user-agent": options.userAgent ?? "perpay-alipay-adapter/1",
  };
  if (body !== "") headers["content-type"] = "application/json";
  if (appAuthToken !== undefined) headers["alipay-app-auth-token"] = appAuthToken;
  if (options.alipayRootCertSn !== undefined) {
    headers["alipay-root-cert-sn"] = requireSafeAuthPart(options.alipayRootCertSn, "alipayRootCertSn");
  }
  return Object.freeze({
    method,
    path,
    body,
    headers: Object.freeze(headers),
    requestId,
  });
}

/**
 * Verify an ordinary V3 JSON response before parsing it. Verification is
 * intentionally independent of JSON shape and retains the exact body.
 */
export function verifyV3Response(
  response: RawV3Response,
  alipayPublicKey: KeyLike | string,
  options: { readonly expectedAlipayCertSn?: string | undefined; readonly requestId?: string | undefined } = {},
): VerifiedV3Response {
  if (
    !response ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    !(response.body instanceof Uint8Array)
  ) {
    throw invalidResponseError("provider response has an invalid transport shape");
  }
  const bodyBytes = responseBodyBytes(response.body);
  const body = bodyBytes.toString("utf8");
  let headers: V3Headers;
  try {
    headers = normalizeV3Headers(response.headers);
  } catch (error) {
    throw invalidResponseError("provider response headers are invalid", error, bodyBytes);
  }
  const requestId = options.requestId ?? "unknown";
  const traceId = getHeader(headers, "alipay-trace-id") ?? requestId;
  const timestamp = getHeader(headers, "alipay-timestamp");
  const nonce = getHeader(headers, "alipay-nonce");
  const signature = getHeader(headers, "alipay-signature");
  if (!timestamp || !nonce || !signature) {
    throw new AlipayProviderError({
      kind: "signature_invalid",
      code: "response_signature_missing",
      message: "provider response signature headers are missing",
      status: response.status,
      traceId,
      rawBody: body,
      responseHeaders: headers,
      signatureVerified: false,
    });
  }
  if (options.expectedAlipayCertSn !== undefined) {
    const serialNumber = getHeader(headers, "alipay-sn");
    if (serialNumber !== options.expectedAlipayCertSn) {
      throw new AlipayProviderError({
        kind: "signature_invalid",
        code: "response_certificate_mismatch",
        message: "provider response certificate does not match the configured certificate",
        status: response.status,
        traceId,
        rawBody: body,
        responseHeaders: headers,
        signatureVerified: false,
      });
    }
  }
  const responseSigningString = `${timestamp}\n${nonce}\n${body}\n`;
  let valid = false;
  try {
    const publicKey = requireRsaKey(alipayPublicKey, "public");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(responseSigningString, "utf8");
    verifier.end();
    valid = verifier.verify(publicKey, Buffer.from(signature, "base64"));
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider response verification configuration is invalid",
      status: response.status,
      traceId,
      rawBody: body,
      responseHeaders: headers,
      cause: error,
    });
  }
  if (!valid) {
    throw new AlipayProviderError({
      kind: "signature_invalid",
      code: "response_signature_invalid",
      message: "provider response signature is invalid",
      status: response.status,
      traceId,
      rawBody: body,
      responseHeaders: headers,
      signatureVerified: false,
    });
  }
  return Object.freeze({
    body,
    bodyBytes,
    headers,
    status: response.status,
    traceId,
    signatureVerified: true as const,
  });
}

/** Utility used by a local fake server and contract tests. */
export function createV3ResponseSignature(
  body: string | Uint8Array,
  timestamp: string,
  nonce: string,
  privateKey: KeyLike | string,
): string {
  const bodyBytes = responseBodyBytes(body);
  const signingString = `${timestamp}\n${nonce}\n${bodyBytes.toString("utf8")}\n`;
  try {
    return sign(
      "RSA-SHA256",
      Buffer.from(signingString, "utf8"),
      requireRsaKey(privateKey, "private"),
    ).toString("base64");
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider response signing configuration is invalid",
      cause: error,
    });
  }
}

export function canonicalPath(
  path: string,
  query: Readonly<Record<string, string | number>> | undefined,
): string {
  if (!path.startsWith("/") || path.includes("#") || /[\u0000-\u0020\u007f]/.test(path)) {
    throw signingError("path must be an absolute encoded path without a fragment or control character");
  }
  const queryEntries = Object.entries(query ?? {});
  for (const [key, value] of queryEntries) {
    if (!key || /[\r\n]/.test(key)) throw signingError("query keys must be non-empty and safe");
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw signingError("query values must be finite");
    }
  }
  const existingSeparator = path.includes("?") ? "&" : "?";
  const encoded = queryEntries
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return encoded ? `${path}${existingSeparator}${encoded}` : path;
}

function normalizeRequestBody(body: string | Uint8Array | undefined): string {
  if (body === undefined) return "";
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  if (!isUtf8(bytes)) throw signingError("request body must be valid UTF-8");
  return bytes.toString("utf8");
}

function responseBodyBytes(body: string | Uint8Array): Buffer {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_body_too_large",
      message: "provider response body exceeds the configured limit",
    });
  }
  if (!isUtf8(bytes)) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_invalid_utf8",
      message: "provider response body is not valid UTF-8",
    });
  }
  return bytes;
}

function requireSafeAuthPart(value: string, name: string): string {
  if (!value || /[\r\n,]/.test(value)) throw signingError(`${name} contains unsafe characters`);
  return value;
}

function signingError(message: string): AlipayProviderError {
  return new AlipayProviderError({
    kind: "configuration",
    code: "request_signing_failed",
    message,
  });
}

function invalidResponseError(
  message: string,
  cause?: unknown,
  rawBody?: Uint8Array,
): AlipayProviderError {
  return new AlipayProviderError({
    kind: "invalid_response",
    code: "response_invalid_shape",
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(rawBody === undefined ? {} : { rawBody }),
  });
}

// Keep these imports exercised in environments that pass raw PEM strings while
// making malformed keys fail at the adapter boundary rather than in a request.
export function validateV3Keys(privateKey: KeyObject | string, publicKey: KeyObject | string): void {
  try {
    requireRsaKey(privateKey, "private");
    requireRsaKey(publicKey, "public");
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider key configuration is invalid",
      cause: error,
    });
  }
}

function requireRsaKey(key: KeyLike | string, expectedType: "private" | "public"): KeyObject {
  if (key instanceof KeyObject && key.type !== expectedType) {
    throw new TypeError(`key is not a ${expectedType} key`);
  }
  if (
    expectedType === "public" &&
    typeof key === "string" &&
    /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)
  ) {
    throw new TypeError("a private key cannot be used as the provider public key");
  }
  const parsed = key instanceof KeyObject
    ? key
    : expectedType === "private" ? createPrivateKey(key) : createPublicKey(key);
  if (parsed.type !== expectedType || parsed.asymmetricKeyType !== "rsa") {
    throw new TypeError(`key must be an RSA ${expectedType} key`);
  }
  const modulusLength = parsed.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2_048) {
    throw new TypeError("RSA keys must use a modulus of at least 2048 bits");
  }
  return parsed;
}
