import assert from "node:assert/strict";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  AlipayProviderError,
  MAX_PROVIDER_RESPONSE_BYTES,
  NodeV3Transport,
  normalizeV3Headers,
  type NodeV3TransportTestDependencies,
  type SignedV3Request,
} from "../src/infrastructure/alipay/index.ts";

const request: SignedV3Request = {
  method: "GET",
  path: "/v3/alipay/data/bill/accountlog/query?page_no=1",
  body: "",
  headers: { authorization: "ALIPAY-SHA256withRSA test" },
  requestId: "transport-race-test",
};

const publicAddresses = Object.freeze([
  Object.freeze({ address: "8.8.8.8", family: 4 }),
  Object.freeze({ address: "2606:4700:4700::1111", family: 6 }),
]);

describe("Node V3 transport network behavior", () => {
  it("rejects unsafe custom user agents before resolving DNS", () => {
    let resolverCalls = 0;
    const dependencies: NodeV3TransportTestDependencies = {
      resolveHostname: async () => {
        resolverCalls += 1;
        return publicAddresses;
      },
    };
    for (const userAgent of [
      "",
      "unsafe\0agent",
      "unsafe\u0001agent",
      "unsafe\u007fagent",
      "unsafe\u0100agent",
      "x".repeat(8 * 1024 + 1),
    ]) {
      assert.throws(
        () => new NodeV3Transport({ userAgent }, dependencies),
        (error: unknown) =>
          error instanceof AlipayProviderError && error.code === "configuration_invalid",
      );
    }
    assert.equal(resolverCalls, 0);
  });

  it("pins all validated addresses into one auto-family HTTPS request", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    await harness.created;

    assert.equal(harness.requestCalls, 1);
    assert.equal(harness.options?.hostname, "openapi.alipay.com");
    assert.equal(harness.options?.servername, "openapi.alipay.com");
    assert.equal(harness.options?.autoSelectFamily, true);
    assert.equal(harness.options?.agent, false);
    assert.equal(
      (harness.options?.headers as Readonly<Record<string, string>> | undefined)?.host,
      "openapi.alipay.com",
    );
    const pinned = await invokeAllLookup(harness.options?.lookup);
    assert.deepEqual(pinned, publicAddresses);

    const response = new FakeIncomingResponse();
    harness.respond(response);
    response.emit("data", Buffer.from("ok", "utf8"));
    response.emit("end");
    const result = await responsePromise;

    assert.equal(Buffer.from(result.body).toString("utf8"), "ok");
    assert.equal(harness.requestCalls, 1);
  });

  it("rejects request header arrays before resolving DNS", async () => {
    let resolverCalls = 0;
    const transport = new NodeV3Transport({}, {
      resolveHostname: async () => {
        resolverCalls += 1;
        return publicAddresses;
      },
    });

    await assert.rejects(
      transport.request({
        ...request,
        headers: { authorization: ["ALIPAY-SHA256withRSA test"] },
      }, { timeoutMilliseconds: 1_000 }),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    assert.equal(resolverCalls, 0);
  });

  it("preserves bounded duplicate response headers", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    await harness.created;

    const response = new FakeIncomingResponse(Object.freeze({
      "set-cookie": Object.freeze(["first=1", "second=2"]),
    }));
    harness.respond(response);
    response.emit("end");
    const result = await responsePromise;

    assert.deepEqual(result.headers["set-cookie"], ["first=1", "second=2"]);
    assert.equal(Object.isFrozen(result.headers["set-cookie"]), true);
  });

  it("counts duplicate response headers as complete HTTP field lines", () => {
    assert.doesNotThrow(() => normalizeV3Headers({
      "x-small": ["", ""],
    }));
    assert.throws(
      () => normalizeV3Headers({
        x: ["a".repeat(8_190), "b".repeat(8_190)],
      }),
      TypeError,
    );
    assert.throws(
      () => normalizeV3Headers({
        x: Array.from({ length: 129 }, () => ""),
      }),
      TypeError,
    );
  });

  it("reads a bounded body before reporting invalid response headers", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(responsePromise, (error: unknown) => {
      assert.ok(error instanceof AlipayProviderError);
      assert.equal(error.code, "response_invalid_shape");
      assert.equal(error.status, 502);
      assert.ok(error.rawBody instanceof Uint8Array);
      assert.equal(Buffer.from(error.rawBody).toString("utf8"), "header evidence");
      return true;
    });
    await harness.created;

    const response = new FakeIncomingResponse(Object.freeze({
      "x-many": Object.freeze(Array.from({ length: 129 }, () => "")),
    }), 502);
    harness.respond(response);
    response.emit("data", Buffer.from("header evidence", "utf8"));
    assert.equal(response.destroyCount, 0);
    response.emit("end");

    await rejection;
    assert.equal(response.destroyCount, 0);
    assert.equal(harness.client.destroyErrors.length, 0);
  });

  it("enforces the body limit while response headers are invalid", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(responsePromise, (error: unknown) => {
      assert.ok(error instanceof AlipayProviderError);
      assert.equal(error.code, "response_body_too_large");
      assert.equal(error.status, 502);
      assert.equal(error.responseHeaders, null);
      assert.ok(error.rawBody instanceof Uint8Array);
      assert.equal(error.rawBody.byteLength, MAX_PROVIDER_RESPONSE_BYTES);
      assert.equal(error.signatureVerified, null);
      return true;
    });
    await harness.created;

    const response = new FakeIncomingResponse(Object.freeze({
      "x-many": Object.freeze(Array.from({ length: 129 }, () => "")),
    }), 502);
    harness.respond(response);
    response.emit("data", Buffer.alloc(MAX_PROVIDER_RESPONSE_BYTES + 1));

    await rejection;
    assert.equal(response.destroyCount, 1);
    assert.equal(harness.client.destroyErrors.length, 1);
  });

  it("never expands a sub-250ms total deadline into a 250ms address attempt", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 100 });
    const rejection = assert.rejects(
      responsePromise,
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "transport_timeout",
    );
    await harness.created;

    const deadline = harness.timers.onlyActive();
    assert.ok(deadline.delay > 0 && deadline.delay <= 100);
    deadline.fire();
    await rejection;
    assert.equal(harness.client.destroyErrors.length, 1);
  });

  it("settles caller cancellation first and destroys the request once", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const responsePromise = harness.transport.request(request, {
      timeoutMilliseconds: 1_000,
      signal: controller.signal,
    });
    const rejection = assert.rejects(
      responsePromise,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await harness.created;

    controller.abort();
    controller.abort();
    await rejection;
    assert.equal(harness.client.destroyErrors.length, 1);
    assert.equal(harness.client.destroyErrors[0]?.name, "AbortError");
    assert.equal(harness.timers.activeCount, 0);
  });

  it("keeps a completed response successful when cancellation and deadline arrive later", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const responsePromise = harness.transport.request(request, {
      timeoutMilliseconds: 1_000,
      signal: controller.signal,
    });
    await harness.created;

    const response = new FakeIncomingResponse();
    harness.respond(response);
    response.emit("data", Buffer.from("complete", "utf8"));
    response.emit("end");
    const result = await responsePromise;
    controller.abort();
    harness.timers.fireAll();

    assert.equal(Buffer.from(result.body).toString("utf8"), "complete");
    assert.equal(harness.client.destroyErrors.length, 0);
    assert.equal(response.destroyCount, 0);
  });

  it("preserves partial response evidence when cancellation arrives after response headers", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const responsePromise = harness.transport.request(request, {
      timeoutMilliseconds: 1_000,
      signal: controller.signal,
    });
    const rejection = assert.rejects(responsePromise, (error: unknown) => {
      assertResponseFailureEvidence(error, "transport_cancelled", 502, "partial-cancelled");
      assert.equal(error.kind, "cancelled");
      assert.equal(error.retryable, false);
      assert.deepEqual({ ...error.responseHeaders }, { "x-trace": "cancelled" });
      return true;
    });
    await harness.created;

    const response = new FakeIncomingResponse({ "x-trace": "cancelled" }, 502);
    harness.respond(response);
    response.emit("data", Buffer.from("partial-cancelled", "utf8"));
    controller.abort();

    await rejection;
    assert.equal(response.destroyCount, 1);
    assert.equal(harness.client.destroyErrors.length, 1);
  });

  it("drops response events that arrive after the deadline", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(
      responsePromise,
      (error: unknown) => {
        assertResponseFailureEvidence(error, "transport_timeout", 200, "partial");
        return true;
      },
    );
    await harness.created;

    const response = new FakeIncomingResponse();
    harness.respond(response);
    response.emit("data", Buffer.from("partial", "utf8"));
    harness.timers.onlyActive().fire();
    await rejection;

    const poison = { toString: () => { throw new Error("late data was converted"); } };
    assert.doesNotThrow(() => response.emit("data", poison));
    assert.doesNotThrow(() => response.emit("end"));
    assert.equal(response.destroyCount, 1);
    assert.equal(harness.client.destroyErrors.length, 1);

    const lateHarness = createHarness();
    const latePromise = lateHarness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const lateRejection = assert.rejects(latePromise, AlipayProviderError);
    await lateHarness.created;
    lateHarness.timers.onlyActive().fire();
    await lateRejection;
    const lateResponse = new FakeIncomingResponse();
    lateHarness.respond(lateResponse);
    assert.equal(lateResponse.destroyCount, 1);
    assert.equal(lateResponse.listenerCount("data"), 0);
    assert.equal(lateResponse.listenerCount("end"), 0);
  });

  it("does not open HTTPS after DNS loses a timeout or cancellation race", async () => {
    for (const outcome of ["timeout", "cancel"] as const) {
      const resolution = deferred<readonly ResolverAddress[]>();
      const harness = createHarness(() => resolution.promise);
      const controller = new AbortController();
      const responsePromise = harness.transport.request(request, {
        timeoutMilliseconds: 1_000,
        signal: controller.signal,
      });
      const rejection = assert.rejects(
        responsePromise,
        (error: unknown) => outcome === "cancel"
          ? error instanceof Error && error.name === "AbortError"
          : error instanceof AlipayProviderError && error.code === "transport_timeout",
      );

      if (outcome === "cancel") controller.abort();
      else harness.timers.onlyActive().fire();
      await rejection;
      resolution.resolve(publicAddresses);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.requestCalls, 0, outcome);
    }
  });

  it("keeps one shared in-flight DNS task after an individual caller times out", async () => {
    const resolution = deferred<readonly ResolverAddress[]>();
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return resolution.promise;
    };
    const first = createHarness(resolver);
    const second = createHarness(resolver);
    const firstPromise = first.transport.request(request, { timeoutMilliseconds: 1_000 });
    const firstRejection = assert.rejects(firstPromise, AlipayProviderError);
    const secondPromise = second.transport.request(request, { timeoutMilliseconds: 1_000 });

    first.timers.onlyActive().fire();
    await firstRejection;
    const third = createHarness(resolver);
    const thirdPromise = third.transport.request(request, { timeoutMilliseconds: 1_000 });
    resolution.resolve(publicAddresses);
    await Promise.all([second.created, third.created]);

    assert.equal(resolverCalls, 1);
    assert.equal(first.requestCalls, 0);
    const secondResponse = new FakeIncomingResponse();
    const thirdResponse = new FakeIncomingResponse();
    second.respond(secondResponse);
    third.respond(thirdResponse);
    secondResponse.emit("end");
    thirdResponse.emit("end");
    await Promise.all([secondPromise, thirdPromise]);
  });

  it("destroys an oversized response immediately", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(
      responsePromise,
      (error: unknown) => {
        assert.ok(error instanceof AlipayProviderError);
        assert.equal(error.code, "response_body_too_large");
        assert.equal(error.status, 502);
        assert.deepEqual({ ...error.responseHeaders }, { "x-trace": "oversized" });
        assert.ok(error.rawBody instanceof Uint8Array);
        assert.equal(error.rawBody.byteLength, MAX_PROVIDER_RESPONSE_BYTES);
        assert.equal(error.signatureVerified, null);
        return true;
      },
    );
    await harness.created;

    const response = new FakeIncomingResponse({ "x-trace": "oversized" }, 502);
    harness.respond(response);
    response.emit("data", Buffer.alloc(MAX_PROVIDER_RESPONSE_BYTES + 1));
    await rejection;
    assert.equal(response.destroyCount, 1);
    assert.equal(harness.client.destroyErrors.length, 1);
  });

  it("preserves partial response evidence when the response or connection fails", async () => {
    for (const failure of ["response-aborted", "response-error", "request-error"] as const) {
      const harness = createHarness();
      const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
      const rejection = assert.rejects(responsePromise, (error: unknown) => {
        assertResponseFailureEvidence(error, "transport_network", 502, `partial-${failure}`);
        assert.deepEqual({ ...(error as AlipayProviderError).responseHeaders }, { "x-trace": failure });
        return true;
      });
      await harness.created;

      const response = new FakeIncomingResponse({ "x-trace": failure }, 502);
      harness.respond(response);
      response.emit("data", Buffer.from(`partial-${failure}`, "utf8"));
      if (failure === "response-aborted") response.emit("aborted");
      else if (failure === "response-error") response.emit("error", new Error("stream failed"));
      else harness.client.emit("error", new Error("connection failed"));

      await rejection;
      assert.equal(response.destroyCount, 1);
      assert.equal(harness.client.destroyErrors.length, 1);
    }
  });

  it("ignores every late failure after preserving the first response failure", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(responsePromise, (error: unknown) => {
      assertResponseFailureEvidence(error, "transport_network", 502, "first-failure");
      return true;
    });
    await harness.created;

    const response = new FakeIncomingResponse({ "x-trace": "late-failures" }, 502);
    harness.respond(response);
    response.emit("data", Buffer.from("first-failure", "utf8"));
    response.emit("aborted");
    await rejection;

    assert.doesNotThrow(() => response.emit("error", new Error("late stream error")));
    assert.doesNotThrow(() => harness.client.emit("error", new Error("late request error")));
    assert.doesNotThrow(() => harness.timers.fireAll());
    assert.equal(response.destroyCount, 1);
    assert.equal(harness.client.destroyErrors.length, 1);
  });

  it("does not issue a second GET after a connection error", async () => {
    const harness = createHarness();
    const responsePromise = harness.transport.request(request, { timeoutMilliseconds: 1_000 });
    const rejection = assert.rejects(responsePromise, /connection failed/);
    await harness.created;

    harness.client.emit("error", new Error("connection failed"));
    await rejection;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.requestCalls, 1);
  });
});

interface ResolverAddress {
  readonly address: string;
  readonly family: number;
}

class FakeClientRequest extends EventEmitter {
  readonly destroyErrors: Array<Error | undefined> = [];
  readonly writes: Buffer[] = [];
  ended = false;

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(error?: Error): this {
    this.destroyErrors.push(error);
    return this;
  }
}

class FakeIncomingResponse extends EventEmitter {
  readonly headersDistinct: Readonly<Record<string, string | readonly string[]>>;
  readonly statusCode: number;
  destroyCount = 0;

  constructor(
    headersDistinct: Readonly<Record<string, string | readonly string[]>> = Object.freeze({}),
    statusCode = 200,
  ) {
    super();
    this.headersDistinct = headersDistinct;
    this.statusCode = statusCode;
  }

  destroy(): this {
    this.destroyCount += 1;
    return this;
  }
}

class ManualTimers {
  readonly #entries: ManualTimer[] = [];

  readonly schedule = (callback: () => void, delay: number): NodeJS.Timeout => {
    const timer = new ManualTimer(callback, delay);
    this.#entries.push(timer);
    return timer as unknown as NodeJS.Timeout;
  };

  readonly cancel = (handle: NodeJS.Timeout): void => {
    const timer = handle as unknown as ManualTimer;
    timer.active = false;
  };

  get activeCount(): number {
    return this.#entries.filter((timer) => timer.active).length;
  }

  onlyActive(): ManualTimer {
    const active = this.#entries.filter((timer) => timer.active);
    assert.equal(active.length, 1);
    const timer = active[0];
    if (!timer) throw new Error("active timer disappeared");
    return timer;
  }

  fireAll(): void {
    for (const timer of this.#entries) {
      if (timer.active) timer.fire();
    }
  }
}

class ManualTimer {
  active = true;
  readonly callback: () => void;
  readonly delay: number;

  constructor(callback: () => void, delay: number) {
    this.callback = callback;
    this.delay = delay;
  }

  unref(): this {
    return this;
  }

  fire(): void {
    if (!this.active) return;
    this.active = false;
    this.callback();
  }
}

function createHarness(
  resolver: (hostname: string) => Promise<readonly ResolverAddress[]> = async () => publicAddresses,
) {
  const client = new FakeClientRequest();
  const timers = new ManualTimers();
  const created = deferred<void>();
  let requestCalls = 0;
  let options: (RequestOptions & { readonly autoSelectFamily?: boolean }) | undefined;
  let onResponse: ((response: IncomingMessage) => void) | undefined;
  const dependencies: NodeV3TransportTestDependencies = {
    resolveHostname: resolver,
    request: (capturedOptions, callback) => {
      requestCalls += 1;
      options = capturedOptions;
      onResponse = callback;
      created.resolve();
      return client as unknown as ClientRequest;
    },
    now: () => 0,
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  };
  const transport = new NodeV3Transport({}, dependencies);

  return {
    transport,
    client,
    timers,
    created: created.promise,
    get requestCalls() { return requestCalls; },
    get options() { return options; },
    respond(response: FakeIncomingResponse) {
      assert.ok(onResponse, "HTTPS response callback was not registered");
      onResponse(response as unknown as IncomingMessage);
    },
  };
}

function invokeAllLookup(
  lookupFunction: RequestOptions["lookup"] | undefined,
): Promise<readonly ResolverAddress[]> {
  if (typeof lookupFunction !== "function") {
    throw new Error("HTTPS lookup hook was not configured");
  }
  return new Promise((resolve, reject) => {
    Reflect.apply(lookupFunction, undefined, [
      "openapi.alipay.com",
      { all: true },
      (error: Error | null, addresses: readonly ResolverAddress[]) => {
        if (error) reject(error);
        else resolve(addresses);
      },
    ]);
  });
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

function assertResponseFailureEvidence(
  error: unknown,
  code: AlipayProviderError["code"],
  status: number,
  body: string,
): asserts error is AlipayProviderError {
  assert.ok(error instanceof AlipayProviderError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.ok(error.rawBody instanceof Uint8Array);
  assert.equal(Buffer.from(error.rawBody).toString("utf8"), body);
  assert.equal(error.signatureVerified, null);
}
