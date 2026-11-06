// SPDX-License-Identifier: MIT
import { Dispatcher } from 'urllib';
import {
  AlipayProviderError,
  classifyHttpResponse,
  getHeader,
} from '../../../src/infrastructure/alipay/errors.ts';
import { normalizeV3Headers } from '../../../src/infrastructure/alipay/headers.ts';
import { ACCOUNT_LOG_QUERY_PATH } from '../../../src/infrastructure/alipay/types.ts';

const GATEWAY_ORIGIN = 'https://openapi.alipay.com';

/** One SDK call owns one dispatcher, including its untouched response evidence. */
export class SdkTransportDispatcher extends Dispatcher {
  request = null;
  response = null;
  failure = null;

  #transport;
  #timeoutMilliseconds;
  #requestId;
  #abort = new AbortController();
  #signal;
  #started = false;
  #closed = false;
  #operation = Promise.resolve();

  constructor({ transport, signal, timeoutMilliseconds, requestId }) {
    super();
    this.#transport = transport;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#requestId = requestId;
    this.#signal = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal;
  }

  dispatch(options, handler) {
    if (this.#started || this.#closed) {
      const error = configurationError('SDK dispatcher accepts exactly one request');
      this.failure ??= error;
      queueMicrotask(() => handler.onError(error));
      return false;
    }
    this.#started = true;
    this.#operation = this.#run(options, handler).catch(error => {
      this.failure = error;
      // urllib adds status/headers to the received error. Keep our evidence intact.
      handler.onError(new Error('SDK transport request failed', { cause: error }));
    });
    return true;
  }

  async #run(options, handler) {
    this.request = prepareRequest(options, this.#requestId);
    handler.onConnect(reason => this.#abort.abort(reason ?? cancellationError()), {});
    this.response = await this.#transport.request(this.request, {
      timeoutMilliseconds: this.#timeoutMilliseconds,
      signal: this.#signal,
    });
    this.#throwIfAborted();

    // urllib follows redirects by default. Stop before exposing a redirect to it.
    if (this.response.status < 200 || (this.response.status >= 300 && this.response.status < 400)) {
      throw classifyHttpResponse(this.response, getHeader(this.response.headers, 'alipay-trace-id') ?? this.#requestId);
    }

    const headers = normalizeV3Headers(this.response.headers);
    const rawHeaders = [];
    for (const [name, values] of Object.entries(headers)) {
      for (const value of typeof values === 'string' ? [values] : values) {
        rawHeaders.push(Buffer.from(name, 'latin1'), Buffer.from(value, 'latin1'));
      }
    }

    let resumed = false;
    let resumeWaiter = null;
    const resume = () => {
      resumed = true;
      resumeWaiter?.();
    };
    const waitForResume = async accepted => {
      this.#throwIfAborted();
      if (accepted !== false || resumed) return;
      await new Promise((resolve, reject) => {
        const finish = error => {
          this.#signal.removeEventListener('abort', onAbort);
          resumeWaiter = null;
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish(cancellationError());
        resumeWaiter = () => finish();
        this.#signal.addEventListener('abort', onAbort, { once: true });
        if (this.#signal.aborted) onAbort();
      });
    };

    await waitForResume(handler.onHeaders(this.response.status, rawHeaders, resume, ''));
    const body = Buffer.from(this.response.body);
    if (body.length > 0) {
      resumed = false;
      await waitForResume(handler.onData(body));
    }
    this.#throwIfAborted();
    handler.onComplete([]);
  }

  #throwIfAborted() {
    if (this.#signal.aborted) throw cancellationError();
  }

  close(callback) {
    this.#closed = true;
    if (callback) {
      void this.#operation.then(() => callback(null), callback);
      return;
    }
    return this.#operation;
  }

  destroy(error, callback) {
    if (typeof error === 'function') {
      callback = error;
      error = undefined;
    }
    this.#abort.abort(error ?? cancellationError());
    return this.close(callback);
  }
}

function prepareRequest(options, requestId) {
  let origin;
  try {
    origin = new URL(options.origin);
  } catch {
    throw configurationError('SDK request origin is invalid');
  }
  if (origin.origin !== GATEWAY_ORIGIN || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw configurationError('SDK request must use the official production gateway');
  }
  if (options.method !== 'GET' || (options.body != null && options.body !== '' && !(options.body instanceof Uint8Array && options.body.byteLength === 0))) {
    throw configurationError('SDK account-log request must be GET with an empty body');
  }
  if (typeof options.path !== 'string' || options.path.split('?')[0] !== ACCOUNT_LOG_QUERY_PATH || /[\u0000-\u0020\u007f#]/.test(options.path) || options.query != null) {
    throw configurationError('SDK account-log path must already contain its signed query');
  }
  const headers = { ...normalizeV3Headers(options.headers, { allowArrays: false }) };
  if (typeof requestId !== 'string' || !requestId || headers['alipay-request-id'] !== requestId) {
    throw configurationError('SDK request ID must match the call context');
  }
  if (headers.host !== undefined) {
    if (headers.host !== 'openapi.alipay.com') throw configurationError('SDK request host does not match the gateway');
    delete headers.host;
  }
  if (headers['content-length'] !== undefined) {
    if (headers['content-length'] !== '0') throw configurationError('SDK GET request has a nonzero content length');
    delete headers['content-length'];
  }
  // NodeV3Transport recreates these two validated transport headers verbatim.
  return Object.freeze({
    method: 'GET',
    path: options.path,
    body: '',
    headers: Object.freeze(headers),
    requestId,
  });
}

function configurationError(message) {
  return new AlipayProviderError({ kind: 'configuration', code: 'configuration_invalid', message });
}

function cancellationError() {
  return new AlipayProviderError({ kind: 'cancelled', code: 'transport_cancelled', message: 'SDK request was cancelled' });
}
