import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const API_SIGNATURE_VERSION = "v1" as const;
export const DEFAULT_API_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;

const SIGNATURE_DOMAIN = "PERPAY-HMAC-SHA256";
const MINIMUM_SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const MAX_TARGET_BYTES = 8 * 1024;
const MAX_QUERY_PARAMETERS = 128;
const MAX_CLOCK_SKEW_SECONDS = DEFAULT_API_SIGNATURE_MAX_SKEW_SECONDS;

const clientIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const methodPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const signaturePattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^[1-9][0-9]{9,11}$/;
const pathSegmentPattern = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%]+$/;
const queryComponentPattern = /^[A-Za-z0-9\-._~%]*$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

const unreservedBytes = new Set(
  Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~", "ascii"),
);
const pathSegmentBytes = new Set(
  Buffer.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@",
    "ascii",
  ),
);

export type ApiSignatureErrorCode =
  | "UNSUPPORTED_VERSION"
  | "INVALID_METHOD"
  | "INVALID_TARGET"
  | "INVALID_CLIENT_ID"
  | "INVALID_TIMESTAMP"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "INVALID_NONCE"
  | "INVALID_SIGNATURE"
  | "INVALID_SECRET"
  | "INVALID_BODY"
  | "INVALID_VERIFICATION_CLOCK";

export class ApiSignatureError extends Error {
  readonly code: ApiSignatureErrorCode;

  constructor(code: ApiSignatureErrorCode, message: string) {
    super(message);
    this.name = "ApiSignatureError";
    this.code = code;
  }
}

export interface ApiRequestAuthentication {
  readonly version: string;
  readonly clientId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface SignedApiRequestAuthentication extends ApiRequestAuthentication {
  readonly version: typeof API_SIGNATURE_VERSION;
}

export interface ApiRequestToSign {
  readonly secret: Uint8Array;
  readonly method: string;
  readonly target: string;
  readonly body: Uint8Array;
  readonly clientId: string;
  readonly timestamp: string;
  readonly nonce: string;
}

export interface ApiRequestToVerify {
  readonly secret: Uint8Array;
  readonly method: string;
  readonly target: string;
  readonly body: Uint8Array;
  readonly authentication: ApiRequestAuthentication;
  readonly now?: Date;
  readonly maxClockSkewSeconds?: number;
}

export interface VerifiedApiRequest {
  readonly version: typeof API_SIGNATURE_VERSION;
  readonly clientId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly method: string;
  readonly canonicalTarget: string;
  readonly bodySha256: string;
}

interface CanonicalRequestMaterial {
  readonly method: string;
  readonly canonicalTarget: string;
  readonly clientId: string;
  readonly timestampText: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodySha256: string;
  readonly payload: Buffer;
}

export function createApiRequestNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

/*
 * Canonical targets are ASCII origin-form targets. Percent escapes are decoded as strict UTF-8,
 * required to be NFC, and emitted with uppercase hex. Encoded ASCII path-reserved characters are
 * rejected instead of being merged with their literal form. Query parameters must be unique
 * key=value pairs and are sorted by their encoded names; forms that intermediaries commonly
 * reinterpret (raw Unicode, '+', dot segments, encoded separators, repeated names) are rejected.
 */
export function canonicalizeApiRequestTarget(target: string): string {
  if (typeof target !== "string" || target.length === 0) {
    throw invalidTarget("request target must be a non-empty string");
  }
  if (Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES) {
    throw invalidTarget(`request target must not exceed ${MAX_TARGET_BYTES} bytes`);
  }
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw invalidTarget("request target must use origin-form with a single leading slash");
  }
  if (target.includes("#") || !isAscii(target)) {
    throw invalidTarget("request target must be ASCII and must not contain a fragment");
  }

  const queryMarker = target.indexOf("?");
  const rawPath = queryMarker === -1 ? target : target.slice(0, queryMarker);
  const rawQuery = queryMarker === -1 ? undefined : target.slice(queryMarker + 1);
  const canonicalPath = canonicalizePath(rawPath);

  if (rawQuery === undefined) return canonicalPath;
  if (rawQuery.length === 0) {
    throw invalidTarget("an empty query marker is not canonical");
  }

  return `${canonicalPath}?${canonicalizeQuery(rawQuery)}`;
}

export function signApiRequest(input: ApiRequestToSign): SignedApiRequestAuthentication {
  validateSecret(input.secret);
  const material = canonicalizeRequest(input);
  const signature = createHmac("sha256", input.secret).update(material.payload).digest("hex");

  return Object.freeze({
    version: API_SIGNATURE_VERSION,
    clientId: material.clientId,
    timestamp: material.timestampText,
    nonce: material.nonce,
    signature,
  });
}

export function verifyApiRequestSignature(input: ApiRequestToVerify): VerifiedApiRequest {
  validateSecret(input.secret);
  if (input.authentication.version !== API_SIGNATURE_VERSION) {
    throw new ApiSignatureError("UNSUPPORTED_VERSION", "unsupported API signature version");
  }

  const material = canonicalizeRequest({
    method: input.method,
    target: input.target,
    body: input.body,
    clientId: input.authentication.clientId,
    timestamp: input.authentication.timestamp,
    nonce: input.authentication.nonce,
  });
  const suppliedSignature = decodeSignature(input.authentication.signature);
  const expectedSignature = createHmac("sha256", input.secret).update(material.payload).digest();

  if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
    throw new ApiSignatureError("INVALID_SIGNATURE", "API request signature is invalid");
  }

  validateTimestampWindow(
    material.timestamp,
    input.now ?? new Date(),
    input.maxClockSkewSeconds ?? DEFAULT_API_SIGNATURE_MAX_SKEW_SECONDS,
  );

  return Object.freeze({
    version: API_SIGNATURE_VERSION,
    clientId: material.clientId,
    timestamp: material.timestamp,
    nonce: material.nonce,
    method: material.method,
    canonicalTarget: material.canonicalTarget,
    bodySha256: material.bodySha256,
  });
}

function canonicalizeRequest(input: Omit<ApiRequestToSign, "secret">): CanonicalRequestMaterial {
  const method = canonicalizeMethod(input.method);
  const canonicalTarget = canonicalizeApiRequestTarget(input.target);
  const clientId = validateClientId(input.clientId);
  const { text: timestampText, seconds: timestamp } = parseTimestamp(input.timestamp);
  const nonce = validateNonce(input.nonce);
  const bodySha256 = hashBody(input.body);
  const payload = Buffer.from(
    [
      SIGNATURE_DOMAIN,
      API_SIGNATURE_VERSION,
      method,
      canonicalTarget,
      timestampText,
      nonce,
      clientId,
      bodySha256,
    ].join("\n"),
    "utf8",
  );

  return {
    method,
    canonicalTarget,
    clientId,
    timestampText,
    timestamp,
    nonce,
    bodySha256,
    payload,
  };
}

function canonicalizeMethod(method: string): string {
  if (
    typeof method !== "string" ||
    method.length === 0 ||
    method.length > 32 ||
    !methodPattern.test(method)
  ) {
    throw new ApiSignatureError("INVALID_METHOD", "HTTP method must be a valid ASCII token");
  }
  return method.toUpperCase();
}

function canonicalizePath(rawPath: string): string {
  if (rawPath === "/") return rawPath;
  if (rawPath.length === 0 || rawPath.endsWith("/")) {
    throw invalidTarget("non-root paths must not end with a slash");
  }

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw invalidTarget("path must not contain empty segments");
  }

  const canonicalSegments = rawSegments.map((rawSegment) => {
    if (!pathSegmentPattern.test(rawSegment)) {
      throw invalidTarget("path contains a character outside the RFC 3986 path segment set");
    }
    rejectPercentEncodedPathReservedCharacters(rawSegment);
    const decoded = decodePercentEncoded(rawSegment, "path segment");
    if (decoded === "." || decoded === "..") {
      throw invalidTarget("path dot segments are not accepted");
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw invalidTarget("encoded path separators are not accepted");
    }
    return percentEncode(decoded, pathSegmentBytes);
  });

  return `/${canonicalSegments.join("/")}`;
}

function rejectPercentEncodedPathReservedCharacters(rawSegment: string): void {
  for (let index = 0; index < rawSegment.length; index += 1) {
    if (rawSegment[index] !== "%" || index + 2 >= rawSegment.length) continue;
    const encodedByte = Number.parseInt(rawSegment.slice(index + 1, index + 3), 16);
    if (encodedByte < 0x80 && !unreservedBytes.has(encodedByte)) {
      throw invalidTarget("ASCII path reserved characters must not be percent-encoded");
    }
    index += 2;
  }
}

function canonicalizeQuery(rawQuery: string): string {
  const rawPairs = rawQuery.split("&");
  if (rawPairs.length > MAX_QUERY_PARAMETERS) {
    throw invalidTarget(`query must not contain more than ${MAX_QUERY_PARAMETERS} parameters`);
  }
  if (rawPairs.some((pair) => pair.length === 0)) {
    throw invalidTarget("query must not contain empty parameters");
  }

  const seenNames = new Set<string>();
  const pairs = rawPairs.map((rawPair) => {
    const separator = rawPair.indexOf("=");
    if (separator <= 0 || separator !== rawPair.lastIndexOf("=")) {
      throw invalidTarget("each query parameter must contain exactly one equals delimiter");
    }

    const rawName = rawPair.slice(0, separator);
    const rawValue = rawPair.slice(separator + 1);
    if (!queryComponentPattern.test(rawName) || !queryComponentPattern.test(rawValue)) {
      throw invalidTarget(
        "query names and values must use unreserved characters or percent-encoded UTF-8",
      );
    }

    const name = percentEncode(decodePercentEncoded(rawName, "query name"), unreservedBytes);
    const value = percentEncode(decodePercentEncoded(rawValue, "query value"), unreservedBytes);
    if (seenNames.has(name)) {
      throw invalidTarget("duplicate query parameter names are not accepted");
    }
    seenNames.add(name);
    return [name, value] as const;
  });

  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  });

  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function decodePercentEncoded(raw: string, label: string): string {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "%") continue;
    if (index + 2 >= raw.length || !/^[0-9A-Fa-f]{2}$/.test(raw.slice(index + 1, index + 3))) {
      throw invalidTarget(`${label} contains an invalid percent escape`);
    }
    index += 2;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidTarget(`${label} is not valid percent-encoded UTF-8`);
  }

  if (controlCharacterPattern.test(decoded)) {
    throw invalidTarget(`${label} must not contain control characters`);
  }
  if (decoded.normalize("NFC") !== decoded) {
    throw invalidTarget(`${label} must use NFC-normalized Unicode`);
  }
  return decoded;
}

function percentEncode(value: string, allowedBytes: ReadonlySet<number>): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    encoded += allowedBytes.has(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function validateClientId(clientId: string): string {
  if (typeof clientId !== "string" || !clientIdPattern.test(clientId)) {
    throw new ApiSignatureError(
      "INVALID_CLIENT_ID",
      "client ID must be 3 to 64 URL-safe ASCII characters",
    );
  }
  return clientId;
}

function parseTimestamp(timestamp: string): { readonly text: string; readonly seconds: number } {
  if (typeof timestamp !== "string" || !timestampPattern.test(timestamp)) {
    throw new ApiSignatureError(
      "INVALID_TIMESTAMP",
      "timestamp must be canonical Unix time in whole seconds",
    );
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) {
    throw new ApiSignatureError("INVALID_TIMESTAMP", "timestamp is outside the supported range");
  }
  return { text: timestamp, seconds };
}

function validateNonce(nonce: string): string {
  if (typeof nonce !== "string" || !noncePattern.test(nonce)) {
    throw new ApiSignatureError(
      "INVALID_NONCE",
      "nonce must be an unpadded base64url encoding of exactly 32 bytes",
    );
  }
  const decoded = Buffer.from(nonce, "base64url");
  if (decoded.byteLength !== NONCE_BYTES || decoded.toString("base64url") !== nonce) {
    throw new ApiSignatureError("INVALID_NONCE", "nonce is not canonical base64url");
  }
  return nonce;
}

function hashBody(body: Uint8Array): string {
  if (!(body instanceof Uint8Array)) {
    throw new ApiSignatureError("INVALID_BODY", "body must contain the exact raw request bytes");
  }
  return createHash("sha256").update(body).digest("hex");
}

function validateSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < MINIMUM_SECRET_BYTES) {
    throw new ApiSignatureError(
      "INVALID_SECRET",
      `HMAC secret must contain at least ${MINIMUM_SECRET_BYTES} bytes`,
    );
  }
}

function decodeSignature(signature: string): Buffer {
  if (typeof signature !== "string" || !signaturePattern.test(signature)) {
    throw new ApiSignatureError(
      "INVALID_SIGNATURE",
      "signature must contain exactly 64 lowercase hexadecimal characters",
    );
  }
  return Buffer.from(signature, "hex");
}

function validateTimestampWindow(timestamp: number, now: Date, maxClockSkewSeconds: number): void {
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(maxClockSkewSeconds) ||
    maxClockSkewSeconds < 0 ||
    maxClockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new ApiSignatureError(
      "INVALID_VERIFICATION_CLOCK",
      `verification clock skew must be a whole number from 0 to ${MAX_CLOCK_SKEW_SECONDS} seconds`,
    );
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > maxClockSkewSeconds) {
    throw new ApiSignatureError(
      "TIMESTAMP_OUT_OF_RANGE",
      "signed timestamp falls outside the accepted clock window",
    );
  }
}

function invalidTarget(message: string): ApiSignatureError {
  return new ApiSignatureError("INVALID_TARGET", message);
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}
