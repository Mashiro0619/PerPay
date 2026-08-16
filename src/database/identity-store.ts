import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "./database.ts";
import {
  assertAuditChainIntegrity,
  calculateAuditEventHash,
} from "./audit-chain.ts";

const MAX_AUDIT_DETAILS_BYTES = 8 * 1024;

export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const STEP_UP_TTL_MS = 10 * 60 * 1000;
export const AUTH_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_FAILURE_THRESHOLD = 5;
export const API_SIGNATURE_SKEW_MS = 5 * 60 * 1000;
const SESSION_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type DatabaseOwner = Pick<AppDatabase, "read" | "write" | "instanceId">;

export interface AdminIdentity {
  readonly username: string;
  readonly passwordHash: string;
  readonly sessionGeneration: number;
}

export interface AdminSession {
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly csrfDigest: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly stepUpExpiresAt: number | null;
  readonly username: string;
}

export interface ApiClientKey {
  readonly clientId: string;
  readonly keyVersion: number;
  readonly secretFingerprint: string;
  readonly enabled: boolean;
}

export interface AuthLimit {
  readonly failureCount: number;
  readonly blockedUntil: number;
  readonly windowStartedAt: number;
}

export interface AuditInput {
  readonly occurredAt: number;
  readonly actorType: "SYSTEM" | "ANONYMOUS" | "ADMIN" | "API_CLIENT";
  readonly actorId?: string | undefined;
  readonly action: string;
  readonly outcome: "SUCCESS" | "FAILURE";
  readonly subjectType?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly remoteAddressHash?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventHash: string;
  readonly previousHash: string | null;
}

export class IdentityStore {
  readonly #database: DatabaseOwner;

  constructor(database: DatabaseOwner) {
    this.#database = database;
  }

  read<T>(operation: (transaction: IdentityReadTransaction) => T): T {
    return this.#database.read((connection) => operation(new IdentityReadTransaction(connection)));
  }

  transaction<T>(operation: (transaction: IdentityTransaction) => T): T {
    return this.#database.write((connection) => operation(new IdentityTransaction(connection)));
  }

  instanceSalt(): string {
    return this.#database.instanceId();
  }
}

export class IdentityReadTransaction {
  protected readonly connection: DatabaseSync;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  adminIdentity(): AdminIdentity | undefined {
    const row = this.connection
      .prepare(
        "SELECT username, password_hash, session_generation FROM admin_identity WHERE singleton_key = 1",
      )
      .get() as
      | { username: string; password_hash: string; session_generation: bigint | number }
      | undefined;
    if (!row) return undefined;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      sessionGeneration: Number(row.session_generation),
    };
  }

  activeSession(tokenDigest: string, now: number): AdminSession | undefined {
    const row = this.connection
      .prepare(
        `SELECT s.session_id, s.token_digest, s.csrf_digest, s.generation,
                s.created_at, s.last_seen_at, s.idle_expires_at,
                s.absolute_expires_at, s.step_up_expires_at, a.username
           FROM admin_sessions AS s
           JOIN admin_identity AS a ON a.singleton_key = 1
          WHERE s.token_digest = ?
            AND s.revoked_at IS NULL
            AND s.generation = a.session_generation
            AND s.idle_expires_at > ?
            AND s.absolute_expires_at > ?`,
      )
      .get(tokenDigest, now, now) as
      | {
          session_id: string;
          token_digest: string;
          csrf_digest: string;
          generation: bigint | number;
          created_at: bigint | number;
          last_seen_at: bigint | number;
          idle_expires_at: bigint | number;
          absolute_expires_at: bigint | number;
          step_up_expires_at: bigint | number | null;
          username: string;
        }
      | undefined;
    return row ? mapSession(row) : undefined;
  }

  activeApiClient(clientId: string): ApiClientKey | undefined {
    const row = this.connection
      .prepare(
        `SELECT client_id, enabled, key_version, secret_fingerprint
           FROM api_client_config
          WHERE singleton_key = 1 AND client_id = ?`,
      )
      .get(clientId) as
      | {
          client_id: string;
          enabled: number | bigint;
          key_version: number | bigint;
          secret_fingerprint: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      keyVersion: Number(row.key_version),
      secretFingerprint: row.secret_fingerprint,
      enabled: Number(row.enabled) === 1,
    };
  }

  authLimit(sourceHash: string): AuthLimit | undefined {
    const row = this.connection
      .prepare(
        "SELECT failure_count, blocked_until, window_started_at FROM admin_auth_limits WHERE source_hash = ?",
      )
      .get(sourceHash) as
      | { failure_count: number | bigint; blocked_until: number | bigint; window_started_at: number | bigint }
      | undefined;
    if (!row) return undefined;
    return {
      failureCount: Number(row.failure_count),
      blockedUntil: Number(row.blocked_until),
      windowStartedAt: Number(row.window_started_at),
    };
  }

  auditEvents(): readonly AuditEvent[] {
    const rows = this.connection
      .prepare("SELECT sequence, event_id, event_hash, previous_hash FROM audit_events ORDER BY sequence")
      .all() as Array<{
      sequence: number | bigint;
      event_id: string;
      event_hash: string;
      previous_hash: string | null;
    }>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      eventId: row.event_id,
      eventHash: row.event_hash,
      previousHash: row.previous_hash,
    }));
  }

  assertAuditChain(): void {
    assertAuditChainIntegrity(this.connection);
  }
}

export class IdentityTransaction extends IdentityReadTransaction {
  initializeAdmin(username: string, passwordHash: string, now: number): boolean {
    const existing = this.adminIdentity();
    if (existing) {
      if (existing.username !== username) {
        throw new Error("configured administrator username does not match the initialized identity");
      }
      return false;
    }

    this.connection
      .prepare(
        `INSERT INTO admin_identity(
           singleton_key, username, password_hash, session_generation,
           password_changed_at, created_at, updated_at
         ) VALUES (1, ?, ?, 1, ?, ?, ?)`,
      )
      .run(username, passwordHash, now, now, now);
    return true;
  }

  updatePassword(input: {
    readonly passwordHash: string;
    readonly expectedPasswordHash: string;
    readonly expectedGeneration: number;
    readonly sessionId: string;
    readonly tokenDigest: string;
    readonly now: number;
  }): number | undefined {
    const row = this.connection
      .prepare("SELECT password_hash, session_generation FROM admin_identity WHERE singleton_key = 1")
      .get() as { password_hash: string; session_generation: number | bigint } | undefined;
    if (!row) throw new Error("administrator identity has not been initialized");
    if (
      row.password_hash !== input.expectedPasswordHash ||
      Number(row.session_generation) !== input.expectedGeneration
    ) {
      return undefined;
    }
    const current = this.activeSession(input.tokenDigest, input.now);
    if (
      !current ||
      current.sessionId !== input.sessionId ||
      current.generation !== input.expectedGeneration ||
      current.stepUpExpiresAt === null ||
      current.stepUpExpiresAt <= input.now
    ) {
      return undefined;
    }
    const nextGeneration = Number(row.session_generation) + 1;
    const updated = this.connection
      .prepare(
        `UPDATE admin_identity
            SET password_hash = ?, session_generation = ?,
                password_changed_at = ?, updated_at = ?
          WHERE singleton_key = 1`,
      )
      .run(input.passwordHash, nextGeneration, input.now, input.now);
    if (Number(updated.changes) !== 1) throw new Error("administrator password was not updated");
    this.connection
      .prepare(
        `UPDATE admin_sessions
            SET revoked_at = ?, revoke_reason = 'password_changed'
          WHERE revoked_at IS NULL`,
      )
      .run(input.now);
    return nextGeneration;
  }

  createSession(input: {
    readonly sessionId: string;
    readonly tokenDigest: string;
    readonly csrfDigest: string;
    readonly generation: number;
    readonly createdAt: number;
    readonly idleExpiresAt: number;
    readonly absoluteExpiresAt: number;
    readonly stepUpExpiresAt?: number | null;
  }): void {
    this.connection
      .prepare(
        `INSERT INTO admin_sessions(
           session_id, token_digest, csrf_digest, generation, created_at,
           last_seen_at, idle_expires_at, absolute_expires_at, step_up_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.tokenDigest,
        input.csrfDigest,
        input.generation,
        input.createdAt,
        input.createdAt,
        input.idleExpiresAt,
        input.absoluteExpiresAt,
        input.stepUpExpiresAt ?? null,
      );
  }

  touchSession(sessionId: string, now: number): void {
    this.connection
      .prepare(
        `UPDATE admin_sessions
            SET last_seen_at = ?,
                idle_expires_at = min(absolute_expires_at, ?)
          WHERE session_id = ?
            AND revoked_at IS NULL
            AND idle_expires_at > ?
            AND absolute_expires_at > ?`,
      )
      .run(now, now + SESSION_IDLE_TTL_MS, sessionId, now, now);
  }

  revokeSession(sessionId: string, reason: string, now: number): boolean {
    const result = this.connection
      .prepare(
        `UPDATE admin_sessions
            SET revoked_at = ?, revoke_reason = ?
          WHERE session_id = ? AND revoked_at IS NULL`,
      )
      .run(now, reason, sessionId);
    return Number(result.changes) === 1;
  }

  revokeAllSessions(input: {
    readonly reason: string;
    readonly now: number;
    readonly sessionId: string;
    readonly tokenDigest: string;
  }): number | undefined {
    const session = this.activeSession(input.tokenDigest, input.now);
    if (
      !session ||
      session.sessionId !== input.sessionId ||
      session.stepUpExpiresAt === null ||
      session.stepUpExpiresAt <= input.now
    ) {
      return undefined;
    }
    const identity = this.adminIdentity();
    if (!identity) throw new Error("administrator identity has not been initialized");
    const nextGeneration = identity.sessionGeneration + 1;
    this.connection
      .prepare(
        "UPDATE admin_identity SET session_generation = ?, updated_at = ? WHERE singleton_key = 1",
      )
      .run(nextGeneration, input.now);
    const result = this.connection
      .prepare(
        `UPDATE admin_sessions
            SET revoked_at = ?, revoke_reason = ?
          WHERE revoked_at IS NULL`,
      )
      .run(input.now, input.reason);
    return Number(result.changes);
  }

  recordAuthFailure(sourceHash: string, now: number): AuthLimit {
    this.pruneIdentityState(now);
    const existing = this.authLimit(sourceHash);
    const inWindow = existing !== undefined && now - existing.windowStartedAt < AUTH_WINDOW_MS;
    const failureCount = inWindow ? existing.failureCount + 1 : 1;
    const windowStartedAt = inWindow ? existing.windowStartedAt : now;
    const exponent = Math.max(0, failureCount - AUTH_FAILURE_THRESHOLD);
    const delay = failureCount >= AUTH_FAILURE_THRESHOLD
      ? Math.min(AUTH_WINDOW_MS, 30_000 * 2 ** Math.min(exponent, 5))
      : 0;
    const blockedUntil = now + delay;
    this.connection
      .prepare(
        `INSERT INTO admin_auth_limits(
           source_hash, window_started_at, failure_count, blocked_until, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_hash) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           failure_count = excluded.failure_count,
           blocked_until = excluded.blocked_until,
           updated_at = excluded.updated_at`,
      )
      .run(sourceHash, windowStartedAt, failureCount, blockedUntil, now);
    return { failureCount, blockedUntil, windowStartedAt };
  }

  resetAuthLimit(sourceHash: string): void {
    this.connection.prepare("DELETE FROM admin_auth_limits WHERE source_hash = ?").run(sourceHash);
  }

  pruneIdentityState(now: number): void {
    this.connection
      .prepare(
        `DELETE FROM admin_sessions
          WHERE max(absolute_expires_at, coalesce(revoked_at, 0)) <= ?`,
      )
      .run(now - SESSION_RECORD_RETENTION_MS);
    this.connection
      .prepare(
        `DELETE FROM admin_auth_limits
          WHERE updated_at <= ? AND blocked_until <= ?`,
      )
      .run(now - AUTH_WINDOW_MS, now);
  }

  syncApiClient(clientId: string, fingerprint: string, now: number): ApiClientKey {
    const row = this.connection
      .prepare(
        `SELECT client_id, enabled, key_version, secret_fingerprint
           FROM api_client_config
          WHERE singleton_key = 1`,
      )
      .get() as
      | {
          client_id: string;
          enabled: number | bigint;
          key_version: number | bigint;
          secret_fingerprint: string;
        }
      | undefined;
    if (row && row.client_id !== clientId) {
      throw new Error("configured API client ID does not match the initialized client");
    }
    const existing = row
      ? {
          clientId: row.client_id,
          keyVersion: Number(row.key_version),
          secretFingerprint: row.secret_fingerprint,
          enabled: Number(row.enabled) === 1,
        }
      : undefined;
    if (!existing) {
      this.connection
        .prepare(
          `INSERT INTO api_client_config(
             singleton_key, client_id, secret_fingerprint, key_version,
             enabled, created_at, updated_at
           ) VALUES (1, ?, ?, 1, 1, ?, ?)`,
        )
        .run(clientId, fingerprint, now, now);
      this.connection
        .prepare(
          `INSERT INTO api_client_keys(
             client_id, key_version, secret_fingerprint, activated_at, retired_at
           ) VALUES (?, 1, ?, ?, NULL)`,
        )
        .run(clientId, fingerprint, now);
      return { clientId, keyVersion: 1, secretFingerprint: fingerprint, enabled: true };
    }

    if (existing.secretFingerprint === fingerprint) {
      const active = this.connection
        .prepare(
          `SELECT 1
             FROM api_client_keys
            WHERE client_id = ? AND key_version = ?
              AND secret_fingerprint = ? AND retired_at IS NULL`,
        )
        .get(clientId, existing.keyVersion, fingerprint);
      if (!active) throw new Error("active API client key history is inconsistent");
      this.connection
        .prepare("UPDATE api_client_config SET enabled = 1, updated_at = ? WHERE singleton_key = 1")
        .run(now);
      return { ...existing, enabled: true };
    }

    const historical = this.connection
      .prepare("SELECT key_version FROM api_client_keys WHERE secret_fingerprint = ?")
      .get(fingerprint) as { key_version: bigint | number } | undefined;
    if (historical) {
      throw new Error("configured API secret was previously retired and cannot be reused");
    }
    const active = this.connection
      .prepare(
        `SELECT activated_at
           FROM api_client_keys
          WHERE client_id = ? AND key_version = ?
            AND secret_fingerprint = ? AND retired_at IS NULL`,
      )
      .get(clientId, existing.keyVersion, existing.secretFingerprint) as
      | { activated_at: bigint | number }
      | undefined;
    if (!active) throw new Error("active API client key history is inconsistent");
    const activatedAt = Math.max(now, Number(active.activated_at));
    const retired = this.connection
      .prepare(
        `UPDATE api_client_keys
            SET retired_at = ?
          WHERE client_id = ? AND key_version = ? AND retired_at IS NULL`,
      )
      .run(activatedAt, clientId, existing.keyVersion);
    if (Number(retired.changes) !== 1) {
      throw new Error("active API client key could not be retired");
    }
    const keyVersion = existing.keyVersion + 1;
    this.connection
      .prepare(
        `INSERT INTO api_client_keys(
           client_id, key_version, secret_fingerprint, activated_at, retired_at
         ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(clientId, keyVersion, fingerprint, activatedAt);
    this.connection
      .prepare(
        `UPDATE api_client_config
            SET secret_fingerprint = ?, key_version = ?, enabled = 1, updated_at = ?
          WHERE singleton_key = 1`,
      )
      .run(fingerprint, keyVersion, activatedAt);
    return { clientId, keyVersion, secretFingerprint: fingerprint, enabled: true };
  }

  consumeApiNonce(clientId: string, nonce: string, requestTimestamp: number, now: number): boolean {
    if (
      !Number.isSafeInteger(requestTimestamp) ||
      requestTimestamp < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce)
    ) {
      return false;
    }
    const decodedNonce = Buffer.from(nonce, "base64url");
    if (decodedNonce.byteLength !== 32 || decodedNonce.toString("base64url") !== nonce) {
      return false;
    }
    const nowSeconds = Math.floor(now / 1000);
    if (Math.abs(nowSeconds - requestTimestamp) > API_SIGNATURE_SKEW_MS / 1000) {
      return false;
    }
    const client = this.activeApiClient(clientId);
    if (!client || !client.enabled) return false;
    this.connection.prepare("DELETE FROM api_nonces WHERE expires_at <= ?").run(now);
    const result = this.connection
      .prepare(
        `INSERT INTO api_nonces(
           client_id, key_version, nonce, request_timestamp_seconds, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id, key_version, nonce) DO NOTHING`,
      )
      .run(
        clientId,
        client.keyVersion,
        nonce,
        requestTimestamp,
        (requestTimestamp * 1000) + API_SIGNATURE_SKEW_MS + 1000,
        now,
      );
    return Number(result.changes) === 1;
  }

  appendAudit(input: AuditInput): AuditEvent {
    return appendAuditEvent(this.connection, input);
  }
}

/**
 * Appends one audit-chain entry inside an existing database transaction.
 * Domain stores use this helper when their state change and its audit fact
 * must commit or roll back together.
 */
export function appendAuditEvent(
  connection: DatabaseSync,
  input: AuditInput,
): AuditEvent {
  validateAuditInput(input);
  const detailsJson = serializeAuditDetails(input.details ?? {});
  const previous = connection
    .prepare("SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1")
    .get() as { event_hash: string } | undefined;
  const previousHash = previous?.event_hash ?? null;
  const eventId = randomUUID();
  const eventHash = calculateAuditEventHash({
    eventId,
    occurredAt: input.occurredAt,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    outcome: input.outcome,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    requestId: input.requestId ?? null,
    remoteAddressHash: input.remoteAddressHash ?? null,
    detailsJson,
    previousHash,
  });
  const result = connection
    .prepare(
      `INSERT INTO audit_events(
         event_id, occurred_at, actor_type, actor_id, action, outcome,
         subject_type, subject_id, request_id, remote_address_hash,
         details_json, previous_hash, event_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.occurredAt,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.outcome,
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.requestId ?? null,
      input.remoteAddressHash ?? null,
      detailsJson,
      previousHash,
      eventHash,
    );
  if (Number(result.changes) !== 1) throw new Error("audit event was not appended");
  const sequence = Number(result.lastInsertRowid);
  return { sequence, eventId, eventHash, previousHash };
}

function validateAuditInput(input: AuditInput): void {
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new Error("audit timestamp is invalid");
  }
  if (!/^[a-z][a-z0-9._-]{0,99}$/.test(input.action)) {
    throw new Error("audit action is invalid");
  }
  for (const [name, value] of [
    ["actor_id", input.actorId],
    ["subject_type", input.subjectType],
    ["subject_id", input.subjectId],
    ["request_id", input.requestId],
  ] as const) {
    if (value !== undefined && (value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))) {
      throw new Error(`audit ${name} is invalid`);
    }
  }
  if (
    input.remoteAddressHash !== undefined &&
    !/^[0-9a-f]{64}$/.test(input.remoteAddressHash)
  ) {
    throw new Error("audit remote address hash is invalid");
  }
}

function mapSession(row: {
  session_id: string;
  token_digest: string;
  csrf_digest: string;
  generation: bigint | number;
  created_at: bigint | number;
  last_seen_at: bigint | number;
  idle_expires_at: bigint | number;
  absolute_expires_at: bigint | number;
  step_up_expires_at: bigint | number | null;
  username: string;
}): AdminSession {
  return {
    sessionId: row.session_id,
    tokenDigest: row.token_digest,
    csrfDigest: row.csrf_digest,
    generation: Number(row.generation),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    idleExpiresAt: Number(row.idle_expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    stepUpExpiresAt: row.step_up_expires_at === null ? null : Number(row.step_up_expires_at),
    username: row.username,
  };
}

function serializeAuditDetails(details: Readonly<Record<string, unknown>>): string {
  const canonical = canonicalizeAuditValue(details, 0);
  const serialized = JSON.stringify(canonical);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_DETAILS_BYTES) {
    throw new Error("audit details exceed the allowed size");
  }
  return serialized;
}

function canonicalizeAuditValue(value: unknown, depth: number): unknown {
  if (depth > 6) throw new Error("audit details are too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("audit details contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeAuditValue(item, depth + 1));
  if (typeof value !== "object") throw new Error("audit details contain an unsupported value");

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (/(password|secret|token|cookie|private|credential|authorization)/i.test(key)) {
      throw new Error("audit details contain a sensitive field");
    }
    output[key] = canonicalizeAuditValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return output;
}
