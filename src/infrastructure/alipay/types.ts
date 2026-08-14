import type { KeyObject } from "node:crypto";

/**
 * Boundary types for the provider integration.
 *
 * None of these types expose an SDK class.  The rest of the application can
 * therefore use a fake provider in tests and a different HTTP implementation
 * without taking a dependency on a vendor package.
 */

export const ACCOUNT_LOG_QUERY_PATH = "/v3/alipay/data/bill/accountlog/query";
export const DEFAULT_ACCOUNT_LOG_PAGE_SIZE = 2_000;
export const MAX_ACCOUNT_LOG_PAGE_SIZE = 2_000;
export const DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS = 8_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export type V3HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type V3HeaderValue = string | readonly string[];
export type V3Headers = Readonly<Record<string, V3HeaderValue>>;

/** A request after signing, ready for a transport to send verbatim. */
export interface SignedV3Request {
  readonly method: V3HttpMethod;
  /** Path and query string used in the V3 signature. */
  readonly path: string;
  /** Exact bytes represented as UTF-8 text. Empty for a GET request. */
  readonly body: string;
  readonly headers: V3Headers;
  readonly requestId: string;
}

/** A response before it is parsed. The body must remain byte-for-byte intact. */
export interface RawV3Response {
  readonly status: number;
  readonly headers: V3Headers;
  readonly body: Uint8Array;
}

export interface V3TransportOptions {
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal | undefined;
}

export interface V3Transport {
  request(request: SignedV3Request, options: V3TransportOptions): Promise<RawV3Response>;
}

export interface LedgerWindow {
  /** Provider-formatted lower bound, normally `YYYY-MM-DD HH:mm:ss`. */
  readonly startTime: string;
  /** Provider-formatted upper bound, normally `YYYY-MM-DD HH:mm:ss`. */
  readonly endTime: string;
}

export interface AccountLogPageRequest extends LedgerWindow {
  readonly pageNo: number;
  readonly pageSize: number;
  readonly requestId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AccountLogDetail {
  /** The unmodified detail object, including fields unknown to this version. */
  readonly raw: unknown;
  readonly accountLogId: string | null;
  readonly occurredAt: string | null;
  readonly amount: string | null;
  readonly direction: string | null;
  readonly alipayOrderNo: string | null;
  readonly merchantOrderNo: string | null;
  readonly transMemo: string | null;
  readonly otherAccount: string | null;
}

export interface RawResponseEvidence {
  readonly status: number;
  readonly headers: V3Headers;
  /** Exact UTF-8 response body retained independently from normalized fields. */
  readonly body: string;
  readonly traceId: string;
  readonly signatureVerified: true;
}

export interface AccountLogPage {
  readonly pageNo: number;
  readonly pageSize: number;
  readonly totalSize: number;
  readonly details: readonly AccountLogDetail[];
  readonly hasMore: boolean;
  readonly traceId: string;
  readonly rawResponse: RawResponseEvidence;
}

export interface LedgerProvider {
  queryPage(input: AccountLogPageRequest): Promise<AccountLogPage>;
}

export interface AlipayLedgerProviderOptions {
  readonly appId: string;
  readonly privateKey: KeyObject | string;
  readonly alipayPublicKey: KeyObject | string;
  readonly transport: V3Transport;
  readonly timeoutMilliseconds?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly appCertSn?: string | undefined;
  readonly alipayRootCertSn?: string | undefined;
  readonly expectedAlipayCertSn?: string | undefined;
  readonly endpointPath?: string | undefined;
  readonly clock?: (() => number) | undefined;
  readonly nonceFactory?: (() => string) | undefined;
}
