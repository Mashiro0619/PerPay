// SPDX-License-Identifier: MIT
import { Dispatcher } from "urllib";

import { AlipayProviderError, classifyHttpResponse, getHeader } from "./errors.ts";
import { normalizeV3Headers } from "./headers.ts";
import {
  ACCOUNT_LOG_QUERY_PATH,
  type RawV3Response,
  type SignedV3Request,
  type V3Transport,
} from "./types.ts";

const GATEWAY_ORIGIN = "https://openapi.alipay.com";

export interface SdkTransportDispatcherOptions {
  readonly transport: V3Transport;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMilliseconds: number;
  readonly requestId: string;
}

type LegacyDispatchHandler = Required<Pick<Dispatcher.DispatchHandler,
  "onConnect" | "onHeaders" | "onData" | "onComplete" | "onError"
>>;

/** A single SDK call owns this dispatcher and its original response evidence. */
export class SdkTransportDispatcher extends Dispatcher {
  readonly #transport: V3Transport;
  readonly #timeoutMilliseconds: number;
  readonly #requestId: string;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  #signedRequest: SignedV3Request | null = null;
  #response: RawV3Response | null = null;
  #failure: unknown = null;
  #started = false;
  #closed = false;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: SdkTransportDispatcherOptions) {
    super();
    this.#transport = options.transport;
    this.#timeoutMilliseconds = options.timeoutMilliseconds;
    this.#requestId = options.requestId;
    this.#signal = options.signal
      ? AbortSignal.any([options.signal, this.#abort.signal])
      : this.#abort.signal;
  }

  get signedRequest(): SignedV3Request | null { return this.#signedRequest; }
  get response(): RawV3Response | null { return this.#response; }
  get failure(): unknown { return this.#failure; }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    requireLegacyHandler(handler);
    if (this.#started || this.#closed) {
      const error = configurationError("SDK dispatcher accepts exactly one request");
      this.#failure ??= error;
      queueMicrotask(() => handler.onError(error));
      return false;
    }
    this.#started = true;
    this.#operation = this.#run(options, handler).catch((error: unknown) => {
      this.#failure = error;
      // urllib mutates the error it receives. Retain the transport evidence separately.
      handler.onError(new Error("SDK transport request failed", { cause: error }));
    });
    return true;
  }

  async #run(options: Dispatcher.DispatchOptions, handler: LegacyDispatchHandler): Promise<void> {
    this.#signedRequest = prepareRequest(options, this.#requestId);
    handler.onConnect(reason => this.#abort.abort(reason ?? cancellationError()));
    this.#response = await this.#transport.request(this.#signedRequest, {
      timeoutMilliseconds: this.#timeoutMilliseconds,
      signal: this.#signal,
    });
    this.#throwIfAborted();

    // urllib follows redirects by default. Reject them before handing over the response.
    if (this.#response.status < 200 || (this.#response.status >= 300 && this.#response.status < 400)) {
      throw classifyHttpResponse(this.#response,
        getHeader(this.#response.headers, "alipay-trace-id") ?? this.#requestId);
    }

    const headers = normalizeV3Headers(this.#response.headers);
    const rawHeaders: Buffer[] = [];
    for (const [name, values] of Object.entries(headers)) {
      for (const value of typeof values === "string" ? [values] : values) {
        rawHeaders.push(Buffer.from(name, "latin1"), Buffer.from(value, "latin1"));
      }
    }

    let resumed = false;
    let resumeWaiter: (() => void) | null = null;
    const resume = (): void => {
      resumed = true;
      resumeWaiter?.();
    };
    const waitForResume = async (accepted: boolean | void): Promise<void> => {
      this.#throwIfAborted();
      if (accepted !== false || resumed) return;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          this.#signal.removeEventListener("abort", onAbort);
          resumeWaiter = null;
          if (error) reject(error);
          else resolve();
        };
        const onAbort = (): void => finish(cancellationError());
        resumeWaiter = () => finish();
        this.#signal.addEventListener("abort", onAbort, { once: true });
        if (this.#signal.aborted) onAbort();
      });
    };

    await waitForResume(handler.onHeaders(this.#response.status, rawHeaders, resume, ""));
    const body = Buffer.from(this.#response.body);
    if (body.length > 0) {
      resumed = false;
      await waitForResume(handler.onData(body));
    }
    this.#throwIfAborted();
    handler.onComplete([]);
  }

  #throwIfAborted(): void {
    if (this.#signal.aborted) throw cancellationError();
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: (error?: Error | null) => void): Promise<void> | void {
    this.#closed = true;
    if (callback) {
      void this.#operation.then(() => callback(null), callback);
      return;
    }
    return this.#operation;
  }

  override destroy(): Promise<void>;
  override destroy(error: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(error?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    if (typeof error === "function") {
      callback = error;
      error = undefined;
    }
    this.#abort.abort(error ?? cancellationError());
    return callback ? this.close(callback) : this.close();
  }
}

function requireLegacyHandler(handler: Dispatcher.DispatchHandler): asserts handler is LegacyDispatchHandler {
  // urllib 4 / undici 7 use these documented callbacks for request().
  if (typeof handler.onConnect !== "function" || typeof handler.onHeaders !== "function" ||
      typeof handler.onData !== "function" || typeof handler.onComplete !== "function" ||
      typeof handler.onError !== "function") {
    throw configurationError("SDK dispatcher requires the urllib request handler");
  }
}

function prepareRequest(options: Dispatcher.DispatchOptions, requestId: string): SignedV3Request {
  let origin: URL;
  try {
    if (options.origin === undefined) throw new TypeError("Missing origin");
    origin = new URL(options.origin);
  } catch {
    throw configurationError("SDK request origin is invalid");
  }
  if (origin.origin !== GATEWAY_ORIGIN || origin.pathname !== "/" ||
      origin.search || origin.hash || origin.username || origin.password) {
    throw configurationError("SDK request must use the official production gateway");
  }
  const body = options.body;
  const emptyBody = body == null || body === "" || (body instanceof Uint8Array && body.byteLength === 0);
  if (options.method !== "GET" || !emptyBody) {
    throw configurationError("SDK account-log request must be GET with an empty body");
  }
  if (options.path.split("?")[0] !== ACCOUNT_LOG_QUERY_PATH ||
      /[\u0000-\u0020\u007f#]/.test(options.path) || options.query != null) {
    throw configurationError("SDK account-log path must already contain its signed query");
  }
  const headers = { ...normalizeV3Headers(options.headers, { allowArrays: false }) };
  if (!requestId || headers["alipay-request-id"] !== requestId) {
    throw configurationError("SDK request ID must match the call context");
  }
  if (headers.host !== undefined) {
    if (headers.host !== "openapi.alipay.com") throw configurationError("SDK request host does not match the gateway");
    delete headers.host;
  }
  if (headers["content-length"] !== undefined) {
    if (headers["content-length"] !== "0") throw configurationError("SDK GET request has a nonzero content length");
    delete headers["content-length"];
  }
  // NodeV3Transport recreates the validated Host and Content-Length values.
  return Object.freeze({
    method: "GET",
    path: options.path,
    body: "",
    headers: Object.freeze(headers),
    requestId,
  });
}

function configurationError(message: string): AlipayProviderError {
  return new AlipayProviderError({ kind: "configuration", code: "configuration_invalid", message });
}

function cancellationError(): AlipayProviderError {
  return new AlipayProviderError({ kind: "cancelled", code: "transport_cancelled", message: "SDK request was cancelled" });
}
