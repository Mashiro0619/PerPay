import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import { LedgerStore, type RawPageEvidence } from "../src/ledger/index.ts";
import { ReconciliationStore } from "../src/reconciliation/index.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const ADMIN_PASSWORD = HTTP_TEST_ADMIN_PASSWORD;
const API_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLECTION_CODE = "https://qr.local.invalid/ledger-conflict-http";
const PUBLIC_ORIGIN = "http://localhost:6190";
const BASE_TIME = Date.now();
const WINDOW = {
  start: "2026-08-14 00:00:00",
  end: "2026-08-14 01:00:00",
} as const;
interface SessionAuth {
  cookie: string;
  csrfToken: string;
}

describe("ledger conflict HTTP operations", () => {
  it("protects conflict evidence, requires step-up, preserves idempotency, and degrades status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-conflict-http-"));
    const services = await createConfiguredHttpServices({
      directory,
      apiSecret: API_SECRET,
      collectionCodePayload: COLLECTION_CODE,
      publicUrl: PUBLIC_ORIGIN,
      identityClock: () => BASE_TIME,
    });
    const { config, database, identity, orders, settings } = services;
    try {
      const ledger = new LedgerStore(database);
      const providerAccountKey = settings.snapshot().activeProviderAccountKey;
      if (!providerAccountKey) throw new Error("provider account is not configured");
      const reconciliation = new ReconciliationStore(database);
      const conflict = createInvalidAmountConflict(ledger, providerAccountKey);
      let ledgerState: "degraded" | "healthy" = "degraded";
      const app = createApp({
        config,
        database,
        identity,
        settings,
        orders,
        ledger,
        reconciliation,
        startedAt: new Date(0),
        clock: () => BASE_TIME,
        ledgerHealth: () => ({
          enabled: true,
          state: ledgerState,
          inFlight: false,
          lastAttemptAt: BASE_TIME,
          lastSuccessAt: BASE_TIME - 1_000,
          lastErrorCode: ledgerState === "degraded" ? "provider_conflict" : null,
          consecutiveFailures: ledgerState === "degraded" ? 1 : 0,
        }),
        reconciliationHealth: () => ({
          enabled: true,
          state: "healthy" as const,
          inFlight: false,
          lastAttemptAt: BASE_TIME,
          lastSuccessAt: BASE_TIME,
          lastErrorCode: null,
          consecutiveFailures: 0,
          pendingOrders: 0,
          continuationPending: false,
        }),
      });

      const anonymous = await app.request("/api/admin/v1/ledger/conflicts");
      assert.equal(anonymous.status, 401);
      assert.equal(await errorCode(anonymous), "session_invalid");

      const auth = await login(app);
      const list = await app.request("/api/admin/v1/ledger/conflicts?status=OPEN&limit=1", {
        headers: { cookie: auth.cookie },
      });
      assert.equal(list.status, 200);
      const listed = await list.json() as {
        data: Array<{ conflict_id: string; conflict_type: string; status: string }>;
        page: { next_cursor: string | null };
      };
      assert.equal(listed.data.length, 1);
      assert.equal(listed.data[0]?.conflict_id, conflict.conflictId);
      assert.equal(listed.data[0]?.conflict_type, "INVALID_AMOUNT");
      assert.equal(listed.data[0]?.status, "OPEN");
      assert.equal(listed.page.next_cursor, null);

      const detail = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(detail.status, 200);
      const detailBody = await responseData<{
        conflict: { conflict_id: string };
        raw_page: Record<string, unknown>;
        incoming_event: Record<string, unknown>;
      }>(detail);
      assert.equal(detailBody.conflict.conflict_id, conflict.conflictId);
      assert.equal(detailBody.incoming_event.amount_text, "1.001");
      assert.equal(Object.hasOwn(detailBody.raw_page, "body"), false);
      assert.equal(Object.hasOwn(detailBody.incoming_event, "raw_payload"), false);

      const readyBefore = await app.request("/readyz");
      assert.equal(readyBefore.status, 200);
      assert.deepEqual(await readyBefore.json(), { status: "degraded", code: null });

      const adminStatus = await app.request("/api/admin/v1/system/status", {
        headers: { cookie: auth.cookie },
      });
      assert.equal(adminStatus.status, 200);
      const statusBody = await responseData<{
        status: string;
        ledger: { conflicts: { open: number; ignored: number; total: number } };
        reconciliation: { exceptions: { open: number; total: number } };
      }>(adminStatus);
      assert.equal(statusBody.status, "degraded");
      assert.deepEqual(
        {
          open: statusBody.ledger.conflicts.open,
          ignored: statusBody.ledger.conflicts.ignored,
          total: statusBody.ledger.conflicts.total,
        },
        { open: 1, ignored: 0, total: 1 },
      );
      assert.deepEqual(statusBody.reconciliation.exceptions, {
        provider_account_key: providerAccountKey,
        open: 0,
        resolved: 0,
        total: 0,
      });

      const operationId = randomUUID();
      const withoutStepUp = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}/actions/resolve`,
        {
          method: "POST",
          headers: writeHeaders(auth),
          body: JSON.stringify({
            conflict_operation_id: operationId,
            action: "ACKNOWLEDGE_ISOLATED",
            reason: "provider evidence is malformed and intentionally isolated",
          }),
        },
      );
      assert.equal(withoutStepUp.status, 403);
      assert.equal(await errorCode(withoutStepUp), "step_up_required");

      await stepUp(app, auth);
      const wrongAction = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}/actions/resolve`,
        {
          method: "POST",
          headers: writeHeaders(auth),
          body: JSON.stringify({
            conflict_operation_id: randomUUID(),
            action: "KEEP_EXISTING",
            reason: "this action does not apply to malformed evidence",
          }),
        },
      );
      assert.equal(wrongAction.status, 409);
      assert.equal(await errorCode(wrongAction), "ledger_conflict_action_not_allowed");

      const request = {
        conflict_operation_id: operationId,
        action: "ACKNOWLEDGE_ISOLATED" as const,
        reason: "provider evidence is malformed and intentionally isolated",
      };
      const resolved = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}/actions/resolve`,
        {
          method: "POST",
          headers: writeHeaders(auth),
          body: JSON.stringify(request),
        },
      );
      assert.equal(resolved.status, 201);
      assert.equal(resolved.headers.get("location"), `/api/admin/v1/ledger/conflicts/${conflict.conflictId}`);
      const resolvedBody = await responseData<{
        conflict: { status: string; resolution_action: string };
        operation: { conflict_operation_id: string; actor_id: string };
        replayed: boolean;
      }>(resolved);
      assert.equal(resolvedBody.conflict.status, "IGNORED");
      assert.equal(resolvedBody.conflict.resolution_action, "ACKNOWLEDGE_ISOLATED");
      assert.equal(resolvedBody.operation.conflict_operation_id, operationId);
      assert.equal(resolvedBody.operation.actor_id, "admin");
      assert.equal(resolvedBody.replayed, false);
      ledgerState = "healthy";

      const replay = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}/actions/resolve`,
        {
          method: "POST",
          headers: writeHeaders(auth),
          body: JSON.stringify(request),
        },
      );
      assert.equal(replay.status, 200);
      assert.equal((await responseData<{ replayed: boolean }>(replay)).replayed, true);

      const changedReplay = await app.request(
        `/api/admin/v1/ledger/conflicts/${conflict.conflictId}/actions/resolve`,
        {
          method: "POST",
          headers: writeHeaders(auth),
          body: JSON.stringify({ ...request, reason: "different reason" }),
        },
      );
      assert.equal(changedReplay.status, 409);
      assert.equal(await errorCode(changedReplay), "ledger_conflict_operation_conflict");

      const readyAfter = await app.request("/readyz");
      assert.equal(readyAfter.status, 200);
      assert.deepEqual(await readyAfter.json(), { status: "ready", code: null });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createInvalidAmountConflict(ledger: LedgerStore, providerAccountKey: string) {
  const run = ledger.startIngestRun({
    ...WINDOW,
    providerAccountKey,
    pageSize: 1,
    now: BASE_TIME,
  });
  const result = ledger.recordPage({
    ingestRunId: run.ingestRunId,
    page: {
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      hasMore: false,
      details: [detail("invalid-amount-http", "1.001")],
    },
    evidence: evidence('{"conflict":"invalid-amount"}'),
    now: BASE_TIME + 1_000,
  });
  const normalized = result.normalized[0];
  assert.equal(normalized?.kind, "isolated");
  if (!normalized || normalized.kind !== "isolated") {
    throw new Error("expected invalid amount evidence to be isolated");
  }
  return normalized.conflict;
}

function detail(accountLogId: string, amount: string): AccountLogDetail {
  return {
    raw: {
      account_log_id: accountLogId,
      amount,
      direction: "CREDIT",
      occurred_at: "2026-08-14 00:01:00",
    },
    accountLogId,
    occurredAt: "2026-08-14 00:01:00",
    amount,
    direction: "CREDIT",
    alipayOrderNo: `alipay-${accountLogId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
}

function evidence(body: string): RawPageEvidence {
  return {
    httpStatus: 200,
    headers: { "alipay-request-id": "trace-ledger-conflict-http" },
    body,
    traceId: "trace-ledger-conflict-http",
    signatureVerified: true,
  };
}

async function login(app: ReturnType<typeof createApp>): Promise<SessionAuth> {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  return authenticationFrom(response);
}

async function stepUp(app: ReturnType<typeof createApp>, auth: SessionAuth): Promise<void> {
  const response = await app.request("/api/admin/v1/session/step-up", {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const replacement = await authenticationFrom(response);
  auth.cookie = replacement.cookie;
  auth.csrfToken = replacement.csrfToken;
}

async function authenticationFrom(response: Response): Promise<SessionAuth> {
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

function writeHeaders(auth: SessionAuth): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: PUBLIC_ORIGIN,
    "x-csrf-token": auth.csrfToken,
  };
}

async function responseData<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T }).data;
}

async function errorCode(response: Response): Promise<string> {
  return (await response.json() as { error: { code: string } }).error.code;
}
