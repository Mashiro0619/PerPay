// SPDX-License-Identifier: MIT
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MERCHANT_NO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export class DemoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function decodeKey(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('请在 .env 中填写 ' + name + '，使用 PerPay 生成的 32 字节 base64url 密钥。');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new Error(name + ' 格式不正确。');
  return bytes;
}
export function perpayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PERPAY_URL 必须是 PerPay 的完整地址。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('PERPAY_URL 只填写 HTTPS 来源（本机可用 HTTP），不要包含路径、凭据或查询参数。');
  }
  return url.origin;
}
export function signRequest(secret, method, target, body, now = Date.now(), nonce = randomBytes(32).toString('base64url')) {
  // Only fixed ASCII paths without queries are used here. Arbitrary paths/queries
  // require PerPay canonicalization; do not copy this shortcut into a generic SDK.
  if (!/^\/api\/v1\/orders(?:\/[A-Za-z0-9._-]+|\/by-merchant-no\/[A-Za-z0-9._-]+)?$/.test(target)) throw new Error('Unsupported demo request target');
  const timestamp = String(Math.floor(now / 1000));
  const digest = createHash('sha256').update(body).digest('hex');
  const material = ['PERPAY-HMAC-SHA256', 'v1', method, target, timestamp, nonce, 'default', digest].join('\n');
  return {
    'content-type': 'application/json',
    'x-perpay-client-id': 'default', 'x-perpay-timestamp': timestamp,
    'x-perpay-nonce': nonce, 'x-perpay-signature-version': 'v1',
    'x-perpay-signature': createHmac('sha256', secret).update(material, 'utf8').digest('hex'),
  };
}
async function responseBytes(response, maximum = 256 * 1024) {
  const chunks = []; let size = 0;
  if (!response.body) throw new DemoError(502, 'PerPay 返回了空响应。');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) throw new DemoError(502, 'PerPay 响应过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export class PerPayClient {
  constructor({ url, secret, fetchImpl = fetch, timeout = 10000 }) {
    this.origin = perpayOrigin(url); this.secret = decodeKey(secret, 'PERPAY_API_SECRET');
    this.fetch = fetchImpl; this.timeout = timeout;
  }
  async request(method, target, data) {
    const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data), 'utf8');
    try {
      const response = await this.fetch(this.origin + target, {
        method, headers: signRequest(this.secret, method, target, body),
        ...(method === 'GET' ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(this.timeout),
      });
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new DemoError(502, 'PerPay 未返回 JSON，请检查地址和反向代理。');
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await responseBytes(response)));
      if (!response.ok) {
        const code = typeof payload?.error?.code === 'string' ? payload.error.code.slice(0, 100) : 'request_failed';
        const message = typeof payload?.error?.message === 'string' ? payload.error.message.slice(0, 240) : '请求失败';
        throw new DemoError(502, 'PerPay ' + response.status + ' [' + code + ']：' + message);
      }
      if (!payload?.data || typeof payload.data !== 'object') throw new DemoError(502, 'PerPay 返回的数据格式不正确。');
      return payload.data;
    } catch (error) {
      if (error instanceof DemoError) throw error;
      throw new DemoError(502, '无法读取 PerPay 响应。请求可能已处理，请保留原业务单号并重试，不要新建一笔。');
    }
  }
  createOrder(payload) { return this.request('POST', '/api/v1/orders', payload); }
  getOrder(id) {
    if (!UUID.test(id)) throw new DemoError(400, '订单 ID 不正确。');
    return this.request('GET', '/api/v1/orders/' + id);
  }
  getByMerchantNo(no) {
    if (!MERCHANT_NO.test(no)) throw new DemoError(400, '业务单号不正确。');
    return this.request('GET', '/api/v1/orders/by-merchant-no/' + no);
  }
}
export function validateSnapshot(snapshot) {
  if (!snapshot || !UUID.test(snapshot.order_id) || !MERCHANT_NO.test(snapshot.merchant_order_no) ||
    snapshot.currency !== 'CNY' || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 ||
    !Number.isSafeInteger(snapshot.requested_amount_cents) || snapshot.requested_amount_cents < 1 ||
    !Number.isSafeInteger(snapshot.payable_amount_cents) || snapshot.payable_amount_cents < snapshot.requested_amount_cents ||
    (snapshot.received_amount_cents !== null && (!Number.isSafeInteger(snapshot.received_amount_cents) || snapshot.received_amount_cents < 0)) ||
    !['UNPAID', 'CONFIRMED', 'DISPUTED'].includes(snapshot.payment_status) || !['NONE', 'PARTIAL', 'FULL'].includes(snapshot.refund_status)) {
    throw new DemoError(422, '订单数据缺少有效的 ID、金额、状态或版本。');
  }
  return snapshot;
}
export function orderSnapshot(order, origin) {
  let checkoutUrl = null;
  if (order.checkout?.checkout_url) {
    const url = new URL(order.checkout.checkout_url);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !/^\/checkout\/pct1_[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
      throw new DemoError(502, '收银台地址不是配置的 PerPay 来源，请核对 PERPAY_PUBLIC_URL。');
    }
    checkoutUrl = url.href;
  }
  return validateSnapshot({
    order_id: order.order_id, merchant_order_no: order.merchant_order_no, currency: order.currency,
    requested_amount_cents: order.requested_amount_cents, payable_amount_cents: order.payable_amount_cents,
    received_amount_cents: order.received_amount_cents, payment_status: order.payment?.status,
    refund_status: order.refund?.status, version: order.version,
    checkout_url: checkoutUrl, checkout_status: order.checkout?.status ?? null, expires_at: order.checkout?.expires_at ?? null,
  });
}
export function verifyWebhook(headers, bytes, secret, now = Date.now()) {
  const version = headers.get('x-perpay-webhook-version');
  const keyId = headers.get('x-perpay-webhook-key-id');
  const timestamp = headers.get('x-perpay-webhook-timestamp');
  const deliveryId = headers.get('x-perpay-webhook-delivery-id');
  const eventId = headers.get('x-perpay-webhook-event-id');
  const attempt = headers.get('x-perpay-webhook-attempt');
  const signature = headers.get('x-perpay-webhook-signature');
  if (version !== '1' || !UUID.test(keyId ?? '') || !UUID.test(deliveryId ?? '') || !UUID.test(eventId ?? '') ||
    !/^[1-9][0-9]*$/.test(timestamp ?? '') || !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now - Number(timestamp)) > 300000 || !/^[1-9][0-9]{0,8}$/.test(attempt ?? '') || !/^v1=[0-9a-f]{64}$/.test(signature ?? '')) {
    throw new DemoError(401, '通知头部无效或投递时间偏差超过五分钟。注意时间戳单位是毫秒。');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  const material = ['perpay:webhook:v1', keyId, timestamp, deliveryId, eventId, attempt, digest].join('\n');
  const expected = 'v1=' + createHmac('sha256', secret).update(material, 'utf8').digest('hex');
  if (!timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(signature, 'ascii'))) throw new DemoError(401, '通知签名不正确。');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DemoError(400, '通知不是有效的 UTF-8 JSON。'); }
  if (event?.schema !== 'perpay:outbox-event:v2' || event.event_id !== eventId ||
    !['PAYMENT_CONFIRMED', 'PAYMENT_DISPUTED', 'REFUND_UPDATED'].includes(event.event_type)) {
    throw new DemoError(422, '通知 schema、事件类型或正文事件 ID 不正确。');
  }
  const snapshot = validateSnapshot({
    order_id: event.order_id, merchant_order_no: event.merchant_order_no, currency: event.currency,
    requested_amount_cents: event.requested_amount_cents, payable_amount_cents: event.payable_amount_cents,
    received_amount_cents: event.received_amount_cents, payment_status: event.payment_status,
    refund_status: event.refund_status, version: event.order_version,
  });
  if ((event.event_type === 'PAYMENT_CONFIRMED' && snapshot.payment_status !== 'CONFIRMED') ||
    (event.event_type === 'PAYMENT_DISPUTED' && snapshot.payment_status !== 'DISPUTED') ||
    (event.event_type === 'REFUND_UPDATED' && snapshot.refund_status === 'NONE')) throw new DemoError(422, '通知类型与订单状态不一致。');
  return { event, snapshot, digest, deliveryId, keyId };
}
