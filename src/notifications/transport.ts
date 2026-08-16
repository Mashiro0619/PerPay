import { createHash } from "node:crypto";
import {
  validateHeaderName,
  validateHeaderValue,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";

import {
  isPublicWebhookAddress,
  isValidWebhookDnsHostname,
} from "../infrastructure/network/public-address.ts";
import {
  startHostnameResolution,
  type StartHostnameResolution,
} from "../infrastructure/network/cancellable-dns.ts";
import { MAX_WEBHOOK_REQUEST_BYTES, MAX_WEBHOOK_RESPONSE_BYTES } from "./model.ts";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_RESOLVED_ADDRESSES = 16;
const MAX_CONCURRENT_DNS_RESOLUTIONS = 4;
const ALLOWED_USER_AGENT = "perpay-webhook/1";
const FORBIDDEN_EXTENSION_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

export type WebhookTransportErrorCode =
  | "webhook_target_invalid"
  | "target_address_forbidden"
  | "target_address_limit"
  | "dns_no_addresses"
  | "dns_failed"
  | "transport_timeout"
  | "transport_cancelled"
  | "transport_network"
  | "tls_verification_failed"
  | "request_headers_invalid"
  | "request_body_too_large"
  | "response_headers_invalid"
  | "response_body_too_large";

export class WebhookTransportError extends Error {
  readonly code: WebhookTransportErrorCode;
  readonly retryable: boolean;
  readonly resolvedAddressesFingerprint: string | null;
  readonly connectedAddress: string | null;

  constructor(input: {
    readonly code: WebhookTransportErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly resolvedAddressesFingerprint?: string | null;
    readonly connectedAddress?: string | null;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "WebhookTransportError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.resolvedAddressesFingerprint = input.resolvedAddressesFingerprint ?? null;
    this.connectedAddress = input.connectedAddress ?? null;
  }
}

export interface WebhookTransportResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly body: Buffer;
  readonly responseFingerprint: string;
  readonly resolvedAddressesFingerprint: string;
  readonly connectedAddress: string;
}

export interface WebhookTransport {
  post(input: {
    readonly targetUrl: string;
    readonly body: Buffer;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMilliseconds: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<WebhookTransportResponse>;
}

interface ResolverAddress {
  readonly address: string;
  readonly family: number;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

interface RequestOptionsWithLookup extends RequestOptions {
  readonly autoSelectFamily: true;
  readonly agent: false;
}

type RequestFactory = (
  options: RequestOptionsWithLookup,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

interface Dependencies {
  readonly startHostnameResolution: StartHostnameResolution;
  readonly request: RequestFactory;
  readonly now: () => number;
  readonly scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout;
  readonly cancelTimeout: (timer: NodeJS.Timeout) => void;
}

const defaultDependencies: Dependencies = Object.freeze({
  startHostnameResolution,
  request: httpsRequest,
  now: () => performance.now(),
  scheduleTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  cancelTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
});

export interface WebhookTransportTestDependencies {
  readonly startHostnameResolution?: StartHostnameResolution;
  readonly request?: RequestFactory;
  readonly now?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  readonly cancelTimeout?: (timer: NodeJS.Timeout) => void;
}

export class NodeWebhookTransport implements WebhookTransport {
  readonly #allowedOrigin: URL;
  readonly #dependencies: Dependencies;
  readonly #dnsGate = new DnsResolutionGate(MAX_CONCURRENT_DNS_RESOLUTIONS);

  constructor(
    allowedOrigin: string,
    testingDependencies: WebhookTransportTestDependencies = {},
  ) {
    let parsed: URL;
    try {
      parsed = new URL(allowedOrigin);
    } catch (cause) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知允许 origin 无效",
        retryable: false,
        cause,
      });
    }
    if (
      parsed.protocol !== "https:" ||
      allowedOrigin.includes("#") ||
      allowedOrigin.endsWith("?") ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !isValidWebhookDnsHostname(parsed.hostname)
    ) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知允许 origin 必须是 HTTPS DNS origin",
        retryable: false,
      });
    }
    this.#allowedOrigin = parsed;
    this.#dependencies = Object.freeze({
      startHostnameResolution: testingDependencies.startHostnameResolution ??
        defaultDependencies.startHostnameResolution,
      request: testingDependencies.request ?? defaultDependencies.request,
      now: testingDependencies.now ?? defaultDependencies.now,
      scheduleTimeout: testingDependencies.scheduleTimeout ?? defaultDependencies.scheduleTimeout,
      cancelTimeout: testingDependencies.cancelTimeout ?? defaultDependencies.cancelTimeout,
    });
  }

  async post(input: {
    readonly targetUrl: string;
    readonly body: Buffer;
    readonly headers: Readonly<Record<string, string>>;
    readonly timeoutMilliseconds: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<WebhookTransportResponse> {
    if (
      !Number.isSafeInteger(input.timeoutMilliseconds) ||
      input.timeoutMilliseconds < 1 ||
      input.timeoutMilliseconds > 30_000
    ) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知超时配置无效",
        retryable: false,
      });
    }
    if (input.body.byteLength > MAX_WEBHOOK_REQUEST_BYTES) {
      throw new WebhookTransportError({
        code: "request_body_too_large",
        message: "通知请求体超过上限",
        retryable: false,
      });
    }
    const target = this.#parseTarget(input.targetUrl);
    if (input.signal?.aborted) throw cancelledError();
    const deadline = this.#dependencies.now() + input.timeoutMilliseconds;
    const addresses = await this.#resolveAddresses(target.hostname, deadline, input.signal);
    const addressesFingerprint = fingerprintAddresses(addresses);
    if (input.signal?.aborted) throw cancelledError(addressesFingerprint);
    if (deadline - this.#dependencies.now() < 1) throw timeoutError(addressesFingerprint);
    return requestPinnedAddresses({
      endpoint: target,
      addresses,
      addressesFingerprint,
      body: input.body,
      headers: input.headers,
      deadline,
      signal: input.signal,
      dependencies: this.#dependencies,
    });
  }

  #parseTarget(value: string): URL {
    let target: URL;
    try {
      target = new URL(value);
    } catch (cause) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知目标 URL 无效",
        retryable: false,
        cause,
      });
    }
    if (
      target.protocol !== "https:" ||
      target.username !== "" ||
      target.password !== "" ||
      value.includes("#") ||
      value.endsWith("?") ||
      target.hash !== "" ||
      !isValidWebhookDnsHostname(target.hostname) ||
      target.origin !== this.#allowedOrigin.origin ||
      /\p{Cc}/u.test(value) ||
      /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(`${target.pathname}${target.search}`)
    ) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知目标 URL 不符合允许 origin 约束",
        retryable: false,
      });
    }
    if (Buffer.byteLength(value, "utf8") > 4096) {
      throw new WebhookTransportError({
        code: "webhook_target_invalid",
        message: "通知目标 URL 超过上限",
        retryable: false,
      });
    }
    return target;
  }

  async #resolveAddresses(
    hostname: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly ResolvedAddress[]> {
    let records: readonly ResolverAddress[];
    try {
      records = await this.#dnsGate.run(
        () => this.#dependencies.startHostnameResolution(hostname),
        deadline,
        signal,
        this.#dependencies,
      );
    } catch (error) {
      if (error instanceof WebhookTransportError) throw error;
      throw new WebhookTransportError({
        code: "dns_failed",
        message: "通知目标 DNS 解析失败",
        retryable: true,
        cause: error,
      });
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new WebhookTransportError({
        code: "dns_no_addresses",
        message: "通知目标没有 DNS 地址",
        retryable: true,
      });
    }
    const seen = new Set<string>();
    const addresses: ResolvedAddress[] = [];
    for (const record of records) {
      if (
        !record ||
        (record.family !== 4 && record.family !== 6) ||
        isIP(record.address) !== record.family ||
        !isPublicWebhookAddress(record.address, record.family)
      ) {
        throw new WebhookTransportError({
          code: "target_address_forbidden",
          message: "通知目标 DNS 返回了非公网地址",
          retryable: false,
        });
      }
      const key = `${record.family}:${record.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push({ address: record.address, family: record.family });
    }
    if (addresses.length === 0) {
      throw new WebhookTransportError({
        code: "dns_no_addresses",
        message: "通知目标没有可用公网地址",
        retryable: true,
      });
    }
    if (addresses.length > MAX_RESOLVED_ADDRESSES) {
      throw new WebhookTransportError({
        code: "target_address_limit",
        message: "通知目标 DNS 地址数量超过上限",
        retryable: false,
      });
    }
    return Object.freeze(addresses);
  }
}

function requestPinnedAddresses(input: {
  readonly endpoint: URL;
  readonly addresses: readonly ResolvedAddress[];
  readonly addressesFingerprint: string;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadline: number;
  readonly signal?: AbortSignal | undefined;
  readonly dependencies: Dependencies;
}): Promise<WebhookTransportResponse> {
  return new Promise<WebhookTransportResponse>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | null = null;
    let response: IncomingMessage | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let responseBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      if (deadlineTimer) input.dependencies.cancelTimeout(deadlineTimer);
      deadlineTimer = null;
      input.signal?.removeEventListener("abort", onAbort);
    };
    const finishError = (error: WebhookTransportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy(error);
      reject(error);
    };
    const finishResponse = (value: WebhookTransportResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => finishError(cancelledError(input.addressesFingerprint));

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const remaining = Math.floor(input.deadline - input.dependencies.now());
    if (remaining < 1) {
      finishError(timeoutError(input.addressesFingerprint));
      return;
    }
    deadlineTimer = input.dependencies.scheduleTimeout(
      () => finishError(timeoutError(input.addressesFingerprint)),
      remaining,
    );
    deadlineTimer.unref();

    const endpointHost = input.endpoint.hostname;
    try {
      const headers: Record<string, string> = {
        ...normalizeExtensionHeaders(input.headers, input.addressesFingerprint),
        host: input.endpoint.host,
        "content-length": String(input.body.byteLength),
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": ALLOWED_USER_AGENT,
        connection: "close",
      };
      request = input.dependencies.request(
        {
          protocol: "https:",
          hostname: endpointHost,
          port: input.endpoint.port || 443,
          path: `${input.endpoint.pathname}${input.endpoint.search}`,
          method: "POST",
          headers,
          servername: endpointHost,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          maxHeaderSize: MAX_HEADER_BYTES,
          autoSelectFamily: true,
          agent: false,
          lookup: (hostname, options, callback) => {
            if (hostname !== endpointHost) {
              callback(new Error("webhook request hostname changed"), "", 4);
              return;
            }
            if (options.all) {
              callback(null, input.addresses.map((address) => ({ ...address })));
            } else {
              const first = input.addresses[0];
              if (!first) {
                callback(new Error("webhook address set is empty"), "", 4);
              } else {
                callback(null, first.address, first.family);
              }
            }
          },
        },
        (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          response = incoming;
          const connectedAddress = incoming.socket?.remoteAddress;
          if (
            !connectedAddress ||
            !matchesApprovedAddress(input.addresses, connectedAddress)
          ) {
            finishError(new WebhookTransportError({
              code: "target_address_forbidden",
              message: "通知 TLS 连接地址未通过 DNS 绑定校验",
              retryable: false,
              resolvedAddressesFingerprint: input.addressesFingerprint,
              connectedAddress: connectedAddress ?? null,
            }));
            return;
          }
          const headerValues = readResponseHeaders(incoming.headersDistinct);
          if (!headerValues.valid) {
            finishError(new WebhookTransportError({
              code: "response_headers_invalid",
              message: "通知响应头无效",
              retryable: false,
              resolvedAddressesFingerprint: input.addressesFingerprint,
              connectedAddress,
            }));
            return;
          }
          incoming.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (responseBytes + bytes.byteLength > MAX_WEBHOOK_RESPONSE_BYTES) {
              finishError(new WebhookTransportError({
                code: "response_body_too_large",
                message: "通知响应体超过上限",
                retryable: false,
                resolvedAddressesFingerprint: input.addressesFingerprint,
                connectedAddress,
              }));
              return;
            }
            responseBytes += bytes.byteLength;
            chunks.push(Buffer.from(bytes));
          });
          incoming.once("error", (cause) => {
            finishError(new WebhookTransportError({
              code: "transport_network",
              message: "读取通知响应失败",
              retryable: true,
              resolvedAddressesFingerprint: input.addressesFingerprint,
              connectedAddress,
              cause,
            }));
          });
          incoming.once("aborted", () => {
            finishError(new WebhookTransportError({
              code: "transport_network",
              message: "通知响应被中止",
              retryable: true,
              resolvedAddressesFingerprint: input.addressesFingerprint,
              connectedAddress,
            }));
          });
          incoming.once("end", () => {
            const body = Buffer.concat(chunks, responseBytes);
            finishResponse({
              status: incoming.statusCode ?? 0,
              contentType: headerValues.contentType,
              contentEncoding: headerValues.contentEncoding,
              body,
              responseFingerprint: fingerprintBytes(body),
              resolvedAddressesFingerprint: input.addressesFingerprint,
              connectedAddress,
            });
          });
        },
      );
      request.once("error", (cause: NodeJS.ErrnoException) => {
        if (settled) return;
        const certificate = ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]
          .includes(cause.code ?? "") || cause.code?.startsWith("ERR_TLS_");
        finishError(new WebhookTransportError({
          code: certificate ? "tls_verification_failed" : "transport_network",
          message: certificate ? "通知 TLS 证书校验失败" : "通知连接失败",
          retryable: !certificate,
          resolvedAddressesFingerprint: input.addressesFingerprint,
          cause,
        }));
      });
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        finishError(new WebhookTransportError({
          code: "response_headers_invalid",
          message: "通知响应不允许协议升级",
          retryable: false,
          resolvedAddressesFingerprint: input.addressesFingerprint,
        }));
      });
      request.write(input.body);
      request.end();
    } catch (cause) {
      finishError(cause instanceof WebhookTransportError
        ? cause
        : new WebhookTransportError({
            code: "transport_network",
            message: "通知请求无法建立",
            retryable: true,
            resolvedAddressesFingerprint: input.addressesFingerprint,
            cause,
          }));
    }
  });
}

function readResponseHeaders(headers: IncomingHttpHeaders & Record<string, string | string[] | undefined>): {
  readonly valid: boolean;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
} {
  const readSingle = (name: string): string | null | undefined => {
    const value = headers[name];
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const contentType = readSingle("content-type");
  const contentEncoding = readSingle("content-encoding");
  if (contentType === undefined || contentEncoding === undefined) {
    return { valid: false, contentType: null, contentEncoding: null };
  }
  return { valid: true, contentType, contentEncoding };
}

function normalizeExtensionHeaders(
  headers: Readonly<Record<string, string>>,
  addressesFingerprint: string,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(headers)) {
      const lowerName = name.toLowerCase();
      validateHeaderName(lowerName);
      validateHeaderValue(lowerName, value);
      if (
        FORBIDDEN_EXTENSION_HEADERS.has(lowerName) ||
        Object.hasOwn(normalized, lowerName)
      ) {
        throw new Error(`webhook request header is reserved or duplicated: ${lowerName}`);
      }
      normalized[lowerName] = value;
    }
  } catch (cause) {
    throw new WebhookTransportError({
      code: "request_headers_invalid",
      message: "通知请求头无效",
      retryable: false,
      resolvedAddressesFingerprint: addressesFingerprint,
      cause,
    });
  }
  return normalized;
}

interface DnsWaiter {
  grant(): boolean;
}

interface CancellableOperation<T> {
  readonly result: Promise<T>;
  cancel(): void;
}

class DnsResolutionGate {
  readonly #maximum: number;
  readonly #waiters: DnsWaiter[] = [];
  #active = 0;

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new RangeError("DNS concurrency limit is invalid");
    }
    this.#maximum = maximum;
  }

  async run<T>(
    operation: () => CancellableOperation<T>,
    deadline: number,
    signal: AbortSignal | undefined,
    dependencies: Dependencies,
  ): Promise<T> {
    await this.#acquire(deadline, signal, dependencies);
    let resolution: CancellableOperation<T>;
    try {
      resolution = operation();
    } catch (error) {
      this.#release();
      throw error;
    }
    const tracked = resolution.result.then(
      (value) => {
        this.#release();
        return value;
      },
      (error: unknown) => {
        this.#release();
        throw error;
      },
    );
    return withDeadline(tracked, deadline, signal, dependencies, () => resolution.cancel());
  }

  #acquire(
    deadline: number,
    signal: AbortSignal | undefined,
    dependencies: Dependencies,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (deadline - dependencies.now() < 1) return Promise.reject(timeoutError());
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let waiter: DnsWaiter | null = null;
      const cleanup = () => {
        if (timer) dependencies.cancelTimeout(timer);
        timer = null;
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: WebhookTransportError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (waiter) {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
        }
        reject(error);
      };
      const onAbort = () => rejectOnce(cancelledError());
      waiter = {
        grant: () => {
          if (settled) return false;
          settled = true;
          cleanup();
          this.#active += 1;
          resolve();
          return true;
        },
      };
      this.#waiters.push(waiter);
      const remaining = Math.floor(deadline - dependencies.now());
      if (remaining < 1) {
        rejectOnce(timeoutError());
        return;
      }
      timer = dependencies.scheduleTimeout(() => rejectOnce(timeoutError()), remaining);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #release(): void {
    if (this.#active < 1) throw new Error("DNS concurrency gate underflow");
    this.#active -= 1;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter?.grant()) return;
    }
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  dependencies: Dependencies,
  cancelOperation?: (() => void) | undefined,
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
    const stop = (error: WebhookTransportError) => finish(() => {
      cancelOperation?.();
      reject(error);
    });
    const onAbort = () => stop(cancelledError());
    const remaining = Math.floor(deadline - dependencies.now());
    if (remaining < 1) {
      stop(timeoutError());
      return;
    }
    timer = dependencies.scheduleTimeout(() => stop(timeoutError()), remaining);
    timer.unref();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fingerprintAddresses(addresses: readonly ResolvedAddress[]): string {
  return fingerprintBytes(Buffer.from(addresses.map((address) => `${address.family}:${address.address}`).join("\n"), "ascii"));
}

function matchesApprovedAddress(
  addresses: readonly ResolvedAddress[],
  connectedAddress: string,
): boolean {
  const family = isIP(connectedAddress);
  if (family !== 4 && family !== 6) return false;
  const approved = new BlockList();
  for (const address of addresses) {
    if (address.family === family) {
      approved.addAddress(address.address, family === 4 ? "ipv4" : "ipv6");
    }
  }
  return approved.check(connectedAddress, family === 4 ? "ipv4" : "ipv6");
}

function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cancelledError(addressesFingerprint: string | null = null): WebhookTransportError {
  return new WebhookTransportError({
    code: "transport_cancelled",
    message: "通知请求被取消",
    retryable: true,
    resolvedAddressesFingerprint: addressesFingerprint,
  });
}

function timeoutError(addressesFingerprint: string | null = null): WebhookTransportError {
  return new WebhookTransportError({
    code: "transport_timeout",
    message: "通知请求超时",
    retryable: true,
    resolvedAddressesFingerprint: addressesFingerprint,
  });
}
