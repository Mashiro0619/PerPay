// SPDX-License-Identifier: MIT
// Runs the fixed New API backend with a new SQLite database and synthetic credentials.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyEpayV1 } from '../../../src/epay/protocol.ts';
import { createPerPayInteropFixture } from './perpay-fixture.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(root, '.scratch', 'epay-clients');
const binary = process.env.NEW_API_BINARY ?? join(scratch, 'new-api-validation.exe');
const provenance = JSON.parse((await readFile(binary + '.json', 'utf8')).replace(/^\uFEFF/, ''));
assert.equal(provenance.sourceCommit, '6c1575c32ba93ad92f7837993ce8fa282bae17ee');
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), provenance.binarySha256);
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, 'newapi-run-'));
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const filename = join(directory, 'new-api.sqlite3');
const child = spawn(binary, [], {
  cwd: directory, windowsHide: true, env: { ...process.env, SQL_DSN: '', LOG_SQL_DSN: '', REDIS_CONN_STRING: '',
    SQLITE_PATH: filename, PORT: String(port), SESSION_SECRET: randomBytes(32).toString('hex'),
    SESSION_COOKIE_SECURE: 'false', SESSION_COOKIE_TRUSTED_URL: '', PASSWORD_LOGIN_ENCRYPTION_ENABLED: 'false',
    GIN_MODE: 'release' },
});
let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
let token = '';
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(origin + path, { method, redirect: 'manual', headers: {
    'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.success === false || result.message === 'error') throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result;
}
let database;
let perpay;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('New API stopped during startup');
    try { await api('/api/setup'); ready = true; break; } catch { await delay(200); }
  }
  assert.equal(ready, true, 'New API startup');
  const password = 'Synthetic-' + randomBytes(16).toString('hex');
  await api('/api/setup', { username: 'epaytest', password, confirmPassword: password, SelfUseModeEnabled: true, DemoSiteEnabled: false });
  const login = await api('/api/user/login', { username: 'epaytest', password });
  token = login.data.access_token;
  assert.equal(typeof token, 'string');
  await api('/api/option/payment_compliance', { confirmed: true });
  perpay = await createPerPayInteropFixture(port);
  const key = perpay.credentials.v1Key;
  for (const [name, value] of Object.entries({ PayAddress: 'https://pay.example/', EpayId: perpay.credentials.pid, EpayKey: key,
    CustomCallbackAddress: 'https://shop.example', ServerAddress: 'https://shop.example', Price: '1', MinTopUp: '1' })) {
    await api('/api/option/', { key: name, value }, 'PUT');
  }
  database = new DatabaseSync(filename, { readOnly: true });
  const userId = database.prepare('SELECT id FROM users WHERE username=?').get('epaytest').id;
  const quota = () => database.prepare('SELECT quota FROM users WHERE id=?').get(userId).quota;
  const fulfilled = () => database.prepare('SELECT COUNT(*) AS count FROM user_subscriptions WHERE user_id=?').get(userId).count;
  const results = [];
  for (const first of ['return', 'notify']) {
    const before = quota();
    const order = await api('/api/user/pay', { amount: 10, payment_method: 'alipay' });
    assert.equal(verifyEpayV1(order.data, key), true);
    const paid = await perpay.pay(order.data);
    const returned = paid.returnUrl;
    if (first === 'return') await fetch(returned, { redirect: 'manual' });
    const notify = await paid.notify();
    const deliveries = await Promise.all([fetch(notify), fetch(notify)]);
    for (const response of deliveries) assert.equal((await response.text()).trim(), 'success');
    if (first === 'notify') await fetch(returned, { redirect: 'manual' });
    const row = database.prepare('SELECT amount,status FROM top_ups WHERE trade_no=?').get(order.data.out_trade_no);
    assert.equal(row.status, 'success');
    assert.equal(quota() - before, row.amount * 500000);
    results.push({ flow: 'topup', first, deliveries: 3, fulfillmentCount: 1 });
  }
  const created = await api('/api/subscription/admin/plans', { plan: {
    title: 'Synthetic Epay Validation', price_amount: 10, duration_unit: 'month', duration_value: 1,
    enabled: true, total_amount: 500000, max_purchase_per_user: 0,
  } });
  for (const first of ['return', 'notify']) {
    const before = fulfilled();
    const order = await api('/api/subscription/epay/pay', { plan_id: created.data.id, payment_method: 'alipay' });
    assert.equal(verifyEpayV1(order.data, key), true);
    const paid = await perpay.pay(order.data);
    const returned = paid.returnUrl;
    if (first === 'return') assert.equal((await fetch(returned, { redirect: 'manual' })).status, 302);
    const notify = await paid.notify();
    const deliveries = await Promise.all([fetch(notify), fetch(notify)]);
    for (const response of deliveries) assert.equal((await response.text()).trim(), 'success');
    if (first === 'notify') assert.equal((await fetch(returned, { redirect: 'manual' })).status, 302);
    assert.equal(fulfilled() - before, 1);
    results.push({ flow: 'subscription', first, deliveries: 3, fulfillmentCount: 1 });
  }
  assert.equal(perpay.integrity().ok, true);
  const evidence = { ...provenance, verifiedAt: new Date().toISOString(), results };
  await writeFile(join(directory, 'results.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidence: directory }, null, 2));
} finally {
  database?.close();
  perpay?.close();
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  await writeFile(join(directory, 'server.log'), logs);
}
