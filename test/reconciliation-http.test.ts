import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { createOrderRequestSchema, type OrderProjection } from "../src/orders/model.ts";
import {
  ReconciliationStore,
  type ReconcileEntryResult,
} from "../src/reconciliation/index.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

const ADMIN_PASSWORD = HTTP_TEST_ADMIN_PASSWORD;
const PUBLIC_ORIGIN = "http://localhost:6190";
const API_SECRET = Buffer.alloc(32, 13).toString("base64url");
const COLLECTION_CODE = "https://qr.alipay.com/fkx-http-contract-2026";
describe("reconciliation HTTP contract", () => {
  it("automatically confirms a unique payment and exposes only settlement history", async () => {
    await withHttpFixture(async (fixture) => {
      const settlement = fixture.createSettlement("auto-http", 999);
      const checkout = await fixture.app.request(
        `/api/public/v1/checkouts/${settlement.order.checkoutToken}`,
      );
      assert.equal(checkout.status, 200);
      const checkoutData = await responseData<Record<string, any>>(checkout);
      assert.equal(checkoutData.payment.status, "CONFIRMED");
      assert.equal(checkoutData.payment.basis, "INFERRED");
      assert.equal(checkoutData.payment_instructions, null);

      const anonymous = await fixture.app.request("/api/admin/v1/reconciliation/matches");
      assert.equal(anonymous.status, 401);
      assert.equal(await responseErrorCode(anonymous), "session_invalid");
      const auth = await login(fixture.app);

      const detailResponse = await fixture.app.request(
        `/api/admin/v1/reconciliation/matches/${settlement.result.paymentMatchId}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(detailResponse.status, 200);
      const detail = await responseData<Record<string, any>>(detailResponse);
      assert.equal(detail.status, "SETTLED");
      assert.equal(detail.payment_match_id, settlement.result.paymentMatchId);
      assert.equal(detail.candidate.status, "SELECTED");
      assert.equal(detail.order.payment_status, "CONFIRMED");

      const history = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=SETTLED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(history.status, 200);
      const historyData = await responseData<Array<Record<string, any>>>(history);
      assert.equal(historyData.length, 1);
      assert.equal(historyData[0]?.payment_match_id, settlement.result.paymentMatchId);

      for (const action of ["confirm", "reject"]) {
        const removed = await fixture.app.request(
          `/api/admin/v1/reconciliation/matches/${settlement.result.paymentMatchId}/actions/${action}`,
          { method: "POST", headers: { cookie: auth.cookie } },
        );
        assert.equal(removed.status, 404);
        assert.equal(await responseErrorCode(removed), "route_not_found");
      }

      const debit = fixture.recordDebit("http-unmatched-debit", 100, 1);
      const unmatched = fixture.reconciliation.reconcileEntry(debit.ledgerEntryId);
      assert.equal(unmatched.kind, "unmatched");
      if (unmatched.kind !== "unmatched") return;
      const exceptions = await fixture.app.request(
        "/api/admin/v1/reconciliation/exceptions?limit=10",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(exceptions.status, 200);
      const exceptionData = await responseData<Array<Record<string, any>>>(exceptions);
      const exception = exceptionData.find((item) => item.exception_id === unmatched.exceptionId);
      assert.ok(exception);
      assert.equal(exception.exception_type, "UNMATCHED_DEBIT");
      assert.equal(exception.status, "OPEN");
    });
  });

  it("paginates settlement history with a status-bound cursor", async () => {
    await withHttpFixture(async (fixture) => {
      const settlements = [1_001, 2_001, 3_001].map((amount, index) =>
        fixture.createSettlement(`history-${index}`, amount),
      );
      const auth = await login(fixture.app);
      let cursor: string | null = null;
      const discovered: string[] = [];
      do {
        const query = new URLSearchParams({ status: "SETTLED", limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await fixture.app.request(
          `/api/admin/v1/reconciliation/matches?${query.toString()}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          data: Array<Record<string, any>>;
          page: { next_cursor: string | null };
        };
        assert.equal(page.data.length, 1);
        discovered.push(String(page.data[0]?.payment_match_id));
        cursor = page.page.next_cursor;
      } while (cursor !== null);
      assert.deepEqual(
        new Set(discovered),
        new Set(settlements.map((item) => item.result.paymentMatchId)),
      );

      const invalid = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=PROPOSED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(invalid.status, 422);
      assert.equal(await responseErrorCode(invalid), "validation_failed");
      const malformed = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=SETTLED&cursor=not-a-canonical-cursor",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(malformed.status, 422);
      assert.equal(await responseErrorCode(malformed), "validation_failed");
    });
  });

  it("lists and inspects administrator orders without exposing checkout credentials", async () => {
    await withHttpFixture(async (fixture) => {
      const open = fixture.createOrder("admin-open", 1_499);
      const closed = fixture.createOrder("admin-closed", 2_499);
      fixture.closeOrder(closed.orderId);
      const confirmed = fixture.createSettlement("admin-confirmed", 3_499).order;

      const anonymous = await fixture.app.request("/api/admin/v1/orders");
      assert.equal(anonymous.status, 401);
      assert.equal(await responseErrorCode(anonymous), "session_invalid");
      const auth = await login(fixture.app);

      const unpaidIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ payment_status: "UNPAID", limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await fixture.app.request(
          `/api/admin/v1/orders?${query.toString()}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          data: Array<Record<string, any>>;
          page: { next_cursor: string | null };
        };
        assert.equal(page.data.length, 1);
        assert.equal(page.data[0]?.payment.status, "UNPAID");
        unpaidIds.push(String(page.data[0]?.order_id));
        cursor = page.page.next_cursor;
      } while (cursor !== null);
      assert.deepEqual(new Set(unpaidIds), new Set([open.orderId, closed.orderId]));

      const firstPage = await fixture.app.request(
        "/api/admin/v1/orders?payment_status=UNPAID&limit=1",
        { headers: { cookie: auth.cookie } },
      );
      const firstPageBody = (await firstPage.json()) as {
        page: { next_cursor: string | null };
      };
      assert.ok(firstPageBody.page.next_cursor);
      for (const reboundQuery of [
        `payment_status=CONFIRMED&limit=1&cursor=${firstPageBody.page.next_cursor}`,
        `payment_status=UNPAID&checkout_status=OPEN&limit=1&cursor=${firstPageBody.page.next_cursor}`,
      ]) {
        const rebound = await fixture.app.request(
          `/api/admin/v1/orders?${reboundQuery}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(rebound.status, 422);
        assert.equal(await responseErrorCode(rebound), "validation_failed");
      }

      const closedPage = await fixture.app.request(
        "/api/admin/v1/orders?checkout_status=CLOSED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(closedPage.status, 200);
      const closedData = await responseData<Array<Record<string, any>>>(closedPage);
      assert.deepEqual(closedData.map((order) => order.order_id), [closed.orderId]);

      const byMerchant = await fixture.app.request(
        `/api/admin/v1/orders/by-merchant-no/${confirmed.merchantOrderNo}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(byMerchant.status, 200);
      const byMerchantText = await byMerchant.text();
      assert.equal(byMerchantText.includes(confirmed.checkoutToken), false);
      assert.equal(byMerchantText.includes(API_SECRET), false);
      assert.equal(byMerchantText.includes("idempotency_key_digest"), false);
      const byMerchantData = (JSON.parse(byMerchantText) as { data: Record<string, any> }).data;
      assert.equal(byMerchantData.order_id, confirmed.orderId);
      assert.equal(byMerchantData.api_client_id, "default");
      assert.equal(byMerchantData.payment.status, "CONFIRMED");
      assert.deepEqual(
        byMerchantData.events.map((event: Record<string, unknown>) => event.event_type),
        ["CREATED", "PAYMENT_CONFIRMED"],
      );
      assert.equal(byMerchantData.checkout.token, undefined);

      const byId = await fixture.app.request(`/api/admin/v1/orders/${closed.orderId}`, {
        headers: { cookie: auth.cookie },
      });
      assert.equal(byId.status, 200);
      const byIdData = await responseData<Record<string, any>>(byId);
      assert.equal(byIdData.checkout.status, "CLOSED");
      assert.deepEqual(
        byIdData.events.map((event: Record<string, unknown>) => event.event_type),
        ["CREATED", "CHECKOUT_CLOSED"],
      );

      for (const invalidQuery of [
        "checkout_status=UNKNOWN",
        "payment_status=UNKNOWN",
        "limit=0",
        "limit=201",
        "payment_status=UNPAID&payment_status=UNPAID",
        "cursor=not-a-canonical-cursor",
        "unknown=value",
      ]) {
        const invalid = await fixture.app.request(`/api/admin/v1/orders?${invalidQuery}`, {
          headers: { cookie: auth.cookie },
        });
        assert.equal(invalid.status, 422, invalidQuery);
        assert.equal(await responseErrorCode(invalid), "validation_failed");
      }

      const missing = await fixture.app.request(
        "/api/admin/v1/orders/00000000-0000-4000-8000-000000000000",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(missing.status, 404);
      assert.equal(await responseErrorCode(missing), "order_not_found");
      const invalidMerchant = await fixture.app.request(
        "/api/admin/v1/orders/by-merchant-no/invalid%20merchant",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(invalidMerchant.status, 404);
      assert.equal(await responseErrorCode(invalidMerchant), "order_not_found");
    });
  });

  it("keeps manual claim, reversal, and refund as stepped-up exception actions", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      await stepUp(fixture.app, auth);

      const manualOrder = fixture.createOrder("manual", 2_999);
      const manualEntry = fixture.recordCredit("http-manual-entry", 2_900, 1);
      const manual = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/settlements/manual",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: manualOrder.orderId,
          ledger_entry_id: manualEntry.ledgerEntryId,
          reason: "link an exception after reviewing evidence",
        },
      );
      assert.equal(manual.status, 200);
      const manualData = await responseData<Record<string, any>>(manual);
      assert.equal(manualData.operation.operation_type, "MANUAL_SETTLEMENT");
      assert.equal(manualData.payment_match.status, "SETTLED");

      const auto = fixture.createSettlement("reverse", 3_999);
      const reversed = await postFinancial(
        fixture.app,
        `/api/admin/v1/reconciliation/matches/${auto.result.paymentMatchId}/actions/reverse`,
        auth,
        {
          financial_operation_id: randomUUID(),
          reason: "reverse an incorrect settlement",
        },
      );
      assert.equal(reversed.status, 200);
      const reversedData = await responseData<Record<string, any>>(reversed);
      assert.equal(reversedData.operation.operation_type, "REVERSE_SETTLEMENT");
      assert.equal(reversedData.payment_match.status, "REVERSED");

      const debit = fixture.recordDebit("http-refund-entry", 500, 2);
      const refund = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/refunds",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: manualOrder.orderId,
          ledger_entry_id: debit.ledgerEntryId,
          reason: "record a provider debit as a refund",
        },
      );
      assert.equal(refund.status, 200);
      const refundData = await responseData<Record<string, any>>(refund);
      assert.equal(refundData.operation.operation_type, "RECORD_REFUND");
      assert.equal(refundData.refund_status, "PARTIAL");
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("rejects an over-refund without partial financial side effects", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      await stepUp(fixture.app, auth);
      const settlement = fixture.createSettlement("refund-cap", 4_999);
      const firstDebit = fixture.recordDebit("http-refund-cap-first", 3_000, 1);
      const first = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/refunds",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: settlement.order.orderId,
          ledger_entry_id: firstDebit.ledgerEntryId,
          reason: "first bounded refund",
        },
      );
      assert.equal(first.status, 200);
      const before = fixture.database.read((connection) => ({
        operations: readCountWhere(connection, "financial_operations", "operation_type = 'RECORD_REFUND'"),
        refunds: readCount(connection, "refund_records"),
        transactions: readCount(connection, "ledger_transactions"),
        postings: readCount(connection, "ledger_postings"),
      }));
      const secondDebit = fixture.recordDebit("http-refund-cap-second", 3_000, 2);
      const second = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/refunds",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: settlement.order.orderId,
          ledger_entry_id: secondDebit.ledgerEntryId,
          reason: "this refund exceeds the confirmed receipt",
        },
      );
      assert.equal(second.status, 409);
      assert.equal(await responseErrorCode(second), "match_state_conflict");
      fixture.database.read((connection) => {
        assert.deepEqual({
          operations: readCountWhere(connection, "financial_operations", "operation_type = 'RECORD_REFUND'"),
          refunds: readCount(connection, "refund_records"),
          transactions: readCount(connection, "ledger_transactions"),
          postings: readCount(connection, "ledger_postings"),
        }, before);
        assert.equal(readText(
          connection,
          "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          secondDebit.ledgerEntryId,
        ), "UNALLOCATED");
      });
    });
  });
});

interface SessionAuth {
  cookie: string;
  csrfToken: string;
}

interface SettlementFixture {
  readonly order: OrderProjection;
  readonly entry: LedgerEntry;
  readonly result: Extract<ReconcileEntryResult, { readonly kind: "auto_settled" }>;
}

interface ReconciliationHttpFixture {
  readonly app: ReturnType<typeof createApp>;
  readonly database: AppDatabase;
  readonly reconciliation: ReconciliationStore;
  readonly createOrder: (suffix: string, requestedAmountCents: number) => OrderProjection;
  readonly closeOrder: (orderId: string) => OrderProjection;
  readonly createSettlement: (suffix: string, requestedAmountCents: number) => SettlementFixture;
  readonly recordCredit: (externalEventId: string, amountCents: number, occurrenceOffset: number) => LedgerEntry;
  readonly recordDebit: (externalEventId: string, amountCents: number, occurrenceOffset: number) => LedgerEntry;
}

async function withHttpFixture(
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
    const providerAccountKey = settings.snapshot().activeProviderAccountKey;
    if (!providerAccountKey) throw new Error("provider account is not configured");
    const reconciliation = new ReconciliationStore(database);
    const window = {
      start: formatProviderTimestamp(baseTime - 60_000),
      end: formatProviderTimestamp(baseTime + 60 * 60 * 1_000),
    } as const;
    let orderSequence = 0;
    let ingestSequence = 0;
    const createOrder = (suffix: string, requestedAmountCents: number): OrderProjection => {
      orderSequence += 1;
      return orders.create(createOrderRequestSchema.parse({
        idempotency_key: `http-idem-${suffix}-${orderSequence}`,
        merchant_order_no: `http-merchant-${suffix}-${orderSequence}`,
        amount_cents: requestedAmountCents,
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
        reconciliation,
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
      createOrder,
      closeOrder(orderId) {
        return orders.close(orderId);
      },
      createSettlement(suffix, requestedAmountCents) {
        const order = createOrder(suffix, requestedAmountCents);
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
    rmSync(directory, { recursive: true, force: true });
  }
}

async function login(app: ReturnType<typeof createApp>): Promise<SessionAuth> {
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

async function stepUp(app: ReturnType<typeof createApp>, auth: SessionAuth): Promise<void> {
  const response = await app.request("/api/admin/v1/session/step-up", {
    method: "POST",
    headers: financialHeaders(auth),
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith("perpay_session="));
  const csrfCookie = cookies.find((value) => value.startsWith("perpay_csrf="));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  const body = await responseData<{ csrf_token: string }>(response);
  auth.cookie = [sessionCookie, csrfCookie].map((value) => value.split(";", 1)[0]).join("; ");
  auth.csrfToken = body.csrf_token;
}

async function postFinancial(
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

function financialHeaders(auth: SessionAuth): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: PUBLIC_ORIGIN,
    "x-csrf-token": auth.csrfToken,
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

function readCount(connection: import("node:sqlite").DatabaseSync, table: string): number {
  const row = connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: bigint | number;
  };
  return Number(row.count);
}

function readCountWhere(
  connection: import("node:sqlite").DatabaseSync,
  table: string,
  predicate: string,
): number {
  const row = connection.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
  ).get() as { count: bigint | number };
  return Number(row.count);
}

function readText(
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
