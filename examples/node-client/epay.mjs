// SPDX-License-Identifier: MIT
import { constants, createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { DemoError, MERCHANT_NO, perpayOrigin } from './perpay.mjs';

export function epayContent(parameters, protocol) {
  return Object.keys(parameters).sort().filter(key => {
    const value = parameters[key];
    return key !== 'sign' && key !== 'sign_type' && value !== null && value !== undefined &&
      typeof value !== 'object' && (protocol === 'epay_v1' ? String(value) !== '' : !/^[\x00\x09\x0a\x0b\x0d\x20]*$/.test(String(value)));
  }).map(key => `${key}=${parameters[key]}`).join('&');
}

export function epayRsaKey(value, kind) {
  if (typeof value !== 'string' || !value) throw new DemoError(400, '请配置易支付 RSA 密钥。');
  if (!value.includes('-----BEGIN')) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new DemoError(400, 'RSA 密钥需要 PEM 或单行 Base64。');
    const name = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
    value = `-----BEGIN ${name}-----\n${value}\n-----END ${name}-----`;
  }
  try {
    const key = kind === 'private' ? createPrivateKey(value) : createPublicKey(value);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    return key;
  } catch { throw new DemoError(400, '易支付 RSA 密钥无效。'); }
}

export function signEpay(parameters, config) {
  const content = epayContent(parameters, config.protocol);
  return config.protocol === 'epay_v1'
    ? createHash('md5').update(content + config.epayKey).digest('hex')
    : sign('RSA-SHA256', Buffer.from(content), { key: config.merchantPrivateKey, padding: constants.RSA_PKCS1_PADDING }).toString('base64');
}

export function verifyEpay(parameters, config, now = Date.now()) {
  const content = epayContent(parameters, config.protocol);
  const signature = parameters.sign;
  if (config.protocol === 'epay_v1') {
    if (typeof signature !== 'string' || !/^[a-f0-9]{32}$/.test(signature) || parameters.sign_type !== 'MD5') throw new DemoError(401, '易支付通知签名格式无效。');
    const expected = createHash('md5').update(content + config.epayKey).digest('hex');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new DemoError(401, '易支付签名不正确。');
  } else {
    if (!/^\d{10}$/.test(String(parameters.timestamp ?? '')) || Math.abs(Math.floor(now / 1000) - Number(parameters.timestamp)) > 300) throw new DemoError(503, '易支付时间戳偏差超过五分钟，请校准时钟。');
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || parameters.sign_type !== 'RSA' ||
        !verify('RSA-SHA256', Buffer.from(content), { key: config.platformPublicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64'))) throw new DemoError(401, '易支付签名不正确。');
  }
}

export function parseEpayQuery(query) {
  if (Buffer.byteLength(query) > 65536) throw new DemoError(413, '易支付参数过大。');
  const parameters = Object.create(null);
  for (const pair of query.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    let key, value;
    try {
      key = decodeURIComponent((index < 0 ? pair : pair.slice(0, index)).replaceAll('+', ' '));
      value = decodeURIComponent((index < 0 ? '' : pair.slice(index + 1)).replaceAll('+', ' '));
    } catch { throw new DemoError(400, '易支付参数编码无效。'); }
    if (!key || /[\[\]&=\x00-\x20\x7f]/.test(key) || value.includes('&') || Object.hasOwn(parameters, key)) throw new DemoError(400, '易支付参数重复、包含数组或不支持的 & 字符。');
    parameters[key] = value;
  }
  return parameters;
}

export function epayMoney(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new DemoError(422, '易支付金额格式无效。');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1) throw new DemoError(422, '易支付金额超出支持范围。');
  return cents;
}

export function readEpayConfig(env, protocol) {
  const url = perpayOrigin(env.EPAY_URL);
  const pid = env.EPAY_PID;
  if (typeof pid !== 'string' || !/^[1-9]\d{0,19}$/.test(pid)) throw new Error('EPAY_PID 必须是后台显示的数字 PID。');
  const config = { protocol, url, clientId: pid, pid };
  if (protocol === 'epay_v1') {
    if (typeof env.EPAY_V1_KEY !== 'string' || !env.EPAY_V1_KEY || /[\r\n]/.test(env.EPAY_V1_KEY)) throw new Error('请填写 EPAY_V1_KEY。');
    config.epayKey = env.EPAY_V1_KEY;
  } else {
    config.merchantPrivateKey = epayRsaKey(env.EPAY_MERCHANT_PRIVATE_KEY, 'private');
    config.platformPublicKey = epayRsaKey(env.EPAY_PLATFORM_PUBLIC_KEY, 'public');
  }
  return config;
}

export class EpayClient {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  async request(path, parameters, query = false) {
    const config = this.config;
    const values = { ...parameters, pid: config.pid };
    if (config.protocol === 'epay_v1' && query) values.key = config.epayKey;
    else {
      if (config.protocol === 'epay_v2') values.timestamp = String(Math.floor(Date.now() / 1000));
      values.sign = signEpay(values, config);
      values.sign_type = config.protocol === 'epay_v1' ? 'MD5' : 'RSA';
    }
    let response;
    try {
      response = await this.fetch(config.url + path, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values), signal: AbortSignal.timeout(10000) });
    } catch { throw new DemoError(502, '无法读取易支付响应，请保留原业务单号重试。'); }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new DemoError(502, '易支付未返回 JSON。');
    const parts = []; let size = 0;
    for await (const part of response.body ?? []) {
      size += part.length;
      if (size > 256 * 1024) throw new DemoError(502, '易支付响应过大。');
      parts.push(part);
    }
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
    catch { throw new DemoError(502, '易支付返回了无效 JSON。'); }
    if (!response.ok || result?.code !== (config.protocol === 'epay_v1' ? 1 : 0)) throw new DemoError(502, typeof result?.msg === 'string' ? result.msg.slice(0, 240) : '易支付请求失败。');
    if (config.protocol === 'epay_v2') verifyEpay(result, config);
    return result;
  }
  async identity() {
    const result = await this.request(this.config.protocol === 'epay_v1' ? '/api.php' : '/api/merchant/info',
      this.config.protocol === 'epay_v1' ? { act: 'query' } : {}, true);
    if (String(result.pid) !== this.config.pid) throw new DemoError(502, '易支付返回的 PID 与配置不一致。');
    return this.config.pid;
  }
  async createOrder(payload) {
    const parameters = { type: 'alipay', out_trade_no: payload.merchant_order_no, name: payload.product_name,
      money: (payload.amount_cents / 100).toFixed(2), notify_url: payload.notify_url,
      clientip: '127.0.0.1', device: 'pc', param: payload.note ?? '' };
    if (payload.return_url) parameters.return_url = payload.return_url;
    if (Object.values(parameters).some(value => value.includes('&'))) throw new DemoError(400, '易支付参数值暂不支持 & 字符。');
    if (this.config.protocol === 'epay_v2') parameters.method = 'jump';
    const result = await this.request(this.config.protocol === 'epay_v1' ? '/mapi.php' : '/api/pay/create', parameters);
    const payurl = this.config.protocol === 'epay_v1' ? result.payurl : result.pay_type === 'jump' ? result.pay_info : null;
    if (typeof payurl !== 'string') throw new DemoError(502, '易支付没有返回可用的跳转收银台。');
    const checkout = new URL(payurl);
    if (checkout.origin !== this.config.url || checkout.username || checkout.password || !/^\/checkout\/pct1_[A-Za-z0-9_-]{43}$/.test(checkout.pathname) || checkout.search || checkout.hash) throw new DemoError(502, '收银台地址与当前 PerPay 实例不一致。');
    const order = await this.query({ trade_no: result.trade_no }, checkout.href);
    if (order.order_id !== String(result.trade_no) || order.merchant_order_no !== payload.merchant_order_no ||
        order.requested_amount_cents !== payload.amount_cents) throw new DemoError(502, '创建后的查单结果与原业务订单不一致。');
    return order;
  }
  async getOrder(id) { return this.query({ trade_no: id }); }
  async getByMerchantNo(no) { return this.query({ out_trade_no: no }); }
  async query(parameters, checkoutUrl) {
    const result = await this.request(this.config.protocol === 'epay_v1' ? '/api.php' : '/api/pay/query',
      { ...(this.config.protocol === 'epay_v1' ? { act: 'order' } : {}), ...parameters }, true);
    return this.snapshot(result, checkoutUrl);
  }
  snapshot(order, checkoutUrl) {
    if (!/^[1-9]\d{0,63}$/.test(String(order.trade_no)) || !MERCHANT_NO.test(order.out_trade_no ?? '') ||
        String(order.pid) !== this.config.pid || ![0, 1].includes(order.status)) throw new DemoError(502, '易支付订单身份或状态无效。');
    return { payment_protocol: this.config.protocol, order_id: String(order.trade_no), merchant_order_no: order.out_trade_no,
      currency: 'CNY', requested_amount_cents: epayMoney(order.money), payable_amount_cents: null,
      received_amount_cents: null, payment_status: order.status === 1 ? 'CONFIRMED' : 'UNPAID',
      refund_status: 'NONE', version: 1, ...(checkoutUrl ? { checkout_url: checkoutUrl, checkout_status: 'OPEN', expires_at: null } : {}) };
  }
}

export function verifyEpayNotification(query, config) {
  const parameters = parseEpayQuery(query);
  verifyEpay(parameters, config);
  if (parameters.pid !== config.pid || parameters.type !== 'alipay' || parameters.trade_status !== 'TRADE_SUCCESS' ||
      !/^[1-9]\d{0,63}$/.test(parameters.trade_no ?? '') || !MERCHANT_NO.test(parameters.out_trade_no ?? '')) throw new DemoError(422, '易支付通知的商户、订单或支付状态不正确。');
  const moneyCents = epayMoney(parameters.money);
  const content = { pid: parameters.pid, trade_no: parameters.trade_no, out_trade_no: parameters.out_trade_no,
    money: (moneyCents / 100).toFixed(2), trade_status: parameters.trade_status };
  return { parameters, moneyCents, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    eventId: `${config.protocol}:${config.pid}:${parameters.trade_no}:success` };
}
