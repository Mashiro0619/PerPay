import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { createOrderRequestSchema, type OrderProjection } from "../src/orders/model.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { webhookSigningKeyFingerprint } from "../src/notifications/model.ts";
import {
  ReconciliationStore,
  type ReconcileEntryResult,
} from "../src/reconciliation/index.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const ADMIN_PASSWORD = HTTP_TEST_ADMIN_PASSWORD;
export const PUBLIC_ORIGIN = "http://localhost:6190";
export const API_SECRET = Buffer.alloc(32, 13).toString("base64url");
const COLLECTION_CODE = "https://qr.alipay.com/fkx-http-contract-2026";

export interface SessionAuth {
  cookie: string;
  csrfToken: string;
}

export interface SettlementFixture {
  readonly order: OrderProjection;
  readonly entry: LedgerEntry;
  readonly result: Extract<ReconcileEntryResult, { readonly kind: "auto_settled" }>;
}

export interface ReconciliationHttpFixture {
  readonly app: ReturnType<typeof createApp>;
  readonly database: AppDatabase;
  readonly reconciliation: ReconciliationStore;
  readonly services: Awaited<ReturnType<typeof createConfiguredHttpServices>>;
  readonly ledger: LedgerStore;
  readonly webhooks: WebhookStore;
  readonly directory: string;
  readonly baseTime: number;
  readonly createOrder: (suffix: string, requestedAmountCents: number, notifyUrl?: string) => OrderProjection;
  readonly closeOrder: (orderId: string) => OrderProjection;
  readonly createSettlement: (suffix: string, requestedAmountCents: number, notifyUrl?: string) => SettlementFixture;
  readonly recordCredit: (externalEventId: string, amountCents: number, occurrenceOffset: number) => LedgerEntry;
  readonly recordDebit: (externalEventId: string, amountCents: number, occurrenceOffset: number) => LedgerEntry;
}

export async function withHttpFixture(
  operation: (fixture: ReconciliationHttpFixture) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-reconciliation-http-"));
  const baseTime = Date.now();
  const services = await createConfiguredHttpServices({
    directory,
    apiSecret: API_SECRET,
    collectionCodePayload: COLLECTION_CODE,
    publicUrl: PUBLIC_ORIGIN,
    identityClock: () => baseTime,
  });
  const { config, database, identity, settings, orders } = services;
  try {
    const ledger = new LedgerStore(database);
    const webhooks = new WebhookStore(database);
    const providerAccountKey = settings.snapshot().activeProviderAccountKey;
    if (!providerAccountKey) throw new Error("provider account is not configured");
    const reconciliation = new ReconciliationStore(database);
    const window = {
      start: formatProviderTimestamp(baseTime - 60_000),
      end: formatProviderTimestamp(baseTime + 60 * 60 * 1_000),
    } as const;
    let orderSequence = 0;
    let ingestSequence = 0;
    const createOrder = (suffix: string, requestedAmountCents: number, notifyUrl?: string): OrderProjection => {
      orderSequence += 1;
      return orders.create(createOrderRequestSchema.parse({
        idempotency_key: `http-idem-${suffix}-${orderSequence}`,
        merchant_order_no: `http-merchant-${suffix}-${orderSequence}`,
        amount_cents: requestedAmountCents,
        product_name: `http-merchant-${suffix}-${orderSequence}`,
        ...(notifyUrl ? { notify_url: notifyUrl } : {}),
      })).order;
    };
    const record = (
      externalEventId: string,
      amountCents: number,
      occurrenceOffset: number,
      direction: "CREDIT" | "DEBIT",
    ): LedgerEntry => {
      const startedAt = baseTime - 60_000 + ingestSequence;
      const occurredAt = baseTime + 60_000 + occurrenceOffset * 1_000;
      ingestSequence += 1;
      return recordLedgerEntry(
        ledger,
        window,
        externalEventId,
        amountCents,
        occurredAt,
        startedAt,
        direction,
        providerAccountKey,
      );
    };
    const fixture: ReconciliationHttpFixture = {
      app: createApp({
        config,
        database,
        identity,
        settings,
        orders,
        reconciliation, ledger, webhookStore: webhooks,
        startedAt: new Date(0),
        clock: () => baseTime,
        ledgerHealth: () => ({
          enabled: true,
          state: "healthy" as const,
          inFlight: false,
          lastAttemptAt: baseTime,
          lastSuccessAt: baseTime,
          lastErrorCode: null,
          consecutiveFailures: 0,
        }),
        reconciliationHealth: () => ({
          enabled: true,
          state: "healthy" as const,
          inFlight: false,
          lastAttemptAt: baseTime,
          lastSuccessAt: baseTime,
          lastErrorCode: null,
          consecutiveFailures: 0,
          pendingOrders: 0,
          continuationPending: false,
        }),
      }),
      database,
      reconciliation,
      services, ledger, webhooks, directory, baseTime,
      createOrder,
      closeOrder(orderId) {
        return orders.close(orderId);
      },
      createSettlement(suffix, requestedAmountCents, notifyUrl) {
        const order = createOrder(suffix, requestedAmountCents, notifyUrl);
        const entry = record(
          `http-entry-${suffix}`,
          order.payableAmountCents,
          ingestSequence + 1,
          "CREDIT",
        );
        const result = reconciliation.reconcileEntry(entry.ledgerEntryId);
        if (result.kind !== "auto_settled") {
          throw new Error(`expected auto settlement, received ${result.kind}`);
        }
        return { order, entry, result };
      },
      recordCredit(externalEventId, amountCents, occurrenceOffset) {
        return record(externalEventId, amountCents, occurrenceOffset, "CREDIT");
      },
      recordDebit(externalEventId, amountCents, occurrenceOffset) {
        return record(externalEventId, amountCents, occurrenceOffset, "DEBIT");
      },
    };
    await operation(fixture);
  } finally {
    database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-reconciliation-http-"));
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function login(app: ReturnType<typeof createApp>): Promise<SessionAuth> {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
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

export async function postFinancial(
  app: ReturnType<typeof createApp>,
  path: string,
  auth: SessionAuth,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: financialHeaders(auth),
    body: JSON.stringify(body),
  });
}

export function financialHeaders(auth: SessionAuth): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: PUBLIC_ORIGIN,
    "x-csrf-token": auth.csrfToken,
  };
}

export async function responseData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

export async function responseErrorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function recordLedgerEntry(
  store: LedgerStore,
  window: { readonly start: string; readonly end: string },
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
  direction: "CREDIT" | "DEBIT",
  providerAccountKey: string,
): LedgerEntry {
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const amount = (amountCents / 100).toFixed(2);
  const detail: AccountLogDetail = {
    raw: {
      account_log_id: externalEventId,
      amount,
      direction,
      occurred_at: occurredAtText,
    },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction,
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const record = (runStartedAt: number, observedAt: number) => {
    const run = store.startIngestRun({
      ...window,
      providerAccountKey,
      pageSize: 1,
      now: runStartedAt,
    });
    return store.recordPage({
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
        body: JSON.stringify({ external_event_id: externalEventId, amount, direction }),
        traceId: `trace-${externalEventId}`,
        signatureVerified: true,
      },
      now: observedAt,
    });
  };
  let recorded = record(startedAt, startedAt + 1);
  if (recorded.kind === "variant") {
    recorded = record(startedAt + 2, startedAt + 3);
    assert.equal(recorded.kind, "confirmed_variant");
  }
  const normalized = recorded.normalized[0];
  if (!normalized || normalized.kind !== "created") {
    throw new Error(`expected a created ledger entry, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.entry;
}

export function readCount(connection: import("node:sqlite").DatabaseSync, table: string): number {
  const row = connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: bigint | number;
  };
  return Number(row.count);
}

export function readCountWhere(
  connection: import("node:sqlite").DatabaseSync,
  table: string,
  predicate: string,
): number {
  const row = connection.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
  ).get() as { count: bigint | number };
  return Number(row.count);
}

export function readText(
  connection: import("node:sqlite").DatabaseSync,
  sql: string,
  parameter: string,
): string {
  const row = connection.prepare(sql).get(parameter) as Record<string, string>;
  const value = Object.values(row)[0];
  if (value === undefined) throw new Error("expected a text value");
  return value;
}

function formatProviderTimestamp(milliseconds: number): string {
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

/** All destinations are synthetic; store tests never open a network connection. */
export function enableNotifications(fixture: ReconciliationHttpFixture) {
  const allowedOrigin = "https://business.example.com";
  const secret = Buffer.alloc(32, 73).toString("base64url");
  const store = fixture.services.settingsStore;
  store.saveWebhook({ revision: store.snapshot().revision, enabled: true, allowed_origin: allowedOrigin,
    timeout_milliseconds: 5000, maximum_attempts: 2, retry_base_seconds: 1, retry_maximum_seconds: 60, secret,
  }, { actorId: "admin", requestId: "enable-isolated-notifications", remoteAddressHash: "a".repeat(64) });
  fixture.webhooks.syncSigningKey({ secretFingerprint: webhookSigningKeyFingerprint(secret), now: Date.now() });
  return { allowedOrigin, notifyUrl: allowedOrigin + "/notify" };
}
