// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoError, MERCHANT_NO, PerPayClient, decodeKey, orderSnapshot, perpayOrigin, verifyWebhook } from './perpay.mjs';
import { DemoStore } from './store.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
export function readConfig(env = process.env) {
  const port = Number(env.DEMO_PORT ?? '6196');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEMO_PORT 必须是 1–65535 的整数。');
  const url = perpayOrigin(env.PERPAY_URL ?? 'http://127.0.0.1:6190');
  const secret = env.PERPAY_API_SECRET ?? '';
  decodeKey(secret, 'PERPAY_API_SECRET');
  const notifyUrl = env.DEMO_NOTIFY_URL || null;
  const webhookSecret = env.PERPAY_WEBHOOK_SECRET ? decodeKey(env.PERPAY_WEBHOOK_SECRET, 'PERPAY_WEBHOOK_SECRET') : null;
  if (Boolean(notifyUrl) !== Boolean(webhookSecret)) throw new Error('启用通知时必须同时填写 DEMO_NOTIFY_URL 和 PERPAY_WEBHOOK_SECRET；不使用时两者均留空。');
  if (notifyUrl) {
    let notify;
    try { notify = new URL(notifyUrl); } catch { throw new Error('DEMO_NOTIFY_URL 不是完整 URL。'); }
    if (notify.protocol !== 'https:' || notify.username || notify.password || notify.search || notify.hash || notify.pathname !== '/webhooks/perpay') throw new Error('DEMO_NOTIFY_URL 必须是公开 HTTPS 来源下的 /webhooks/perpay 地址，不带查询参数。');
  }
  return { port, url, secret, notifyUrl, webhookSecret, database: join(resolve(directory, env.DEMO_DATA_DIR ?? 'data'), 'demo.sqlite3') };
}
function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
async function bodyBytes(request, maxBytes = 65536) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new DemoError(415, '请求必须使用 application/json。');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new DemoError(415, '请发送未压缩的原始 JSON。');
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw new DemoError(413, '请求体过大。');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new DemoError(413, '请求体过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DemoError(400, '请求不是有效的 UTF-8 JSON。'); }
}
export function orderPayload(input, config) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['merchant_order_no', 'amount', 'product_name', 'note', 'confirm_real_payment'].includes(key))) throw new DemoError(400, '订单字段不正确。');
  if (input.confirm_real_payment !== true) throw new DemoError(400, '请先确认会创建真实收款订单。');
  if (typeof input.merchant_order_no !== 'string' || !MERCHANT_NO.test(input.merchant_order_no)) throw new DemoError(400, '业务单号限 1–64 位字母、数字、点、下划线或短横线，以字母或数字开头。');
  if (typeof input.amount !== 'string' || !/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/.test(input.amount)) throw new DemoError(400, '金额最多两位小数，示例范围为 0.01–100.00 元。');
  const [whole, fraction = ''] = input.amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1 || cents > 10000) throw new DemoError(400, '示例订单金额必须在 0.01–100.00 元之间。');
  const product = typeof input.product_name === 'string' ? input.product_name.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!product || Array.from(product).length > 200 || !product.isWellFormed() || /[\u0000-\u001f\u007f]/.test(product) || Array.from(note).length > 500 || !note.isWellFormed() || /[\u0000-\u001f\u007f]/.test(note)) throw new DemoError(400, '商品名或备注无效；商品名最多 200 字，备注最多 500 字，不含控制字符。');
  return { idempotency_key: 'demo:' + input.merchant_order_no, merchant_order_no: input.merchant_order_no, amount_cents: cents, product_name: product, ...(note ? { note } : {}), ...(config.notifyUrl ? { notify_url: config.notifyUrl } : {}) };
}
export function createDemoServer({ config, client = new PerPayClient(config), store = new DemoStore(config.database, config.url) }) {
  const csrf = randomBytes(32).toString('base64url');
  const pending = new Map();
  async function perform(no, create) {
    if (pending.has(no)) return pending.get(no);
    const operation = (async () => {
      const row = store.get(no);
      if (!row) throw new DemoError(404, '本地没有这个业务订单。');
      try {
        const result = create ? await client.createOrder(row.request) : row.order_id ? await client.getOrder(row.order_id) : await client.getByMerchantNo(no);
        const snapshot = orderSnapshot(result, config.url);
        if (snapshot.merchant_order_no !== no) throw new DemoError(502, 'PerPay 返回了另一笔业务订单。');
        store.apply(snapshot, 'api');
        return { merchant_order_no: no };
      } catch (error) {
        const failure = error instanceof DemoError ? error : new DemoError(502, '订单处理失败，请保留原业务单号重试。');
        store.failure(no, failure.message);
        throw failure;
      }
    })();
    pending.set(no, operation);
    try { return await operation; } finally { pending.delete(no); }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.url === '/webhooks/perpay' && request.method === 'POST') {
        if (!config.webhookSecret) throw new DemoError(404, '通知接收未启用。');
        const bytes = await bodyBytes(request, 256 * 1024);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const verified = verifyWebhook(headers, bytes, config.webhookSecret);
        store.receive(verified);
        json(response, 200, { schema: 'perpay:webhook-ack:v1', ack: true, event_id: verified.event.event_id, delivery_id: verified.deliveryId });
        return;
      }
      const port = request.socket.localPort;
      if (!['127.0.0.1:' + port, 'localhost:' + port].includes(request.headers.host)) throw new DemoError(403, '示例页面仅允许从本机访问。');
      const allowedOrigin = 'http://' + request.headers.host;
      if (request.method === 'POST' && (request.headers.origin !== allowedOrigin || request.headers['x-demo-csrf'] !== csrf)) throw new DemoError(403, '请从本机演示页面发起操作。');
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
        const [name, type] = assets[request.url];
        const bytes = await readFile(join(directory, 'public', name));
        response.writeHead(200, { 'content-type': type }); response.end(bytes); return;
      }
      if (request.method === 'GET' && request.url === '/demo/state') {
        json(response, 200, { csrf, perpay_url: config.url, notifications: Boolean(config.notifyUrl), orders: store.list(), events: store.events() }); return;
      }
      if (request.method === 'POST' && request.url === '/demo/orders') {
        const payload = orderPayload(parseJson(await bodyBytes(request)), config);
        store.prepare(payload); // Persist immutable parameters BEFORE a network request.
        json(response, 200, await perform(payload.merchant_order_no, true)); return;
      }
      const action = /^\/demo\/orders\/([A-Za-z0-9._-]+)\/(retry|refresh)$/.exec(request.url ?? '');
      if (request.method === 'POST' && action) {
        const payload = parseJson(await bodyBytes(request));
        if (!payload || Array.isArray(payload) || Object.keys(payload).length) throw new DemoError(400, '此操作不接受修改订单参数。');
        json(response, 200, await perform(action[1], action[2] === 'retry')); return;
      }
      throw new DemoError(404, '页面或操作不存在。');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error instanceof DemoError ? error.status : 500, { error: error instanceof DemoError ? error.message : '示例服务处理失败，请检查本机配置和数据目录。' });
      else response.destroy();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, store };
}
if (import.meta.main) {
  try {
    const config = readConfig();
    const { server, store } = createDemoServer({ config });
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请修改 DEMO_PORT。' : '示例服务无法启动。'); store.close(); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => {
      console.log('PerPay 调用端 Demo：http://127.0.0.1:' + config.port);
      console.log('创建的是真实收款订单。API 密钥仅保留在后端；示例不会自动付款或发货。');
    });
    let closing = false;
    const close = () => { if (closing) return; closing = true; server.close(() => store.close()); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
