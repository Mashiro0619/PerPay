import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "../database/database.ts";
import {
  ADMIN_USERNAME,
  AUTH_FAILURE_THRESHOLD,
  AUTH_WINDOW_MS,
  API_SIGNATURE_SKEW_MS,
  IdentityStore,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  type AdminSession,
  type AuthLimit,
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
const PASSWORD_WORK_TOTAL_LIMIT = PASSWORD_WORK_QUEUE_LIMIT + 1;
const PASSWORD_WORK_ANONYMOUS_LIMIT = 1;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const SOURCE_MAX_LENGTH = 256;

export type IdentityErrorCode =
  | "identity_not_initialized"
  | "identity_already_initialized"
  | "invalid_credentials"
  | "auth_rate_limited"
  | "password_work_busy"
  | "session_invalid"
  | "csrf_invalid"
  | "password_unchanged"
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

export interface SetupAdminResult {
  readonly username: typeof ADMIN_USERNAME;
  readonly initializedAt: number;
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
  readonly #clock: () => number;
  readonly #passwordGate = new PasswordWorkGate();

  constructor(
    database: AppDatabase,
    clockOrLegacyConfig: (() => number) | unknown = Date.now,
    legacyClock?: (() => number) | undefined,
  ) {
    this.#store = new IdentityStore(database);
    this.#clock = typeof clockOrLegacyConfig === "function"
      ? clockOrLegacyConfig as () => number
      : legacyClock ?? Date.now;
  }

  get store(): IdentityStore {
    return this.#store;
  }

  /** Verifies persisted identity state without requiring first-run setup to be complete. */
  async initialize(): Promise<void> {
    this.#store.read((transaction) => transaction.assertAuditChain());
    const existing = this.#store.read((transaction) => transaction.adminIdentity());
    if (existing && existing.username !== ADMIN_USERNAME) {
      throw new Error("initialized administrator username is invalid");
    }
  }

  isInitialized(): boolean {
    return this.#store.read((transaction) => transaction.adminIdentity() !== undefined);
  }

  async setupAdmin(
    password: string,
    context: IdentityContext = {},
  ): Promise<SetupAdminResult> {
    if (this.isInitialized()) throw identityAlreadyInitialized();
    if (typeof password !== "string" || Array.from(password).length < 12) {
      throw new PasswordInputError("Password must contain at least 12 Unicode characters.");
    }

    const sourceHash = this.sourceHash(context.sourceAddress);
    const attemptedAt = this.#clock();
    const setupAttempt = this.#recordSetupAttempt(sourceHash, attemptedAt);
    try {
      // Another process may have completed setup after the initial fast-path
      // check. Preserve this request's persisted attempt, but avoid needless
      // password work once an administrator now exists.
      if (this.isInitialized()) throw identityAlreadyInitialized();

      const passwordHash = await this.#runPasswordWork(
        "anonymous",
        () => hashPassword(password),
      );
      const initializedAt = this.#clock();
      this.#store.transaction((transaction) => {
        if (!transaction.initializeAdmin(passwordHash, initializedAt)) {
          throw identityAlreadyInitialized();
        }
        transaction.resetAuthLimitThrough(sourceHash, setupAttempt, initializedAt);
        transaction.appendAudit({
          occurredAt: initializedAt,
          actorType: "ANONYMOUS",
          action: "admin.initialized",
          outcome: "SUCCESS",
          subjectType: "admin_identity",
          subjectId: ADMIN_USERNAME,
          requestId: context.requestId,
          remoteAddressHash: sourceHash,
          details: { session_generation: 1 },
        });
      });
      return { username: ADMIN_USERNAME, initializedAt };
    } catch (error) {
      // The attempt was committed before hashing. A successful competing
      // setup from the same source can clear that row while this request is
      // still running, so restore one persisted attempt for the loser without
      // double-counting ordinary hash or transaction failures.
      try {
        this.#retainSetupAttempt(sourceHash, this.#clock());
      } catch {
        // Preserve the setup failure. The original attempt normally remains;
        // this fallback is only needed when a competing success cleared it.
      }
      throw error;
    }
  }

  async login(
    password: string,
    context: IdentityContext = {},
  ): Promise<LoginResult> {
    const now = this.#clock();
    const sourceHash = this.sourceHash(context.sourceAddress);
    this.#assertAuthAttemptAllowed(sourceHash, now);

    const identity = this.#store.read((transaction) => transaction.adminIdentity());
    if (!identity) throw new IdentityError("identity_not_initialized", "管理员身份尚未初始化");

    const valid = await this.#verifyCredentialPassword(
      password,
      identity.passwordHash,
      "anonymous",
    );

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
        throw new IdentityError("session_invalid", "会话不存在或已过期");
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
    nextPassword: string,
    context: IdentityContext = {},
  ): Promise<void> {
    const now = this.#clock();
    const sourceHash = this.sourceHash(context.sourceAddress);
    const sessionBeforeWork = this.#store.read((transaction) =>
      transaction.activeSession(session.session.tokenDigest, now),
    );
    if (!sessionBeforeWork || sessionBeforeWork.sessionId !== session.session.sessionId) {
      throw new IdentityError("session_invalid", "会话不存在或已过期");
    }
    const identity = this.#store.read((transaction) => transaction.adminIdentity());
    if (!identity) throw new IdentityError("identity_not_initialized", "管理员身份尚未初始化");
    const unchanged = await this.#verifyCredentialPassword(
      nextPassword,
      identity.passwordHash,
      "authenticated",
    );
    if (unchanged) {
      throw new IdentityError("password_unchanged", "新密码不能与当前密码相同");
    }
    const nextHash = await this.#runPasswordWork(
      "authenticated",
      () => hashPassword(nextPassword),
    );
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
        throw new IdentityError("session_invalid", "会话或管理员凭据已发生变化");
      }
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
    if (!configured || !configured.enabled) return undefined;
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
    expectedKeyVersion: number,
    expectedSecretFingerprint: string,
    verifiedAt = this.#clock(),
  ): boolean {
    return this.#store.transaction((transaction) =>
      transaction.consumeApiNonce(
        clientId,
        nonce,
        timestampSeconds,
        expectedKeyVersion,
        expectedSecretFingerprint,
        verifiedAt,
      ),
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
    this.#assertAuthLimitAllowed(limit, now);
  }

  #recordSetupAttempt(sourceHash: string, now: number): AuthLimit {
    return this.#store.transaction((transaction) => {
      this.#assertAuthLimitAllowed(transaction.authLimit(sourceHash), now);
      return transaction.recordAuthFailure(sourceHash, now);
    });
  }

  #retainSetupAttempt(sourceHash: string, now: number): void {
    this.#store.transaction((transaction) => {
      if (transaction.authLimit(sourceHash) === undefined) {
        transaction.recordAuthFailure(sourceHash, now);
      }
    });
  }

  #assertAuthLimitAllowed(
    limit: { readonly blockedUntil: number } | undefined,
    now: number,
  ): void {
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

  async #verifyCredentialPassword(
    password: string,
    encodedHash: string,
    lane: PasswordWorkLane,
  ): Promise<boolean> {
    try {
      return await this.#runPasswordWork(lane, () => verifyPassword(password, encodedHash));
    } catch (error) {
      if (error instanceof PasswordInputError) return false;
      throw error;
    }
  }

  async #runPasswordWork<T>(lane: PasswordWorkLane, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.#passwordGate.run(lane, operation);
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

function identityAlreadyInitialized(): IdentityError {
  return new IdentityError(
    "identity_already_initialized",
    "administrator setup has already been completed",
  );
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

type PasswordWorkLane = "anonymous" | "authenticated";

class PasswordWorkGate {
  #tail: Promise<void> = Promise.resolve();
  #outstanding = 0;
  #anonymousOutstanding = 0;

  async run<T>(lane: PasswordWorkLane, operation: () => Promise<T>): Promise<T> {
    if (
      this.#outstanding >= PASSWORD_WORK_TOTAL_LIMIT ||
      (lane === "anonymous" && this.#anonymousOutstanding >= PASSWORD_WORK_ANONYMOUS_LIMIT)
    ) {
      throw new PasswordWorkBusyError();
    }
    this.#outstanding += 1;
    if (lane === "anonymous") this.#anonymousOutstanding += 1;
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      this.#outstanding -= 1;
      if (lane === "anonymous") this.#anonymousOutstanding -= 1;
      release();
    }
  }
}

export const IDENTITY_LIMITS = Object.freeze({
  sessionIdleMs: SESSION_IDLE_TTL_MS,
  sessionAbsoluteMs: SESSION_ABSOLUTE_TTL_MS,
  authWindowMs: AUTH_WINDOW_MS,
  apiSignatureSkewMs: API_SIGNATURE_SKEW_MS,
});
