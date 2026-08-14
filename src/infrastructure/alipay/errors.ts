import type { RawV3Response, V3Headers } from "./types.ts";
import { normalizeV3Headers } from "./headers.ts";

export type AlipayErrorKind =
  | "configuration"
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "network"
  | "transient"
  | "signature_invalid"
  | "invalid_response"
  | "permanent";

export type AlipayErrorCode =
  | "configuration_invalid"
  | "request_signing_failed"
  | "transport_timeout"
  | "transport_cancelled"
  | "transport_network"
  | "remote_authentication_failed"
  | "remote_authorization_failed"
  | "remote_rate_limited"
  | "remote_client_error"
  | "remote_server_error"
  | "unexpected_http_status"
  | "response_signature_missing"
  | "response_certificate_mismatch"
  | "response_signature_invalid"
  | "response_body_too_large"
  | "response_invalid_utf8"
  | "response_invalid_json"
  | "response_invalid_shape"
  | "pagination_invalid";

export interface AlipayProviderErrorOptions {
  readonly kind: AlipayErrorKind;
  readonly code: AlipayErrorCode;
  readonly message: string;
  readonly status?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly traceId?: string | undefined;
  readonly rawBody?: string | Uint8Array | undefined;
  readonly responseHeaders?: V3Headers | undefined;
  readonly signatureVerified?: boolean | null | undefined;
  readonly cause?: unknown | undefined;
}

/**
 * Error type crossing the provider boundary.
 *
 * `message` is deliberately generic. Remote response text and credentials are
 * retained as structured data for the ingestion/audit layer, never interpolated
 * into logs by this adapter.
 */
export class AlipayProviderError extends Error {
  readonly kind: AlipayErrorKind;
  readonly code: AlipayErrorCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly traceId: string | null;
  declare readonly rawBody: string | Uint8Array | null;
  declare readonly responseHeaders: V3Headers | null;
  readonly signatureVerified: boolean | null;
  readonly retryable: boolean;

  constructor(options: AlipayProviderErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AlipayProviderError";
    this.kind = options.kind;
    this.code = options.code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.traceId = options.traceId ?? null;
    Object.defineProperties(this, {
      rawBody: {
        value: options.rawBody instanceof Uint8Array
          ? new Uint8Array(options.rawBody)
          : options.rawBody ?? null,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      responseHeaders: {
        value: copyResponseHeaders(options.responseHeaders),
        enumerable: false,
        configurable: false,
        writable: false,
      },
    });
    this.signatureVerified = options.signatureVerified ?? null;
    this.retryable =
      options.kind === "timeout" ||
      options.kind === "network" ||
      options.kind === "transient" ||
      options.kind === "rate_limited";
  }
}

function copyResponseHeaders(headers: V3Headers | undefined): V3Headers | null {
  if (headers === undefined) return null;
  try {
    return normalizeV3Headers(headers);
  } catch {
    return null;
  }
}

export function isAlipayProviderError(error: unknown): error is AlipayProviderError {
  return error instanceof AlipayProviderError;
}

export function classifyTransportError(error: unknown): AlipayProviderError {
  if (error instanceof AlipayProviderError) return error;

  const name = error instanceof Error ? error.name : "";
  const code = readErrorProperty(error, "code");
  if (name === "AbortError") {
    return new AlipayProviderError({
      kind: "cancelled",
      code: "transport_cancelled",
      message: "provider request was cancelled",
      cause: error,
    });
  }
  const timeout =
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT";

  if (timeout) {
    return new AlipayProviderError({
      kind: "timeout",
      code: "transport_timeout",
      message: "provider request timed out",
      cause: error,
    });
  }
  return new AlipayProviderError({
    kind: "network",
    code: "transport_network",
    message: "provider request failed before receiving a response",
    cause: error,
  });
}

export function classifyHttpResponse(response: RawV3Response, traceId: string): AlipayProviderError {
  let headers: V3Headers;
  try {
    headers = normalizeV3Headers(response.headers);
  } catch (error) {
    return new AlipayProviderError({
      kind: "invalid_response",
      code: "response_invalid_shape",
      message: "provider returned invalid response headers",
      status: response.status,
      traceId,
      rawBody: response.body,
      cause: error,
    });
  }
  const retryAfterSeconds = parseRetryAfter(headers);
  const status = response.status;
  const rawBody = response.body;
  if (status === 401) {
    return new AlipayProviderError({
      kind: "authentication",
      code: "remote_authentication_failed",
      message: "provider rejected the application credentials",
      status,
      traceId,
      rawBody,
      responseHeaders: headers,
    });
  }
  if (status === 403) {
    return new AlipayProviderError({
      kind: "authorization",
      code: "remote_authorization_failed",
      message: "provider rejected the application permission",
      status,
      traceId,
      rawBody,
      responseHeaders: headers,
    });
  }
  if (status === 429) {
    return new AlipayProviderError({
      kind: "rate_limited",
      code: "remote_rate_limited",
      message: "provider rate limit reached",
      status,
      retryAfterSeconds,
      traceId,
      rawBody,
      responseHeaders: headers,
    });
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new AlipayProviderError({
      kind: "transient",
      code: status >= 500 ? "remote_server_error" : "unexpected_http_status",
      message: "provider returned a retryable HTTP error",
      status,
      retryAfterSeconds,
      traceId,
      rawBody,
      responseHeaders: headers,
    });
  }
  if (status >= 400) {
    return new AlipayProviderError({
      kind: "permanent",
      code: "remote_client_error",
      message: "provider rejected the request",
      status,
      traceId,
      rawBody,
      responseHeaders: headers,
    });
  }
  return new AlipayProviderError({
    kind: "invalid_response",
    code: "unexpected_http_status",
    message: "provider returned an unexpected HTTP status",
    status,
    traceId,
    rawBody,
    responseHeaders: headers,
  });
}

export function parseRetryAfter(headers: V3Headers): number | undefined {
  const value = getHeader(headers, "retry-after");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : undefined;
}

export function getHeader(headers: V3Headers, name: string): string | null {
  const expected = name.toLowerCase();
  const matches: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) continue;
    if (typeof value === "string") matches.push(value);
    else matches.push(...value);
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

function readErrorProperty(error: unknown, key: string): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
