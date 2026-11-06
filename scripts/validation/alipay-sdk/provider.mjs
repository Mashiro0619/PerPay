// SPDX-License-Identifier: MIT
// Isolated candidate. Production still constructs AlipayLedgerProvider.
import { createPrivateKey, createPublicKey, KeyObject, randomUUID } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
import { parseStrictJson } from '../../../src/http/strict-json.ts';
import { AlipayProviderError, classifyHttpResponse, classifyTransportError, getHeader } from '../../../src/infrastructure/alipay/errors.ts';
import { parseAccountLogPage, validatePageRequest, validateRawResponse } from '../../../src/infrastructure/alipay/provider.ts';
import { validateV3Keys } from '../../../src/infrastructure/alipay/v3.ts';
import { NodeV3Transport } from '../../../src/infrastructure/alipay/node-transport.ts';
import { ACCOUNT_LOG_QUERY_PATH, DEFAULT_ACCOUNT_LOG_PAGE_SIZE } from '../../../src/infrastructure/alipay/types.ts';
import { SdkTransportDispatcher } from './dispatcher.mjs';

export class SdkLedgerProvider {
  constructor({ appId, privateKey, alipayPublicKey, transport = new NodeV3Transport(),
    timeoutMilliseconds = 8000, pageSize = DEFAULT_ACCOUNT_LOG_PAGE_SIZE, expectedAlipayCertSn }) {
    validateV3Keys(privateKey, alipayPublicKey);
    if (!appId || /[\r\n]/.test(appId) || !Number.isInteger(timeoutMilliseconds) ||
        timeoutMilliseconds < 1 || timeoutMilliseconds > 120000 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 2000) {
      throw new AlipayProviderError({ kind: 'configuration', code: 'configuration_invalid', message: 'Invalid SDK adapter configuration' });
    }
    this.transport = transport;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.pageSize = pageSize;
    this.expectedAlipayCertSn = expectedAlipayCertSn;
    const privateObject = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    const publicObject = alipayPublicKey instanceof KeyObject ? alipayPublicKey : createPublicKey(alipayPublicKey);
    this.sdk = new AlipaySdk({ appId,
      privateKey: privateObject.export({ format: 'pem', type: 'pkcs8' }).toString(),
      alipayPublicKey: publicObject.export({ format: 'pem', type: 'spki' }).toString(),
      keyType: 'PKCS8', timeout: timeoutMilliseconds });
  }

  async queryPage(input) {
    validatePageRequest(input, this.pageSize);
    const requestId = input.requestId ?? randomUUID();
    let raw = null;
    const dispatcher = new SdkTransportDispatcher({
      requestId,
      signal: input.signal,
      timeoutMilliseconds: this.timeoutMilliseconds,
      transport: { request: async (request, options) => {
        raw = validateRawResponse(await this.transport.request(request, options));
        const traceId = getHeader(raw.headers, 'alipay-trace-id') ?? requestId;
        if (raw.status < 200 || raw.status >= 300) throw classifyHttpResponse(raw, traceId);
        const encoding = getHeader(raw.headers, 'content-encoding');
        if (raw.headers['content-encoding'] !== undefined && encoding !== 'identity') {
          throw evidenceError(raw, requestId, 'invalid_response', 'response_invalid_shape', null);
        }
        for (const header of ['alipay-timestamp', 'alipay-nonce', 'alipay-signature']) {
          if (!getHeader(raw.headers, header)) {
            throw evidenceError(raw, requestId, 'signature_invalid', 'response_signature_missing', false);
          }
        }
        if (this.expectedAlipayCertSn !== undefined &&
            getHeader(raw.headers, 'alipay-sn') !== this.expectedAlipayCertSn) {
          throw evidenceError(raw, requestId, 'signature_invalid', 'response_certificate_mismatch', false);
        }
        return raw;
      } },
    });
    try {
      await this.sdk.curl('GET', ACCOUNT_LOG_QUERY_PATH, {
        requestId,
        requestTimeout: this.timeoutMilliseconds,
        query: { end_time: input.endTime, page_no: input.pageNo, page_size: input.pageSize, start_time: input.startTime },
        agent: dispatcher,
      });
    } catch (error) {
      if (dispatcher.failure) {
        const failure = classifyTransportError(dispatcher.failure);
        if (raw && failure.rawBody === null) {
          throw evidenceError(raw, requestId, failure.kind, failure.code, null);
        }
        throw failure;
      }
      if (raw && error.code === 'response-signature-verify-error') {
        throw evidenceError(raw, requestId, 'signature_invalid', 'response_signature_invalid', false);
      }
      // The standard SDK parses JSON only after its RSA verification succeeds.
      if (raw && error instanceof SyntaxError) {
        throw evidenceError(raw, requestId, 'invalid_response', 'response_invalid_json', true);
      }
      if (raw) throw evidenceError(raw, requestId, 'invalid_response', 'response_invalid_shape', null);
      throw new AlipayProviderError({ kind: 'invalid_response', code: 'response_invalid_shape', message: 'Unexpected SDK failure' });
    }
    if (!raw) throw new Error('SDK completed without captured response evidence');
    let parsed;
    try {
      parsed = parseStrictJson(raw.body);
    } catch {
      throw evidenceError(raw, requestId, 'invalid_response', 'response_invalid_json', true);
    }
    const bodyBytes = Buffer.from(raw.body);
    return parseAccountLogPage(parsed, input, {
      ...raw,
      body: bodyBytes.toString('utf8'),
      bodyBytes,
      traceId: getHeader(raw.headers, 'alipay-trace-id') ?? requestId,
      signatureVerified: true,
    });
  }
}

function evidenceError(raw, requestId, kind, code, signatureVerified) {
  return new AlipayProviderError({ kind, code, message: code, status: raw.status,
    traceId: getHeader(raw.headers, 'alipay-trace-id') ?? requestId,
    rawBody: Buffer.from(raw.body).toString('utf8'), responseHeaders: raw.headers, signatureVerified });
}
