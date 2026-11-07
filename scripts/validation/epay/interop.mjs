// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildEpayCallbackUrl, parseEpayParameters, signEpayV2, verifyEpayV1, verifyEpayV2, assertEpayTimestamp } from '../../../src/epay/protocol.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = join(root, '.scratch', 'epay-clients');
const image = 'php:8.3-cli@sha256:628102249d93494233b54490b785f12db9cd60f4dc89416dfca15973f2125f10';
const pinned = {
  'php-v1.zip': 'aed03c52396dafbf3be3c636d4fcef51bb3f1bc829b20024eedf6dd032614f2d',
  'php-v2.zip': '33de95841095f99fe8ccd1c16148b71671ed1319b3912205c53a794449a442b0',
  'v1/lib/EpayCore.class.php': '4f675d7bde66565aa2d372c5cee41c3dd7dcd12a636fa746b36aa06497bdcb77',
  'v2/SDK/lib/EpayCore.class.php': '161fffe3c68998f539bf4253d4cd274e69aaf1f4b1df30bfe8578eac4d1c94b5',
};
for (const [path, hash] of Object.entries(pinned)) assert.equal(createHash('sha256').update(await readFile(join(scratch, path))).digest('hex'), hash, path);
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = 'synthetic-interop-secret';
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const parts = []; for await (const part of request) parts.push(part);
    const url = new URL(request.url, 'http://localhost');
    const parameters = parseEpayParameters(url.search, Buffer.concat(parts));
    const v2 = url.pathname.startsWith('/api/');
    const auth = v2 ? verifyEpayV2(parameters, merchant.publicKey)
      : url.pathname === '/api.php' ? parameters.pid === '1001' && parameters.key === key : verifyEpayV1(parameters, key);
    assert.equal(auth, true); if (v2) assertEpayTimestamp(parameters);
    requests.push(url.pathname);
    let result = url.pathname.endsWith('/create') || url.pathname === '/mapi.php'
      ? { code: v2 ? 0 : 1, trade_no: '202611070001', pay_type: 'jump', pay_info: 'https://pay.example/checkout/demo', payurl: 'https://pay.example/checkout/demo' }
      : { code: v2 ? 0 : 1, pid: '1001', trade_no: '202611070001', out_trade_no: 'SDK-1', status: 1, money: '10.00' };
    if (url.pathname.endsWith('/orders')) result = { code: 0, msg: 'success', data: [{ ...result }] };
    if (v2) { result.timestamp = String(Math.floor(Date.now() / 1000)); result.sign_type = 'RSA'; result.sign = signEpayV2(result, platform.privateKey); }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: -1, msg: error.message })); }
});
server.listen(0, '0.0.0.0'); await once(server, 'listening');
function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true }); let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
try {
  const port = server.address().port;
  await mkdir(scratch, { recursive: true });
  for (const protocol of ['epay_v1', 'epay_v2']) {
    const config = { pid: '1001', key, apiurl: `http://host.docker.internal:${port}/`,
      merchant_private_key: merchant.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      platform_public_key: platform.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const request = { pid: '1001', type: 'alipay', method: 'jump', out_trade_no: 'SDK-1', name: '中文 +=%26', money: '10.00',
      notify_url: 'https://shop.example/notify', return_url: 'https://shop.example/return', clientip: '127.0.0.1', zero: '0', blank: ' ', empty: '' };
    const callback = buildEpayCallbackUrl('https://shop.example/notify?source=demo%2B%3D%2526',
      { pid: '1001', tradeNo: '202611070001', outTradeNo: 'SDK-1', name: request.name, moneyCents: 1000, param: '0' }, protocol, protocol === 'epay_v1' ? key : platform.privateKey);
    const notification = parseEpayParameters(new URL(callback).search);
    const data = { protocol, config, request, notification };
    await writeFile(join(scratch, protocol + '.json'), JSON.stringify(data), { mode: 0o600 });
    const sdk = protocol === 'epay_v1' ? 'v1/lib/EpayCore.class.php' : 'v2/SDK/lib/EpayCore.class.php';
    const output = await run('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '-v', `${root}:/work:ro`, image,
      'php', '/work/scripts/validation/epay/php-client.php', '/work/.scratch/epay-clients/' + sdk, '/work/.scratch/epay-clients/' + protocol + '.json']);
    const result = JSON.parse(output);
    assert.equal(protocol === 'epay_v1' ? verifyEpayV1(result.request, key) : verifyEpayV2(result.request, merchant.publicKey), true);
    assert.equal(result.create.code, protocol === 'epay_v1' ? 1 : 0); assert.equal(result.query.status, 1);
    assert.equal(result.notify, true); assert.equal(result.return, true);
    if (protocol === 'epay_v2') assert.equal(result.list.data.length, 1);
    console.log(`${protocol} PHP SDK request/create/query/notify/return passed`);
  }
  const output = await run('go', ['run', '.', join(scratch, 'epay_v1.json')], join(root, 'scripts/validation/epay'));
  const result = JSON.parse(output);
  assert.equal(verifyEpayV1(result.request, key), true); assert.equal(result.notify, true); assert.equal(result.rejectAmpersand, true);
  assert.equal(requests.length, 5);
  console.log('go-epay v0.0.5 purchase/notify/ambiguous-parameter rejection passed');
} finally { await new Promise(resolve => server.close(resolve)); }
