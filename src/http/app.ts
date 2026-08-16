import { randomUUID } from "node:crypto";

import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import { IdentityError, IdentityService, type AuthenticatedSession } from "../identity/service.ts";
import {
  LedgerConflictError,
  type LedgerConflict,
  type LedgerConflictCursor,
  type LedgerConflictDetail,
  type LedgerConflictOperation,
  type LedgerConflictStatus,
  type LedgerConflictSummary,
  type LedgerEntry,
  type LedgerSchedulerHealth,
  type LedgerStore,
} from "../ledger/index.ts";
import {
  ForwardedAddressError,
  resolveForwardedClientAddress,
  type TrustedProxyPolicy,
} from "../infrastructure/network/trusted-proxy.ts";
import {
  createOrderRequestSchema,
  merchantOrderNumberSchema,
  type OrderProjection,
  type PublicCheckoutProjection,
} from "../orders/model.ts";
import { OrderError, type OrderErrorCode, type OrderService } from "../orders/service.ts";
import {
  financialDecisionRequestSchema,
  linkedFinancialDecisionRequestSchema,
  ReconciliationError,
  type FinancialDecisionResult,
  type FinancialException,
  type FinancialExceptionCursor,
  type FinancialExceptionSummary,
  type MatchCandidate,
  type PaymentMatch,
  type PaymentMatchDetail,
  type PaymentMatchHistoryCursor,
  type PaymentMatchStatus,
  type ReconciliationLedgerProjection,
  type ReconciliationOrderProjection,
  type ReconciliationErrorCode,
  type ReconciliationSchedulerHealth,
  type ReconciliationStore,
  type RefundRecordResult,
} from "../reconciliation/index.ts";
import {
  webhookReplayRequestSchema,
  WebhookStoreError,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookDeliveryCursor,
  type WebhookDeliveryDetail,
  type WebhookDeliveryStatus,
  type WebhookDeliverySummary,
  type WebhookEvent,
  type WebhookSchedulerHealth,
  type WebhookStore,
} from "../notifications/index.ts";
import { verifyApiRequestSignature, type ApiRequestAuthentication } from "../security/api-signature.ts";
import { APP_VERSION } from "../version.ts";
import { PublicCheckoutRateLimiter } from "./public-checkout-rate-limit.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

const SESSION_COOKIE = "perpay_session";
const SECURE_SESSION_COOKIE = "__Host-perpay_session";
const CSRF_COOKIE = "perpay_csrf";
const SECURE_CSRF_COOKIE = "__Host-perpay_csrf";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WEBHOOK_DELIVERY_STATUSES = new Set<WebhookDeliveryStatus>([
  "PENDING",
  "LEASED",
  "RETRY_WAIT",
  "ACKNOWLEDGED",
  "DEAD_LETTER",
]);
const PAYMENT_MATCH_STATUSES = new Set<PaymentMatchStatus>([
  "SETTLED",
  "REVERSED",
]);
const LEDGER_CONFLICT_STATUSES = new Set<LedgerConflictStatus>([
  "OPEN",
  "RESOLVED",
  "IGNORED",
]);

type AppEnvironment = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    requestId: string;
    adminSession: AuthenticatedSession;
    apiRawBody: Buffer;
    apiClientId: string;
  };
};

const passwordValueSchema = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES,
  { message: `must contain at most ${MAX_PASSWORD_BYTES} UTF-8 bytes` },
);
const newPasswordValueSchema = z.string().min(12).refine(
  (value) => value.isWellFormed(),
  { message: "must contain only Unicode scalar values" },
).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES,
  { message: `must contain at most ${MAX_PASSWORD_BYTES} UTF-8 bytes` },
);

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: passwordValueSchema,
}).strict();

const passwordSchema = z.object({ password: passwordValueSchema }).strict();
const changePasswordSchema = z.object({
  current_password: passwordValueSchema,
  new_password: newPasswordValueSchema,
}).strict();
const ledgerConflictResolutionSchema = z.object({
  conflict_operation_id: z.string().regex(ORDER_ID_PATTERN),
  action: z.enum(["KEEP_EXISTING", "ACKNOWLEDGE_ISOLATED"]),
  reason: z.string().min(1).max(512).refine(
    (value) => value === value.trim() && !/\p{Cc}/u.test(value),
    { message: "must not contain surrounding whitespace or control characters" },
  ).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 2_048,
    { message: "must contain at most 2048 UTF-8 bytes" },
  ),
}).strict();

interface BackupHealth {
  readonly ok: boolean;
  readonly status: "healthy" | "unhealthy";
  readonly last_attempt_at: number | null;
  readonly last_success_at: number | null;
  readonly last_error_at: number | null;
  readonly last_error_stage: string | null;
  readonly backup_name: string | null;
  readonly snapshot_id: string | null;
  readonly instance_id: string | null;
  readonly repository_id: string | null;
  readonly interval_milliseconds: number | null;
  readonly maximum_age_milliseconds: number | null;
  readonly clock_moved_backwards: boolean;
  readonly configuration_mismatch: boolean;
}

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: AppDatabase;
  readonly identity: IdentityService;
  readonly orders: OrderService;
  readonly startedAt: Date;
  readonly clock?: (() => number) | undefined;
  readonly backupHealth?: (() => BackupHealth) | undefined;
  readonly ledger?: LedgerStore | undefined;
  readonly ledgerHealth?: (() => LedgerSchedulerHealth & { readonly enabled: boolean }) | undefined;
  readonly reconciliation?: ReconciliationStore | undefined;
  readonly reconciliationHealth?: (
    () => ReconciliationSchedulerHealth & { readonly enabled: boolean }
  ) | undefined;
  readonly webhookStore?: WebhookStore | undefined;
  readonly webhookHealth?: (() => WebhookSchedulerHealth) | undefined;
  readonly onWebhookAvailable?: (() => void | Promise<void>) | undefined;
  readonly onOrderAvailable?: ((orderId: string) => void) | undefined;
}

const disabledLedgerHealth = Object.freeze({
  enabled: false,
  state: "idle" as const,
  inFlight: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
});

const disabledReconciliationHealth = Object.freeze({
  enabled: false,
  state: "idle" as const,
  inFlight: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
  pendingOrders: 0,
  continuationPending: false,
});

const disabledWebhookHealth = Object.freeze({
  enabled: false,
  state: "idle" as const,
  inFlight: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
  pendingDeliveries: 0,
  deadLetters: 0,
});

const disabledBackupHealth = Object.freeze({
  enabled: false,
  ok: true,
  status: "disabled" as const,
  last_attempt_at: null,
  last_success_at: null,
  last_error_at: null,
  last_error_stage: null,
  backup_name: null,
  snapshot_id: null,
  instance_id: null,
  repository_id: null,
  interval_milliseconds: null,
  maximum_age_milliseconds: null,
  clock_moved_backwards: false,
  configuration_mismatch: false,
  instance_matches: null,
});

export function createApp(dependencies: AppDependencies): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (context, next) => {
    const supplied = context.req.header("x-request-id");
    const requestId = supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    context.header("cache-control", "no-store");
    context.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    context.header("cross-origin-resource-policy", "same-origin");
    context.header("cross-origin-opener-policy", "same-origin");
    context.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (dependencies.config.secureCookies) {
      context.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    await next();
  });

  app.get("/livez", (context) =>
    context.json({
      status: "alive",
      version: APP_VERSION,
      uptime_seconds: Math.floor((Date.now() - dependencies.startedAt.getTime()) / 1000),
    }),
  );

  app.get("/readyz", (context) => {
    const database = dependencies.database.health();
    const ledger = currentLedgerHealth(dependencies);
    const reconciliation = dependencies.reconciliationHealth?.() ?? disabledReconciliationHealth;
    const webhook = dependencies.webhookHealth?.() ?? disabledWebhookHealth;
    const collection = collectionFreshness(dependencies, ledger);
    const confirmation = confirmationFreshness(dependencies, reconciliation);
    const operations = operationalSummaries(dependencies, database.ok);
    const ready = database.ok && collection.ready && confirmation.ready;
    const degraded = ready && (
      isBackgroundHealthDegraded(ledger) ||
      isBackgroundHealthDegraded(reconciliation) ||
      isBackgroundHealthDegraded(webhook) ||
      operations.unavailable ||
      (operations.conflicts?.open ?? 0) > 0 ||
      (operations.exceptions?.open ?? 0) > 0
    );
    return context.json(
      {
        status: ready ? (degraded ? "degraded" : "ready") : "not_ready",
      },
      ready ? 200 : 503,
    );
  });

  app.post("/api/admin/v1/session/login", async (context) => {
    requireJsonContentType(context);
    requireSameOrigin(context, dependencies.config.publicOrigin);
    const body = await readJson(context, loginSchema, MAX_JSON_BODY_BYTES);
    const result = await dependencies.identity.login(
      body.username,
      body.password,
      identityContext(context, dependencies.config.trustedProxy),
    );
    setAuthenticationCookies(
      context,
      result.sessionToken,
      result.csrfToken,
      dependencies.config.secureCookies,
      Math.max(1, Math.ceil((result.absoluteExpiresAt - result.createdAt) / 1_000)),
    );
    return context.json({
      data: {
        username: result.username,
        csrf_token: result.csrfToken,
        idle_expires_at: new Date(result.idleExpiresAt).toISOString(),
        absolute_expires_at: new Date(result.absoluteExpiresAt).toISOString(),
      },
    });
  });

  const adminSession = requireAdminSession(dependencies.identity, dependencies.config.secureCookies);

  app.get("/api/admin/v1/session", adminSession, (context) => {
    const session = context.get("adminSession");
    return context.json({
      data: {
        username: session.session.username,
        csrf_token_required: true,
        step_up_active: dependencies.identity.isStepUp(session),
        idle_expires_at: new Date(session.session.idleExpiresAt).toISOString(),
        absolute_expires_at: new Date(session.session.absoluteExpiresAt).toISOString(),
      },
    });
  });

  app.get("/api/admin/v1/system/status", adminSession, (context) =>
    context.json({ data: systemStatus(dependencies) }),
  );

  app.post("/api/admin/v1/session/logout", adminSession, (context) => {
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    dependencies.identity.logout(
      context.get("adminSession"),
      identityContext(context, dependencies.config.trustedProxy),
    );
    clearAuthenticationCookies(context, dependencies.config.secureCookies);
    return context.body(null, 204);
  });

  app.post("/api/admin/v1/session/step-up", adminSession, async (context) => {
    requireJsonContentType(context);
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    const body = await readJson(context, passwordSchema, MAX_JSON_BODY_BYTES);
    const result = await dependencies.identity.stepUp(
      context.get("adminSession"),
      body.password,
      identityContext(context, dependencies.config.trustedProxy),
    );
    setAuthenticationCookies(
      context,
      result.sessionToken,
      result.csrfToken,
      dependencies.config.secureCookies,
      Math.max(1, Math.ceil((result.absoluteExpiresAt - result.createdAt) / 1_000)),
    );
    return context.json({
      data: {
        csrf_token: result.csrfToken,
        step_up_expires_at: new Date(result.stepUpExpiresAt).toISOString(),
        idle_expires_at: new Date(result.idleExpiresAt).toISOString(),
        absolute_expires_at: new Date(result.absoluteExpiresAt).toISOString(),
      },
    });
  });

  app.post("/api/admin/v1/sessions/revoke-all", adminSession, (context) => {
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    const revoked = dependencies.identity.revokeAllSessions(
      context.get("adminSession"),
      identityContext(context, dependencies.config.trustedProxy),
    );
    clearAuthenticationCookies(context, dependencies.config.secureCookies);
    return context.json({ data: { revoked_sessions: revoked } });
  });

  app.post("/api/admin/v1/password", adminSession, async (context) => {
    requireJsonContentType(context);
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    const body = await readJson(context, changePasswordSchema, MAX_JSON_BODY_BYTES);
    await dependencies.identity.changePassword(
      context.get("adminSession"),
      body.current_password,
      body.new_password,
      identityContext(context, dependencies.config.trustedProxy),
    );
    clearAuthenticationCookies(context, dependencies.config.secureCookies);
    return context.body(null, 204);
  });

  const financialWrite = requireFinancialWrite(
    dependencies.identity,
    dependencies.config.publicOrigin,
    dependencies.config.secureCookies,
  );

  app.get("/api/admin/v1/ledger/conflicts", adminSession, (context) => {
    const query = readLedgerConflictPageQuery(context);
    const page = requireLedgerStore(dependencies)
      .conflictPage("primary", query.status, query.cursor, query.limit);
    return context.json({
      data: page.conflicts.map(serializeLedgerConflict),
      page: {
        next_cursor: encodeLedgerConflictCursor(page.nextCursor, query.status),
      },
    });
  });

  app.get("/api/admin/v1/ledger/conflicts/:conflictId", adminSession, (context) => {
    const conflictId = requireResourceId(
      context.req.param("conflictId"),
      "ledger_conflict_not_found",
      "账务冲突不存在",
    );
    const detail = requireLedgerStore(dependencies).conflict(conflictId);
    if (!detail) {
      throw new HttpApiError(404, "ledger_conflict_not_found", "账务冲突不存在");
    }
    return context.json({ data: serializeLedgerConflictDetail(detail) });
  });

  app.post(
    "/api/admin/v1/ledger/conflicts/:conflictId/actions/resolve",
    adminSession,
    financialWrite,
    async (context) => {
      const conflictId = requireResourceId(
        context.req.param("conflictId"),
        "ledger_conflict_not_found",
        "账务冲突不存在",
      );
      const body = await readJson(context, ledgerConflictResolutionSchema, MAX_JSON_BODY_BYTES);
      const session = requireCurrentStepUp(context, dependencies.identity);
      const result = requireLedgerStore(dependencies).resolveConflict({
        conflictOperationId: body.conflict_operation_id,
        conflictId,
        action: body.action,
        actorId: session.session.username,
        reason: body.reason,
        requestId: context.get("requestId"),
        remoteAddressHash: dependencies.identity.sourceHash(
          remoteAddress(context, dependencies.config.trustedProxy),
        ),
      });
      context.header(
        "location",
        `/api/admin/v1/ledger/conflicts/${encodeURIComponent(result.conflict.conflictId)}`,
      );
      return context.json(
        {
          data: {
            conflict: serializeLedgerConflict(result.conflict),
            operation: serializeLedgerConflictOperation(result.operation),
            replayed: result.replayed,
          },
        },
        result.replayed ? 200 : 201,
      );
    },
  );

  app.get("/api/admin/v1/reconciliation/candidates/:candidateId", adminSession, (context) => {
    const candidateId = requireResourceId(
      context.req.param("candidateId"),
      "candidate_not_found",
      "匹配候选不存在",
    );
    const candidate = requireReconciliationStore(dependencies).candidate(candidateId);
    if (!candidate) throw new HttpApiError(404, "candidate_not_found", "匹配候选不存在");
    return context.json({ data: serializeCandidate(candidate) });
  });

  app.get(
    "/api/admin/v1/reconciliation/ledger-entries/:ledgerEntryId",
    adminSession,
    (context) => {
      const ledgerEntryId = requireResourceId(
        context.req.param("ledgerEntryId"),
        "ledger_entry_not_found",
        "账务流水不存在",
      );
      const ledgerEntry = requireReconciliationStore(dependencies).ledgerEntry(ledgerEntryId);
      if (!ledgerEntry) {
        throw new HttpApiError(404, "ledger_entry_not_found", "账务流水不存在");
      }
      return context.json({ data: serializeReconciliationLedger(ledgerEntry) });
    },
  );

  app.get(
    "/api/admin/v1/reconciliation/ledger-entries/:ledgerEntryId/candidates",
    adminSession,
    (context) => {
      const ledgerEntryId = requireResourceId(
        context.req.param("ledgerEntryId"),
        "ledger_entry_not_found",
        "账务流水不存在",
      );
      const reconciliation = requireReconciliationStore(dependencies);
      if (!reconciliation.ledgerEntry(ledgerEntryId)) {
        throw new HttpApiError(404, "ledger_entry_not_found", "账务流水不存在");
      }
      const candidates = reconciliation
        .listCandidates(ledgerEntryId)
        .map(serializeCandidate);
      return context.json({ data: candidates });
    },
  );

  app.get("/api/admin/v1/reconciliation/matches", adminSession, (context) => {
    const query = readPaymentMatchHistoryPageQuery(context);
    const page = requireReconciliationStore(dependencies)
      .paymentMatchHistoryPage(query.status, query.cursor, query.limit);
    return context.json({
      data: page.matches.map(serializePaymentMatchDetail),
      page: {
        next_cursor: encodePaymentMatchHistoryCursor(page.nextCursor, query.status),
      },
    });
  });

  app.get("/api/admin/v1/reconciliation/matches/:paymentMatchId", adminSession, (context) => {
    const paymentMatchId = requireResourceId(
      context.req.param("paymentMatchId"),
      "match_not_found",
      "支付关联不存在",
    );
    const match = requireReconciliationStore(dependencies).paymentMatchDetail(paymentMatchId);
    if (!match) throw new HttpApiError(404, "match_not_found", "支付关联不存在");
    return context.json({ data: serializePaymentMatchDetail(match) });
  });

  app.get("/api/admin/v1/reconciliation/exceptions", adminSession, (context) => {
    const query = readExceptionPageQuery(context);
    const page = requireReconciliationStore(dependencies)
      .openExceptionPage("primary", query.cursor, query.limit);
    return context.json({
      data: page.exceptions.map(serializeFinancialException),
      page: { next_cursor: encodeExceptionCursor(page.nextCursor) },
    });
  });

  app.get("/api/admin/v1/reconciliation/exceptions/:exceptionId", adminSession, (context) => {
    const exceptionId = requireResourceId(
      context.req.param("exceptionId"),
      "financial_exception_not_found",
      "资金异常不存在",
    );
    const exception = requireReconciliationStore(dependencies).exception(exceptionId);
    if (!exception) {
      throw new HttpApiError(404, "financial_exception_not_found", "资金异常不存在");
    }
    return context.json({ data: serializeFinancialException(exception) });
  });

  app.post(
    "/api/admin/v1/reconciliation/matches/:paymentMatchId/actions/reverse",
    adminSession,
    financialWrite,
    async (context) => {
      const paymentMatchId = requireResourceId(
        context.req.param("paymentMatchId"),
        "match_not_found",
        "支付关联不存在",
      );
      const body = await readJson(context, financialDecisionRequestSchema, MAX_JSON_BODY_BYTES);
      const session = requireCurrentStepUp(context, dependencies.identity);
      const result = requireReconciliationStore(dependencies).reverseSettlement({
        financialOperationId: body.financial_operation_id,
        paymentMatchId,
        actorId: session.session.username,
        reason: body.reason,
      });
      notifyWebhookAvailable(dependencies, context);
      return context.json({ data: serializeFinancialDecision(result) });
    },
  );

  app.post(
    "/api/admin/v1/reconciliation/settlements/manual",
    adminSession,
    financialWrite,
    async (context) => {
      const body = await readJson(
        context,
        linkedFinancialDecisionRequestSchema,
        MAX_JSON_BODY_BYTES,
      );
      const session = requireCurrentStepUp(context, dependencies.identity);
      const result = requireReconciliationStore(dependencies).settleManually({
        financialOperationId: body.financial_operation_id,
        orderId: body.order_id,
        ledgerEntryId: body.ledger_entry_id,
        actorId: session.session.username,
        reason: body.reason,
      });
      notifyWebhookAvailable(dependencies, context);
      return context.json({ data: serializeFinancialDecision(result) });
    },
  );

  app.post(
    "/api/admin/v1/reconciliation/refunds",
    adminSession,
    financialWrite,
    async (context) => {
      const body = await readJson(
        context,
        linkedFinancialDecisionRequestSchema,
        MAX_JSON_BODY_BYTES,
      );
      const session = requireCurrentStepUp(context, dependencies.identity);
      const result = requireReconciliationStore(dependencies).recordRefund({
        financialOperationId: body.financial_operation_id,
        orderId: body.order_id,
        ledgerEntryId: body.ledger_entry_id,
        actorId: session.session.username,
        reason: body.reason,
      });
      notifyWebhookAvailable(dependencies, context);
      return context.json({ data: serializeRefundDecision(result) });
    },
  );

  app.get("/api/admin/v1/webhooks/deliveries", adminSession, (context) => {
    const query = readWebhookDeliveryPageQuery(context);
    const page = requireWebhookStore(dependencies).listDeliveries({
      status: query.status ?? undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return context.json({
      data: page.deliveries.map(serializeWebhookDeliverySummary),
      page: {
        next_cursor: encodeWebhookDeliveryCursor(page.nextCursor, query.status),
      },
    });
  });

  app.get(
    "/api/admin/v1/webhooks/deliveries/:deliveryId/attempts",
    adminSession,
    (context) => {
      const deliveryId = requireResourceId(
        context.req.param("deliveryId"),
        "webhook_delivery_not_found",
        "通知投递不存在",
      );
      const detail = requireWebhookStore(dependencies).delivery(deliveryId);
      if (!detail) {
        throw new HttpApiError(404, "webhook_delivery_not_found", "通知投递不存在");
      }
      return context.json({ data: detail.attempts.map(serializeWebhookAttempt) });
    },
  );

  app.get(
    "/api/admin/v1/webhooks/deliveries/:deliveryId",
    adminSession,
    (context) => {
      const deliveryId = requireResourceId(
        context.req.param("deliveryId"),
        "webhook_delivery_not_found",
        "通知投递不存在",
      );
      const detail = requireWebhookStore(dependencies).delivery(deliveryId);
      if (!detail) {
        throw new HttpApiError(404, "webhook_delivery_not_found", "通知投递不存在");
      }
      return context.json({ data: serializeWebhookDeliveryDetail(detail) });
    },
  );

  app.post(
    "/api/admin/v1/webhooks/deliveries/:deliveryId/actions/redeliver",
    adminSession,
    financialWrite,
    async (context) => {
      const deliveryId = requireResourceId(
        context.req.param("deliveryId"),
        "webhook_delivery_not_found",
        "通知投递不存在",
      );
      const body = await readJson(context, webhookReplayRequestSchema, MAX_JSON_BODY_BYTES);
      const session = requireCurrentStepUp(context, dependencies.identity);
      const store = requireWebhookStore(dependencies);
      const result = store.replay({
        redeliveryId: body.redelivery_id,
        deliveryId,
        actorId: session.session.username,
        reason: body.reason,
        activeAllowedOrigin: dependencies.config.webhook.enabled
          ? dependencies.config.webhook.allowedOrigin
          : null,
        now: Date.now(),
        requestId: context.get("requestId"),
        remoteAddressHash: dependencies.identity.sourceHash(
          remoteAddress(context, dependencies.config.trustedProxy),
        ),
      });
      notifyWebhookAvailable(dependencies, context);
      context.header(
        "location",
        `/api/admin/v1/webhooks/deliveries/${encodeURIComponent(result.delivery.deliveryId)}`,
      );
      return context.json(
        {
          data: {
            delivery: serializeWebhookDelivery(result.delivery),
            replayed: result.replayed,
          },
        },
        result.replayed ? 200 : 201,
      );
    },
  );

  const apiFailureAuditLimiter = new ApiFailureAuditLimiter();
  const publicCheckoutBudget = new PublicCheckoutRateLimiter();
  const signedApi = (maximumBodyBytes: number) =>
    requireApiClient(dependencies, maximumBodyBytes, apiFailureAuditLimiter);

  app.post("/api/v1/orders", signedApi(MAX_JSON_BODY_BYTES), (context) => {
    requirePaymentDatabaseReady(dependencies);
    requireJsonContentType(context);
    const request = parseJsonBytes(context.get("apiRawBody"), createOrderRequestSchema);
    const result = dependencies.orders.create(
      context.get("apiClientId"),
      request,
      () => requirePaymentBackgroundReady(dependencies),
    );
    try {
      dependencies.onOrderAvailable?.(result.order.orderId);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "order_reconciliation_trigger_failed",
        request_id: context.get("requestId"),
        error_type: error instanceof Error ? error.name : "unknown_error",
      }));
    }
    const data = serializeOrder(result.order, dependencies.config.publicOrigin);
    context.header("location", `/api/v1/orders/${encodeURIComponent(result.order.orderId)}`);
    return context.json({ data }, result.created ? 201 : 200);
  });

  app.get(
    "/api/v1/orders/by-merchant-no/:merchantOrderNo",
    signedApi(0),
    (context) => {
      const parsed = merchantOrderNumberSchema.safeParse(context.req.param("merchantOrderNo"));
      if (!parsed.success) throw orderNotFoundHttpError();
      const order = dependencies.orders.getByMerchantOrderNumber(
        context.get("apiClientId"),
        parsed.data,
      );
      return context.json({ data: serializeOrder(order, dependencies.config.publicOrigin) });
    },
  );

  app.get("/api/v1/orders/:orderId", signedApi(0), (context) => {
    const orderId = requireOrderId(context.req.param("orderId"));
    const order = dependencies.orders.get(context.get("apiClientId"), orderId);
    return context.json({ data: serializeOrder(order, dependencies.config.publicOrigin) });
  });

  app.post("/api/v1/orders/:orderId/actions/close", signedApi(0), (context) => {
    const orderId = requireOrderId(context.req.param("orderId"));
    const order = dependencies.orders.close(context.get("apiClientId"), orderId);
    return context.json({ data: serializeOrder(order, dependencies.config.publicOrigin) });
  });

  app.get("/api/v1/events/:eventId", signedApi(0), (context) => {
    const eventId = requireResourceId(
      context.req.param("eventId"),
      "event_not_found",
      "通知事件不存在",
    );
    const event = requireWebhookStore(dependencies).eventForApiClient(
      context.get("apiClientId"),
      eventId,
    );
    if (!event) throw new HttpApiError(404, "event_not_found", "通知事件不存在");
    return context.json({ data: serializeWebhookEvent(event) });
  });

  app.get("/api/public/v1/checkouts/:token", (context) => {
    const sourceAddress = remoteAddress(context, dependencies.config.trustedProxy);
    if (!publicCheckoutBudget.take(sourceAddress)) {
      throw new HttpApiError(
        429,
        "public_checkout_rate_limited",
        "公开收银台请求过于频繁",
        1,
      );
    }
    const checkout = dependencies.orders.publicCheckout(context.req.param("token"));
    if (checkout.paymentInstructions !== null) requirePaymentEntryReady(dependencies);
    return context.json({ data: serializePublicCheckout(checkout) });
  });

  app.get("/api/v1/system/status", signedApi(0), (context) => {
    return context.json({ data: systemStatus(dependencies) });
  });

  app.notFound((context) =>
    errorResponse(context, 404, "route_not_found", "请求的资源不存在"),
  );

  app.onError((error, context) => {
    if (error instanceof ForwardedAddressError) {
      return errorResponse(
        context,
        400,
        "forwarded_header_invalid",
        "受信代理提供的 X-Forwarded-For 无效",
      );
    }
    if (error instanceof HttpApiError) {
      if (error.retryAfterSeconds !== undefined) {
        context.header("retry-after", String(error.retryAfterSeconds));
      }
      return errorResponse(context, error.status, error.code, error.message);
    }
    if (error instanceof IdentityError) {
      if (error.retryAfterSeconds !== undefined) {
        context.header("retry-after", String(error.retryAfterSeconds));
      }
      const status = identityStatus(error.code);
      return errorResponse(context, status, error.code, error.message);
    }
    if (error instanceof OrderError) {
      if (error.retryAfterSeconds !== undefined) {
        context.header("retry-after", String(error.retryAfterSeconds));
      }
      return errorResponse(context, orderStatus(error.code), error.code, error.message);
    }
    if (error instanceof ReconciliationError) {
      return errorResponse(
        context,
        reconciliationStatus(error.code),
        error.code,
        reconciliationMessage(error.code),
      );
    }
    if (error instanceof LedgerConflictError) {
      return errorResponse(
        context,
        ledgerConflictStatus(error.code),
        error.code,
        ledgerConflictMessage(error.code),
      );
    }
    if (error instanceof WebhookStoreError) {
      return errorResponse(
        context,
        webhookStoreStatus(error.code),
        error.code,
        webhookStoreMessage(error.code),
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "http_request_failed",
        request_id: context.get("requestId"),
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return errorResponse(context, 500, "internal_error", "服务器处理请求失败");
  });

  return app;
}

function requireAdminSession(identity: IdentityService, secureCookies: boolean): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const token = getCookie(context, sessionCookieName(secureCookies));
    const authenticated = token ? identity.authenticate(token) : undefined;
    if (!authenticated) throw new HttpApiError(401, "session_invalid", "会话不存在或已过期");
    context.set("adminSession", authenticated);
    await next();
  };
}

function requireFinancialWrite(
  identity: IdentityService,
  publicOrigin: string,
  secureCookies: boolean,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    requireSameOrigin(context, publicOrigin);
    requireCsrf(context, identity, secureCookies);
    if (!identity.isStepUp(context.get("adminSession"))) {
      throw new IdentityError("step_up_required", "此资金操作需要近期密码验证");
    }
    requireJsonContentType(context);
    await next();
  };
}

function requireReconciliationStore(dependencies: AppDependencies): ReconciliationStore {
  if (!dependencies.reconciliation) {
    throw new HttpApiError(503, "reconciliation_unavailable", "对账服务不可用");
  }
  return dependencies.reconciliation;
}

function requireLedgerStore(dependencies: AppDependencies): LedgerStore {
  if (!dependencies.ledger) {
    throw new HttpApiError(503, "ledger_unavailable", "账务服务不可用");
  }
  return dependencies.ledger;
}

function requireWebhookStore(dependencies: AppDependencies): WebhookStore {
  if (!dependencies.webhookStore) {
    throw new HttpApiError(503, "webhook_unavailable", "通知服务不可用");
  }
  return dependencies.webhookStore;
}

function notifyWebhookAvailable(
  dependencies: AppDependencies,
  context: Context<AppEnvironment>,
): void {
  try {
    const result = dependencies.onWebhookAvailable?.();
    if (result) {
      void result.catch((error: unknown) => {
        console.error(JSON.stringify({
          level: "error",
          event: "webhook_scheduler_trigger_failed",
          request_id: context.get("requestId"),
          error_type: error instanceof Error ? error.name : "unknown_error",
        }));
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "webhook_scheduler_trigger_failed",
      request_id: context.get("requestId"),
      error_type: error instanceof Error ? error.name : "unknown_error",
    }));
  }
}

function requireCurrentStepUp(
  context: Context<AppEnvironment>,
  identity: IdentityService,
): AuthenticatedSession {
  const current = identity.authenticate(context.get("adminSession").token);
  if (!current) throw new HttpApiError(401, "session_invalid", "会话不存在或已过期");
  context.set("adminSession", current);
  if (!identity.isStepUp(current)) {
    throw new IdentityError("step_up_required", "此操作需要近期密码验证");
  }
  return current;
}

function requireApiClient(
  dependencies: AppDependencies,
  maximumBodyBytes: number,
  failureAuditLimiter: ApiFailureAuditLimiter,
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const authentication = readApiAuthentication(context);
    const client = dependencies.identity.apiClient(authentication.clientId);
    if (!client) throw new HttpApiError(401, "api_authentication_failed", "API 认证失败");
    const body = await readBodyLimited(context, maximumBodyBytes);
    context.set("apiRawBody", body);

    let verified;
    const verifiedAt = new Date();
    try {
      verified = verifyApiRequestSignature({
        secret: Buffer.from(dependencies.config.apiSecret, "base64url"),
        method: context.req.method,
        target: originalRequestTarget(context),
        body,
        authentication,
        now: verifiedAt,
      });
    } catch {
      auditApiFailure(
        dependencies.identity,
        failureAuditLimiter,
        authentication.clientId,
        "signature_invalid",
        context.get("requestId"),
      );
      throw new HttpApiError(401, "api_authentication_failed", "API 认证失败");
    }

    if (
      !dependencies.identity.consumeApiNonce(
        client.clientId,
        verified.nonce,
        verified.timestamp,
        verifiedAt.getTime(),
      )
    ) {
      auditApiFailure(
        dependencies.identity,
        failureAuditLimiter,
        client.clientId,
        "nonce_replayed",
        context.get("requestId"),
      );
      throw new HttpApiError(409, "api_nonce_replayed", "请求 nonce 已被使用");
    }
    context.set("apiClientId", client.clientId);
    await next();
  };
}

function auditApiFailure(
  identity: IdentityService,
  limiter: ApiFailureAuditLimiter,
  clientId: string,
  reason: "signature_invalid" | "nonce_replayed",
  requestId: string,
): void {
  const decision = limiter.record(`${clientId}\0${reason}`, Date.now());
  if (!decision.audit) return;
  try {
    identity.auditApi({
      clientId,
      action: "api.authentication",
      outcome: "FAILURE",
      requestId,
      details: {
        reason,
        suppressed_since_previous: decision.suppressed,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "api_authentication_audit_failed",
        request_id: requestId,
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
  }
}

class ApiFailureAuditLimiter {
  static readonly WINDOW_MS = 60_000;
  readonly #buckets = new Map<string, { windowStartedAt: number; count: number }>();

  record(key: string, now: number): { readonly audit: boolean; readonly suppressed: number } {
    const previous = this.#buckets.get(key);
    if (
      !previous ||
      now < previous.windowStartedAt ||
      now - previous.windowStartedAt >= ApiFailureAuditLimiter.WINDOW_MS
    ) {
      this.#buckets.set(key, { windowStartedAt: now, count: 1 });
      return { audit: true, suppressed: Math.max(0, (previous?.count ?? 1) - 1) };
    }
    previous.count += 1;
    return { audit: false, suppressed: 0 };
  }
}

function requireSameOrigin(context: Context<AppEnvironment>, expectedOrigin: string): void {
  const origin = context.req.header("origin");
  if (origin !== expectedOrigin) {
    throw new HttpApiError(403, "origin_not_allowed", "请求来源不受信任");
  }
  const fetchSite = context.req.header("sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpApiError(403, "origin_not_allowed", "请求来源不受信任");
  }
}

function requireCsrf(
  context: Context<AppEnvironment>,
  identity: IdentityService,
  secureCookies: boolean,
): void {
  const csrf = context.req.header("x-csrf-token");
  const csrfCookie = getCookie(context, csrfCookieName(secureCookies));
  if (
    csrf === undefined ||
    csrfCookie === undefined ||
    csrf !== csrfCookie ||
    !identity.verifyCsrf(context.get("adminSession"), csrf)
  ) {
    throw new HttpApiError(403, "csrf_invalid", "CSRF 令牌无效");
  }
}

function requireJsonContentType(context: Context<AppEnvironment>): void {
  const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpApiError(415, "unsupported_media_type", "请求必须使用 application/json");
  }
}

async function readJson<T>(
  context: Context<AppEnvironment>,
  schema: z.ZodType<T>,
  maximumBytes: number,
): Promise<T> {
  const bytes = await readBodyLimited(context, maximumBytes);
  return parseJsonBytes(bytes, schema);
}

function parseJsonBytes<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof StrictJsonError && error.code === "DUPLICATE_KEY") {
      throw new HttpApiError(400, "duplicate_json_key", "请求体包含重复 JSON 字段");
    }
    throw new HttpApiError(400, "invalid_json", "请求体不是有效 JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpApiError(422, "validation_failed", "请求字段校验失败");
  }
  return parsed.data;
}

async function readBodyLimited(
  context: Context<AppEnvironment>,
  maximumBytes: number,
): Promise<Buffer> {
  const contentLength = parseContentLength(context.req.header("content-length"));
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new HttpApiError(413, "request_body_too_large", "请求体超过允许大小");
  }

  const body = context.req.raw.body;
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpApiError(413, "request_body_too_large", "请求体超过允许大小");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof HttpApiError) throw error;
    throw new HttpApiError(400, "request_body_unreadable", "无法读取请求体");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function originalRequestTarget(context: Context<AppEnvironment>): string {
  const incomingTarget = context.env?.incoming?.url;
  if (typeof incomingTarget === "string") return incomingTarget;
  const url = new URL(context.req.url);
  return `${url.pathname}${url.search}`;
}

function setAuthenticationCookies(
  context: Context<AppEnvironment>,
  sessionToken: string,
  csrfToken: string,
  secure: boolean,
  maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS,
): void {
  setCookie(context, sessionCookieName(secure), sessionToken, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Strict",
    maxAge: maxAgeSeconds,
    priority: "High",
  });
  setCookie(context, csrfCookieName(secure), csrfToken, {
    path: "/",
    httpOnly: false,
    secure,
    sameSite: "Strict",
    maxAge: maxAgeSeconds,
    priority: "High",
  });
}

function clearAuthenticationCookies(context: Context<AppEnvironment>, secure: boolean): void {
  deleteCookie(context, sessionCookieName(secure), {
    path: "/",
    secure,
    sameSite: "Strict",
  });
  deleteCookie(context, csrfCookieName(secure), {
    path: "/",
    secure,
    sameSite: "Strict",
  });
}

function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

function csrfCookieName(secure: boolean): string {
  return secure ? SECURE_CSRF_COOKIE : CSRF_COOKIE;
}

function readApiAuthentication(context: Context<AppEnvironment>): ApiRequestAuthentication {
  const version = context.req.header("x-perpay-signature-version");
  const clientId = context.req.header("x-perpay-client-id");
  const timestamp = context.req.header("x-perpay-timestamp");
  const nonce = context.req.header("x-perpay-nonce");
  const signature = context.req.header("x-perpay-signature");
  if (!version || !clientId || !timestamp || !nonce || !signature) {
    throw new HttpApiError(401, "api_authentication_failed", "API 认证失败");
  }
  return { version, clientId, timestamp, nonce, signature };
}

function identityContext(
  context: Context<AppEnvironment>,
  trustedProxy: TrustedProxyPolicy,
): {
  readonly requestId: string;
  readonly sourceAddress: string;
} {
  return {
    requestId: context.get("requestId"),
    sourceAddress: remoteAddress(context, trustedProxy),
  };
}

function remoteAddress(
  context: Context<AppEnvironment>,
  trustedProxy: TrustedProxyPolicy,
): string {
  let peerAddress: string | undefined;
  try {
    peerAddress = getConnInfo(context).remote.address;
  } catch {
    peerAddress = undefined;
  }
  return resolveForwardedClientAddress(
    trustedProxy,
    peerAddress,
    context.req.header("x-forwarded-for"),
  );
}

function currentLedgerHealth(
  dependencies: AppDependencies,
): LedgerSchedulerHealth & { readonly enabled: boolean } {
  if (dependencies.ledgerHealth) return dependencies.ledgerHealth();
  if (!dependencies.config.alipay.enabled) return disabledLedgerHealth;
  return {
    ...disabledLedgerHealth,
    enabled: true,
  };
}

interface OperationalSummaries {
  readonly conflicts: LedgerConflictSummary | null;
  readonly exceptions: FinancialExceptionSummary | null;
  readonly unavailable: boolean;
}

function operationalSummaries(
  dependencies: AppDependencies,
  databaseReady: boolean,
): OperationalSummaries {
  if (!databaseReady) {
    return { conflicts: null, exceptions: null, unavailable: false };
  }
  let conflicts: LedgerConflictSummary | null = null;
  let exceptions: FinancialExceptionSummary | null = null;
  let unavailable = false;
  if (dependencies.ledger) {
    try {
      conflicts = dependencies.ledger.conflictSummary();
    } catch {
      unavailable = true;
    }
  }
  if (dependencies.reconciliation) {
    try {
      exceptions = dependencies.reconciliation.exceptionSummary();
    } catch {
      unavailable = true;
    }
  }
  return { conflicts, exceptions, unavailable };
}

function systemStatus(dependencies: AppDependencies) {
  const database = dependencies.database.health();
  const ledger = currentLedgerHealth(dependencies);
  const reconciliation = dependencies.reconciliationHealth?.() ?? disabledReconciliationHealth;
  const webhook = dependencies.webhookHealth?.() ?? disabledWebhookHealth;
  const collection = collectionFreshness(dependencies, ledger);
  const confirmation = confirmationFreshness(dependencies, reconciliation);
  const operations = operationalSummaries(dependencies, database.ok);
  const backup = currentBackupHealth(dependencies);
  const ready = database.ok && collection.ready && confirmation.ready;
  const degraded = ready && (
    isBackgroundHealthDegraded(ledger) ||
    isBackgroundHealthDegraded(reconciliation) ||
    isBackgroundHealthDegraded(webhook) ||
    (backup.enabled && !backup.ok) ||
    operations.unavailable ||
    (operations.conflicts?.open ?? 0) > 0 ||
    (operations.exceptions?.open ?? 0) > 0
  );
  return {
    status: ready ? (degraded ? "degraded" : "ready") : "not_ready",
    version: APP_VERSION,
    instance_id: dependencies.database.instanceId(),
    database,
    ledger: {
      ...serializeLedgerHealth(ledger, collection),
      conflicts: serializeLedgerConflictSummary(operations.conflicts),
    },
    reconciliation: {
      ...serializeReconciliationHealth(reconciliation, confirmation),
      exceptions: serializeFinancialExceptionSummary(operations.exceptions),
    },
    webhook: serializeWebhookHealth(webhook),
    backup,
  };
}

function isBackgroundHealthDegraded(health: {
  readonly enabled: boolean;
  readonly state: string;
  readonly lastErrorCode: string | null;
  readonly consecutiveFailures: number;
}): boolean {
  return health.enabled && (
    health.state === "degraded" ||
    health.state === "catching_up" ||
    health.state === "stopped" ||
    health.lastErrorCode !== null ||
    health.consecutiveFailures > 0
  );
}

function currentBackupHealth(dependencies: AppDependencies) {
  if (!dependencies.backupHealth) return disabledBackupHealth;
  try {
    const health = dependencies.backupHealth();
    const applicationInstanceId = dependencies.database.instanceId();
    const instanceMatches = health.instance_id === null
      ? null
      : health.instance_id === applicationInstanceId;
    const ok = health.ok && instanceMatches === true;
    return Object.freeze({
      enabled: true,
      ...health,
      ok,
      status: ok ? "healthy" as const : "unhealthy" as const,
      instance_matches: instanceMatches,
    });
  } catch {
    return Object.freeze({
      ...disabledBackupHealth,
      enabled: true,
      ok: false,
      status: "unavailable" as const,
    });
  }
}

interface CollectionFreshness {
  readonly ready: boolean;
  readonly lastSuccessAgeMilliseconds: number | null;
  readonly maximumSuccessAgeMilliseconds: number;
}

function collectionFreshness(
  dependencies: AppDependencies,
  health: LedgerSchedulerHealth & { readonly enabled: boolean },
): CollectionFreshness {
  const maximumSuccessAgeMilliseconds =
    dependencies.config.alipay.maximumSuccessAgeMilliseconds;
  if (!health.enabled) {
    return {
      ready: false,
      lastSuccessAgeMilliseconds: null,
      maximumSuccessAgeMilliseconds,
    };
  }
  if (health.lastSuccessAt === null) {
    return {
      ready: false,
      lastSuccessAgeMilliseconds: null,
      maximumSuccessAgeMilliseconds,
    };
  }
  const now = dependencies.clock?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return {
      ready: false,
      lastSuccessAgeMilliseconds: null,
      maximumSuccessAgeMilliseconds,
    };
  }
  const successAge = now - health.lastSuccessAt;
  const validAge = Number.isSafeInteger(successAge) && successAge >= 0;
  return {
    ready:
      health.state !== "stopped" &&
      validAge &&
      successAge <= maximumSuccessAgeMilliseconds,
    lastSuccessAgeMilliseconds: validAge ? successAge : null,
    maximumSuccessAgeMilliseconds,
  };
}

interface ConfirmationFreshness {
  readonly ready: boolean;
  readonly lastSuccessAgeMilliseconds: number | null;
  readonly maximumSuccessAgeMilliseconds: number;
}

function confirmationFreshness(
  dependencies: AppDependencies,
  health: ReconciliationSchedulerHealth & { readonly enabled: boolean },
): ConfirmationFreshness {
  const maximumSuccessAgeMilliseconds =
    dependencies.config.alipay.maximumSuccessAgeMilliseconds;
  if (!health.enabled || health.state === "stopped" || health.lastSuccessAt === null) {
    return {
      ready: false,
      lastSuccessAgeMilliseconds: null,
      maximumSuccessAgeMilliseconds,
    };
  }
  const now = dependencies.clock?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return {
      ready: false,
      lastSuccessAgeMilliseconds: null,
      maximumSuccessAgeMilliseconds,
    };
  }
  const successAge = now - health.lastSuccessAt;
  const validAge = Number.isSafeInteger(successAge) && successAge >= 0;
  return {
    ready: validAge && successAge <= maximumSuccessAgeMilliseconds,
    lastSuccessAgeMilliseconds: validAge ? successAge : null,
    maximumSuccessAgeMilliseconds,
  };
}

function requirePaymentEntryReady(dependencies: AppDependencies): void {
  requirePaymentDatabaseReady(dependencies);
  requirePaymentBackgroundReady(dependencies);
}

function requirePaymentDatabaseReady(dependencies: AppDependencies): void {
  if (!dependencies.database.health().ok) {
    throw new HttpApiError(
      503,
      "system_not_ready",
      "收款系统当前未就绪",
      5,
    );
  }
}

function requirePaymentBackgroundReady(dependencies: AppDependencies): void {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(dependencies.config.alipay.scanIntervalMilliseconds / 1_000),
  );
  if (!collectionFreshness(dependencies, currentLedgerHealth(dependencies)).ready) {
    throw new HttpApiError(
      503,
      "collection_not_ready",
      "账务采集没有近期成功扫描记录",
      retryAfterSeconds,
    );
  }
  const reconciliation = dependencies.reconciliationHealth?.() ?? disabledReconciliationHealth;
  if (confirmationFreshness(dependencies, reconciliation).ready) return;
  throw new HttpApiError(
    503,
    "reconciliation_not_ready",
    "自动对账没有近期成功运行记录",
    retryAfterSeconds,
  );
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpApiError(400, "invalid_content_length", "Content-Length 无效");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpApiError(400, "invalid_content_length", "Content-Length 无效");
  }
  return parsed;
}

function identityStatus(code: IdentityError["code"]): 401 | 403 | 409 | 429 | 503 {
  switch (code) {
    case "invalid_credentials":
    case "session_invalid":
    case "api_client_invalid":
      return 401;
    case "csrf_invalid":
    case "step_up_required":
      return 403;
    case "password_unchanged":
    case "api_nonce_replayed":
      return 409;
    case "auth_rate_limited":
      return 429;
    case "identity_not_initialized":
    case "password_work_busy":
      return 503;
  }
}

function orderStatus(code: OrderErrorCode): 404 | 409 | 422 | 503 {
  switch (code) {
    case "order_not_found":
    case "checkout_not_found":
      return 404;
    case "idempotency_conflict":
    case "merchant_order_no_conflict":
      return 409;
    case "amount_slots_exhausted":
    case "order_clock_unavailable":
      return 503;
    case "webhook_disabled":
    case "webhook_target_invalid":
    case "webhook_target_not_allowed":
      return 422;
  }
}

function reconciliationStatus(code: ReconciliationErrorCode): 404 | 409 | 503 {
  switch (code) {
    case "candidate_not_found":
    case "match_not_found":
      return 404;
    case "match_state_conflict":
    case "candidate_set_changed":
    case "operation_conflict":
      return 409;
    case "financial_clock_unavailable":
      return 503;
  }
}

function reconciliationMessage(code: ReconciliationErrorCode): string {
  switch (code) {
    case "candidate_not_found":
      return "匹配候选或订单不存在";
    case "match_not_found":
      return "支付关联不存在";
    case "match_state_conflict":
      return "资金事实或处理状态已经变化";
    case "candidate_set_changed":
      return "匹配候选集合已经变化，请刷新后重新判断";
    case "operation_conflict":
      return "资金操作编号已用于不同请求";
    case "financial_clock_unavailable":
      return "资金操作时钟暂时不可用";
  }
}

function ledgerConflictStatus(code: LedgerConflictError["code"]): 404 | 409 {
  switch (code) {
    case "ledger_conflict_not_found":
      return 404;
    case "ledger_conflict_state_conflict":
    case "ledger_conflict_action_not_allowed":
    case "ledger_conflict_operation_conflict":
      return 409;
  }
}

function ledgerConflictMessage(code: LedgerConflictError["code"]): string {
  switch (code) {
    case "ledger_conflict_not_found":
      return "账务冲突不存在";
    case "ledger_conflict_state_conflict":
      return "账务冲突处理状态已经变化";
    case "ledger_conflict_action_not_allowed":
      return "该账务冲突不允许执行此处理动作";
    case "ledger_conflict_operation_conflict":
      return "账务冲突处理编号已用于不同请求";
  }
}

function webhookStoreStatus(
  code: WebhookStoreError["code"],
): 404 | 409 | 503 {
  switch (code) {
    case "webhook_delivery_not_found":
    case "webhook_event_not_found":
      return 404;
    case "webhook_operation_conflict":
    case "webhook_delivery_state_conflict":
    case "webhook_disabled":
    case "webhook_target_inactive":
      return 409;
    case "webhook_signing_key_rollback":
    case "webhook_signing_key_unavailable":
      return 503;
  }
}

function webhookStoreMessage(code: WebhookStoreError["code"]): string {
  switch (code) {
    case "webhook_delivery_not_found":
      return "通知投递不存在";
    case "webhook_event_not_found":
      return "通知事件不存在";
    case "webhook_operation_conflict":
      return "补发编号已经用于不同的通知请求";
    case "webhook_delivery_state_conflict":
      return "通知投递状态已经变化";
    case "webhook_disabled":
      return "通知功能未启用";
    case "webhook_target_inactive":
      return "通知目标不再属于当前允许的 origin";
    case "webhook_signing_key_rollback":
    case "webhook_signing_key_unavailable":
      return "通知签名密钥不可用";
  }
}

function requireResourceId(value: string, code: string, message: string): string {
  if (!ORDER_ID_PATTERN.test(value)) throw new HttpApiError(404, code, message);
  return value;
}

function readLedgerConflictPageQuery(context: Context<AppEnvironment>): {
  readonly limit: number;
  readonly status: LedgerConflictStatus | "ALL";
  readonly cursor: LedgerConflictCursor | null;
} {
  const values = new URL(context.req.url).searchParams;
  for (const key of values.keys()) {
    if (key !== "limit" && key !== "status" && key !== "cursor") {
      throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
    }
  }
  const limits = values.getAll("limit");
  if (
    limits.length > 1 ||
    (limits.length === 1 && !/^[1-9][0-9]{0,2}$/.test(limits[0] ?? ""))
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const limit = limits.length === 0 ? 100 : Number(limits[0]);
  if (limit > 200) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statuses = values.getAll("status");
  if (statuses.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statusValue = statuses[0] ?? "OPEN";
  if (statusValue !== "ALL" && !LEDGER_CONFLICT_STATUSES.has(statusValue as LedgerConflictStatus)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const status = statusValue as LedgerConflictStatus | "ALL";
  const cursors = values.getAll("cursor");
  if (cursors.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return {
    limit,
    status,
    cursor: cursors.length === 0
      ? null
      : decodeLedgerConflictCursor(cursors[0] ?? "", status),
  };
}

function encodeLedgerConflictCursor(
  cursor: LedgerConflictCursor | null,
  status: LedgerConflictStatus | "ALL",
): string | null {
  if (!cursor) return null;
  return Buffer.from(
    `perpay:ledger-conflicts:v1\n${status}\n${cursor.createdAt}\n${cursor.conflictId}`,
    "ascii",
  ).toString("base64url");
}

function decodeLedgerConflictCursor(
  value: string,
  expectedStatus: LedgerConflictStatus | "ALL",
): LedgerConflictCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || decoded.some((byte) => byte > 0x7f)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const match = /^perpay:ledger-conflicts:v1\n(OPEN|RESOLVED|IGNORED|ALL)\n(0|[1-9][0-9]*)\n([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
    .exec(decoded.toString("ascii"));
  const createdAt = Number(match?.[2]);
  if (!match || match[1] !== expectedStatus || !Number.isSafeInteger(createdAt)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return { createdAt, conflictId: match[3]! };
}

function readPaymentMatchHistoryPageQuery(context: Context<AppEnvironment>): {
  readonly limit: number;
  readonly status: PaymentMatchStatus;
  readonly cursor: PaymentMatchHistoryCursor | null;
} {
  const values = new URL(context.req.url).searchParams;
  for (const key of values.keys()) {
    if (key !== "limit" && key !== "status" && key !== "cursor") {
      throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
    }
  }
  const limits = values.getAll("limit");
  if (
    limits.length > 1 ||
    (limits.length === 1 && !/^[1-9][0-9]{0,2}$/.test(limits[0] ?? ""))
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const limit = limits.length === 0 ? 100 : Number(limits[0]);
  if (limit > 200) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statuses = values.getAll("status");
  if (statuses.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statusValue = statuses[0] ?? "SETTLED";
  if (!PAYMENT_MATCH_STATUSES.has(statusValue as PaymentMatchStatus)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const status = statusValue as PaymentMatchStatus;
  const cursors = values.getAll("cursor");
  if (cursors.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return {
    limit,
    status,
    cursor: cursors.length === 0
      ? null
      : decodePaymentMatchHistoryCursor(cursors[0] ?? "", status),
  };
}

function encodePaymentMatchHistoryCursor(
  cursor: PaymentMatchHistoryCursor | null,
  status: PaymentMatchStatus,
): string | null {
  if (!cursor) return null;
  return Buffer.from(
    `perpay:payment-match-history:v1\n${status}\n${cursor.eventSequence}`,
    "ascii",
  ).toString("base64url");
}

function decodePaymentMatchHistoryCursor(
  value: string,
  expectedStatus: PaymentMatchStatus,
): PaymentMatchHistoryCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    decoded.some((byte) => byte > 0x7f)
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const match =
    /^perpay:payment-match-history:v1\n(SETTLED|REVERSED)\n([1-9][0-9]*)$/
      .exec(decoded.toString("ascii"));
  const eventSequence = Number(match?.[2]);
  if (
    !match ||
    !Number.isSafeInteger(eventSequence) ||
    match[1] !== expectedStatus
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return { eventSequence };
}

function readExceptionPageQuery(context: Context<AppEnvironment>): {
  readonly limit: number;
  readonly cursor: FinancialExceptionCursor | null;
} {
  const values = new URL(context.req.url).searchParams;
  for (const key of values.keys()) {
    if (key !== "limit" && key !== "cursor") {
      throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
    }
  }
  const limits = values.getAll("limit");
  if (limits.length > 1 || (limits.length === 1 && !/^[1-9][0-9]{0,2}$/.test(limits[0] ?? ""))) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const limit = limits.length === 0 ? 100 : Number(limits[0]);
  if (limit > 200) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const cursors = values.getAll("cursor");
  if (cursors.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return {
    limit,
    cursor: cursors.length === 0 ? null : decodeExceptionCursor(cursors[0] ?? ""),
  };
}

function encodeExceptionCursor(
  cursor: FinancialExceptionCursor | null,
): string | null {
  if (!cursor) return null;
  return Buffer.from(`${cursor.createdAt}:${cursor.exceptionId}`, "ascii").toString("base64url");
}

function decodeExceptionCursor(
  value: string,
): FinancialExceptionCursor {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const match = /^(0|[1-9][0-9]*):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
    .exec(decoded.toString("ascii"));
  const createdAt = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(createdAt)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return { createdAt, exceptionId: match[2]! };
}

function readWebhookDeliveryPageQuery(context: Context<AppEnvironment>): {
  readonly limit: number;
  readonly status: WebhookDeliveryStatus | null;
  readonly cursor: WebhookDeliveryCursor | null;
} {
  const values = new URL(context.req.url).searchParams;
  for (const key of values.keys()) {
    if (key !== "limit" && key !== "status" && key !== "cursor") {
      throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
    }
  }
  const limits = values.getAll("limit");
  if (
    limits.length > 1 ||
    (limits.length === 1 && !/^[1-9][0-9]{0,2}$/.test(limits[0] ?? ""))
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const limit = limits.length === 0 ? 100 : Number(limits[0]);
  if (limit > 200) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statuses = values.getAll("status");
  if (statuses.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const statusValue = statuses[0];
  if (
    statusValue !== undefined &&
    !WEBHOOK_DELIVERY_STATUSES.has(statusValue as WebhookDeliveryStatus)
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const status = statusValue as WebhookDeliveryStatus | undefined;
  const cursors = values.getAll("cursor");
  if (cursors.length > 1) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return {
    limit,
    status: status ?? null,
    cursor: cursors.length === 0
      ? null
      : decodeWebhookDeliveryCursor(cursors[0] ?? "", status ?? null),
  };
}

function encodeWebhookDeliveryCursor(
  cursor: WebhookDeliveryCursor | null,
  status: WebhookDeliveryStatus | null,
): string | null {
  if (!cursor) return null;
  const filter = status ?? "*";
  return Buffer.from(
    `perpay:webhook-deliveries:v1\n${filter}\n${cursor.createdAt}\n${cursor.deliveryId}`,
    "ascii",
  ).toString("base64url");
}

function decodeWebhookDeliveryCursor(
  value: string,
  expectedStatus: WebhookDeliveryStatus | null,
): WebhookDeliveryCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    decoded.some((byte) => byte > 0x7f)
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  const match =
    /^perpay:webhook-deliveries:v1\n(\*|PENDING|LEASED|RETRY_WAIT|ACKNOWLEDGED|DEAD_LETTER)\n(0|[1-9][0-9]*)\n([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
      .exec(decoded.toString("ascii"));
  const createdAt = Number(match?.[2]);
  if (
    !match ||
    !Number.isSafeInteger(createdAt) ||
    match[1] !== (expectedStatus ?? "*")
  ) {
    throw new HttpApiError(422, "validation_failed", "查询参数校验失败");
  }
  return { createdAt, deliveryId: match[3]! };
}

function requireOrderId(value: string): string {
  if (!ORDER_ID_PATTERN.test(value)) throw orderNotFoundHttpError();
  return value;
}

function orderNotFoundHttpError(): HttpApiError {
  return new HttpApiError(404, "order_not_found", "订单不存在");
}

function serializeOrder(order: OrderProjection, publicOrigin: string) {
  return {
    order_id: order.orderId,
    merchant_order_no: order.merchantOrderNo,
    requested_amount_cents: order.requestedAmountCents,
    payable_amount_cents: order.payableAmountCents,
    received_amount_cents: order.receivedAmountCents,
    currency: order.currency,
    description: order.description,
    checkout: {
      status: order.checkout.status,
      token: order.checkoutToken,
      state_url: new URL(
        `/api/public/v1/checkouts/${encodeURIComponent(order.checkoutToken)}`,
        publicOrigin,
      ).toString(),
      expires_at: new Date(order.checkout.expiresAt).toISOString(),
      closed_at: nullableIsoTime(order.checkout.closedAt),
    },
    payment: {
      status: order.payment.status,
      basis: order.payment.basis,
      received_amount_cents: order.payment.receivedAmountCents,
    },
    refund: { status: order.refund.status },
    notification: { notify_url: order.notification.notifyUrl },
    created_at: new Date(order.createdAt).toISOString(),
    updated_at: new Date(order.updatedAt).toISOString(),
    version: order.version,
  };
}

function serializeWebhookEvent(event: WebhookEvent) {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    order_id: event.orderId,
    order_version: event.orderVersion,
    payload: parseStrictJson(Buffer.from(event.payloadJson, "utf8")),
    payload_fingerprint: event.payloadFingerprint,
    created_at: new Date(event.createdAt).toISOString(),
  };
}

function serializeWebhookDeliverySummary(summary: WebhookDeliverySummary) {
  return {
    ...serializeWebhookDelivery(summary.delivery),
    event: {
      event_type: summary.eventType,
      order_id: summary.orderId,
    },
    target: {
      format: summary.targetFormat,
      url_fingerprint: summary.targetUrlFingerprint,
    },
  };
}

function serializeWebhookDeliveryDetail(detail: WebhookDeliveryDetail) {
  return {
    delivery: serializeWebhookDelivery(detail.delivery),
    event: serializeWebhookEvent(detail.event),
    target: {
      target_id: detail.target.targetId,
      order_id: detail.target.orderId,
      api_client_id: detail.target.apiClientId,
      format: detail.target.format,
      target_url: detail.target.targetUrl,
      allowed_origin: detail.target.allowedOrigin,
      url_fingerprint: detail.target.urlFingerprint,
      created_at: new Date(detail.target.createdAt).toISOString(),
    },
  };
}

function serializeWebhookDelivery(delivery: WebhookDelivery) {
  const retryPending = delivery.status === "PENDING" || delivery.status === "RETRY_WAIT";
  return {
    delivery_id: delivery.deliveryId,
    event_id: delivery.eventId,
    target_id: delivery.targetId,
    generation: delivery.generation,
    predecessor_delivery_id: delivery.predecessorDeliveryId,
    request_key: delivery.requestKey,
    requested_by_type: delivery.requestedByType,
    requested_by_actor_id: delivery.requestedByActorId,
    reason: delivery.reason,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    next_attempt_at: retryPending ? new Date(delivery.nextAttemptAt).toISOString() : null,
    lease_expires_at: nullableIsoTime(delivery.leaseExpiresAt),
    acknowledged_at: nullableIsoTime(delivery.acknowledgedAt),
    dead_lettered_at: nullableIsoTime(delivery.deadLetteredAt),
    last_error_code: delivery.lastErrorCode,
    created_at: new Date(delivery.createdAt).toISOString(),
    updated_at: new Date(delivery.updatedAt).toISOString(),
  };
}

function serializeWebhookAttempt(attempt: WebhookAttempt) {
  return {
    attempt_id: attempt.attemptId,
    delivery_id: attempt.deliveryId,
    attempt_number: attempt.attemptNumber,
    key_version: attempt.keyVersion,
    key_id: attempt.keyId,
    request_timestamp: attempt.requestTimestamp,
    request_body_fingerprint: attempt.requestBodyFingerprint,
    outcome: attempt.outcome,
    resolved_addresses_fingerprint: attempt.resolvedAddressesFingerprint,
    connected_address: attempt.connectedAddress,
    http_status: attempt.httpStatus,
    response_bytes: attempt.responseBytes,
    response_fingerprint: attempt.responseFingerprint,
    ack_code: attempt.ackCode,
    error_code: attempt.errorCode,
    started_at: new Date(attempt.startedAt).toISOString(),
    finished_at: nullableIsoTime(attempt.finishedAt),
  };
}

function serializePublicCheckout(checkout: PublicCheckoutProjection) {
  return {
    merchant_order_no: checkout.merchantOrderNo,
    requested_amount_cents: checkout.requestedAmountCents,
    currency: checkout.currency,
    description: checkout.description,
    payment_instructions:
      checkout.paymentInstructions === null
        ? null
        : {
            payable_amount_cents: checkout.paymentInstructions.payableAmountCents,
            currency: checkout.paymentInstructions.currency,
            collection_code_payload: checkout.paymentInstructions.collectionCodePayload,
          },
    checkout: {
      status: checkout.checkout.status,
      expires_at: new Date(checkout.checkout.expiresAt).toISOString(),
      closed_at: nullableIsoTime(checkout.checkout.closedAt),
    },
    payment: {
      status: checkout.payment.status,
      basis: checkout.payment.basis,
      received_amount_cents: checkout.payment.receivedAmountCents,
    },
    refund: { status: checkout.refund.status },
  };
}

function serializeCandidate(candidate: MatchCandidate) {
  return {
    candidate_id: candidate.candidateId,
    ledger_entry_id: candidate.ledgerEntryId,
    order_id: candidate.orderId,
    slot_id: candidate.slotId,
    evidence_type: candidate.evidenceType,
    rule_version: candidate.ruleVersion,
    evidence: candidate.evidence,
    candidate_fingerprint: candidate.candidateFingerprint,
    status: candidate.status,
    decided_by_operation_id: candidate.decidedByOperationId,
    created_at: new Date(candidate.createdAt).toISOString(),
    updated_at: new Date(candidate.updatedAt).toISOString(),
    decided_at: nullableIsoTime(candidate.decidedAt),
  };
}

function serializePaymentMatch(match: PaymentMatch) {
  return {
    payment_match_id: match.paymentMatchId,
    ledger_entry_id: match.ledgerEntryId,
    order_id: match.orderId,
    candidate_id: match.candidateId,
    evidence_type: match.evidenceType,
    evidence: match.evidence,
    status: match.status,
    created_by_operation_id: match.createdByOperationId,
    resolved_by_operation_id: match.resolvedByOperationId,
    created_at: new Date(match.createdAt).toISOString(),
    updated_at: new Date(match.updatedAt).toISOString(),
    resolved_at: nullableIsoTime(match.resolvedAt),
  };
}

function serializePaymentMatchDetail(review: PaymentMatchDetail) {
  return {
    ...serializePaymentMatch(review.paymentMatch),
    candidate: review.candidate ? serializeCandidate(review.candidate) : null,
    ledger_entry: serializeReconciliationLedger(review.ledgerEntry),
    order: serializeReconciliationOrder(review.order),
  };
}

function serializeReconciliationLedger(entry: ReconciliationLedgerProjection) {
  return {
    ledger_entry_id: entry.ledgerEntryId,
    external_event_id: entry.externalEventId,
    semantic_fingerprint: entry.semanticFingerprint,
    occurred_at: new Date(entry.occurredAt).toISOString(),
    occurred_at_precision_milliseconds: entry.occurredAtPrecisionMilliseconds,
    occurred_at_interval_end_exclusive: new Date(
      entry.occurredAtIntervalEndExclusive,
    ).toISOString(),
    amount_cents: entry.amountCents,
    direction: entry.direction,
    currency: entry.currency,
    provider_order_no: entry.alipayOrderNo,
    merchant_order_no: entry.merchantOrderNo,
    memo: entry.transMemo,
    other_account: entry.otherAccount,
    state: entry.state,
    created_at: new Date(entry.createdAt).toISOString(),
    updated_at: new Date(entry.updatedAt).toISOString(),
  };
}

function serializeReconciliationOrder(order: ReconciliationOrderProjection) {
  return {
    order_id: order.orderId,
    merchant_order_no: order.merchantOrderNo,
    requested_amount_cents: order.requestedAmountCents,
    payable_amount_cents: order.payableAmountCents,
    received_amount_cents: order.receivedAmountCents,
    currency: order.currency,
    description: order.description,
    checkout_status: order.checkoutStatus,
    payment_status: order.paymentStatus,
    payment_basis: order.paymentBasis,
    refund_status: order.refundStatus,
    eligible_from: new Date(order.eligibleFrom).toISOString(),
    created_at: new Date(order.createdAt).toISOString(),
    expires_at: new Date(order.expiresAt).toISOString(),
    closed_at: nullableIsoTime(order.closedAt),
    updated_at: new Date(order.updatedAt).toISOString(),
    version: order.version,
  };
}

function serializeFinancialOperation(result: FinancialDecisionResult["operation"]) {
  return {
    financial_operation_id: result.financialOperationId,
    operation_type: result.operationType,
    actor_type: result.actorType,
    actor_id: result.actorId,
    order_id: result.orderId,
    ledger_entry_id: result.ledgerEntryId,
    reverses_operation_id: result.reversesOperationId,
    reason: result.reason,
    request_fingerprint: result.requestFingerprint,
    created_at: new Date(result.createdAt).toISOString(),
  };
}

function serializeLedgerConflict(conflict: LedgerConflict) {
  return {
    conflict_id: conflict.conflictId,
    provider_account_key: conflict.providerAccountKey,
    conflict_type: conflict.conflictType,
    raw_page_id: conflict.rawPageId,
    raw_event_id: conflict.rawEventId,
    existing_ledger_entry_id: conflict.existingLedgerEntryId,
    external_event_id: conflict.externalEventId,
    existing_semantic_fingerprint: conflict.existingSemanticFingerprint,
    incoming_semantic_fingerprint: conflict.incomingSemanticFingerprint,
    details: conflict.details,
    status: conflict.status,
    resolution: conflict.resolution,
    resolution_action: conflict.resolutionAction,
    resolution_operation_id: conflict.resolutionOperationId,
    resolution_fingerprint: conflict.resolutionFingerprint,
    conflict_fingerprint: conflict.conflictFingerprint,
    created_at: new Date(conflict.createdAt).toISOString(),
    resolved_at: nullableIsoTime(conflict.resolvedAt),
  };
}

function serializeLedgerConflictOperation(operation: LedgerConflictOperation) {
  return {
    conflict_operation_id: operation.conflictOperationId,
    operation_key: operation.operationKey,
    conflict_id: operation.conflictId,
    request_fingerprint: operation.requestFingerprint,
    action: operation.action,
    actor_type: operation.actorType,
    actor_id: operation.actorId,
    reason: operation.reason,
    created_at: new Date(operation.createdAt).toISOString(),
  };
}

function serializeLedgerConflictDetail(detail: LedgerConflictDetail) {
  return {
    conflict: serializeLedgerConflict(detail.conflict),
    raw_page: detail.rawPage === null
      ? null
      : {
          raw_page_id: detail.rawPage.rawPageId,
          ingest_run_id: detail.rawPage.ingestRunId,
          provider_account_key: detail.rawPage.providerAccountKey,
          window_start: detail.rawPage.windowStart,
          window_end: detail.rawPage.windowEnd,
          page_no: detail.rawPage.pageNo,
          page_size: detail.rawPage.pageSize,
          total_size: detail.rawPage.totalSize,
          has_more: detail.rawPage.hasMore,
          request_fingerprint: detail.rawPage.requestFingerprint,
          response_fingerprint: detail.rawPage.responseFingerprint,
          http_status: detail.rawPage.httpStatus,
          signature_verified: detail.rawPage.signatureVerified,
          trace_id: detail.rawPage.traceId,
          received_at: new Date(detail.rawPage.receivedAt).toISOString(),
        },
    incoming_event: detail.incomingEvent === null
      ? null
      : {
          raw_event_id: detail.incomingEvent.rawEventId,
          raw_page_id: detail.incomingEvent.rawPageId,
          provider_account_key: detail.incomingEvent.providerAccountKey,
          ordinal: detail.incomingEvent.ordinal,
          external_event_id: detail.incomingEvent.externalEventId,
          occurred_at_text: detail.incomingEvent.occurredAtText,
          amount_text: detail.incomingEvent.amountText,
          direction_text: detail.incomingEvent.directionText,
          alipay_order_no: detail.incomingEvent.alipayOrderNo,
          merchant_order_no: detail.incomingEvent.merchantOrderNo,
          trans_memo: detail.incomingEvent.transMemo,
          other_account: detail.incomingEvent.otherAccount,
          payload_fingerprint: detail.incomingEvent.payloadFingerprint,
          observed_at: new Date(detail.incomingEvent.observedAt).toISOString(),
        },
    existing_ledger_entry: detail.existingLedgerEntry === null
      ? null
      : serializeConflictLedgerEntry(detail.existingLedgerEntry),
    resolution_operation: detail.resolutionOperation === null
      ? null
      : serializeLedgerConflictOperation(detail.resolutionOperation),
  };
}

function serializeConflictLedgerEntry(entry: LedgerEntry) {
  return {
    ledger_entry_id: entry.ledgerEntryId,
    provider_account_key: entry.providerAccountKey,
    raw_event_id: entry.rawEventId,
    external_event_id: entry.externalEventId,
    semantic_fingerprint: entry.semanticFingerprint,
    occurred_at: new Date(entry.occurredAt).toISOString(),
    occurred_at_precision_milliseconds: entry.occurredAtPrecisionMilliseconds,
    amount_cents: entry.amountCents,
    direction: entry.direction,
    currency: entry.currency,
    alipay_order_no: entry.alipayOrderNo,
    merchant_order_no: entry.merchantOrderNo,
    trans_memo: entry.transMemo,
    other_account: entry.otherAccount,
    state: entry.state,
    created_at: new Date(entry.createdAt).toISOString(),
    updated_at: new Date(entry.updatedAt).toISOString(),
  };
}

function serializeFinancialDecision(result: FinancialDecisionResult) {
  return {
    operation: serializeFinancialOperation(result.operation),
    payment_match: serializePaymentMatch(result.paymentMatch),
    order_id: result.orderId,
    ledger_entry_id: result.ledgerEntryId,
    order_version: result.orderVersion,
    replayed: result.replayed,
  };
}

function serializeRefundDecision(result: RefundRecordResult) {
  return {
    operation: serializeFinancialOperation(result.operation),
    refund_record_id: result.refundRecordId,
    order_id: result.orderId,
    ledger_entry_id: result.ledgerEntryId,
    refund_status: result.refundStatus,
    order_version: result.orderVersion,
    replayed: result.replayed,
  };
}

function serializeFinancialException(exception: FinancialException) {
  return {
    exception_id: exception.exceptionId,
    provider_account_key: exception.providerAccountKey,
    exception_type: exception.exceptionType,
    ledger_entry_id: exception.ledgerEntryId,
    order_id: exception.orderId,
    candidate_id: exception.candidateId,
    context_key: exception.contextKey,
    details: exception.details,
    exception_fingerprint: exception.exceptionFingerprint,
    status: exception.status,
    resolution_operation_id: exception.resolutionOperationId,
    resolution: exception.resolution,
    created_at: new Date(exception.createdAt).toISOString(),
    resolved_at: nullableIsoTime(exception.resolvedAt),
  };
}

function nullableIsoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function serializeLedgerHealth(
  health: LedgerSchedulerHealth & { readonly enabled: boolean },
  freshness: CollectionFreshness,
) {
  return {
    enabled: health.enabled,
    state: health.state,
    in_flight: health.inFlight,
    last_attempt_at: health.lastAttemptAt,
    last_success_at: health.lastSuccessAt,
    last_error_code: health.lastErrorCode,
    consecutive_failures: health.consecutiveFailures,
    collection_ready: freshness.ready,
    last_success_age_milliseconds: freshness.lastSuccessAgeMilliseconds,
    maximum_success_age_milliseconds: freshness.maximumSuccessAgeMilliseconds,
  };
}

function serializeReconciliationHealth(
  health: ReconciliationSchedulerHealth & { readonly enabled: boolean },
  freshness: ConfirmationFreshness,
) {
  return {
    enabled: health.enabled,
    state: health.state,
    in_flight: health.inFlight,
    last_attempt_at: health.lastAttemptAt,
    last_success_at: health.lastSuccessAt,
    last_error_code: health.lastErrorCode,
    consecutive_failures: health.consecutiveFailures,
    pending_orders: health.pendingOrders,
    continuation_pending: health.continuationPending,
    confirmation_ready: freshness.ready,
    last_success_age_milliseconds: freshness.lastSuccessAgeMilliseconds,
    maximum_success_age_milliseconds: freshness.maximumSuccessAgeMilliseconds,
  };
}

function serializeWebhookHealth(health: WebhookSchedulerHealth) {
  return {
    enabled: health.enabled,
    state: health.state,
    in_flight: health.inFlight,
    last_attempt_at: health.lastAttemptAt,
    last_success_at: health.lastSuccessAt,
    last_error_code: health.lastErrorCode,
    consecutive_failures: health.consecutiveFailures,
    pending_deliveries: health.pendingDeliveries,
    dead_letters: health.deadLetters,
  };
}

function serializeLedgerConflictSummary(summary: LedgerConflictSummary | null) {
  if (summary === null) return null;
  return {
    provider_account_key: summary.providerAccountKey,
    open: summary.open,
    resolved: summary.resolved,
    ignored: summary.ignored,
    total: summary.total,
    by_type: summary.byType.map((item) => ({
      conflict_type: item.conflictType,
      open: item.open,
      resolved: item.resolved,
      ignored: item.ignored,
      total: item.total,
    })),
  };
}

function serializeFinancialExceptionSummary(summary: FinancialExceptionSummary | null) {
  if (summary === null) return null;
  return {
    provider_account_key: summary.providerAccountKey,
    open: summary.open,
    resolved: summary.resolved,
    total: summary.total,
  };
}

function errorResponse(
  context: Context<AppEnvironment>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
  code: string,
  message: string,
): Response {
  return context.json(
    {
      error: {
        code,
        message,
        request_id: context.get("requestId"),
      },
    },
    status,
  );
}

class HttpApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
