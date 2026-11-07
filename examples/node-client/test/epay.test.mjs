// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { EpayClient, epayContent, readEpayConfig, signEpay, verifyEpay, verifyEpayNotification } from '../epay.mjs';
import { readConfig, createDemoServer } from '../server.mjs';
import { DemoStore } from '../store.mjs';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { EPAY_URL: 'https://pay.example/', EPAY_PID: '1001', EPAY_V1_KEY: 'synthetic-epay-key',
  EPAY_MERCHANT_PRIVATE_KEY: merchant.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  EPAY_PLATFORM_PUBLIC_KEY: platform.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  DEMO_NOTIFY_URL: 'https://shop.example/webhooks/perpay', DEMO_RETURN_URL: 'https://shop.example/return' };
const payload = { merchant_order_no: 'SHOP-1', amount_cents: 1000, product_name: '商品 +=%26', notify_url: env.DEMO_NOTIFY_URL, return_url: env.DEMO_RETURN_URL };
function platformSigned(fields, config) {
  const values = { ...fields };
  if (config.protocol === 'epay_v2') {
    values.timestamp = String(Math.floor(Date.now() / 1000)); values.sign_type = 'RSA';
    values.sign = sign('RSA-SHA256', Buffer.from(epayContent(values, config.protocol)), platform.privateKey).toString('base64');
  } else { values.sign_type = 'MD5'; values.sign = signEpay(values, config); }
  return values;
}

for (const protocol of ['epay_v1', 'epay_v2']) {
  test(protocol + ' loads exported configuration, creates and queries through the correct protocol', async () => {
    const config = readConfig({ ...env, PAYMENT_PROTOCOL: protocol });
    assert.equal(config.returnUrl, env.DEMO_RETURN_URL);
    assert.match(config.database, new RegExp('1001-' + protocol));
    const requests = [];
    const client = new EpayClient(config, async (url, options) => {
      requests.push({ url, values: Object.fromEntries(new URLSearchParams(options.body)) });
      const fields = url.endsWith('/mapi.php') || url.endsWith('/api/pay/create')
        ? { code: protocol === 'epay_v1' ? 1 : 0, trade_no: '202611070001', payurl: 'https://pay.example/checkout/pct1_' + 'a'.repeat(43), pay_type: 'jump', pay_info: 'https://pay.example/checkout/pct1_' + 'a'.repeat(43) }
        : { code: protocol === 'epay_v1' ? 1 : 0, pid: '1001', trade_no: '202611070001', out_trade_no: 'SHOP-1', status: 1, money: '10.00' };
      return Response.json(protocol === 'epay_v2' ? platformSigned(fields, config) : fields);
    });
    assert.equal((await client.createOrder(payload)).checkout_status, 'OPEN');
    assert.equal((await client.getByMerchantNo('SHOP-1')).payment_status, 'CONFIRMED');
    assert.equal(requests[0].values.money, '10.00');
    assert.equal(requests[0].values.name, payload.product_name);
    if (protocol === 'epay_v1') assert.equal(requests[1].values.key, env.EPAY_V1_KEY);
    else assert.equal(requests[0].values.method, 'jump');
  });

  for (const first of ['return', 'notify']) test(protocol + ' deduplicates ' + first + '-first delivery on configured callback paths', async t => {
    const config = readConfig({ ...env, PAYMENT_PROTOCOL: protocol,
      DEMO_NOTIFY_URL: 'https://shop.example/proxy/callback?source=demo%2B%3D%2526',
      DEMO_RETURN_URL: 'https://shop.example/proxy/complete?source=demo%2B%3D%2526' });
    const store = new DemoStore(':memory:', config.url, config.pid, protocol);
    store.prepare(payload);
    const client = new EpayClient(config);
    client.getOrder = async () => client.snapshot({ pid: '1001', trade_no: '202611070001', out_trade_no: 'SHOP-1', status: 1, money: '10.00' });
    const { server } = createDemoServer({ config, client, store });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const fields = platformSigned({ source: 'demo+=%26', pid: '1001', trade_no: '202611070001', out_trade_no: 'SHOP-1', name: payload.product_name, money: '10.00', type: 'alipay', trade_status: 'TRADE_SUCCESS' }, config);
    const query = new URLSearchParams(fields);
    const receiveReturn = async () => assert.match(await (await fetch(base + '/proxy/complete?' + query)).text(), /付款已确认/);
    const receiveNotify = async () => assert.equal(await (await fetch(base + '/proxy/callback?' + query)).text(), 'success');
    if (first === 'return') { await receiveReturn(); await receiveNotify(); }
    else { await receiveNotify(); await receiveReturn(); }
    assert.equal(store.events().length, 1);
    assert.equal(store.get('SHOP-1').snapshot.payment_status, 'CONFIRMED');
    fields.money = '11.00';
    assert.equal((await fetch(base + '/proxy/callback?' + new URLSearchParams(fields))).status, 401);
    assert.notEqual(await (await fetch(base + '/proxy/callback?' + query.toString().replace('demo%2B%3D%2526', 'wrong'))).text(), 'success');
    assert.throws(() => verifyEpayNotification(query + '&pid=1001', config));
  });
}

test('V2 responses require platform signature and timestamp, and stores retain protocol identity', () => {
  const config = readEpayConfig(env, 'epay_v2');
  const fields = platformSigned({ code: 0, pid: '1001' }, config);
  verifyEpay(fields, config);
  assert.throws(() => verifyEpay({ ...fields, timestamp: '1000000000' }, config));
  assert.throws(() => verifyEpay({ ...fields, pid: '1002' }, config));
  const store = new DemoStore(':memory:', config.url, config.pid, config.protocol);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE name='payment_protocol'").get().value, 'epay_v2');
  store.close();
});
