import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as sendNodeRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { serve, type ServerType } from "@hono/node-server";

import { createApp } from "../src/http/app.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import {
  createConfiguredHttpServices,
} from "./http-fixture.ts";

const apiSecret = Buffer.alloc(32, 11).toString("base64url");
const collectionCodePayload = "https://qr.alipay.com/fkx-test-code-2026";

async function fixture(environment: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-http-node-"));
  const { config, database, identity, settings, orders } = await createConfiguredHttpServices({
    directory,
    apiSecret,
    collectionCodePayload,
    publicUrl: "http://127.0.0.1:6190",
    environment,
  });
  const app = createApp({ config, database, identity, settings, orders, startedAt: new Date() });
  const listening = Promise.withResolvers<AddressInfo>();
  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
    (info) => listening.resolve(info),
  );
  const address = await listening.promise;

  return {
    address,
    database,
    directory,
    identity,
    server,
    async close() {
      await closeServer(server);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Node HTTP adapter boundaries", () => {
  it("verifies the original wire request-target before URL normalization", async () => {
    const test = await fixture();
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const acceptedHeaders = signedHeaders(
        "/api/v1/system/status",
        timestamp,
        Buffer.alloc(32, 1).toString("base64url"),
      );
      const accepted = await request(test.address, {
        path: "/api/v1/system/status",
        headers: acceptedHeaders,
      });
      assert.equal(accepted.status, 200);

      const normalizedHeaders = signedHeaders(
        "/api/v1/system/status",
        timestamp,
        Buffer.alloc(32, 2).toString("base64url"),
      );
      const dotSegment = await request(test.address, {
        path: "/api/v1/ignored/../system/status",
        headers: normalizedHeaders,
      });
      assert.equal(dotSegment.status, 401);
      assert.equal(
        (JSON.parse(dotSegment.body) as { error: { code: string } }).error.code,
        "api_authentication_failed",
      );
    } finally {
      await test.close();
    }
  });

  it("stops a chunked request as soon as the JSON body limit is exceeded", async () => {
    const test = await fixture();
    try {
      const response = await request(test.address, {
        method: "POST",
        path: "/api/admin/v1/session/login",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:6190",
        },
        chunks: [Buffer.alloc(16 * 1024), Buffer.from("x")],
      });
      assert.equal(response.status, 413);
      assert.equal(
        (JSON.parse(response.body) as { error: { code: string } }).error.code,
        "request_body_too_large",
      );
    } finally {
      await test.close();
    }
  });

  it("uses forwarding headers only through an explicitly trusted direct peer", async () => {
    const test = await fixture({ PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.0/8" });
    try {
      const clientAddress = "198.51.100.23";
      const failed = await request(test.address, {
        method: "POST",
        path: "/api/admin/v1/session/login",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:6190",
          "x-forwarded-for": `${clientAddress}, 127.0.0.2`,
        },
        chunks: [Buffer.from(JSON.stringify({ password: "wrong-password" }))],
      });
      assert.equal(failed.status, 401);
      const remoteAddressHash = test.database.read((connection) => (
        connection.prepare(
          `SELECT remote_address_hash
             FROM audit_events
            WHERE action = 'admin.login'
              AND outcome = 'FAILURE'
            ORDER BY sequence DESC
            LIMIT 1`,
        ).get() as { remote_address_hash: string }
      ).remote_address_hash);
      assert.equal(remoteAddressHash, test.identity.sourceHash(clientAddress));

      const malformed = await request(test.address, {
        method: "POST",
        path: "/api/admin/v1/session/login",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:6190",
          "x-forwarded-for": "198.51.100.23:443",
        },
        chunks: [Buffer.from(JSON.stringify({ password: "wrong-password" }))],
      });
      assert.equal(malformed.status, 400);
      assert.equal(
        (JSON.parse(malformed.body) as { error: { code: string } }).error.code,
        "forwarded_header_invalid",
      );
    } finally {
      await test.close();
    }
  });

  it("isolates public checkout polling by the client resolved through trusted proxies", async () => {
    const test = await fixture({ PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.0/8" });
    const target = `/api/public/v1/checkouts/pct1_${"A".repeat(43)}`;
    try {
      const firstSourceResponses = await Promise.all(
        Array.from({ length: 160 }, () => request(test.address, {
          path: target,
          headers: { "x-forwarded-for": "198.51.100.23, 127.0.0.2" },
        })),
      );
      const limited = firstSourceResponses.find((response) => response.status === 429);
      assert.ok(limited);
      assert.equal(
        (JSON.parse(limited.body) as { error: { code: string } }).error.code,
        "public_checkout_rate_limited",
      );

      const independentSource = await request(test.address, {
        path: target,
        headers: { "x-forwarded-for": "203.0.113.17, 127.0.0.2" },
      });
      assert.equal(independentSource.status, 404);
    } finally {
      await test.close();
    }
  });

  it("does not let an untrusted forwarding header select a fresh checkout budget", async () => {
    const test = await fixture();
    const target = `/api/public/v1/checkouts/pct1_${"A".repeat(43)}`;
    try {
      const responses = await Promise.all(
        Array.from({ length: 160 }, (_, index) => request(test.address, {
          path: target,
          headers: { "x-forwarded-for": `198.51.100.${index + 1}` },
        })),
      );
      assert.ok(responses.some((response) => response.status === 429));
    } finally {
      await test.close();
    }
  });
});

function signedHeaders(target: string, timestamp: string, nonce: string): Record<string, string> {
  const signed = signApiRequest({
    secret: Buffer.from(apiSecret, "base64url"),
    method: "GET",
    target,
    body: Buffer.alloc(0),
    clientId: "default",
    timestamp,
    nonce,
  });
  return {
    "x-perpay-signature-version": signed.version,
    "x-perpay-client-id": signed.clientId,
    "x-perpay-timestamp": signed.timestamp,
    "x-perpay-nonce": signed.nonce,
    "x-perpay-signature": signed.signature,
  };
}

function request(
  address: AddressInfo,
  input: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunks?: readonly Uint8Array[];
  },
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = sendNodeRequest(
      {
        hostname: address.address,
        port: address.port,
        method: input.method ?? "GET",
        path: input.path,
        headers: input.headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    for (const chunk of input.chunks ?? []) outgoing.write(chunk);
    outgoing.end();
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
