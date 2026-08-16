import { createHash, randomUUID } from "node:crypto";

import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import {
  AUTH_FAILURE_THRESHOLD,
  AUTH_WINDOW_MS,
  API_SIGNATURE_SKEW_MS,
  IdentityStore,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  STEP_UP_TTL_MS,
  type AdminSession,
} from "../database/identity-store.ts";
import {
  PasswordInputError,
  digestToken,
  hashPassword,
  issueCsrfToken,
  issueSessionToken,
  tokenMatchesDigest,
  verifyPassword,
} from "./crypto.ts";

const PASSWORD_WORK_QUEUE_LIMIT = 2;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const SOURCE_MAX_LENGTH = 256;

export type IdentityErrorCode =
  | "identity_not_initialized"
  | "invalid_credentials"
  | "auth_rate_limited"
  | "password_work_busy"
  | "session_invalid"
  | "csrf_invalid"
  | "step_up_required"
  | "api_client_invalid"
  | "api_nonce_replayed";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: IdentityErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface IdentityContext {
  readonly requestId?: string;
  readonly sourceAddress?: string;
}

export interface LoginResult {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly username: string;
  readonly createdAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface AuthenticatedSession {
  readonly session: AdminSession;
  readonly token: string;
}

export interface ApiClientAuthentication {
  readonly clientId: string;
  readonly keyVersion: number;
  readonly secretFingerprint: string;
}

export interface ApiAuditInput {
  readonly clientId: string;
  readonly action: string;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly requestId?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export class IdentityService {
  readonly #store: IdentityStore;
  readonly #config: AppConfig;
  readonly #clock: () => number;
  readonly #passwordGate = new PasswordWorkGate();

  constructor(database: AppDatabase, config: AppConfig, clock: () => number = Date.now) {
    this.#store = new IdentityStore(database);
    this.#config = config;
    this.#clock = clock;
  }

  get store(): IdentityStore {
    return this.#store;
  }

  /** Seeds the administrator exactly once before HTTP starts and syncs the configured API key fingerprint. */
  async initialize(): Promise<void> {
    const now = this.#clock();
    this.#store.read((transaction) => transaction.assertAuditChain());
    const existing = this.#store.read((transaction) => transaction.adminIdentity());
    if (!existing) {
      const initialPassword = this.#config.adminPassword;
      if (initialPassword === null) {
        throw new Error(
          "database has no administrator; PERPAY_INITIAL_ADMIN_PASSWORD is required for first initialization",
        );
      }
      const passwordHash = await hashPassword(initialPassword);
      this.#store.transaction((transaction) => {
        const inserted = transaction.initializeAdmin(this.#config.adminUsername, passwordHash, now);
        if (!inserted) return;
        transaction.appendAudit({
          occurredAt: now,
          actorType: "SYSTEM",
          action: "admin.initialized",
          outcome: "SUCCESS",
          subjectType: "admin_identity",
          subjectId: this.#config.adminUsername,
          details: { session_generation: 1 },
        });
      });
    } else if (existing.username !== this.#config.adminUsername) {
      throw new Error("configured administrator username does not match the initialized identity");
    }

    const fingerprint = fingerprintApiSecret(this.#config.apiSecret);
    this.#store.transaction((transaction) => {
      const before = transaction.activeApiClient(this.#config.apiClientId);
      const current = transaction.syncApiClient(this.#config.apiClientId, fingerprint, now);
      if (!before) {
        transaction.appendAudit({
          occurredAt: now,
          actorType: "SYSTEM",
          action: "api_client.initialized",
          outcome: "SUCCESS",
          subjectType: "api_client",
          subjectId: current.clientId,
          details: { key_version: current.keyVersion },
        });
      } else if (before.secretFingerprint !== current.secretFingerprint) {
        transaction.appendAudit({
          occurredAt: now,
          actorType: "SYSTEM",
          action: "api_client.rotated",
          outcome: "SUCCESS",
          subjectType: "api_client",
          subjectId: current.clientId,
          details: { key_version: current.keyVersion },
        });
      }
    });
  }

  async login(
    username: string,
    password: string,
    context: IdentityContext = {},
  ): Promise<LoginResult> {
    const now = this.#clock();
    const sourceHash = this.sourceHash(context.sourceAddress);
    this.#assertAuthAttemptAllowed(sourceHash, now);

    const identity = this.#store.read((transaction) => transaction.adminIdentity());
    if (!identity) throw new IdentityError("identity_not_initialized", "管理员身份尚未初始化");

    // A wrong username still performs the same password work to avoid a username oracle.
    let valid = await this.#verifyCredentialPassword(password, identity.passwordHash);
    valid = valid && username === identity.username;

    if (!valid) {
      const failureAt = this.#clock();
      this.#store.transaction((transaction) => {
        const next = transaction.recordAuthFailure(sourceHash, failureAt);
        transaction.appendAudit({
          occurredAt: failureAt,
          actorType: "ANONYMOUS",
          action: "admin.login",
          outcome: "FAILURE",
          subjectType: "admin_identity",
          requestId: context.requestId,
          remoteAddressHash: sourceHash,
          details: {
            reason: next.failureCount >= AUTH_FAILURE_THRESHOLD ? "throttled" : "invalid_credentials",
          },
        });
      });
      throw new IdentityError("invalid_credentials", "用户名或密码错误");
    }

    const sessionToken = issueSessionToken();
    const csrfToken = issueCsrfToken();
    const sessionId = randomUUID();
    const authenticatedAt = this.#clock();
    const idleExpiresAt = authenticatedAt + SESSION_IDLE_TTL_MS;
    const absoluteExpiresAt = authenticatedAt + SESSION_ABSOLUTE_TTL_MS;
    this.#store.transaction((transaction) => {
      const currentIdentity = transaction.adminIdentity();
      if (
        !currentIdentity ||
        currentIdentity.username !== identity.username ||
        currentIdentity.passwordHash !== identity.passwordHash ||
        currentIdentity.sessionGeneration !== identity.sessionGeneration
      ) {
        throw new IdentityError("invalid_credentials", "管理员凭据已发生变化，请重新登录");
      }
      transaction.pruneIdentityState(authenticatedAt);
      transaction.resetAuthLimit(sourceHash);
      transaction.createSession({
        sessionId,
        tokenDigest: sessionToken.digest,
        csrfDigest: csrfToken.digest,
        generation: identity.sessionGeneration,
        createdAt: authenticatedAt,
        idleExpiresAt,
        absoluteExpiresAt,
      });
      transaction.appendAudit({
        occurredAt: authenticatedAt,
        actorType: "ADMIN",
        actorId: identity.username,
        action: "admin.login",
        outcome: "SUCCESS",
        subjectType: "admin_session",
        subjectId: sessionId,
        requestId: context.requestId,
        remoteAddressHash: sourceHash,
        details: { generation: identity.sessionGeneration },
      });
    });

    return {
      sessionToken: sessionToken.token,
      csrfToken: csrfToken.token,
      username: identity.username,
      createdAt: authenticatedAt,
      idleExpiresAt,
      absoluteExpiresAt,
    };
  }

  authenticate(token: string): AuthenticatedSession | undefined {
    let sessionDigest: string;
    try {
      sessionDigest = digestSessionToken(token);
    } catch {
      return undefined;
    }
    const now = this.#clock();
    let session = this.#store.read((transaction) => transaction.activeSession(sessionDigest, now));
    if (!session) return undefined;

    if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      this.#store.transaction((transaction) => {
        const current = transaction.activeSession(sessionDigest, now);
        if (!current) return;
        transaction.touchSession(current.sessionId, now);
      });
      session = this.#store.read((transaction) => transaction.activeSession(sessionDigest, now));
      if (!session) return undefined;
    }
    return { session, token };
  }

  verifyCsrf(session: AuthenticatedSession, csrfToken: string | undefined): boolean {
    if (csrfToken === undefined) return false;
    const current = this.#currentSession(session, this.#clock());
    return current !== undefined && tokenMatchesDigest(csrfToken, current.csrfDigest);
  }

  async stepUp(
    session: AuthenticatedSession,
    password: string,
    context: IdentityContext = {},
  ): Promise<number> {
    const now = this.#clock();
    const sourceHash = this.sourceHash(context.sourceAddress);
    this.#assertAuthAttemptAllowed(sourceHash, now);
    const sessionBeforeWork = this.#store.read((transaction) =>
      transaction.activeSession(session.session.tokenDigest, now),
    );
    if (!sessionBeforeWork || sessionBeforeWork.sessionId !== session.session.sessionId) {
      throw new IdentityError("session_invalid", "会话已失效");
    }
    const identity = this.#store.read((transaction) => transaction.adminIdentity());
    if (!identity) throw new IdentityError("identity_not_initialized", "管理员身份尚未初始化");
    const valid = await this.#verifyCredentialPassword(password, identity.passwordHash);
    if (!valid) {
      const failureAt = this.#clock();
      this.#store.transaction((transaction) => {
        const current = transaction.activeSession(session.session.tokenDigest, failureAt);
        if (!current || current.sessionId !== session.session.sessionId) {
          throw new IdentityError("session_invalid", "会话已失效");
        }
        const next = transaction.recordAuthFailure(sourceHash, failureAt);
        transaction.appendAudit({
          occurredAt: failureAt,
          actorType: "ADMIN",
          actorId: current.username,
          action: "admin.step_up",
          outcome: "FAILURE",
          subjectType: "admin_session",
          subjectId: current.sessionId,
          requestId: context.requestId,
          remoteAddressHash: sourceHash,
          details: {
            reason: next.failureCount >= AUTH_FAILURE_THRESHOLD ? "throttled" : "invalid_password",
          },
        });
      });
      throw new IdentityError("invalid_credentials", "密码错误");
    }

    const verifiedAt = this.#clock();
    const expiresAt = Math.min(verifiedAt + STEP_UP_TTL_MS, sessionBeforeWork.absoluteExpiresAt);
    this.#store.transaction((transaction) => {
      const current = transaction.activeSession(session.session.tokenDigest, verifiedAt);
      const currentIdentity = transaction.adminIdentity();
      if (
        !current ||
        current.sessionId !== session.session.sessionId ||
        !currentIdentity ||
        currentIdentity.passwordHash !== identity.passwordHash ||
        currentIdentity.sessionGeneration !== identity.sessionGeneration
      ) {
        throw new IdentityError("session_invalid", "会话或管理员凭据已发生变化");
      }
      if (!transaction.setStepUp(current.sessionId, expiresAt, verifiedAt)) {
        throw new IdentityError("session_invalid", "会话已失效");
      }
      transaction.resetAuthLimit(sourceHash);
      transaction.appendAudit({
        occurredAt: verifiedAt,
        actorType: "ADMIN",
        actorId: current.username,
        action: "admin.step_up",
        outcome: "SUCCESS",
        subjectType: "admin_session",
        subjectId: current.sessionId,
        requestId: context.requestId,
        remoteAddressHash: sourceHash,
        details: { expires_at: expiresAt },
      });
    });
    return expiresAt;
  }

  logout(session: AuthenticatedSession, context: IdentityContext = {}): void {
    const now = this.#clock();
    this.#store.transaction((transaction) => {
      const revoked = transaction.revokeSession(session.session.sessionId, "logout", now);
      if (revoked) {
        transaction.appendAudit({
          occurredAt: now,
          actorType: "ADMIN",
          actorId: session.session.username,
          action: "admin.logout",
          outcome: "SUCCESS",
          subjectType: "admin_session",
          subjectId: session.session.sessionId,
          requestId: context.requestId,
        });
      }
    });
  }

  revokeAllSessions(session: AuthenticatedSession, context: IdentityContext = {}): number {
    const now = this.#clock();
    return this.#store.transaction((transaction) => {
      const count = transaction.revokeAllSessions({
        reason: "admin_requested",
        now,
        sessionId: session.session.sessionId,
        tokenDigest: session.session.tokenDigest,
      });
      if (count === undefined) {
        throw new IdentityError("step_up_required", "此操作需要有效会话和近期密码验证");
      }
      transaction.appendAudit({
        occurredAt: now,
        actorType: "ADMIN",
        actorId: session.session.username,
        action: "admin.sessions_revoke_all",
        outcome: "SUCCESS",
        subjectType: "admin_sessions",
        requestId: context.requestId,
        details: { revoked_count: count },
      });
      return count;
    });
  }

  async changePassword(
    session: AuthenticatedSession,
    currentPassword: string,
    nextPassword: string,
    context: IdentityContext = {},
  ): Promise<void> {
    const now = this.#clock();
    const sourceHash = this.sourceHash(context.sourceAddress);
    this.#assertAuthAttemptAllowed(sourceHash, now);
    const sessionBeforeWork = this.#store.read((transaction) =>
      transaction.activeSession(session.session.tokenDigest, now),
    );
    if (
      !sessionBeforeWork ||
      sessionBeforeWork.sessionId !== session.session.sessionId ||
      sessionBeforeWork.stepUpExpiresAt === null ||
      sessionBeforeWork.stepUpExpiresAt <= now
    ) {
      throw new IdentityError("step_up_required", "此操作需要有效会话和近期密码验证");
    }
    const identity = this.#store.read((transaction) => transaction.adminIdentity());
    if (!identity) throw new IdentityError("identity_not_initialized", "管理员身份尚未初始化");
    const valid = await this.#verifyCredentialPassword(currentPassword, identity.passwordHash);
    if (!valid) {
      const failureAt = this.#clock();
      this.#store.transaction((transaction) => {
        const current = transaction.activeSession(session.session.tokenDigest, failureAt);
        if (!current || current.sessionId !== session.session.sessionId) {
          throw new IdentityError("session_invalid", "会话已失效");
        }
        const next = transaction.recordAuthFailure(sourceHash, failureAt);
        transaction.appendAudit({
          occurredAt: failureAt,
          actorType: "ADMIN",
          actorId: current.username,
          action: "admin.password_change",
          outcome: "FAILURE",
          subjectType: "admin_identity",
          requestId: context.requestId,
          remoteAddressHash: sourceHash,
          details: {
            reason: next.failureCount >= AUTH_FAILURE_THRESHOLD ? "throttled" : "invalid_password",
          },
        });
      });
      throw new IdentityError("invalid_credentials", "当前密码错误");
    }
    const nextHash = await this.#runPasswordWork(() => hashPassword(nextPassword));
    const changedAt = this.#clock();
    this.#store.transaction((transaction) => {
      const generation = transaction.updatePassword({
        passwordHash: nextHash,
        expectedPasswordHash: identity.passwordHash,
        expectedGeneration: identity.sessionGeneration,
        sessionId: session.session.sessionId,
        tokenDigest: session.session.tokenDigest,
        now: changedAt,
      });
      if (generation === undefined) {
        throw new IdentityError(
          "step_up_required",
          "会话、密码或近期验证状态已发生变化，请重新验证",
        );
      }
      transaction.resetAuthLimit(sourceHash);
      transaction.appendAudit({
        occurredAt: changedAt,
        actorType: "ADMIN",
        actorId: identity.username,
        action: "admin.password_changed",
        outcome: "SUCCESS",
        subjectType: "admin_identity",
        requestId: context.requestId,
        remoteAddressHash: sourceHash,
        details: { session_generation: generation },
      });
    });
  }

  apiClient(clientId: string): ApiClientAuthentication | undefined {
    const configured = this.#store.read((transaction) => transaction.activeApiClient(clientId));
    if (!configured || !configured.enabled || clientId !== this.#config.apiClientId) return undefined;
    const expected = fingerprintApiSecret(this.#config.apiSecret);
    if (configured.secretFingerprint !== expected) return undefined;
    return {
      clientId: configured.clientId,
      keyVersion: configured.keyVersion,
      secretFingerprint: configured.secretFingerprint,
    };
  }

  consumeApiNonce(
    clientId: string,
    nonce: string,
    timestampSeconds: number,
    verifiedAt = this.#clock(),
  ): boolean {
    return this.#store.transaction((transaction) =>
      transaction.consumeApiNonce(clientId, nonce, timestampSeconds, verifiedAt),
    );
  }

  auditApi(input: ApiAuditInput): void {
    const now = this.#clock();
    this.#store.transaction((transaction) => {
      transaction.appendAudit({
        occurredAt: now,
        actorType: "API_CLIENT",
        actorId: input.clientId,
        action: input.action,
        outcome: input.outcome,
        subjectType: "api_client",
        subjectId: input.clientId,
        requestId: input.requestId,
        details: input.details,
      });
    });
  }

  isStepUp(session: AuthenticatedSession, now = this.#clock()): boolean {
    const current = this.#currentSession(session, now);
    return current !== undefined &&
      current.stepUpExpiresAt !== null &&
      current.stepUpExpiresAt > now;
  }

  sourceHash(sourceAddress: string | undefined): string {
    const normalized = normalizeSource(sourceAddress);
    return createHash("sha256")
      .update(this.#store.instanceSalt(), "utf8")
      .update("\0", "ascii")
      .update(normalized, "utf8")
      .digest("hex");
  }

  #assertAuthAttemptAllowed(sourceHash: string, now: number): void {
    const limit = this.#store.read((transaction) => transaction.authLimit(sourceHash));
    if (limit && limit.blockedUntil > now) {
      throw new IdentityError(
        "auth_rate_limited",
        "密码验证请求过于频繁，请稍后重试",
        Math.max(1, Math.ceil((limit.blockedUntil - now) / 1000)),
      );
    }
  }

  #currentSession(session: AuthenticatedSession, now: number): AdminSession | undefined {
    let tokenDigest: string;
    try {
      tokenDigest = digestSessionToken(session.token);
    } catch {
      return undefined;
    }
    if (tokenDigest !== session.session.tokenDigest) return undefined;

    const current = this.#store.read((transaction) =>
      transaction.activeSession(tokenDigest, now),
    );
    return current?.sessionId === session.session.sessionId ? current : undefined;
  }

  async #verifyCredentialPassword(password: string, encodedHash: string): Promise<boolean> {
    try {
      return await this.#runPasswordWork(() => verifyPassword(password, encodedHash));
    } catch (error) {
      if (error instanceof PasswordInputError) return false;
      throw error;
    }
  }

  async #runPasswordWork<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.#passwordGate.run(operation);
    } catch (error) {
      if (error instanceof PasswordWorkBusyError) {
        throw new IdentityError("password_work_busy", "密码验证服务当前繁忙，请稍后重试", 1);
      }
      throw error;
    }
  }
}

export function fingerprintApiSecret(secret: string): string {
  return createHash("sha256")
    .update("perpay-api-secret-v1\0", "utf8")
    .update(Buffer.from(secret, "base64url"))
    .digest("hex");
}

function digestSessionToken(token: string): string {
  return digestToken(token);
}

function normalizeSource(sourceAddress: string | undefined): string {
  if (typeof sourceAddress !== "string" || sourceAddress.length === 0) return "unknown";
  const normalized = sourceAddress.trim();
  if (normalized.length === 0) return "unknown";
  return normalized.slice(0, SOURCE_MAX_LENGTH);
}

class PasswordWorkBusyError extends Error {
  constructor() {
    super("password verification capacity is full");
  }
}

class PasswordWorkGate {
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queued >= PASSWORD_WORK_QUEUE_LIMIT) throw new PasswordWorkBusyError();
    this.#queued += 1;
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.#queued -= 1;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const IDENTITY_LIMITS = Object.freeze({
  sessionIdleMs: SESSION_IDLE_TTL_MS,
  sessionAbsoluteMs: SESSION_ABSOLUTE_TTL_MS,
  stepUpMs: STEP_UP_TTL_MS,
  authWindowMs: AUTH_WINDOW_MS,
  apiSignatureSkewMs: API_SIGNATURE_SKEW_MS,
});
