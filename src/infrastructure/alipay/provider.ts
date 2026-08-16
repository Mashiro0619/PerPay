import { isUtf8 } from "node:buffer";

import { parseStrictJson } from "../../http/strict-json.ts";
import {
  AlipayProviderError,
  classifyHttpResponse,
  classifyTransportError,
  getHeader,
} from "./errors.ts";
import { normalizeV3Headers } from "./headers.ts";
import {
  ACCOUNT_LOG_QUERY_PATH,
  DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
  DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS,
  MAX_ACCOUNT_LOG_PAGE_SIZE,
  MAX_PROVIDER_RESPONSE_BYTES,
  type AccountLogDetail,
  type AccountLogPage,
  type AccountLogPageRequest,
  type AlipayLedgerProviderOptions,
  type LedgerProvider,
  type RawV3Response,
} from "./types.ts";
import { signV3Request, validateV3Keys, verifyV3Response } from "./v3.ts";

const UNSUPPORTED_PAGE_FIELD_REPRESENTATIONS = [
  "pageNo",
  "pageSize",
  "totalSize",
  "detailList",
] as const;
const UNSUPPORTED_DETAIL_FIELD_REPRESENTATIONS = [
  "accountLogId",
  "transDt",
  "transAmount",
  "alipayOrderNo",
  "merchantOrderNo",
  "transMemo",
  "otherAccount",
] as const;

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

function parseAccountLogPage(
  value: unknown,
  input: AccountLogPageRequest,
  verified: ReturnType<typeof verifyV3Response>,
): AccountLogPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidShape("response root must be an object", verified);
  }
  const record = value as Record<string, unknown>;
  rejectUnsupportedRepresentations(
    record,
    UNSUPPORTED_PAGE_FIELD_REPRESENTATIONS,
    verified,
  );
  const returnedPageNo = integerField(record, ["page_no"], "page number", verified);
  const pageSize = integerField(record, ["page_size"], "page size", verified);
  const totalSize = integerField(record, ["total_size"], "total size", verified);
  const returnedDetails = aliasedField(record, ["detail_list"], "detail list", verified);
  const detailsValue = returnedDetails === undefined && totalSize === 0
    ? []
    : returnedDetails;
  if (
    returnedPageNo === null ||
    pageSize === null ||
    totalSize === null ||
    !Array.isArray(detailsValue)
  ) {
    throw invalidShape("response does not contain a valid account log page", verified);
  }
  const pageNo = returnedPageNo === 0 &&
      input.pageNo === 1 &&
      totalSize === 0 &&
      detailsValue.length === 0
    ? input.pageNo
    : returnedPageNo;
  if (
    pageNo !== input.pageNo ||
    pageSize !== input.pageSize ||
    pageSize < 1 ||
    pageSize > MAX_ACCOUNT_LOG_PAGE_SIZE ||
    totalSize < 0
  ) {
    throw invalidShape("response page metadata is outside the supported range", verified);
  }
  if (detailsValue.length > pageSize) {
    throw invalidShape("response contains more details than page_size", verified);
  }
  const pageOffset = (pageNo - 1) * pageSize;
  if (!Number.isSafeInteger(pageOffset) || totalSize < pageOffset + detailsValue.length) {
    throw invalidShape("response total_size is inconsistent with the returned page", verified);
  }
  const expectedDetails = Math.min(pageSize, totalSize - pageOffset);
  if (expectedDetails < 0 || detailsValue.length !== expectedDetails) {
    throw paginationResponseError("provider returned an incomplete page for its declared total", verified);
  }
  const hasMore = pageNo * pageSize < totalSize;
  const details = detailsValue.map((detail) => normalizeDetail(detail, verified));
  return {
    pageNo,
    pageSize,
    totalSize,
    details,
    hasMore,
    traceId: verified.traceId,
    rawResponse: {
      status: verified.status,
      headers: verified.headers,
      body: verified.body,
      traceId: verified.traceId,
      signatureVerified: true,
    },
  };
}

function normalizeDetail(
  value: unknown,
  verified: ReturnType<typeof verifyV3Response>,
): AccountLogDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      raw: value,
      accountLogId: null,
      occurredAt: null,
      amount: null,
      direction: null,
      alipayOrderNo: null,
      merchantOrderNo: null,
      transMemo: null,
      otherAccount: null,
    };
  }
  const record = value as Record<string, unknown>;
  rejectUnsupportedRepresentations(
    record,
    UNSUPPORTED_DETAIL_FIELD_REPRESENTATIONS,
    verified,
  );
  return {
    raw: value,
    accountLogId: identifierField(
      aliasedField(record, ["account_log_id"], "account log ID", verified),
    ),
    occurredAt: stringField(
      aliasedField(record, ["trans_dt"], "transaction time", verified),
    ),
    amount: amountField(
      aliasedField(record, ["trans_amount"], "transaction amount", verified),
    ),
    direction: stringField(record.direction),
    alipayOrderNo: identifierField(
      aliasedField(record, ["alipay_order_no"], "provider order number", verified),
    ),
    merchantOrderNo: identifierField(
      aliasedField(
        record,
        ["merchant_order_no"],
        "merchant order number",
        verified,
      ),
    ),
    transMemo: stringField(
      aliasedField(record, ["trans_memo"], "transaction memo", verified),
    ),
    otherAccount: stringField(
      aliasedField(record, ["other_account"], "other account", verified),
    ),
  };
}

function identifierField(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function amountField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerField(
  record: Record<string, unknown>,
  keys: readonly string[],
  fieldName: string,
  verified: ReturnType<typeof verifyV3Response>,
): number | null {
  const value = aliasedField(record, keys, fieldName, verified);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function aliasedField(
  record: Record<string, unknown>,
  keys: readonly string[],
  fieldName: string,
  verified: ReturnType<typeof verifyV3Response>,
): unknown {
  let selected = false;
  let value: unknown;
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    if (selected) {
      throw invalidShape(`response contains multiple representations of ${fieldName}`, verified);
    }
    selected = true;
    value = record[key];
  }
  return value;
}

function rejectUnsupportedRepresentations(
  record: Record<string, unknown>,
  keys: readonly string[],
  verified: ReturnType<typeof verifyV3Response>,
): void {
  if (keys.some((key) => Object.hasOwn(record, key))) {
    throw invalidShape("response contains unsupported field representations", verified);
  }
}

function validatePageRequest(input: AccountLogPageRequest, defaultPageSize: number): void {
  validateWindow(input.startTime, input.endTime);
  if (!Number.isSafeInteger(input.pageNo) || input.pageNo < 1) {
    throw paginationError("pageNo must be a positive integer");
  }
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAX_ACCOUNT_LOG_PAGE_SIZE) {
    throw paginationError(`pageSize must be between 1 and ${MAX_ACCOUNT_LOG_PAGE_SIZE}`);
  }
  if (input.pageSize > defaultPageSize) {
    throw paginationError("pageSize exceeds the provider default limit configured for this adapter");
  }
  if (input.requestId !== undefined && (!input.requestId || /[\r\n]/.test(input.requestId))) {
    throw paginationError("requestId must be non-empty and must not contain line breaks");
  }
}

function validateWindow(startTime: string, endTime: string): void {
  for (const [name, value] of [["startTime", startTime], ["endTime", endTime]] as const) {
    if (!isProviderTimestamp(value)) {
      throw paginationError(`${name} must use YYYY-MM-DD HH:mm:ss and contain a real date`);
    }
  }
  if (startTime >= endTime) throw paginationError("startTime must be earlier than endTime");
}

function validateRawResponse(response: RawV3Response): RawV3Response {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "unexpected_http_status",
      message: "transport returned an invalid HTTP response",
    });
  }
  if (!(response.body instanceof Uint8Array)) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_invalid_shape",
      message: "transport returned an invalid response body",
    });
  }
  const bytes = Buffer.from(response.body);
  let headers;
  try {
    headers = normalizeV3Headers(response.headers);
  } catch (error) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_invalid_shape",
      message: "transport returned invalid response headers",
      status: response.status,
      rawBody: bytes,
      signatureVerified: null,
      cause: error,
    });
  }
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_body_too_large",
      message: "provider response body exceeds the configured limit",
      status: response.status,
      responseHeaders: response.headers,
      rawBody: bytes,
    });
  }
  if (!isUtf8(bytes)) {
    throw new AlipayProviderError({
      kind: "invalid_response",
      code: "response_invalid_utf8",
      message: "provider response body is not valid UTF-8",
      status: response.status,
      responseHeaders: response.headers,
      rawBody: bytes,
    });
  }
  return Object.freeze({
    status: response.status,
    headers,
    body: new Uint8Array(bytes),
  });
}

function isProviderTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function invalidShape(message: string, verified: ReturnType<typeof verifyV3Response>): AlipayProviderError {
  return new AlipayProviderError({
    kind: "invalid_response",
    code: "response_invalid_shape",
    message,
    status: verified.status,
    traceId: verified.traceId,
    rawBody: verified.body,
    responseHeaders: verified.headers,
    signatureVerified: true,
  });
}

function paginationResponseError(
  message: string,
  verified: ReturnType<typeof verifyV3Response>,
): AlipayProviderError {
  return new AlipayProviderError({
    kind: "transient",
    code: "pagination_invalid",
    message,
    status: verified.status,
    traceId: verified.traceId,
    rawBody: verified.body,
    responseHeaders: verified.headers,
    signatureVerified: true,
  });
}

function configurationError(message: string): AlipayProviderError {
  return new AlipayProviderError({ kind: "configuration", code: "configuration_invalid", message });
}

function paginationError(message: string): AlipayProviderError {
  return new AlipayProviderError({ kind: "invalid_response", code: "pagination_invalid", message });
}
