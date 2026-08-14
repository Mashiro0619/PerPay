import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";

import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import { IdentityError, IdentityService, type AuthenticatedSession } from "../identity/service.ts";
import { verifyApiRequestSignature, type ApiRequestAuthentication } from "../security/api-signature.ts";
import { APP_VERSION } from "../version.ts";

const SESSION_COOKIE = "perpay_session";
const SECURE_SESSION_COOKIE = "__Host-perpay_session";
const CSRF_COOKIE = "perpay_csrf";
const SECURE_CSRF_COOKIE = "__Host-perpay_csrf";
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const API_MAX_BODY_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;

type AppEnvironment = {
  Bindings: Partial<HttpBindings>;
  Variables: {
    requestId: string;
    adminSession: AuthenticatedSession;
    apiRawBody: Buffer;
  };
};

const passwordValueSchema = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES,
  { message: `must contain at most ${MAX_PASSWORD_BYTES} UTF-8 bytes` },
);
const newPasswordValueSchema = z.string().min(12).refine(
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

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: AppDatabase;
  readonly identity: IdentityService;
  readonly startedAt: Date;
}

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
    const ready = database.ok;
    return context.json(
      {
        status: ready ? "ready" : "not_ready",
        checks: { database },
      },
      ready ? 200 : 503,
    );
  });

  app.post("/api/admin/v1/session/login", async (context) => {
    requireJsonContentType(context);
    requireSameOrigin(context, dependencies.config.publicOrigin);
    const body = await readJson(context, loginSchema, MAX_JSON_BODY_BYTES);
    const result = await dependencies.identity.login(body.username, body.password, identityContext(context));
    setAuthenticationCookies(
      context,
      result.sessionToken,
      result.csrfToken,
      dependencies.config.secureCookies,
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

  app.post("/api/admin/v1/session/logout", adminSession, (context) => {
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    dependencies.identity.logout(context.get("adminSession"), identityContext(context));
    clearAuthenticationCookies(context, dependencies.config.secureCookies);
    return context.body(null, 204);
  });

  app.post("/api/admin/v1/session/step-up", adminSession, async (context) => {
    requireJsonContentType(context);
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    const body = await readJson(context, passwordSchema, MAX_JSON_BODY_BYTES);
    const expiresAt = await dependencies.identity.stepUp(
      context.get("adminSession"),
      body.password,
      identityContext(context),
    );
    return context.json({ data: { step_up_expires_at: new Date(expiresAt).toISOString() } });
  });

  app.post("/api/admin/v1/sessions/revoke-all", adminSession, (context) => {
    requireSameOrigin(context, dependencies.config.publicOrigin);
    requireCsrf(context, dependencies.identity, dependencies.config.secureCookies);
    const revoked = dependencies.identity.revokeAllSessions(
      context.get("adminSession"),
      identityContext(context),
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
      identityContext(context),
    );
    clearAuthenticationCookies(context, dependencies.config.secureCookies);
    return context.body(null, 204);
  });

  app.get("/api/v1/system/status", requireApiClient(dependencies), (context) =>
    context.json({
      data: {
        status: "ready",
        version: APP_VERSION,
        instance_id: dependencies.database.instanceId(),
      },
    }),
  );

  app.notFound((context) =>
    errorResponse(context, 404, "route_not_found", "请求的资源不存在"),
  );

  app.onError((error, context) => {
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

function requireApiClient(dependencies: AppDependencies): MiddlewareHandler<AppEnvironment> {
  const failureAuditLimiter = new ApiFailureAuditLimiter();
  return async (context, next) => {
    const authentication = readApiAuthentication(context);
    const client = dependencies.identity.apiClient(authentication.clientId);
    if (!client) throw new HttpApiError(401, "api_authentication_failed", "API 认证失败");
    const body = await readBodyLimited(context, API_MAX_BODY_BYTES);
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
  if (!isUtf8(bytes)) {
    throw new HttpApiError(400, "invalid_json", "请求体不是有效 UTF-8 JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
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
): void {
  setCookie(context, sessionCookieName(secure), sessionToken, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Strict",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    priority: "High",
  });
  setCookie(context, csrfCookieName(secure), csrfToken, {
    path: "/",
    httpOnly: false,
    secure,
    sameSite: "Strict",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
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

function identityContext(context: Context<AppEnvironment>): {
  readonly requestId: string;
  readonly sourceAddress: string;
} {
  return {
    requestId: context.get("requestId"),
    sourceAddress: remoteAddress(context),
  };
}

function remoteAddress(context: Context<AppEnvironment>): string {
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
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
    case "api_nonce_replayed":
      return 409;
    case "auth_rate_limited":
      return 429;
    case "identity_not_initialized":
    case "password_work_busy":
      return 503;
  }
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
  readonly status: 400 | 401 | 403 | 409 | 413 | 415 | 422 | 429 | 503;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: 400 | 401 | 403 | 409 | 413 | 415 | 422 | 429 | 503,
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
