// SPDX-License-Identifier: MIT
// Legacy adapter retained only for SDK contract comparisons.
import { parseStrictJson } from "../../src/http/strict-json.ts";
import { AlipayProviderError, classifyHttpResponse, classifyTransportError, getHeader } from "../../src/infrastructure/alipay/errors.ts";
import { parseAccountLogPage, validatePageRequest, validateRawResponse } from "../../src/infrastructure/alipay/provider.ts";
import {
  ACCOUNT_LOG_QUERY_PATH, DEFAULT_ACCOUNT_LOG_PAGE_SIZE, DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS,
  MAX_ACCOUNT_LOG_PAGE_SIZE, type AccountLogPage, type AccountLogPageRequest,
  type AlipayLedgerProviderOptions, type LedgerProvider, type RawV3Response,
} from "../../src/infrastructure/alipay/types.ts";
import { validateV3Keys } from "../../src/infrastructure/alipay/v3.ts";
import { signV3Request, verifyV3Response } from "./alipay-legacy-v3.ts";

export class AlipayLedgerProvider implements LedgerProvider {
  readonly #appId: string;
  readonly #privateKey: AlipayLedgerProviderOptions["privateKey"];
  readonly #alipayPublicKey: AlipayLedgerProviderOptions["alipayPublicKey"];
  readonly #transport: AlipayLedgerProviderOptions["transport"];
  readonly #timeoutMilliseconds: number;
  readonly #pageSize: number;
  readonly #appCertSn: string | undefined;
  readonly #alipayRootCertSn: string | undefined;
  readonly #expectedAlipayCertSn: string | undefined;
  readonly #endpointPath: string;
  readonly #clock: (() => number) | undefined;
  readonly #nonceFactory: (() => string) | undefined;

  constructor(options: AlipayLedgerProviderOptions) {
    if (!options.appId || /[\r\n]/.test(options.appId)) {
      throw configurationError("appId must be non-empty and must not contain line breaks");
    }
    if (!options.transport || typeof options.transport.request !== "function") {
      throw configurationError("transport is required");
    }
    validateV3Keys(options.privateKey, options.alipayPublicKey);
    const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
      throw configurationError("timeoutMilliseconds must be between 1 and 120000");
    }
    const pageSize = options.pageSize ?? DEFAULT_ACCOUNT_LOG_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_ACCOUNT_LOG_PAGE_SIZE) {
      throw configurationError(`pageSize must be between 1 and ${MAX_ACCOUNT_LOG_PAGE_SIZE}`);
    }
    const endpointPath = options.endpointPath ?? ACCOUNT_LOG_QUERY_PATH;
    if (!endpointPath.startsWith("/") || /[\r\n#]/.test(endpointPath)) {
      throw configurationError("endpointPath must be an absolute path without a fragment");
    }
    this.#appId = options.appId;
    this.#privateKey = options.privateKey;
    this.#alipayPublicKey = options.alipayPublicKey;
    this.#transport = options.transport;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#pageSize = pageSize;
    this.#appCertSn = options.appCertSn;
    this.#alipayRootCertSn = options.alipayRootCertSn;
    this.#expectedAlipayCertSn = options.expectedAlipayCertSn;
    this.#endpointPath = endpointPath;
    this.#clock = options.clock;
    this.#nonceFactory = options.nonceFactory;
  }

  async queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    validatePageRequest(input, this.#pageSize);
    const signedRequest = signV3Request(
      {
        method: "GET",
        path: this.#endpointPath,
        query: {
          end_time: input.endTime,
          page_no: input.pageNo,
          page_size: input.pageSize,
          start_time: input.startTime,
        },
        requestId: input.requestId,
      },
      {
        appId: this.#appId,
        privateKey: this.#privateKey,
        appCertSn: this.#appCertSn,
        alipayRootCertSn: this.#alipayRootCertSn,
        clock: this.#clock,
        nonceFactory: this.#nonceFactory,
      },
    );

    let response: RawV3Response;
    try {
      response = await this.#transport.request(signedRequest, {
        timeoutMilliseconds: this.#timeoutMilliseconds,
        signal: input.signal,
      });
    } catch (error) {
      throw classifyTransportError(error);
    }
    response = validateRawResponse(response);
    const responseTraceId = getHeader(response.headers, "alipay-trace-id") ?? signedRequest.requestId;
    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpResponse(response, responseTraceId);
    }

    const verified = verifyV3Response(response, this.#alipayPublicKey, {
      expectedAlipayCertSn: this.#expectedAlipayCertSn,
      requestId: signedRequest.requestId,
    });
    let parsed: unknown;
    try {
      parsed = parseStrictJson(verified.bodyBytes);
    } catch (error) {
      throw new AlipayProviderError({
        kind: "invalid_response",
        code: "response_invalid_json",
        message: "provider returned invalid JSON",
        status: response.status,
        traceId: verified.traceId,
        rawBody: verified.body,
        responseHeaders: response.headers,
        signatureVerified: true,
        cause: error,
      });
    }
    return parseAccountLogPage(parsed, input, verified);
  }

}


function configurationError(message: string): AlipayProviderError {
  return new AlipayProviderError({ kind: "configuration", code: "configuration_invalid", message });
}
