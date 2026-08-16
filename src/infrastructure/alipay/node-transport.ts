import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";

import { AlipayProviderError } from "./errors.ts";
import { normalizeV3Headers } from "./headers.ts";
import {
  startHostnameResolution,
  type HostnameResolution,
  type StartHostnameResolution,
} from "../network/cancellable-dns.ts";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  type RawV3Response,
  type SignedV3Request,
  type V3Headers,
  type V3Transport,
  type V3TransportOptions,
} from "./types.ts";

const DEFAULT_ENDPOINT = "https://openapi.alipay.com";
const ALLOWED_ENDPOINT_HOSTS = new Set([
  "openapi.alipay.com",
  "openapi-sandbox.dl.alipaydev.com",
]);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const blockedIpv4Addresses = createBlockedIpv4AddressList();
const blockedIpv6Addresses = createBlockedIpv6AddressList();
const globalIpv6Addresses = new BlockList();
globalIpv6Addresses.addSubnet("2000::", 3, "ipv6");
const pendingAddressLookups = new WeakMap<
  StartHostnameResolution,
  Map<string, PendingAddressLookup>
>();

interface AutoSelectingRequestOptions extends RequestOptions {
  readonly autoSelectFamily: true;
  readonly agent: false;
}
type HttpsRequestFactory = (
  options: AutoSelectingRequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

interface NodeV3TransportDependencies {
  readonly startHostnameResolution: StartHostnameResolution;
  readonly request: HttpsRequestFactory;
  readonly now: () => number;
  readonly scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout;
  readonly cancelTimeout: (timer: NodeJS.Timeout) => void;
}

const defaultDependencies: NodeV3TransportDependencies = Object.freeze({
  startHostnameResolution,
  request: httpsRequest,
  now: () => performance.now(),
  scheduleTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancelTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
});

export interface NodeV3TransportOptions {
  /** Only the official production or sandbox gateway is accepted. */
  readonly endpoint?: string;
  readonly userAgent?: string;
}

/** @internal Test-only dependency seam. Production callers must omit this argument. */
export interface NodeV3TransportTestDependencies {
  readonly startHostnameResolution?: StartHostnameResolution;
  readonly request?: HttpsRequestFactory;
  readonly now?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  readonly cancelTimeout?: (timer: NodeJS.Timeout) => void;
}

/**
 * HTTPS transport with a resolved-address binding.
 *
 * `fetch()` is intentionally not used here: it may resolve a hostname again
 * after an allow-list check. The filtered public address set is passed to one
 * `https.request` through its lookup hook, while TLS SNI and Host remain the
 * configured gateway hostname.
 */
export class NodeV3Transport implements V3Transport {
  readonly #endpoint: URL;
  readonly #userAgent: string;
  readonly #dependencies: NodeV3TransportDependencies;

  constructor(
    options: NodeV3TransportOptions = {},
    testingDependencies: NodeV3TransportTestDependencies = {},
  ) {
    const endpoint = parseEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#endpoint = endpoint;
    const userAgent = options.userAgent ?? "perpay-alipay-transport/1";
    try {
      const normalized = normalizeV3Headers({ "user-agent": userAgent })["user-agent"];
      if (typeof normalized !== "string" || normalized.length === 0) {
        throw new TypeError("user-agent must be a non-empty string");
      }
      this.#userAgent = normalized;
    } catch (cause) {
      throw new AlipayProviderError({
        kind: "configuration",
        code: "configuration_invalid",
        message: "provider transport user agent is invalid",
        cause,
      });
    }
    this.#dependencies = Object.freeze({
      startHostnameResolution: testingDependencies.startHostnameResolution ??
        defaultDependencies.startHostnameResolution,
      request: testingDependencies.request ?? defaultDependencies.request,
      now: testingDependencies.now ?? defaultDependencies.now,
      scheduleTimeout: testingDependencies.scheduleTimeout ?? defaultDependencies.scheduleTimeout,
      cancelTimeout: testingDependencies.cancelTimeout ?? defaultDependencies.cancelTimeout,
    });
  }

  async request(request: SignedV3Request, options: V3TransportOptions): Promise<RawV3Response> {
    if (
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds < 1 ||
      options.timeoutMilliseconds > 120_000
    ) {
      throw configurationError("provider transport timeout is invalid");
    }
    const prepared = prepareRequest(request, this.#endpoint, this.#userAgent);
    if (options.signal?.aborted) throw abortError();
    const deadline = this.#dependencies.now() + options.timeoutMilliseconds;
    const addresses = await resolvePublicAddresses(
      this.#endpoint.hostname,
      deadline,
      options.signal,
      this.#dependencies,
    );
    if (addresses.length === 0) {
      throw new AlipayProviderError({
        kind: "network",
        code: "transport_network",
        message: "provider gateway did not resolve to a usable public address",
      });
    }
    if (options.signal?.aborted) throw abortError();
    if (deadline - this.#dependencies.now() < 1) throw timeoutError();
    return requestAddresses(
      this.#endpoint,
      addresses,
      prepared,
      deadline,
      options.signal,
      this.#dependencies,
    );
  }
}

interface PreparedRequest {
  readonly method: SignedV3Request["method"];
  readonly path: string;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface PendingAddressLookup {
  readonly resolution: HostnameResolution;
  readonly result: Promise<readonly ResolvedAddress[]>;
  waiters: number;
  settled: boolean;
}

function requestAddresses(
  endpoint: URL,
  addresses: readonly ResolvedAddress[],
  prepared: PreparedRequest,
  deadline: number,
  callerSignal: AbortSignal | undefined,
  dependencies: NodeV3TransportDependencies,
): Promise<RawV3Response> {
  return new Promise<RawV3Response>((resolveResponse, reject) => {
    let settled = false;
    let responseBytes = 0;
    const chunks: Buffer[] = [];
    let deadlineTimer: NodeJS.Timeout | null = null;
    let requestHandle: ClientRequest | null = null;
    let responseHandle: IncomingMessage | null = null;
    let responseStatus: number | null = null;
    let responseHeaders: V3Headers | null = null;
    let requestDestroyed = false;
    let responseDestroyed = false;
    let pendingRequestDestroyError: Error | null = null;

    const cleanup = () => {
      if (deadlineTimer) dependencies.cancelTimeout(deadlineTimer);
      deadlineTimer = null;
      callerSignal?.removeEventListener("abort", abortFromCaller);
    };
    const settleError = (error: unknown): boolean => {
      if (settled) return false;
      settled = true;
      chunks.length = 0;
      responseBytes = 0;
      cleanup();
      reject(error);
      return true;
    };
    const settleResponse = (response: RawV3Response): boolean => {
      if (settled) return false;
      settled = true;
      cleanup();
      resolveResponse(response);
      return true;
    };
    const destroyRequest = (error: Error) => {
      if (requestDestroyed) return;
      if (!requestHandle) {
        pendingRequestDestroyError = error;
        return;
      }
      requestDestroyed = true;
      requestHandle.destroy(error);
    };
    const destroyResponse = () => {
      if (!responseHandle || responseDestroyed) return;
      responseDestroyed = true;
      responseHandle.destroy();
    };
    const failAndDestroy = (error: Error) => {
      if (!settleError(error)) return;
      destroyResponse();
      destroyRequest(error);
    };
    const responseFailure = (
      kind: "timeout" | "cancelled" | "network" | "invalid_response",
      code: "transport_timeout" | "transport_cancelled" | "transport_network" | "response_body_too_large",
      message: string,
      cause?: unknown,
    ) => new AlipayProviderError({
      kind,
      code,
      message,
      ...(responseStatus === null ? {} : { status: responseStatus }),
      ...(responseHeaders === null ? {} : { responseHeaders }),
      ...(responseHandle === null ? {} : { rawBody: Buffer.concat(chunks, responseBytes) }),
      signatureVerified: null,
      ...(cause === undefined ? {} : { cause }),
    });
    const failResponse = (
      kind: "timeout" | "cancelled" | "network" | "invalid_response",
      code: "transport_timeout" | "transport_cancelled" | "transport_network" | "response_body_too_large",
      message: string,
      cause?: unknown,
    ) => {
      if (settled) return;
      failAndDestroy(responseFailure(kind, code, message, cause));
    };
    const abortFromCaller = () => {
      if (responseHandle) {
        failResponse("cancelled", "transport_cancelled", "provider response was cancelled");
        return;
      }
      failAndDestroy(abortError());
    };

    if (callerSignal?.aborted) {
      abortFromCaller();
      return;
    }
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const remainingMilliseconds = Math.floor(deadline - dependencies.now());
    if (remainingMilliseconds < 1) {
      settleError(timeoutError());
      return;
    }
    deadlineTimer = dependencies.scheduleTimeout(
      () => {
        if (responseHandle) {
          failResponse("timeout", "transport_timeout", "provider response timed out");
          return;
        }
        failAndDestroy(timeoutError());
      },
      remainingMilliseconds,
    );
    deadlineTimer.unref();

    try {
      requestHandle = dependencies.request(
        {
          protocol: "https:",
          hostname: endpoint.hostname,
          port: endpoint.port || 443,
          path: prepared.path,
          method: prepared.method,
          headers: prepared.headers,
          servername: endpoint.hostname,
          maxHeaderSize: 16 * 1024,
          autoSelectFamily: true,
          agent: false,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) {
              callback(null, addresses.map(({ address, family }) => ({ address, family })));
            } else {
              const selected = addresses[0];
              if (!selected) {
                callback(new Error("provider gateway has no usable public address"), "", 4);
                return;
              }
              callback(null, selected.address, selected.family);
            }
          },
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          responseHandle = response;
          responseStatus = Number.isInteger(response.statusCode) ? response.statusCode ?? null : null;
          response.once("error", (cause) => {
            failResponse(
              "network",
              "transport_network",
              "provider response stream failed",
              cause,
            );
          });
          response.once("aborted", () => {
            failResponse(
              "network",
              "transport_network",
              "provider response was aborted",
            );
          });

          let responseHeadersInvalid = false;
          let responseHeadersError: unknown;
          try {
            responseHeaders = normalizeV3Headers(response.headersDistinct);
          } catch (cause) {
            responseHeadersInvalid = true;
            responseHeadersError = cause;
          }
          response.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = MAX_PROVIDER_RESPONSE_BYTES - responseBytes;
            if (bytes.byteLength > remaining) {
              if (remaining > 0) {
                chunks.push(Buffer.from(bytes.subarray(0, remaining)));
                responseBytes += remaining;
              }
              failResponse(
                "invalid_response",
                "response_body_too_large",
                "provider response body exceeds the configured limit",
              );
              return;
            }
            responseBytes += bytes.byteLength;
            chunks.push(bytes);
          });
          response.once("end", () => {
            if (settled) return;
            const body = Buffer.concat(chunks, responseBytes);
            if (responseHeadersInvalid || responseHeaders === null) {
              settleError(new AlipayProviderError({
                kind: "invalid_response",
                code: "response_invalid_shape",
                message: "provider response headers are invalid",
                status: response.statusCode ?? 0,
                rawBody: body,
                cause: responseHeadersError,
              }));
              return;
            }
            settleResponse({
              status: response.statusCode ?? 0,
              headers: responseHeaders,
              body,
            });
          });
        },
      );
      requestHandle.once("error", (cause) => {
        if (responseHandle) {
          failResponse(
            "network",
            "transport_network",
            "provider connection failed while receiving a response",
            cause,
          );
          return;
        }
        settleError(cause);
      });
      if (pendingRequestDestroyError) {
        destroyRequest(pendingRequestDestroyError);
        return;
      }
      if (settled) {
        requestDestroyed = true;
        requestHandle.destroy();
        return;
      }
      if (prepared.body.byteLength > 0) requestHandle.write(prepared.body);
      requestHandle.end();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("provider request failed");
      failAndDestroy(normalized);
    }
  });
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider endpoint is not a valid URL",
    });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.port !== "" && endpoint.port !== "443") ||
    !ALLOWED_ENDPOINT_HOSTS.has(endpoint.hostname.toLowerCase())
  ) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider endpoint must be an allow-listed HTTPS gateway origin",
    });
  }
  return endpoint;
}

async function resolvePublicAddresses(
  hostname: string,
  deadline: number,
  signal: AbortSignal | undefined,
  dependencies: NodeV3TransportDependencies,
): Promise<readonly ResolvedAddress[]> {
  let resolverLookups = pendingAddressLookups.get(dependencies.startHostnameResolution);
  if (!resolverLookups) {
    resolverLookups = new Map<string, PendingAddressLookup>();
    pendingAddressLookups.set(dependencies.startHostnameResolution, resolverLookups);
  }
  let pending = resolverLookups.get(hostname);
  if (!pending) {
    const resolution = dependencies.startHostnameResolution(hostname);
    pending = {
      resolution,
      result: Promise.resolve(resolution.result)
      .then((records) => {
        const seen = new Set<string>();
        const addresses: ResolvedAddress[] = [];
        for (const record of records) {
          if (!isPublicAddress(record.address, record.family)) continue;
          const key = `${record.family}:${record.address}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addresses.push(Object.freeze({
            address: record.address,
            family: record.family as 4 | 6,
          }));
        }
        return Object.freeze(addresses);
      })
      .finally(() => {
        if (pending) pending.settled = true;
        if (resolverLookups?.get(hostname) === pending) resolverLookups.delete(hostname);
      }),
      waiters: 0,
      settled: false,
    };
    resolverLookups.set(hostname, pending);
  }
  pending.waiters += 1;
  try {
    return await withDeadline(pending.result, deadline, signal, dependencies);
  } finally {
    pending.waiters -= 1;
    if (pending.waiters === 0 && !pending.settled) {
      pending.resolution.cancel();
      if (resolverLookups.get(hostname) === pending) resolverLookups.delete(hostname);
    }
  }
}

function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  dependencies: NodeV3TransportDependencies,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) dependencies.cancelTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const remainingMilliseconds = Math.floor(deadline - dependencies.now());
    if (remainingMilliseconds < 1) {
      finish(() => reject(timeoutError()));
      return;
    }
    timer = dependencies.scheduleTimeout(
      () => finish(() => reject(timeoutError())),
      remainingMilliseconds,
    );
    timer.unref();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isPublicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
  return !blockedIpv6Addresses.check(address, "ipv6") &&
    globalIpv6Addresses.check(address, "ipv6");
}

function createBlockedIpv4AddressList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blocked.addSubnet(network, prefix, "ipv4");
  }
  return blocked;
}

function createBlockedIpv6AddressList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    blocked.addSubnet(network, prefix, "ipv6");
  }
  return blocked;
}

function abortError(): Error {
  const error = new Error("provider request was aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(): AlipayProviderError {
  return new AlipayProviderError({
    kind: "timeout",
    code: "transport_timeout",
    message: "provider request timed out",
  });
}

function configurationError(message: string): AlipayProviderError {
  return new AlipayProviderError({
    kind: "configuration",
    code: "configuration_invalid",
    message,
  });
}

function prepareRequest(
  request: SignedV3Request,
  endpoint: URL,
  defaultUserAgent: string,
): PreparedRequest {
  if (!request || typeof request !== "object" || !ALLOWED_METHODS.has(request.method)) {
    throw configurationError("provider transport request method is invalid");
  }
  if (
    typeof request.path !== "string" ||
    !request.path.startsWith("/") ||
    request.path.startsWith("//") ||
    /[\u0000-\u0020\u007f#]/.test(request.path)
  ) {
    throw configurationError("provider transport request path is invalid");
  }
  if (typeof request.body !== "string") {
    throw configurationError("provider transport request body is invalid");
  }
  if (typeof request.requestId !== "string" || !request.requestId || /[\r\n]/.test(request.requestId)) {
    throw configurationError("provider transport request ID is invalid");
  }
  const body = Buffer.from(request.body, "utf8");
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw configurationError("provider transport request body exceeds the supported limit");
  }
  if ((request.method === "GET" || request.method === "HEAD") && body.byteLength > 0) {
    throw configurationError("provider transport GET and HEAD requests cannot carry a body");
  }
  let normalized: Readonly<Record<string, string>>;
  try {
    normalized = normalizeV3Headers(request.headers, { allowArrays: false });
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider transport request headers are invalid",
      cause: error,
    });
  }
  for (const name of Object.keys(normalized)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw configurationError(`provider transport request header ${name} is not allowed`);
    }
  }
  const suppliedUserAgent = normalized["user-agent"];
  const headers = Object.create(null) as Record<string, string>;
  headers.host = endpoint.host;
  headers["content-length"] = String(body.byteLength);
  for (const [name, value] of Object.entries(normalized)) {
    headers[name] = value;
  }
  headers["user-agent"] = suppliedUserAgent ?? defaultUserAgent;
  let finalHeaders: Readonly<Record<string, string>>;
  try {
    finalHeaders = normalizeV3Headers(headers, { allowArrays: false });
  } catch (error) {
    throw new AlipayProviderError({
      kind: "configuration",
      code: "configuration_invalid",
      message: "provider transport request headers exceed the supported limits",
      cause: error,
    });
  }
  return Object.freeze({
    method: request.method,
    path: request.path,
    body,
    headers: finalHeaders,
  });
}
