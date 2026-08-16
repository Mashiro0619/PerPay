import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, it } from "node:test";

import { isPublicWebhookAddress } from "../src/infrastructure/network/public-address.ts";
import {
  NodeWebhookTransport,
  WebhookTransportError,
  type WebhookTransportTestDependencies,
} from "../src/notifications/transport.ts";

const publicAddresses = Object.freeze([
  Object.freeze({ address: "8.8.8.8", family: 4 }),
  Object.freeze({ address: "2606:4700:4700::1111", family: 6 }),
]);

describe("webhook outbound transport", () => {
  it("accepts only one HTTPS DNS origin", () => {
    for (const origin of [
      "http://hooks.example.test",
      "https://hooks.example.test/path",
      "https://user@hooks.example.test",
      "https://hooks.example.test/#fragment",
      "https://hooks.example.test#",
      "https://hooks.example.test?",
      "https://hooks.example.test.",
      "https://127.0.0.1",
      "https://[::1]",
      `https://${"a".repeat(64)}.example.test`,
      `https://${Array.from({ length: 5 }, () => "a".repeat(63)).join(".")}`,
    ]) {
      assert.throws(
        () => new NodeWebhookTransport(origin),
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "webhook_target_invalid",
        origin,
      );
    }
    assert.doesNotThrow(() => new NodeWebhookTransport("https://hooks.example.test:8443"));
  });

  it("rejects fragment and empty-query delimiters before DNS", async () => {
    let resolverCalls = 0;
    const transport = new NodeWebhookTransport("https://hooks.example.test", {
      startHostnameResolution: () => {
        resolverCalls += 1;
        return resolvedResolution(publicAddresses);
      },
    });
    for (const targetUrl of [
      "https://hooks.example.test/callback#fragment",
      "https://hooks.example.test/callback#",
      "https://hooks.example.test/callback?",
    ]) {
      await assert.rejects(
        transport.post({ ...postInput(), targetUrl }),
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "webhook_target_invalid" &&
          error.retryable === false,
        targetUrl,
      );
    }
    assert.equal(resolverCalls, 0);
  });

  it("rejects every mixed or special-use DNS result before HTTPS", async () => {
    for (const addresses of [
      [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [{ address: "100.100.100.200", family: 4 }],
      [{ address: "2001:db8::1", family: 6 }],
      [{ address: "2001:5::1", family: 6 }],
      [{ address: "::ffff:8.8.8.8", family: 6 }],
    ] as const) {
      let requestCalls = 0;
      const transport = new NodeWebhookTransport("https://hooks.example.test", {
        startHostnameResolution: () => resolvedResolution(addresses),
        request: () => {
          requestCalls += 1;
          return new FakeClientRequest() as unknown as ClientRequest;
        },
      });
      await assert.rejects(
        transport.post(postInput()),
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "target_address_forbidden",
      );
      assert.equal(requestCalls, 0);
    }
  });

  it("pins all addresses, preserves path/query, and fixes protocol headers", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.post(postInput());
    await harness.created;
    assert.equal(harness.options?.hostname, "hooks.example.test");
    assert.equal(harness.options?.servername, "hooks.example.test");
    assert.equal(harness.options?.path, "/receive?tenant=a%26b&mode=1");
    assert.equal(harness.options?.agent, false);
    assert.equal(
      (harness.options as (RequestOptions & { autoSelectFamily?: boolean }) | undefined)
        ?.autoSelectFamily,
      true,
    );
    const headers = harness.options?.headers as Record<string, string>;
    assert.equal(headers.host, "hooks.example.test");
    assert.equal(headers["content-length"], "16");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["accept-encoding"], "identity");
    assert.equal(headers.connection, "close");
    assert.equal(headers["x-perpay-webhook-version"], "1");
    assert.deepEqual(await invokeAllLookup(harness.options?.lookup), publicAddresses);

    const response = new FakeIncomingResponse({
      "content-type": ["application/json"],
      "content-encoding": ["identity"],
    });
    harness.respond(response);
    response.emit("data", Buffer.from('{"ack":true}'));
    response.emit("end");
    const result = await responsePromise;
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "application/json");
    assert.equal(result.contentEncoding, "identity");
    assert.equal(result.body.toString(), '{"ack":true}');
    assert.equal(result.connectedAddress, "8.8.8.8");
    assert.match(result.resolvedAddressesFingerprint, /^[0-9a-f]{64}$/);
  });

  it("does not allow extension headers to replace transport headers", async () => {
    for (const name of ["host", "Host", "content-length", "Connection", "transfer-encoding"]) {
      const harness = createHarness();
      await assert.rejects(
        harness.transport.post({
          ...postInput(),
          headers: { [name]: "attacker-controlled" },
        }),
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "request_headers_invalid" &&
          error.retryable === false,
      );
      assert.equal(harness.client.writes.length, 0);
    }
  });

  it("rejects duplicate protocol headers, remote-address changes, and oversized bodies", async () => {
    {
      const harness = createHarness();
      const promise = harness.transport.post(postInput());
      const rejection = assert.rejects(
        promise,
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "response_headers_invalid",
      );
      await harness.created;
      const response = new FakeIncomingResponse({
        "content-type": ["application/json", "text/plain"],
      });
      harness.respond(response);
      await rejection;
      assert.equal(response.destroyCount, 1);
    }
    {
      const harness = createHarness();
      const promise = harness.transport.post(postInput());
      const rejection = assert.rejects(
        promise,
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "target_address_forbidden",
      );
      await harness.created;
      harness.respond(new FakeIncomingResponse(
        { "content-type": ["application/json"] },
        200,
        "1.1.1.1",
      ));
      await rejection;
    }
    {
      const harness = createHarness();
      const promise = harness.transport.post(postInput());
      const rejection = assert.rejects(
        promise,
        (error: unknown) =>
          error instanceof WebhookTransportError &&
          error.code === "response_body_too_large",
      );
      await harness.created;
      const response = new FakeIncomingResponse({
        "content-type": ["application/json"],
      });
      harness.respond(response);
      response.emit("data", Buffer.alloc(16 * 1024 + 1));
      await rejection;
      assert.equal(response.destroyCount, 1);
    }
  });

  it("resolves independently for every attempt and never follows redirects", async () => {
    let resolverCalls = 0;
    let requestCalls = 0;
    const transport = new NodeWebhookTransport("https://hooks.example.test", {
      startHostnameResolution: () => {
        resolverCalls += 1;
        return resolvedResolution(resolverCalls === 1
          ? publicAddresses
          : [{ address: "127.0.0.1", family: 4 }]);
      },
      request: (_options, onResponse) => {
        requestCalls += 1;
        const client = new FakeClientRequest();
        queueMicrotask(() => {
          const response = new FakeIncomingResponse(
            { "content-type": ["text/plain"] },
            302,
          );
          onResponse(response as unknown as IncomingMessage);
          response.emit("end");
        });
        return client as unknown as ClientRequest;
      },
    });
    const first = await transport.post(postInput());
    assert.equal(first.status, 302);
    await assert.rejects(
      transport.post(postInput()),
      (error: unknown) =>
        error instanceof WebhookTransportError &&
        error.code === "target_address_forbidden",
    );
    assert.equal(resolverCalls, 2);
    assert.equal(requestCalls, 1);
  });

  it("bounds concurrent DNS work without coalescing independent attempts", async () => {
    let resolverCalls = 0;
    let activeResolvers = 0;
    let maximumActiveResolvers = 0;
    const pendingResolvers: Array<(
      addresses: readonly { readonly address: string; readonly family: number }[],
    ) => void> = [];
    const transport = new NodeWebhookTransport("https://hooks.example.test", {
      startHostnameResolution: () => {
        resolverCalls += 1;
        activeResolvers += 1;
        maximumActiveResolvers = Math.max(maximumActiveResolvers, activeResolvers);
        const result = new Promise<readonly ResolverAddress[]>((resolve) => {
          pendingResolvers.push((addresses) => {
            activeResolvers -= 1;
            resolve(addresses);
          });
        });
        return resolutionTask(result);
      },
      request: (_options, onResponse) => {
        const client = new FakeClientRequest();
        queueMicrotask(() => {
          const response = new FakeIncomingResponse({
            "content-type": ["application/json"],
          });
          onResponse(response as unknown as IncomingMessage);
          response.emit("end");
        });
        return client as unknown as ClientRequest;
      },
    });

    const attempts = Array.from({ length: 6 }, () => transport.post(postInput()));
    await waitFor(() => resolverCalls === 4);
    assert.equal(maximumActiveResolvers, 4);
    for (const resolve of pendingResolvers.splice(0, 4)) resolve(publicAddresses);
    await waitFor(() => resolverCalls === 6);
    assert.equal(maximumActiveResolvers, 4);
    for (const resolve of pendingResolvers.splice(0)) resolve(publicAddresses);
    await Promise.all(attempts);
    assert.equal(resolverCalls, 6);
    assert.equal(activeResolvers, 0);
  });

  it("cancels hung DNS work, restores capacity, and preserves the hard limit", async () => {
    let resolverCalls = 0;
    let activeResolvers = 0;
    let maximumActiveResolvers = 0;
    const jobs: Array<{
      complete(addresses: readonly ResolverAddress[]): void;
    }> = [];
    const transport = new NodeWebhookTransport("https://hooks.example.test", {
      startHostnameResolution: () => {
        resolverCalls += 1;
        activeResolvers += 1;
        maximumActiveResolvers = Math.max(maximumActiveResolvers, activeResolvers);
        const pending = deferred<readonly ResolverAddress[]>();
        let active = true;
        const stop = () => {
          if (!active) return;
          active = false;
          activeResolvers -= 1;
        };
        jobs.push({
          complete(addresses) {
            stop();
            pending.resolve(addresses);
          },
        });
        return resolutionTask(pending.promise, () => {
          stop();
          pending.reject(new Error("DNS resolution cancelled"));
        });
      },
      request: (_options, onResponse) => {
        const client = new FakeClientRequest();
        queueMicrotask(() => {
          const response = new FakeIncomingResponse({
            "content-type": ["application/json"],
          });
          onResponse(response as unknown as IncomingMessage);
          response.emit("end");
        });
        return client as unknown as ClientRequest;
      },
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const cancelledAttempts = controllers.map((controller) => assert.rejects(
      transport.post({ ...postInput(), signal: controller.signal }),
      (error: unknown) =>
        error instanceof WebhookTransportError && error.code === "transport_cancelled",
    ));
    const survivors = [transport.post(postInput()), transport.post(postInput())];

    await waitFor(() => resolverCalls === 4);
    assert.equal(activeResolvers, 4);
    for (const controller of controllers) controller.abort();
    await Promise.all(cancelledAttempts);
    await waitFor(() => resolverCalls === 6);
    assert.equal(activeResolvers, 2);
    assert.equal(maximumActiveResolvers, 4);
    const fifth = jobs[4];
    const sixth = jobs[5];
    assert.ok(fifth);
    assert.ok(sixth);
    fifth.complete(publicAddresses);
    sixth.complete(publicAddresses);
    await Promise.all(survivors);
    assert.equal(activeResolvers, 0);
    assert.equal(maximumActiveResolvers, 4);
  });

  it("cancels or times out during DNS without opening HTTPS", async () => {
    let requestCalls = 0;
    let resolverCalls = 0;
    let cancelCalls = 0;
    const transport = new NodeWebhookTransport("https://hooks.example.test", {
      startHostnameResolution: () => {
        resolverCalls += 1;
        const pending = deferred<readonly ResolverAddress[]>();
        const timer = setTimeout(() => pending.resolve(publicAddresses), 40);
        return resolutionTask(pending.promise, () => {
          cancelCalls += 1;
          clearTimeout(timer);
          pending.reject(new Error("DNS resolution cancelled"));
        });
      },
      request: () => {
        requestCalls += 1;
        return new FakeClientRequest() as unknown as ClientRequest;
      },
    });

    await assert.rejects(
      transport.post({ ...postInput(), timeoutMilliseconds: 5 }),
      (error: unknown) =>
        error instanceof WebhookTransportError && error.code === "transport_timeout",
    );
    assert.equal(resolverCalls, 1);
    assert.equal(cancelCalls, 1);

    const controller = new AbortController();
    const cancelled = transport.post({ ...postInput(), signal: controller.signal });
    controller.abort();
    await assert.rejects(
      cancelled,
      (error: unknown) =>
        error instanceof WebhookTransportError && error.code === "transport_cancelled",
    );
    assert.equal(resolverCalls, 2);
    assert.equal(cancelCalls, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requestCalls, 0);
  });

  it("uses a direct pinned request even when proxy environment variables exist", async () => {
    const previousHttpsProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    try {
      const harness = createHarness();
      const responsePromise = harness.transport.post(postInput());
      await harness.created;
      assert.equal(harness.options?.hostname, "hooks.example.test");
      assert.equal(harness.options?.path, "/receive?tenant=a%26b&mode=1");
      assert.equal(Object.hasOwn(harness.options ?? {}, "proxy"), false);
      const headers = harness.options?.headers as Record<string, string>;
      assert.equal(Object.hasOwn(headers, "proxy-authorization"), false);
      const response = new FakeIncomingResponse({
        "content-type": ["application/json"],
      });
      harness.respond(response);
      response.emit("end");
      await responsePromise;
    } finally {
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousHttpsProxy;
    }
  });
});

describe("webhook public-address policy", () => {
  it("accepts ordinary public addresses and rejects non-global ranges", () => {
    assert.equal(isPublicWebhookAddress("8.8.8.8", 4), true);
    assert.equal(isPublicWebhookAddress("2606:4700:4700::1111", 6), true);
    for (const [address, family] of [
      ["10.0.0.1", 4],
      ["198.51.100.1", 4],
      ["::1", 6],
      ["fc00::1", 6],
      ["fe80::1", 6],
      ["2001:db8::1", 6],
      ["2002:0808:0808::1", 6],
    ] as const) {
      assert.equal(isPublicWebhookAddress(address, family), false, address);
    }
  });
});

class FakeClientRequest extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly destroyErrors: Array<Error | undefined> = [];

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(): this {
    return this;
  }

  destroy(error?: Error): this {
    this.destroyErrors.push(error);
    return this;
  }
}

class FakeIncomingResponse extends EventEmitter {
  readonly headersDistinct: Readonly<Record<string, readonly string[]>>;
  readonly statusCode: number;
  readonly socket: { readonly remoteAddress: string };
  destroyCount = 0;

  constructor(
    headersDistinct: Readonly<Record<string, readonly string[]>>,
    statusCode = 200,
    remoteAddress = "8.8.8.8",
  ) {
    super();
    this.headersDistinct = headersDistinct;
    this.statusCode = statusCode;
    this.socket = { remoteAddress };
  }

  destroy(): this {
    this.destroyCount += 1;
    return this;
  }
}

function postInput() {
  return {
    targetUrl: "https://hooks.example.test/receive?tenant=a%26b&mode=1",
    body: Buffer.from('{"event":"test"}'),
    headers: { "x-perpay-webhook-version": "1" },
    timeoutMilliseconds: 1_000,
  } as const;
}

function createHarness() {
  const client = new FakeClientRequest();
  let options: RequestOptions | undefined;
  let onResponse: ((response: IncomingMessage) => void) | undefined;
  let resolveCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    resolveCreated = resolve;
  });
  const dependencies: WebhookTransportTestDependencies = {
    startHostnameResolution: () => resolvedResolution(publicAddresses),
    request: (captured, callback) => {
      options = captured;
      onResponse = callback;
      resolveCreated();
      return client as unknown as ClientRequest;
    },
  };
  return {
    transport: new NodeWebhookTransport("https://hooks.example.test", dependencies),
    client,
    created,
    get options() {
      return options;
    },
    respond(response: FakeIncomingResponse) {
      assert.ok(onResponse);
      onResponse(response as unknown as IncomingMessage);
    },
  };
}

interface ResolverAddress {
  readonly address: string;
  readonly family: number;
}

type ResolverFactory = NonNullable<
  WebhookTransportTestDependencies["startHostnameResolution"]
>;

function resolvedResolution(addresses: readonly ResolverAddress[]) {
  return resolutionTask(Promise.resolve(addresses));
}

function resolutionTask(
  result: Promise<readonly ResolverAddress[]>,
  cancel: () => void = () => undefined,
): ReturnType<ResolverFactory> {
  return { result, cancel };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function invokeAllLookup(
  lookupFunction: RequestOptions["lookup"] | undefined,
): Promise<readonly { readonly address: string; readonly family: number }[]> {
  if (typeof lookupFunction !== "function") throw new Error("lookup hook is missing");
  return new Promise((resolve, reject) => {
    Reflect.apply(lookupFunction, undefined, [
      "hooks.example.test",
      { all: true },
      (
        error: Error | null,
        addresses: readonly { readonly address: string; readonly family: number }[],
      ) => {
        if (error) reject(error);
        else resolve(addresses);
      },
    ]);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("webhook transport test condition was not reached");
}
