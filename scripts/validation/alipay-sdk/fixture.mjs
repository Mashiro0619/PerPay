// SPDX-License-Identifier: MIT
// Synthetic keys and a loopback server for the isolated SDK validation prototype.
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { NodeV3Transport } from '../../../src/infrastructure/alipay/node-transport.ts';

function bodyBytes(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function requestSignatureValid(request, publicKey) {
  const authorization = request.headers.authorization;
  const prefix = 'ALIPAY-SHA256withRSA ';
  if (typeof authorization !== 'string' || !authorization.startsWith(prefix)) return false;
  const parts = authorization.slice(prefix.length);
  const separator = parts.lastIndexOf(',sign=');
  if (separator < 0) return false;
  const content = [
    Buffer.from(`${parts.slice(0, separator)}\n${request.method}\n${request.path}\n`),
    request.body,
    Buffer.from('\n'),
  ];
  const appAuthToken = request.headers['alipay-app-auth-token'];
  if (typeof appAuthToken === 'string') content.push(Buffer.from(`${appAuthToken}\n`));
  try {
    return verify('RSA-SHA256', Buffer.concat(content), publicKey,
      Buffer.from(parts.slice(separator + 6), 'base64'));
  } catch {
    return false;
  }
}

/**
 * Replies are { status?, headers?, body?, delayMilliseconds?, chunks? } or an
 * async function receiving the captured request and returning that object.
 * Each chunk is { body, delayMilliseconds? }; its delay precedes that write.
 * An omitted reply produces a signed empty account-log page matching the query.
 * Custom replies are sent exactly as supplied; use signedResponse to sign them.
 */
export async function createFixture(options = {}) {
  const application = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const clock = options.clock ?? Date.now;
  const replies = [...(options.replies ?? [])];
  const requests = [];
  const connections = [];
  const transportRequests = [];
  const dnsLookups = [];
  const errors = [];
  const sockets = new Set();
  const sdkConfig = {
    appId: '2026000000000000',
    privateKey: application.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    alipayPublicKey: platform.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    keyType: 'PKCS8',
  };

  function signedResponse(body, overrides = {}, status = 200) {
    const bytes = bodyBytes(body);
    const normalized = Object.fromEntries(Object.entries(overrides).map(([key, value]) =>
      [key.toLowerCase(), value]));
    const timestamp = normalized['alipay-timestamp'] ?? String(clock());
    const nonce = normalized['alipay-nonce'] ?? randomUUID();
    const material = Buffer.concat([
      Buffer.from(`${timestamp}\n${nonce}\n`), bytes, Buffer.from('\n'),
    ]);
    return {
      status,
      body: bytes,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'alipay-timestamp': timestamp,
        'alipay-nonce': nonce,
        'alipay-trace-id': `synthetic-${randomUUID()}`,
        'alipay-signature': sign('RSA-SHA256', material, platform.privateKey).toString('base64'),
        ...normalized,
      },
    };
  }

  async function serve(incoming, response) {
    const controller = new AbortController();
    let resolveResponseClosed;
    let resolveSocketClosed;
    const captured = {
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers },
      rawHeaders: [...incoming.rawHeaders],
      body: Buffer.alloc(0),
      signatureValid: false,
      aborted: false,
      cancelled: false,
      responseFinished: false,
      responseClosed: false,
      socketClosed: false,
      responseClosedPromise: new Promise(resolve => { resolveResponseClosed = resolve; }),
      socketClosedPromise: new Promise(resolve => { resolveSocketClosed = resolve; }),
    };
    requests.push(captured);
    incoming.once('aborted', () => { captured.aborted = true; });
    incoming.socket.once('close', () => {
      captured.socketClosed = true;
      resolveSocketClosed();
    });
    response.once('finish', () => { captured.responseFinished = true; });
    response.once('close', () => {
      captured.responseClosed = true;
      captured.cancelled = !response.writableFinished;
      controller.abort();
      resolveResponseClosed();
    });

    try {
      const parts = [];
      for await (const part of incoming) parts.push(Buffer.from(part));
      captured.body = Buffer.concat(parts);
      captured.signatureValid = requestSignatureValid(captured, application.publicKey);
      await options.onRequest?.(captured);

      let reply = replies.shift();
      if (typeof reply === 'function') reply = await reply(captured);
      if (reply === undefined) {
        const query = new URL(captured.path, 'https://openapi.alipay.com').searchParams;
        reply = signedResponse({
          page_no: Number(query.get('page_no') ?? 1),
          page_size: Number(query.get('page_size') ?? 1),
          total_size: 0,
          detail_list: [],
        });
      }
      if (reply.delayMilliseconds) {
        await delay(reply.delayMilliseconds, undefined, { signal: controller.signal });
      }
      if (response.destroyed) return;
      const headers = Object.fromEntries(Object.entries(reply.headers ?? {})
        .filter(([, value]) => value !== null && value !== undefined));
      response.writeHead(reply.status ?? 200, headers);
      if (reply.chunks) {
        response.flushHeaders();
        for (const chunk of reply.chunks) {
          if (chunk.delayMilliseconds) {
            await delay(chunk.delayMilliseconds, undefined, { signal: controller.signal });
          }
          if (response.destroyed) return;
          response.write(bodyBytes(chunk.body));
        }
        response.end();
      } else {
        response.end(bodyBytes(reply.body ?? ''));
      }
    } catch (error) {
      if (controller.signal.aborted || captured.aborted) return;
      errors.push(error);
      response.destroy(error);
    }
  }

  const server = createServer((incoming, response) => { void serve(incoming, response); });
  server.on('connection', socket => {
    let resolveClosed;
    const connection = {
      closed: false,
      hadError: false,
      closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
    };
    connections.push(connection);
    sockets.add(socket);
    socket.once('close', hadError => {
      connection.closed = true;
      connection.hadError = hadError;
      sockets.delete(socket);
      resolveClosed();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', error => { errors.push(error); });
  const port = server.address().port;

  const transport = new NodeV3Transport({}, {
    startHostnameResolution(hostname) {
      dnsLookups.push(hostname);
      return { result: Promise.resolve([{ address: '8.8.8.8', family: 4 }]), cancel() {} };
    },
    request(requestOptions, onResponse) {
      transportRequests.push({ ...requestOptions, headers: { ...requestOptions.headers } });
      // Only this test seam substitutes the connection. The SDK's signed path,
      // HTTP method, body and headers travel through the real transport intact.
      return httpRequest({
        ...requestOptions,
        protocol: 'http:',
        hostname: '127.0.0.1',
        port,
        lookup: undefined,
        autoSelectFamily: false,
      }, onResponse);
    },
  });
  let closing;
  function close() {
    closing ??= new Promise((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve(); });
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  }

  return {
    transport,
    sdkConfig,
    requests,
    connections,
    transportRequests,
    dnsLookups,
    errors,
    signedResponse,
    enqueue(reply) { replies.push(reply); },
    close,
  };
}
