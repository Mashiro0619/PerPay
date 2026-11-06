// SPDX-License-Identifier: MIT
import { createPrivateKey, createPublicKey, KeyObject, randomUUID } from "node:crypto";
import {
  AlipayRequestError,
  AlipaySdk,
  type AlipayCURLOptions,
  type AlipaySdkConfig,
} from "alipay-sdk";

import { parseStrictJson } from "../../http/strict-json.ts";
import {
  AlipayProviderError,
  classifyHttpResponse,
  classifyTransportError,
  getHeader,
  type AlipayProviderErrorOptions,
} from "./errors.ts";
import { NodeV3Transport } from "./node-transport.ts";
import { parseAccountLogPage, validatePageRequest, validateRawResponse } from "./provider.ts";
import { SdkTransportDispatcher } from "./sdk-dispatcher.ts";
import {
  ACCOUNT_LOG_QUERY_PATH,
  DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
  DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS,
  MAX_ACCOUNT_LOG_PAGE_SIZE,
  type AccountLogPage,
  type AccountLogPageRequest,
  type AlipayLedgerProviderOptions,
  type LedgerProvider,
  type RawV3Response,
  type V3Transport,
} from "./types.ts";
import { validateV3Keys } from "./v3.ts";

export interface SdkAlipayLedgerProviderOptions extends Omit<
  AlipayLedgerProviderOptions,
  "clock" | "nonceFactory" | "endpointPath" | "transport"
> {
  readonly transport?: V3Transport | undefined;
}

/** The SDK owns V3 signatures; the transport and ledger evidence retain their existing boundaries. */
export class SdkAlipayLedgerProvider implements LedgerProvider {
  readonly #sdk: AlipaySdk;
  readonly #transport: V3Transport;
  readonly #timeoutMilliseconds: number;
  readonly #pageSize: number;
  readonly #expectedAlipayCertSn: string | undefined;

  constructor(options: SdkAlipayLedgerProviderOptions) {
    validateAuthPart(options.appId, "appId");
    validateV3Keys(options.privateKey, options.alipayPublicKey);
    const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
      throw configurationError("timeoutMilliseconds must be between 1 and 120000");
    }
    const pageSize = options.pageSize ?? DEFAULT_ACCOUNT_LOG_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_ACCOUNT_LOG_PAGE_SIZE) {
      throw configurationError(`pageSize must be between 1 and ${MAX_ACCOUNT_LOG_PAGE_SIZE}`);
    }
    const transport = options.transport ?? new NodeV3Transport();
    if (typeof transport.request !== "function") {
      throw configurationError("transport must provide a request function");
    }

    const privateKey = options.privateKey instanceof KeyObject
      ? options.privateKey
      : createPrivateKey(options.privateKey);
    const publicKey = options.alipayPublicKey instanceof KeyObject
      ? options.alipayPublicKey
      : createPublicKey(options.alipayPublicKey);
    const sdkConfig: AlipaySdkConfig = {
      appId: options.appId,
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      alipayPublicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      keyType: "PKCS8",
      timeout: timeoutMilliseconds,
    };
    if (options.appCertSn !== undefined) {
      validateAuthPart(options.appCertSn, "appCertSn");
      sdkConfig.appCertSn = options.appCertSn;
    }
    if (options.alipayRootCertSn !== undefined) {
      validateAuthPart(options.alipayRootCertSn, "alipayRootCertSn");
      sdkConfig.alipayRootCertSn = options.alipayRootCertSn;
    }
    if (options.expectedAlipayCertSn !== undefined) {
      validateAuthPart(options.expectedAlipayCertSn, "expectedAlipayCertSn");
      sdkConfig.alipayCertSn = options.expectedAlipayCertSn;
    }
    this.#sdk = new AlipaySdk(sdkConfig);
    this.#transport = transport;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#pageSize = pageSize;
    this.#expectedAlipayCertSn = options.expectedAlipayCertSn;
  }

  async queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    validatePageRequest(input, this.#pageSize);
    const requestId = input.requestId ?? randomUUID();
    // A separate capture and dispatcher for each call keep concurrent evidence isolated.
    const evidence: { response: RawV3Response | null } = { response: null };
    const dispatcher = new SdkTransportDispatcher({
      requestId,
      signal: input.signal,
      timeoutMilliseconds: this.#timeoutMilliseconds,
      transport: {
        request: async (request, options) => {
          const response = validateRawResponse(await this.#transport.request(request, options));
          evidence.response = response;
          validateSdkResponse(response, requestId, this.#expectedAlipayCertSn);
          return response;
        },
      },
    });

    try {
      await this.#sdk.curl<unknown>("GET", ACCOUNT_LOG_QUERY_PATH, {
        requestId,
        requestTimeout: this.#timeoutMilliseconds,
        query: {
          end_time: input.endTime,
          page_no: input.pageNo,
          page_size: input.pageSize,
          start_time: input.startTime,
        },
        // SDK 4.14 types agent as ProxyAgent, but passes it to urllib's Dispatcher API.
        // This adapter implements that API and has no proxy-specific dependency.
        agent: dispatcher as unknown as NonNullable<AlipayCURLOptions["agent"]>,
      });
    } catch (error) {
      const response = evidence.response;
      if (dispatcher.failure !== null) {
        const failure = classifyTransportError(dispatcher.failure);
        if (response && failure.rawBody === null) {
          throw responseError(response, requestId, {
            kind: failure.kind,
            code: failure.code,
            message: failure.message,
            status: failure.status ?? undefined,
            traceId: failure.traceId ?? undefined,
            retryAfterSeconds: failure.retryAfterSeconds ?? undefined,
            signatureVerified: failure.signatureVerified,
            ...(failure.validationReason ? { validationReason: failure.validationReason } : {}),
          });
        }
        throw failure;
      }
      if (response && error instanceof AlipayRequestError) {
        if (error.code === "response-signature-verify-error") {
          throw responseError(response, requestId, {
            kind: "signature_invalid",
            code: "response_signature_invalid",
            message: "provider response signature verification failed",
            signatureVerified: false,
          });
        }
        if (error.code === "response-alipay-sn-verify-error") {
          throw responseError(response, requestId, {
            kind: "signature_invalid",
            code: "response_certificate_mismatch",
            message: "provider response certificate did not match the configured certificate",
            signatureVerified: false,
          });
        }
      }
      // curl parses JSON only after its response signature verification succeeds.
      if (response && error instanceof SyntaxError) {
        throw invalidJsonResponse(response, requestId);
      }
      const failure = {
        kind: "invalid_response",
        code: "response_invalid_shape",
        message: "provider SDK returned an unexpected failure",
        signatureVerified: null,
      } satisfies AlipayProviderErrorOptions;
      throw response ? responseError(response, requestId, failure) : new AlipayProviderError(failure);
    }

    const response = evidence.response;
    if (!response) {
      throw new AlipayProviderError({
        kind: "invalid_response",
        code: "response_invalid_shape",
        message: "provider SDK completed without response evidence",
      });
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(response.body);
    } catch {
      throw invalidJsonResponse(response, requestId);
    }
    const bodyBytes = Buffer.from(response.body);
    return parseAccountLogPage(parsed, input, {
      ...response,
      body: bodyBytes.toString("utf8"),
      bodyBytes,
      traceId: getHeader(response.headers, "alipay-trace-id") ?? requestId,
      signatureVerified: true,
    });
  }
}

function validateSdkResponse(response: RawV3Response, requestId: string, expectedAlipayCertSn: string | undefined): void {
  const traceId = getHeader(response.headers, "alipay-trace-id") ?? requestId;
  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpResponse(response, traceId);
  }
  const encoding = getHeader(response.headers, "content-encoding");
  if (response.headers["content-encoding"] !== undefined && encoding !== "identity") {
    throw responseError(response, requestId, {
      kind: "invalid_response",
      code: "response_invalid_shape",
      message: "provider response uses an unsupported content encoding",
      signatureVerified: null,
    });
  }
  for (const header of ["alipay-timestamp", "alipay-nonce", "alipay-signature"]) {
    if (!getHeader(response.headers, header)) {
      throw responseError(response, requestId, {
        kind: "signature_invalid",
        code: "response_signature_missing",
        message: "provider response is missing a unique signature header",
        signatureVerified: false,
      });
    }
  }
  if (expectedAlipayCertSn !== undefined && getHeader(response.headers, "alipay-sn") !== expectedAlipayCertSn) {
    throw responseError(response, requestId, {
      kind: "signature_invalid",
      code: "response_certificate_mismatch",
      message: "provider response certificate did not match the configured certificate",
      signatureVerified: false,
    });
  }
}

function responseError(response: RawV3Response, requestId: string, details: AlipayProviderErrorOptions): AlipayProviderError {
  return new AlipayProviderError({
    ...details,
    status: details.status ?? response.status,
    traceId: details.traceId ?? getHeader(response.headers, "alipay-trace-id") ?? requestId,
    rawBody: Buffer.from(response.body).toString("utf8"),
    responseHeaders: response.headers,
  });
}

function invalidJsonResponse(response: RawV3Response, requestId: string): AlipayProviderError {
  return responseError(response, requestId, {
    kind: "invalid_response",
    code: "response_invalid_json",
    message: "provider returned invalid JSON",
    signatureVerified: true,
  });
}

function validateAuthPart(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0020\u007f,]/.test(value)) {
    throw configurationError(`${name} must be non-empty and contain no whitespace, control characters, or commas`);
  }
}

function configurationError(message: string): AlipayProviderError {
  return new AlipayProviderError({ kind: "configuration", code: "configuration_invalid", message });
}
