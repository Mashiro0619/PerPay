import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig, type AppConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import {
  WebhookStore,
  webhookSigningKeyFingerprint,
  type WebhookEvent,
} from "../src/notifications/index.ts";
import type { OrderProjection } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { signApiRequest } from "../src/security/api-signature.ts";

const ADMIN_PASSWORD = "notifications-http-admin-password";
const API_SECRET = Buffer.alloc(32, 41).toString("base64url");
const WEBHOOK_SECRET = Buffer.alloc(32, 73).toString("base64url");
const COLLECTION_CODE = "https://qr.alipay.com/fkx-notifications-http";
const PUBLIC_ORIGIN = "http://localhost:8080";
const ALLOWED_ORIGIN = "https://hooks.mashiro.dev";
const ROTATED_ORIGIN = "https://callbacks.mashiro.dev";
const API_CLIENT_ID = "default";
const ISOLATED_CLIENT_ID = "isolated-client";
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000999",
} as const;

describe("notification HTTP contract", () => {
  it("projects notify_url and returns only events owned by the signed API client", async () => {
    await withNotificationFixture(async (fixture) => {
      const firstOrder = fixture.orders[0];
      assert.ok(firstOrder);
      assert.equal(firstOrder.httpProjection.notification.notify_url, firstOrder.notifyUrl);

      const event = firstOrder.event;
      const eventTarget = `/api/v1/events/${event.eventId}`;
      const response = await fixture.app.request(eventTarget, {
        headers: apiHeaders("GET", eventTarget, Buffer.alloc(0)),
      });
      assert.equal(response.status, 200);
      const eventData = await responseData<{
        event_id: string;
        event_type: string;
        order_id: string;
        order_version: number;
        payload: { event_id: string; order_id: string; schema: string };
        payload_fingerprint: string;
        created_at: string;
      }>(response);
      assert.equal(eventData.event_id, event.eventId);
      assert.equal(eventData.event_type, "PAYMENT_CONFIRMED");
      assert.equal(eventData.order_id, firstOrder.order.orderId);
      assert.equal(eventData.payload.event_id, event.eventId);
      assert.equal(eventData.payload.order_id, firstOrder.order.orderId);
      assert.equal(eventData.payload.schema, "perpay:outbox-event:v2");
      assert.equal(eventData.payload_fingerprint, event.payloadFingerprint);
      assert.equal(eventData.created_at, new Date(event.createdAt).toISOString());

      assert.equal(
        fixture.webhooks.eventForApiClient(ISOLATED_CLIENT_ID, fixture.isolatedEvent.eventId)?.eventId,
        fixture.isolatedEvent.eventId,
      );
      for (const hiddenEventId of [fixture.isolatedEvent.eventId, randomUUID()]) {
        const target = `/api/v1/events/${hiddenEventId}`;
        const hidden = await fixture.app.request(target, {
          headers: apiHeaders("GET", target, Buffer.alloc(0)),
        });
        assert.equal(hidden.status, 404);
        assert.equal(await responseErrorCode(hidden), "event_not_found");
      }

      const malformedTarget = "/api/v1/events/not-a-canonical-event";
      const malformed = await fixture.app.request(malformedTarget, {
        headers: apiHeaders("GET", malformedTarget, Buffer.alloc(0)),
      });
      assert.equal(malformed.status, 404);
      assert.equal(await responseErrorCode(malformed), "event_not_found");
    });
  });

  it("rejects a target that exceeds the limit after URL normalization", async () => {
    await withNotificationFixture(async (fixture) => {
      const target = "/api/v1/orders";
      const body = Buffer.from(JSON.stringify({
        idempotency_key: "notifications-http-normalized-url-limit",
        merchant_order_no: "notifications-http-normalized-url-limit",
        amount_cents: 20_001,
        notify_url: `${ALLOWED_ORIGIN}/${"\u4f60".repeat(1_300)}`,
      }), "utf8");
      const response = await fixture.app.request(target, {
        method: "POST",
        headers: {
          ...apiHeaders("POST", target, body),
          "content-type": "application/json",
        },
        body,
      });
      assert.equal(response.status, 422);
      assert.equal(await responseErrorCode(response), "webhook_target_invalid");
    });
  });

  it("protects administration, binds cursors, and redelivers terminal generations", async () => {
    await withNotificationFixture(async (fixture) => {
      const original = fixture.deliveries[0];
      assert.ok(original);
      const deliveryPath = `/api/admin/v1/webhooks/deliveries/${original.deliveryId}`;
      const attemptsPath = `${deliveryPath}/attempts`;
      for (const path of [
        "/api/admin/v1/webhooks/deliveries",
        deliveryPath,
        attemptsPath,
      ]) {
        const anonymous = await fixture.app.request(path);
        assert.equal(anonymous.status, 401);
        assert.equal(await responseErrorCode(anonymous), "session_invalid");
      }

      const auth = await login(fixture.app);
      const detail = await fixture.app.request(deliveryPath, { headers: { cookie: auth.cookie } });
      assert.equal(detail.status, 200);
      const attempts = await fixture.app.request(attemptsPath, { headers: { cookie: auth.cookie } });
      assert.equal(attempts.status, 200);
      const attemptText = await attempts.text();
      assert.equal(attemptText.includes("leaseToken"), false);
      assert.equal(attemptText.includes("lease_token"), false);
      assert.equal(attemptText.includes(original.leaseToken), false);
      const attemptData = (JSON.parse(attemptText) as {
        data: Array<{ attempt_number: number; outcome: string }>;
      }).data;
      assert.equal(attemptData.length, 1);
      assert.equal(attemptData[0]?.attempt_number, 1);
      assert.equal(attemptData[0]?.outcome, "ACKNOWLEDGED");

      const firstPageTarget =
        "/api/admin/v1/webhooks/deliveries?status=ACKNOWLEDGED&limit=1";
      const firstPage = await fixture.app.request(firstPageTarget, {
        headers: { cookie: auth.cookie },
      });
      assert.equal(firstPage.status, 200);
      const firstPageBody = (await firstPage.json()) as {
        data: Array<{ status: string }>;
        page: { next_cursor: string | null };
      };
      assert.equal(firstPageBody.data.length, 1);
      assert.equal(firstPageBody.data[0]?.status, "ACKNOWLEDGED");
      assert.equal(typeof firstPageBody.page.next_cursor, "string");

      const sameFilter = await fixture.app.request(
        `${firstPageTarget}&cursor=${encodeURIComponent(firstPageBody.page.next_cursor!)}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(sameFilter.status, 200);
      const crossFilter = await fixture.app.request(
        "/api/admin/v1/webhooks/deliveries?status=DEAD_LETTER&limit=1" +
          `&cursor=${encodeURIComponent(firstPageBody.page.next_cursor!)}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(crossFilter.status, 422);
      assert.equal(await responseErrorCode(crossFilter), "validation_failed");

      const redeliveryPath = `${deliveryPath}/actions/redeliver`;
      const redeliveryId = randomUUID();
      const request = { redelivery_id: redeliveryId, reason: "operator requested replay" };
      const missingOrigin = await postAdmin(fixture.app, redeliveryPath, auth, request, {
        origin: false,
      });
      assert.equal(missingOrigin.status, 403);
      assert.equal(await responseErrorCode(missingOrigin), "origin_not_allowed");
      const missingCsrf = await postAdmin(fixture.app, redeliveryPath, auth, request, {
        csrf: false,
      });
      assert.equal(missingCsrf.status, 403);
      assert.equal(await responseErrorCode(missingCsrf), "csrf_invalid");
      const missingStepUp = await postAdmin(fixture.app, redeliveryPath, auth, request);
      assert.equal(missingStepUp.status, 403);
      assert.equal(await responseErrorCode(missingStepUp), "step_up_required");

      await stepUp(fixture.app, auth);
      const disabledApp = createFixtureApp(fixture, disabledWebhookConfig(fixture.config));
      const disabled = await postAdmin(
        disabledApp,
        redeliveryPath,
        auth,
        { redelivery_id: randomUUID(), reason: "disabled configuration" },
      );
      assert.equal(disabled.status, 409);
      assert.equal(await responseErrorCode(disabled), "webhook_disabled");

      const rotatedApp = createFixtureApp(fixture, rotatedWebhookConfig(fixture.config));
      const inactive = await postAdmin(
        rotatedApp,
        redeliveryPath,
        auth,
        { redelivery_id: randomUUID(), reason: "historical target" },
      );
      assert.equal(inactive.status, 409);
      assert.equal(await responseErrorCode(inactive), "webhook_target_inactive");

      const created = await postAdmin(fixture.app, redeliveryPath, auth, request);
      assert.equal(created.status, 201);
      const createdData = await responseData<{
        delivery: { delivery_id: string; generation: number; predecessor_delivery_id: string };
        replayed: boolean;
      }>(created);
      assert.equal(createdData.replayed, false);
      assert.equal(createdData.delivery.generation, 2);
      assert.equal(createdData.delivery.predecessor_delivery_id, original.deliveryId);
      assert.equal(
        created.headers.get("location"),
        `/api/admin/v1/webhooks/deliveries/${createdData.delivery.delivery_id}`,
      );

      const replayed = await postAdmin(fixture.app, redeliveryPath, auth, request);
      assert.equal(replayed.status, 200);
      const replayedData = await responseData<{
        delivery: { delivery_id: string };
        replayed: boolean;
      }>(replayed);
      assert.equal(replayedData.replayed, true);
      assert.equal(replayedData.delivery.delivery_id, createdData.delivery.delivery_id);

      for (const changedApp of [disabledApp, rotatedApp]) {
        const replayedAfterConfigurationChange = await postAdmin(
          changedApp,
          redeliveryPath,
          auth,
          request,
        );
        assert.equal(replayedAfterConfigurationChange.status, 200);
        const changedData = await responseData<{
          delivery: { delivery_id: string };
          replayed: boolean;
        }>(replayedAfterConfigurationChange);
        assert.equal(changedData.replayed, true);
        assert.equal(changedData.delivery.delivery_id, createdData.delivery.delivery_id);
      }

      const conflict = await postAdmin(fixture.app, redeliveryPath, auth, {
        ...request,
        reason: "same key with changed input",
      });
      assert.equal(conflict.status, 409);
      assert.equal(await responseErrorCode(conflict), "webhook_operation_conflict");
    });
  });
});

interface SessionAuth {
  cookie: string;
  csrfToken: string;
}

interface FixtureOrder {
  readonly order: OrderProjection;
  readonly notifyUrl: string;
  readonly event: WebhookEvent;
  readonly httpProjection: {
    readonly notification: { readonly notify_url: string | null };
  };
}

interface FixtureDelivery {
  readonly deliveryId: string;
  readonly leaseToken: string;
}

interface NotificationFixture {
  readonly app: ReturnType<typeof createApp>;
  readonly config: AppConfig;
  readonly database: AppDatabase;
  readonly identity: IdentityService;
  readonly ordersService: OrderService;
  readonly webhooks: IsolatedWebhookStore;
  readonly orders: readonly FixtureOrder[];
  readonly deliveries: readonly FixtureDelivery[];
  readonly isolatedEvent: WebhookEvent;
}

class IsolatedWebhookStore extends WebhookStore {
  readonly isolatedEvent: WebhookEvent;

  constructor(database: AppDatabase, isolatedEvent: WebhookEvent) {
    super(database);
    this.isolatedEvent = isolatedEvent;
  }

  override eventForApiClient(apiClientId: string, eventId: string): WebhookEvent | null {
    if (eventId === this.isolatedEvent.eventId) {
      return apiClientId === ISOLATED_CLIENT_ID ? this.isolatedEvent : null;
    }
    return super.eventForApiClient(apiClientId, eventId);
  }
}

async function withNotificationFixture(
  operation: (fixture: NotificationFixture) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-notifications-http-"));
  const orderClock = Date.now() - 60_000;
  const config = webhookConfig(directory, ALLOWED_ORIGIN, true);
  const database = await AppDatabase.open(config.databasePath);
  try {
    const identity = new IdentityService(database, config);
    await identity.initialize();
    const ordersService = new OrderService(database, config, () => orderClock);
    ordersService.initialize();
    const reconciliation = new ReconciliationStore(database);
    const ledger = new LedgerStore(database);
    ledger.bindProviderIdentity(PROVIDER_IDENTITY, orderClock - 1_000);
    const isolatedEvent = isolatedWebhookEvent(orderClock);
    const webhooks = new IsolatedWebhookStore(database, isolatedEvent);
    webhooks.syncSigningKey({
      secretFingerprint: webhookSigningKeyFingerprint(WEBHOOK_SECRET),
      now: Date.now(),
    });
    const app = createApp({
      config,
      database,
      identity,
      orders: ordersService,
      webhookStore: webhooks,
      startedAt: new Date(0),
      clock: () => orderClock,
      ledgerHealth: () => ({
        enabled: true,
        state: "healthy" as const,
        inFlight: false,
        lastAttemptAt: orderClock,
        lastSuccessAt: orderClock,
        lastErrorCode: null,
        consecutiveFailures: 0,
      }),
      reconciliationHealth: () => ({
        enabled: true,
        state: "healthy" as const,
        inFlight: false,
        lastAttemptAt: orderClock,
        lastSuccessAt: orderClock,
        lastErrorCode: null,
        consecutiveFailures: 0,
        pendingOrders: 0,
        continuationPending: false,
      }),
    });

    const orders: FixtureOrder[] = [];
    for (let index = 0; index < 2; index += 1) {
      const suffix = String(index + 1);
      const notifyUrl = `${ALLOWED_ORIGIN}/receive/${suffix}?tenant=personal%26developer`;
      const httpProjection = await createHttpOrder(app, suffix, notifyUrl, 1_000 + index * 1_000);
      const order = ordersService.get(API_CLIENT_ID, httpProjection.order_id);
      const entry = recordLedgerEntry(
        ledger,
        `notifications-http-credit-${suffix}`,
        order.payableAmountCents,
        orderClock + 5_000 + index * 1_000,
        orderClock + 10_000 + index * 1_000,
      );
      reconciliation.settleManually({
        financialOperationId: randomUUID(),
        orderId: order.orderId,
        ledgerEntryId: entry.ledgerEntryId,
        actorId: "admin",
        reason: `settle notification fixture ${suffix}`,
        now: orderClock + 20_000 + index * 1_000,
      });
      const event = readOrderEvent(database, order.orderId);
      orders.push({ order, notifyUrl, event, httpProjection });
    }

    assert.equal(webhooks.materialize(10, Date.now()), 2);
    const deliveries: FixtureDelivery[] = [];
    while (true) {
      const claimed = webhooks.claimNext({
        now: Date.now(),
        leaseMilliseconds: 30_000,
        maximumAttempts: 3,
      });
      if (!claimed) break;
      const response = Buffer.from("{}", "utf8");
      webhooks.completeAttempt({
        deliveryId: claimed.delivery.deliveryId,
        attemptId: claimed.attempt.attemptId,
        leaseToken: claimed.attempt.leaseToken,
        outcome: "ACKNOWLEDGED",
        now: Date.now(),
        maximumAttempts: 3,
        retryBaseMilliseconds: 1_000,
        retryMaximumMilliseconds: 60_000,
        resolvedAddressesFingerprint: "d".repeat(64),
        connectedAddress: "8.8.8.8",
        httpStatus: 200,
        responseBytes: response.byteLength,
        responseFingerprint: createHash("sha256").update(response).digest("hex"),
        ackCode: "acknowledged",
        errorCode: null,
      });
      deliveries.push({
        deliveryId: claimed.delivery.deliveryId,
        leaseToken: claimed.attempt.leaseToken,
      });
    }
    assert.equal(deliveries.length, 2);

    await operation({
      app,
      config,
      database,
      identity,
      ordersService,
      webhooks,
      orders,
      deliveries,
      isolatedEvent,
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createFixtureApp(
  fixture: NotificationFixture,
  config: AppConfig,
): ReturnType<typeof createApp> {
  return createApp({
    config,
    database: fixture.database,
    identity: fixture.identity,
    orders: fixture.ordersService,
    webhookStore: fixture.webhooks,
    startedAt: new Date(0),
    clock: () => Date.now(),
    ledgerHealth: () => ({
      enabled: true,
      state: "healthy" as const,
      inFlight: false,
      lastAttemptAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastErrorCode: null,
      consecutiveFailures: 0,
    }),
    reconciliationHealth: () => ({
      enabled: true,
      state: "healthy" as const,
      inFlight: false,
      lastAttemptAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingOrders: 0,
      continuationPending: false,
    }),
  });
}

async function createHttpOrder(
  app: ReturnType<typeof createApp>,
  suffix: string,
  notifyUrl: string,
  amountCents: number,
): Promise<{
  readonly order_id: string;
  readonly notification: { readonly notify_url: string | null };
}> {
  const target = "/api/v1/orders";
  const body = Buffer.from(JSON.stringify({
    idempotency_key: `notifications-http-idempotency-${suffix}`,
    merchant_order_no: `notifications-http-order-${suffix}`,
    amount_cents: amountCents,
    notify_url: notifyUrl,
  }), "utf8");
  const response = await app.request(target, {
    method: "POST",
    headers: {
      ...apiHeaders("POST", target, body),
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(response.status, 201);
  return await responseData(response);
}

function readOrderEvent(database: AppDatabase, orderId: string): WebhookEvent {
  const eventId = database.read((connection) => {
    const row = connection.prepare(
      `SELECT outbox_event_id FROM outbox_events
        WHERE aggregate_id = ? ORDER BY created_at DESC, outbox_event_id DESC LIMIT 1`,
    ).get(orderId) as { outbox_event_id: string } | undefined;
    return row?.outbox_event_id;
  });
  assert.ok(eventId);
  const store = new WebhookStore(database);
  const event = store.eventForApiClient(API_CLIENT_ID, eventId);
  assert.ok(event);
  return event;
}

function isolatedWebhookEvent(createdAt: number): WebhookEvent {
  const eventId = randomUUID();
  const orderId = randomUUID();
  const payloadJson = JSON.stringify({
    schema: "perpay:outbox-event:v2",
    event_id: eventId,
    event_type: "PAYMENT_CONFIRMED",
    order_id: orderId,
    order_version: 1,
  });
  return {
    eventId,
    eventType: "PAYMENT_CONFIRMED",
    orderId,
    orderVersion: 1,
    payloadJson,
    payloadFingerprint: createHash("sha256").update(payloadJson, "utf8").digest("hex"),
    createdAt,
  };
}

function webhookConfig(directory: string, allowedOrigin: string, enabled: boolean): AppConfig {
  return loadConfig({
    PERPAY_INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
    PERPAY_API_SECRET: API_SECRET,
    PERPAY_COLLECTION_CODE_PAYLOAD: COLLECTION_CODE,
    PERPAY_DATA_DIR: directory,
    PERPAY_PUBLIC_URL: PUBLIC_ORIGIN,
    PERPAY_WEBHOOK_ENABLED: enabled ? "true" : "false",
    ...(enabled
      ? {
          PERPAY_WEBHOOK_ALLOWED_ORIGIN: allowedOrigin,
          PERPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
        }
      : {}),
  });
}

function disabledWebhookConfig(config: AppConfig): AppConfig {
  return webhookConfig(config.dataDir, ALLOWED_ORIGIN, false);
}

function rotatedWebhookConfig(config: AppConfig): AppConfig {
  return webhookConfig(config.dataDir, ROTATED_ORIGIN, true);
}

async function login(app: ReturnType<typeof createApp>): Promise<SessionAuth> {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: PUBLIC_ORIGIN,
    },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith("perpay_session="));
  const csrfCookie = cookies.find((value) => value.startsWith("perpay_csrf="));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  const body = await responseData<{ csrf_token: string }>(response);
  return {
    cookie: [sessionCookie, csrfCookie].map((value) => value.split(";", 1)[0]).join("; "),
    csrfToken: body.csrf_token,
  };
}

async function stepUp(app: ReturnType<typeof createApp>, auth: SessionAuth): Promise<void> {
  const response = await app.request("/api/admin/v1/session/step-up", {
    method: "POST",
    headers: adminHeaders(auth),
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith("perpay_session="));
  const csrfCookie = cookies.find((value) => value.startsWith("perpay_csrf="));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  const body = await responseData<{ csrf_token: string }>(response);
  auth.cookie = [sessionCookie, csrfCookie]
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  auth.csrfToken = body.csrf_token;
}

async function postAdmin(
  app: ReturnType<typeof createApp>,
  path: string,
  auth: SessionAuth,
  body: Readonly<Record<string, unknown>>,
  options: { readonly origin?: boolean; readonly csrf?: boolean } = {},
): Promise<Response> {
  const headers = adminHeaders(auth);
  if (options.origin === false) delete headers.origin;
  if (options.csrf === false) delete headers["x-csrf-token"];
  return await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function adminHeaders(auth: SessionAuth): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: PUBLIC_ORIGIN,
    "x-csrf-token": auth.csrfToken,
  };
}

function apiHeaders(
  method: string,
  target: string,
  body: Uint8Array,
): Record<string, string> {
  const signed = signApiRequest({
    secret: Buffer.from(API_SECRET, "base64url"),
    method,
    target,
    body,
    clientId: API_CLIENT_ID,
    timestamp: String(Math.floor(Date.now() / 1_000)),
    nonce: randomBytes(32).toString("base64url"),
  });
  return {
    "x-perpay-signature-version": signed.version,
    "x-perpay-client-id": signed.clientId,
    "x-perpay-timestamp": signed.timestamp,
    "x-perpay-nonce": signed.nonce,
    "x-perpay-signature": signed.signature,
  };
}

async function responseData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

async function responseErrorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function recordLedgerEntry(
  store: LedgerStore,
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
): LedgerEntry {
  const run = store.startIngestRun({
    start: formatProviderTimestamp(occurredAt - 60_000),
    end: formatProviderTimestamp(occurredAt + 60 * 60 * 1_000),
    pageSize: 1,
    now: startedAt,
  });
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const amount = (amountCents / 100).toFixed(2);
  const detail: AccountLogDetail = {
    raw: {
      account_log_id: externalEventId,
      amount,
      direction: "CREDIT",
      occurred_at: occurredAtText,
    },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction: "CREDIT",
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const recorded = store.recordPage({
    ingestRunId: run.ingestRunId,
    page: {
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      hasMore: false,
      details: [detail],
    },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-${externalEventId}` },
      body: JSON.stringify({ external_event_id: externalEventId, amount }),
      traceId: `trace-${externalEventId}`,
      signatureVerified: true,
    },
    now: startedAt + 1_000,
  });
  const normalized = recorded.normalized[0];
  if (!normalized || normalized.kind !== "created") {
    throw new Error(`expected a created ledger entry, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.entry;
}

function formatProviderTimestamp(milliseconds: number): string {
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}
