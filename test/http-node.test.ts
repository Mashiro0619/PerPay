import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as sendNodeRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { serve, type ServerType } from "@hono/node-server";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { signApiRequest } from "../src/security/api-signature.ts";

const apiSecret = Buffer.alloc(32, 11).toString("base64url");

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-http-node-"));
  const config = loadConfig({
    PERPAY_INITIAL_ADMIN_PASSWORD: "a-secure-local-password",
    PERPAY_API_SECRET: apiSecret,
    PERPAY_DATA_DIR: directory,
    PERPAY_PUBLIC_URL: "http://127.0.0.1:8080",
  });
  const database = await AppDatabase.open(config.databasePath);
  const identity = new IdentityService(database, config);
  await identity.initialize();
  const app = createApp({ config, database, identity, startedAt: new Date() });
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
          origin: "http://127.0.0.1:8080",
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
