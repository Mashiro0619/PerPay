// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EpayCredentials, EpayProtocol } from "../epay/model.ts";
import { readEpayOrder } from "../epay/store.ts";
import { buildEpayCallbackUrl } from "../epay/protocol.ts";

export const EMPTY_WEBHOOK_BODY_FINGERPRINT = createHash("sha256").update("").digest("hex");

export function epayRequestFingerprint(url: string, keyId: string): string {
  return createHash("sha256").update(JSON.stringify([
    "perpay:epay-notification:v1", "GET", url, EMPTY_WEBHOOK_BODY_FINGERPRINT, keyId,
  ])).digest("hex");
}

export function epayConfirmationActive(connection: DatabaseSync, eventId: string): boolean {
  return !!connection.prepare(`SELECT 1 FROM outbox_events AS event
    JOIN payment_orders AS orders ON orders.order_id = event.aggregate_id
    JOIN payment_matches AS match ON match.created_by_operation_id = event.financial_operation_id
    WHERE event.outbox_event_id = ? AND event.event_type = 'PAYMENT_CONFIRMED'
      AND orders.payment_status = 'CONFIRMED' AND match.status = 'SETTLED'`).get(eventId);
}

export function prepareEpayAttempt(connection: DatabaseSync, input: {
  orderId: string; targetUrl: string; credentials: EpayCredentials; now: number;
}) {
  const metadata = readEpayOrder(connection, input.orderId);
  if (!metadata || metadata.siteId !== input.credentials.siteId) throw new Error("EasyPay notification ownership is invalid");
  const v1 = metadata.protocol === "epay_v1";
  const keyId = v1 ? input.credentials.v1KeyId : input.credentials.platformKeyId;
  const secret = v1 ? input.credentials.v1Key : input.credentials.platformPrivateKey;
  const fingerprint = v1 ? input.credentials.v1Fingerprint : input.credentials.platformFingerprint;
  const key = connection.prepare(`SELECT key_version, fingerprint, created_at FROM epay_credentials
    WHERE credential_id = ? AND site_id = ? AND purpose = ? AND retired_at IS NULL`)
    .get(keyId, metadata.siteId, v1 ? "v1_key" : "v2_platform") as
      { key_version: number | bigint; fingerprint: string; created_at: number | bigint } | undefined;
  if (!keyId || !secret || !key || key.fingerprint !== fingerprint) return null;
  const order = connection.prepare(`SELECT merchant_order_no, product_name, requested_amount_cents FROM payment_orders WHERE order_id = ?`)
    .get(input.orderId) as { merchant_order_no: string; product_name: string; requested_amount_cents: number | bigint };
  const requestUrl = buildEpayCallbackUrl(input.targetUrl, { pid: metadata.pid, tradeNo: metadata.tradeNo, outTradeNo: order.merchant_order_no,
    name: order.product_name, moneyCents: Number(order.requested_amount_cents),
    ...(metadata.param === null ? {} : { param: metadata.param }) }, metadata.protocol, secret, input.now);
  if (Buffer.byteLength(requestUrl) > 16 * 1024) throw new Error("EasyPay notification request is too large");
  return {
    protocol: metadata.protocol as EpayProtocol, requestUrl, requestFingerprint: epayRequestFingerprint(requestUrl, keyId),
    key: { keyId, keyVersion: Number(key.key_version), secretFingerprint: key.fingerprint, activatedAt: Number(key.created_at), retiredAt: null },
  };
}
