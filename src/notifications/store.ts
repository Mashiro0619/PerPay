import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import {
  MAX_WEBHOOK_RESPONSE_BYTES,
  webhookDeliveryRequestFingerprint,
  webhookRetryDelayMilliseconds,
  isValidWebhookReason,
  type WebhookAttempt,
  type WebhookAttemptOutcome,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEvent,
  type WebhookTargetFormat,
} from "./model.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LEASE_MILLISECONDS = 120_000;

export interface WebhookSigningKey {
  readonly keyVersion: number;
  readonly keyId: string;
  readonly secretFingerprint: string;
  readonly activatedAt: number;
  readonly retiredAt: number | null;
}

export interface WebhookTargetProjection {
  readonly targetId: string;
  readonly orderId: string;
  readonly apiClientId: string;
  readonly format: WebhookTargetFormat;
  readonly targetUrl: string;
  readonly allowedOrigin: string;
  readonly urlFingerprint: string;
  readonly createdAt: number;
}

export interface ClaimedWebhookAttempt {
  readonly delivery: WebhookDelivery;
  readonly event: WebhookEvent;
  readonly target: WebhookTargetProjection;
  readonly attempt: WebhookAttempt;
  readonly key: WebhookSigningKey;
}

export interface CompleteWebhookAttemptInput {
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly outcome: Exclude<WebhookAttemptOutcome, "STARTED">;
  readonly now: number;
  readonly maximumAttempts: number;
  readonly retryBaseMilliseconds: number;
  readonly retryMaximumMilliseconds: number;
  readonly resolvedAddressesFingerprint?: string | null;
  readonly connectedAddress?: string | null;
  readonly httpStatus?: number | null;
  readonly responseBytes?: number | null;
  readonly responseFingerprint?: string | null;
  readonly ackCode?: string | null;
  readonly errorCode?: string | null;
}

export interface WebhookReplayResult {
  readonly delivery: WebhookDelivery;
  readonly replayed: boolean;
}

export interface WebhookDeliveryPage {
  readonly deliveries: readonly WebhookDeliverySummary[];
  readonly nextCursor: WebhookDeliveryCursor | null;
}

export interface WebhookDeliverySummary {
  readonly delivery: WebhookDelivery;
  readonly eventType: string;
  readonly orderId: string;
  readonly targetFormat: WebhookTargetFormat;
  readonly targetUrlFingerprint: string;
}

export interface WebhookDeliveryCursor {
  readonly createdAt: number;
  readonly deliveryId: string;
}

export interface WebhookDeliveryDetail {
  readonly delivery: WebhookDelivery;
  readonly event: WebhookEvent;
  readonly target: WebhookTargetProjection;
  readonly attempts: readonly WebhookAttempt[];
}

export type WebhookStoreErrorCode =
  | "webhook_delivery_not_found"
  | "webhook_event_not_found"
  | "webhook_operation_conflict"
  | "webhook_delivery_state_conflict"
  | "webhook_disabled"
  | "webhook_target_inactive"
  | "webhook_signing_key_rollback"
  | "webhook_signing_key_unavailable";

export class WebhookStoreError extends Error {
  readonly code: WebhookStoreErrorCode;

  constructor(code: WebhookStoreErrorCode, message: string) {
    super(message);
    this.name = "WebhookStoreError";
    this.code = code;
  }
}

export class WebhookStore {
  readonly #database: DatabaseOwner;

  constructor(database: DatabaseOwner) {
    this.#database = database;
  }

  syncSigningKey(input: {
    readonly secretFingerprint: string;
    readonly now: number;
  }): WebhookSigningKey {
    assertFingerprint(input.secretFingerprint, "webhook signing key fingerprint");
    assertTime(input.now, "webhook signing key time");
    return this.#database.write((connection) => {
      const active = readActiveSigningKey(connection);
      if (active?.secretFingerprint === input.secretFingerprint) return active;
      const historical = connection
        .prepare("SELECT key_version FROM webhook_signing_keys WHERE secret_fingerprint = ?")
        .get(input.secretFingerprint) as { key_version: bigint | number } | undefined;
      if (historical) {
        throw new WebhookStoreError(
          "webhook_signing_key_rollback",
          "通知签名密钥不能回滚到已经退役的版本",
        );
      }
      const activationTime = active
        ? Math.max(input.now, active.activatedAt)
        : input.now;
      if (active) {
        const retired = connection
          .prepare(
            `UPDATE webhook_signing_keys
                SET retired_at = ?
              WHERE key_version = ? AND retired_at IS NULL`,
          )
          .run(activationTime, active.keyVersion);
        assertChangedOnce(retired.changes, "webhook signing key retirement");
      }
      const versionRow = connection
        .prepare("SELECT COALESCE(MAX(key_version), 0) + 1 AS version FROM webhook_signing_keys")
        .get() as { version: bigint | number };
      const keyVersion = toSafeInteger(versionRow.version, "webhook signing key version");
      const keyId = randomUUID();
      const inserted = connection
        .prepare(
          `INSERT INTO webhook_signing_keys(
             key_version, key_id, secret_fingerprint, activated_at, retired_at
           ) VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(keyVersion, keyId, input.secretFingerprint, activationTime);
      assertChangedOnce(inserted.changes, "webhook signing key insert");
      appendAuditEvent(connection, {
        occurredAt: activationTime,
        actorType: "SYSTEM",
        action: active
          ? "webhook.signing_key_rotated"
          : "webhook.signing_key_initialized",
        outcome: "SUCCESS",
        subjectType: "webhook_signing_key",
        subjectId: keyId,
        details: {
          key_version: keyVersion,
          previous_key_id: active?.keyId ?? null,
        },
      });
      return {
        keyVersion,
        keyId,
        secretFingerprint: input.secretFingerprint,
        activatedAt: activationTime,
        retiredAt: null,
      };
    });
  }

  activeSigningKey(): WebhookSigningKey | null {
    return this.#database.read((connection) => readActiveSigningKey(connection));
  }

  counts(): { readonly pending: number; readonly dead: number } {
    return this.#database.read((connection) => {
      const row = connection
        .prepare(
          `SELECT
             COALESCE(SUM(delivery.status IN ('PENDING', 'LEASED', 'RETRY_WAIT')), 0) AS pending,
             COALESCE(SUM(
               delivery.status = 'DEAD_LETTER' AND NOT EXISTS (
                 SELECT 1 FROM webhook_deliveries AS successor
                  WHERE successor.predecessor_delivery_id = delivery.delivery_id
               )
             ), 0) AS dead
             FROM webhook_deliveries AS delivery`,
        )
        .get() as { pending: bigint | number; dead: bigint | number };
      return {
        pending: toSafeInteger(row.pending, "webhook pending count"),
        dead: toSafeInteger(row.dead, "webhook dead letter count"),
      };
    });
  }

  materialize(limit: number, now: number): number {
    assertPositiveInteger(limit, "webhook materialize limit");
    assertTime(now, "webhook materialize time");
    return this.#database.write((connection) => {
      const rows = connection
        .prepare(
          `SELECT outbox.outbox_event_id, outbox.financial_operation_id,
                  outbox.aggregate_id, outbox.aggregate_version, outbox.event_type,
                  outbox.payload_json, outbox.payload_fingerprint,
                  outbox.created_at AS event_created_at,
                  target.target_id, target.order_id, target.api_client_id,
                  target.target_format, target.target_url, target.allowed_origin,
                  target.url_fingerprint, target.created_at AS target_created_at
             FROM outbox_events AS outbox
             JOIN webhook_targets AS target ON target.order_id = outbox.aggregate_id
            WHERE NOT EXISTS (
                    SELECT 1 FROM webhook_deliveries AS delivery
                     WHERE delivery.outbox_event_id = outbox.outbox_event_id
                       AND delivery.target_id = target.target_id
                       AND delivery.generation = 1
                  )
            ORDER BY outbox.created_at, outbox.outbox_event_id
            LIMIT ?`,
        )
        .all(limit) as unknown as MaterializationRow[];
      let inserted = 0;
      for (const row of rows) {
        const deliveryTime = Math.max(
          now,
          toSafeInteger(row.event_created_at, "webhook event time"),
          toSafeInteger(row.target_created_at, "webhook target time"),
        );
        const requestFingerprint = webhookDeliveryRequestFingerprint({
          eventId: row.outbox_event_id,
          targetId: row.target_id,
          generation: 1,
          predecessorDeliveryId: null,
          requestedByType: "SYSTEM",
          requestedByActorId: null,
          reason: null,
        });
        const result = connection
          .prepare(
            `INSERT INTO webhook_deliveries(
               delivery_id, outbox_event_id, target_id, generation,
               predecessor_delivery_id, request_key, request_fingerprint,
               request_fingerprint_version, requested_by_type, requested_by_actor_id,
               reason, status, attempt_count, next_attempt_at, lease_token,
               lease_expires_at, acknowledged_at, dead_lettered_at, last_error_code,
               created_at, updated_at
             ) VALUES (?, ?, ?, 1, NULL, ?, ?, 1, 'SYSTEM', NULL, NULL,
                       'PENDING', 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(
            randomUUID(),
            row.outbox_event_id,
            row.target_id,
            row.outbox_event_id,
            requestFingerprint,
            deliveryTime,
            deliveryTime,
            deliveryTime,
          );
        assertChangedOnce(result.changes, "webhook delivery materialization");
        inserted += 1;
      }
      return inserted;
    });
  }

  claimNext(input: {
    readonly now: number;
    readonly leaseMilliseconds: number;
    readonly maximumAttempts: number;
  }): ClaimedWebhookAttempt | null {
    assertTime(input.now, "webhook claim time");
    if (
      !Number.isSafeInteger(input.leaseMilliseconds) ||
      input.leaseMilliseconds < 1 ||
      input.leaseMilliseconds > MAX_LEASE_MILLISECONDS
    ) {
      throw new RangeError("webhook lease duration is invalid");
    }
    assertPositiveInteger(input.maximumAttempts, "webhook maximum attempts");
    return this.#database.write((connection) => {
      recoverExpiredLeases(connection, input.now);
      deadLetterExhaustedDeliveries(connection, input.maximumAttempts, input.now);
      const key = readActiveSigningKey(connection);
      if (!key) return null;
      const row = connection
        .prepare(
          `SELECT delivery.delivery_id, delivery.outbox_event_id, delivery.target_id,
                  delivery.generation, delivery.predecessor_delivery_id,
                  delivery.request_key, delivery.request_fingerprint,
                  delivery.requested_by_type, delivery.requested_by_actor_id,
                  delivery.reason, delivery.status, delivery.attempt_count,
                  delivery.next_attempt_at, delivery.acknowledged_at,
                  delivery.dead_lettered_at, delivery.last_error_code,
                  delivery.created_at, delivery.updated_at,
                  outbox.event_type, outbox.aggregate_id, outbox.aggregate_version,
                  outbox.payload_json, outbox.payload_fingerprint,
                  outbox.created_at AS event_created_at,
                  target.order_id, target.api_client_id, target.target_format,
                  target.target_url, target.allowed_origin, target.url_fingerprint,
                  target.created_at AS target_created_at
             FROM webhook_deliveries AS delivery
             JOIN outbox_events AS outbox ON outbox.outbox_event_id = delivery.outbox_event_id
             JOIN webhook_targets AS target ON target.target_id = delivery.target_id
            WHERE delivery.status IN ('PENDING', 'RETRY_WAIT')
              AND delivery.next_attempt_at <= ?
              AND delivery.attempt_count < ?
            ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.delivery_id
            LIMIT 1`,
        )
        .get(input.now, input.maximumAttempts) as ClaimRow | undefined;
      if (!row) return null;
      const attemptNumber = toSafeInteger(row.attempt_count, "webhook attempt count") + 1;
      const leaseToken = randomUUID();
      const leaseExpiresAt = input.now + input.leaseMilliseconds;
      assertTime(leaseExpiresAt, "webhook lease expiry time");
      const claimed = connection
        .prepare(
          `UPDATE webhook_deliveries
              SET status = 'LEASED', attempt_count = ?, lease_token = ?,
                  lease_expires_at = ?, updated_at = ?
            WHERE delivery_id = ? AND status IN ('PENDING', 'RETRY_WAIT')`,
        )
        .run(attemptNumber, leaseToken, leaseExpiresAt, input.now, row.delivery_id);
      assertChangedOnce(claimed.changes, "webhook delivery lease");
      const attemptId = randomUUID();
      const attemptInsert = connection
        .prepare(
          `INSERT INTO webhook_attempts(
             attempt_id, delivery_id, attempt_number, lease_token, key_version,
             request_timestamp, request_body_fingerprint, outcome,
             resolved_addresses_fingerprint, connected_address, http_status,
             response_bytes, response_fingerprint, ack_code, error_code,
             started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'STARTED', NULL, NULL, NULL,
                     NULL, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(
          attemptId,
          row.delivery_id,
          attemptNumber,
          leaseToken,
          key.keyVersion,
          input.now,
          row.payload_fingerprint,
          input.now,
        );
      assertChangedOnce(attemptInsert.changes, "webhook attempt start");
      const delivery = mapDelivery({
        ...row,
        status: "LEASED",
        attempt_count: attemptNumber,
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
        updated_at: input.now,
      });
      const event = mapEvent(row);
      const target = mapTarget(row);
      const attempt: WebhookAttempt = {
        attemptId,
        deliveryId: row.delivery_id,
        attemptNumber,
        leaseToken,
        keyVersion: key.keyVersion,
        keyId: key.keyId,
        requestTimestamp: input.now,
        requestBodyFingerprint: row.payload_fingerprint,
        outcome: "STARTED",
        resolvedAddressesFingerprint: null,
        connectedAddress: null,
        httpStatus: null,
        responseBytes: null,
        responseFingerprint: null,
        ackCode: null,
        errorCode: null,
        startedAt: input.now,
        finishedAt: null,
      };
      return { delivery, event, target, attempt, key };
    });
  }

  completeAttempt(input: CompleteWebhookAttemptInput): WebhookDelivery {
    assertUuid(input.deliveryId, "webhook delivery ID");
    assertUuid(input.attemptId, "webhook attempt ID");
    assertUuid(input.leaseToken, "webhook lease token");
    assertTime(input.now, "webhook completion time");
    assertPositiveInteger(input.maximumAttempts, "webhook maximum attempts");
    if (!isTerminalAttemptOutcome(input.outcome)) {
      throw new RangeError("webhook attempt outcome is invalid");
    }
    const evidence = validateCompleteAttemptEvidence(input);
    return this.#database.write((connection) => {
      const current = connection
        .prepare(
          `SELECT delivery_id, status, attempt_count, lease_token, updated_at
             FROM webhook_deliveries WHERE delivery_id = ?`,
        )
        .get(input.deliveryId) as {
        delivery_id: string;
        status: string;
        attempt_count: bigint | number;
        lease_token: string | null;
        updated_at: bigint | number;
      } | undefined;
      if (
        !current ||
        current.status !== "LEASED" ||
        current.lease_token !== input.leaseToken
      ) {
        throw new WebhookStoreError(
          "webhook_delivery_state_conflict",
          "通知投递租约已经变化",
        );
      }
      const attemptNumber = toSafeInteger(current.attempt_count, "webhook attempt count");
      const attempt = connection
        .prepare(
          `SELECT attempt_id, started_at FROM webhook_attempts
            WHERE delivery_id = ? AND attempt_number = ? AND lease_token = ? AND outcome = 'STARTED'`,
        )
        .get(input.deliveryId, attemptNumber, input.leaseToken) as
        | { attempt_id: string; started_at: bigint | number }
        | undefined;
      if (!attempt || attempt.attempt_id !== input.attemptId) {
        throw new WebhookStoreError(
          "webhook_delivery_state_conflict",
          "通知尝试租约已经变化",
        );
      }
      const completionTime = Math.max(
        input.now,
        toSafeInteger(current.updated_at, "webhook delivery update time"),
        toSafeInteger(attempt.started_at, "webhook attempt start time"),
      );

      const {
        resolvedAddressesFingerprint,
        connectedAddress,
        httpStatus,
        responseBytes,
        responseFingerprint,
        ackCode,
        errorCode,
      } = evidence;
      const attemptUpdate = connection
        .prepare(
          `UPDATE webhook_attempts
              SET outcome = ?, resolved_addresses_fingerprint = ?, connected_address = ?,
                  http_status = ?, response_bytes = ?, response_fingerprint = ?,
                  ack_code = ?, error_code = ?, finished_at = ?
            WHERE attempt_id = ? AND outcome = 'STARTED'`,
        )
        .run(
          input.outcome,
          resolvedAddressesFingerprint,
          connectedAddress,
          httpStatus,
          responseBytes,
          responseFingerprint,
          ackCode,
          errorCode,
          completionTime,
          input.attemptId,
        );
      assertChangedOnce(attemptUpdate.changes, "webhook attempt completion");

      let status: "RETRY_WAIT" | "ACKNOWLEDGED" | "DEAD_LETTER";
      let nextAttemptAt = completionTime;
      let acknowledgedAt: number | null = null;
      let deadLetteredAt: number | null = null;
      let lastErrorCode: string | null = errorCode;
      if (input.outcome === "ACKNOWLEDGED") {
        status = "ACKNOWLEDGED";
        acknowledgedAt = completionTime;
        lastErrorCode = null;
      } else if (
        (input.outcome === "RETRYABLE_FAILURE" || input.outcome === "OUTCOME_UNKNOWN") &&
        attemptNumber < input.maximumAttempts
      ) {
        status = "RETRY_WAIT";
        nextAttemptAt = completionTime + webhookRetryDelayMilliseconds({
          deliveryId: input.deliveryId,
          attemptNumber,
          baseMilliseconds: input.retryBaseMilliseconds,
          maximumMilliseconds: input.retryMaximumMilliseconds,
        });
        assertTime(nextAttemptAt, "webhook next attempt time");
      } else {
        status = "DEAD_LETTER";
        deadLetteredAt = completionTime;
      }
      const deliveryUpdate = connection
        .prepare(
          `UPDATE webhook_deliveries
              SET status = ?, next_attempt_at = ?, lease_token = NULL,
                  lease_expires_at = NULL, acknowledged_at = ?, dead_lettered_at = ?,
                  last_error_code = ?, updated_at = ?
            WHERE delivery_id = ? AND status = 'LEASED' AND lease_token = ?`,
        )
        .run(
          status,
          nextAttemptAt,
          acknowledgedAt,
          deadLetteredAt,
          lastErrorCode,
          completionTime,
          input.deliveryId,
          input.leaseToken,
        );
      assertChangedOnce(deliveryUpdate.changes, "webhook delivery completion");
      const row = connection
        .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?")
        .get(input.deliveryId) as DeliveryRow | undefined;
      if (!row) throw new Error("completed webhook delivery cannot be read");
      return mapDelivery(row);
    });
  }

  recoverExpired(now: number): number {
    assertTime(now, "webhook recovery time");
    return this.#database.write((connection) => recoverExpiredLeases(connection, now));
  }

  replay(input: {
    readonly redeliveryId: string;
    readonly deliveryId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly activeAllowedOrigin: string | null;
    readonly now: number;
    readonly requestId?: string | undefined;
    readonly remoteAddressHash?: string | undefined;
  }): WebhookReplayResult {
    assertUuid(input.redeliveryId, "webhook redelivery ID");
    assertUuid(input.deliveryId, "webhook delivery ID");
    assertIdentifier(input.actorId, "webhook actor ID");
    assertReason(input.reason);
    assertActiveAllowedOrigin(input.activeAllowedOrigin);
    assertTime(input.now, "webhook replay time");
    return this.#database.write((connection) => {
      const original = connection
        .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?")
        .get(input.deliveryId) as DeliveryRow | undefined;
      if (!original) {
        throw new WebhookStoreError("webhook_delivery_not_found", "通知投递不存在");
      }
      const existing = connection
        .prepare("SELECT * FROM webhook_deliveries WHERE request_key = ?")
        .get(input.redeliveryId) as DeliveryRow | undefined;
      if (existing) {
        const generation = toSafeInteger(existing.generation, "webhook generation");
        const expectedFingerprint = webhookDeliveryRequestFingerprint({
          eventId: existing.outbox_event_id,
          targetId: existing.target_id,
          generation,
          predecessorDeliveryId: existing.predecessor_delivery_id,
          requestedByType: "ADMIN",
          requestedByActorId: input.actorId,
          reason: input.reason,
        });
        if (
          existing.outbox_event_id !== original.outbox_event_id ||
          existing.target_id !== original.target_id ||
          existing.predecessor_delivery_id !== original.delivery_id ||
          existing.requested_by_type !== "ADMIN" ||
          existing.requested_by_actor_id !== input.actorId ||
          existing.reason !== input.reason ||
          existing.request_fingerprint !== expectedFingerprint
        ) {
          throw new WebhookStoreError(
            "webhook_operation_conflict",
            "补发编号已经用于不同的通知请求",
          );
        }
        return { delivery: mapDelivery(existing), replayed: true };
      }
      if (input.activeAllowedOrigin === null) {
        throw new WebhookStoreError("webhook_disabled", "通知功能未启用");
      }
      const target = connection
        .prepare("SELECT allowed_origin FROM webhook_targets WHERE target_id = ?")
        .get(original.target_id) as { allowed_origin: string } | undefined;
      if (!target) throw new Error("webhook delivery target cannot be read");
      if (target.allowed_origin !== input.activeAllowedOrigin) {
        throw new WebhookStoreError(
          "webhook_target_inactive",
          "通知目标不再属于当前允许的 origin",
        );
      }
      const latest = connection
        .prepare(
          `SELECT status, delivery_id, generation FROM webhook_deliveries
            WHERE outbox_event_id = ? AND target_id = ?
            ORDER BY generation DESC LIMIT 1`,
        )
        .get(original.outbox_event_id, original.target_id) as
        | { status: string; delivery_id: string; generation: bigint | number }
        | undefined;
      if (
        !latest ||
        latest.delivery_id !== original.delivery_id ||
        !["ACKNOWLEDGED", "DEAD_LETTER"].includes(latest.status)
      ) {
        throw new WebhookStoreError(
          "webhook_delivery_state_conflict",
          "只有最新的已确认或死信通知才能人工补发",
        );
      }
      const generation = toSafeInteger(latest.generation, "webhook generation") + 1;
      const replayTime = Math.max(
        input.now,
        toSafeInteger(original.updated_at, "webhook predecessor update time"),
      );
      const requestFingerprint = webhookDeliveryRequestFingerprint({
        eventId: original.outbox_event_id,
        targetId: original.target_id,
        generation,
        predecessorDeliveryId: original.delivery_id,
        requestedByType: "ADMIN",
        requestedByActorId: input.actorId,
        reason: input.reason,
      });
      const deliveryId = randomUUID();
      const inserted = connection
        .prepare(
          `INSERT INTO webhook_deliveries(
             delivery_id, outbox_event_id, target_id, generation,
             predecessor_delivery_id, request_key, request_fingerprint,
             request_fingerprint_version, requested_by_type, requested_by_actor_id,
             reason, status, attempt_count, next_attempt_at, lease_token,
             lease_expires_at, acknowledged_at, dead_lettered_at, last_error_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'ADMIN', ?, ?, 'PENDING', 0, ?,
                     NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          deliveryId,
          original.outbox_event_id,
          original.target_id,
          generation,
          latest.delivery_id,
          input.redeliveryId,
          requestFingerprint,
          input.actorId,
          input.reason,
          replayTime,
          replayTime,
          replayTime,
        );
      assertChangedOnce(inserted.changes, "webhook replay delivery insert");
      appendAuditEvent(connection, {
        occurredAt: replayTime,
        actorType: "ADMIN",
        actorId: input.actorId,
        action: "webhook.delivery_redelivered",
        outcome: "SUCCESS",
        subjectType: "webhook_delivery",
        subjectId: deliveryId,
        requestId: input.requestId,
        remoteAddressHash: input.remoteAddressHash,
        details: {
          predecessor_delivery_id: original.delivery_id,
          event_id: original.outbox_event_id,
          generation,
          redelivery_id: input.redeliveryId,
        },
      });
      const created = connection
        .prepare("SELECT * FROM webhook_deliveries WHERE request_key = ?")
        .get(input.redeliveryId) as DeliveryRow | undefined;
      if (!created) throw new Error("created webhook replay cannot be read");
      return { delivery: mapDelivery(created), replayed: false };
    });
  }

  eventForApiClient(apiClientId: string, eventId: string): WebhookEvent | null {
    assertIdentifier(apiClientId, "webhook API client ID");
    assertUuid(eventId, "webhook event ID");
    return this.#database.read((connection) => {
      const row = connection
        .prepare(
          `SELECT outbox_event_id, event_type, aggregate_id, aggregate_version,
                  payload_json, payload_fingerprint,
                  outbox.created_at AS event_created_at
             FROM outbox_events AS outbox
             JOIN payment_orders AS orders ON orders.order_id = outbox.aggregate_id
            WHERE orders.api_client_id = ? AND outbox.outbox_event_id = ?`,
        )
        .get(apiClientId, eventId) as EventRow | undefined;
      return row ? mapEvent(row) : null;
    });
  }

  delivery(deliveryId: string): WebhookDeliveryDetail | null {
    assertUuid(deliveryId, "webhook delivery ID");
    return this.#database.read((connection) => {
      const row = connection
        .prepare(
          `SELECT delivery.*, outbox.event_type, outbox.aggregate_id,
                  outbox.aggregate_version, outbox.payload_json,
                  outbox.payload_fingerprint, outbox.created_at AS event_created_at,
                  target.order_id, target.api_client_id, target.target_format,
                  target.target_url, target.allowed_origin,
                  target.url_fingerprint, target.created_at AS target_created_at
             FROM webhook_deliveries AS delivery
             JOIN outbox_events AS outbox ON outbox.outbox_event_id = delivery.outbox_event_id
             JOIN webhook_targets AS target ON target.target_id = delivery.target_id
            WHERE delivery.delivery_id = ?`,
        )
        .get(deliveryId) as DetailRow | undefined;
      if (!row) return null;
      const attempts = connection
        .prepare(
          `SELECT attempt_id, delivery_id, attempt_number, key_version,
                  (SELECT key_id FROM webhook_signing_keys WHERE key_version = attempt.key_version) AS key_id,
                  lease_token, request_timestamp, request_body_fingerprint, outcome,
                  resolved_addresses_fingerprint, connected_address, http_status,
                  response_bytes, response_fingerprint, ack_code, error_code,
                  started_at, finished_at
             FROM webhook_attempts AS attempt
            WHERE delivery_id = ? ORDER BY attempt_number`,
        )
        .all(deliveryId) as unknown as AttemptRow[];
      return {
        delivery: mapDelivery(row),
        event: mapEvent(row),
        target: mapTarget(row),
        attempts: attempts.map(mapAttempt),
      };
    });
  }

  listDeliveries(input: {
    readonly status?: WebhookDeliveryStatus | undefined;
    readonly cursor?: WebhookDeliveryCursor | null | undefined;
    readonly limit: number;
  }): WebhookDeliveryPage {
    assertPositiveInteger(input.limit, "webhook delivery page limit");
    if (input.limit > 200) throw new RangeError("webhook delivery page limit is too large");
    if (
      input.status !== undefined &&
      !["PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"].includes(
        input.status,
      )
    ) {
      throw new RangeError("webhook delivery status filter is invalid");
    }
    return this.#database.read((connection) => {
      const where: string[] = [];
      const parameters: Array<string | number> = [];
      if (input.status) {
        where.push("delivery.status = ?");
        parameters.push(input.status);
      }
      if (input.cursor) {
        assertTime(input.cursor.createdAt, "webhook delivery cursor time");
        assertUuid(input.cursor.deliveryId, "webhook delivery cursor ID");
        where.push(
          "(delivery.created_at > ? OR (delivery.created_at = ? AND delivery.delivery_id > ?))",
        );
        parameters.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.deliveryId);
      }
      const rows = connection
        .prepare(
          `SELECT delivery.*, outbox.event_type, outbox.aggregate_id,
                  target.target_format, target.url_fingerprint
             FROM webhook_deliveries AS delivery
             JOIN outbox_events AS outbox
               ON outbox.outbox_event_id = delivery.outbox_event_id
             JOIN webhook_targets AS target
               ON target.target_id = delivery.target_id
            ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY delivery.created_at, delivery.delivery_id LIMIT ?`,
        )
        .all(...parameters, input.limit + 1) as unknown as DeliverySummaryRow[];
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
      const last = pageRows.at(-1);
      return {
        deliveries: pageRows.map((row) => ({
          delivery: mapDelivery(row),
          eventType: row.event_type,
          orderId: row.aggregate_id,
          targetFormat: row.target_format,
          targetUrlFingerprint: row.url_fingerprint,
        })),
        nextCursor: hasMore && last
          ? { createdAt: toSafeInteger(last.created_at, "webhook cursor time"), deliveryId: last.delivery_id }
          : null,
      };
    });
  }
}

interface MaterializationRow extends EventRow {
  readonly target_id: string;
  readonly order_id: string;
  readonly api_client_id: string;
  readonly target_format: WebhookTargetFormat;
  readonly target_url: string;
  readonly allowed_origin: string;
  readonly url_fingerprint: string;
  readonly target_created_at: bigint | number;
}

interface EventRow {
  readonly outbox_event_id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: bigint | number;
  readonly payload_json: string;
  readonly payload_fingerprint: string;
  readonly event_created_at: bigint | number;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly outbox_event_id: string;
  readonly target_id: string;
  readonly generation: bigint | number;
  readonly predecessor_delivery_id: string | null;
  readonly request_key: string;
  readonly request_fingerprint: string;
  readonly requested_by_type: "SYSTEM" | "ADMIN";
  readonly requested_by_actor_id: string | null;
  readonly reason: string | null;
  readonly status: WebhookDelivery["status"];
  readonly attempt_count: bigint | number;
  readonly next_attempt_at: bigint | number;
  readonly lease_token: string | null;
  readonly lease_expires_at: bigint | number | null;
  readonly acknowledged_at: bigint | number | null;
  readonly dead_lettered_at: bigint | number | null;
  readonly last_error_code: string | null;
  readonly created_at: bigint | number;
  readonly updated_at: bigint | number;
  readonly event_type?: string;
  readonly aggregate_id?: string;
  readonly aggregate_version?: bigint | number;
  readonly payload_json?: string;
  readonly payload_fingerprint?: string;
  readonly event_created_at?: bigint | number;
  readonly order_id?: string;
  readonly api_client_id?: string;
  readonly target_format?: WebhookTargetFormat;
  readonly target_url?: string;
  readonly allowed_origin?: string;
  readonly url_fingerprint?: string;
  readonly target_created_at?: bigint | number;
}

interface DeliverySummaryRow extends DeliveryRow {
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly target_format: WebhookTargetFormat;
  readonly url_fingerprint: string;
}

type ClaimRow = DeliveryRow & EventRow & {
  readonly order_id: string;
  readonly api_client_id: string;
  readonly target_format: WebhookTargetFormat;
  readonly target_url: string;
  readonly allowed_origin: string;
  readonly url_fingerprint: string;
  readonly target_created_at: bigint | number;
};
type DetailRow = DeliveryRow & EventRow & {
  readonly order_id: string;
  readonly api_client_id: string;
  readonly target_format: WebhookTargetFormat;
  readonly target_url: string;
  readonly allowed_origin: string;
  readonly url_fingerprint: string;
  readonly target_created_at: bigint | number;
};

interface AttemptRow {
  readonly attempt_id: string;
  readonly delivery_id: string;
  readonly attempt_number: bigint | number;
  readonly key_version: bigint | number;
  readonly key_id: string | null;
  readonly lease_token: string;
  readonly request_timestamp: bigint | number;
  readonly request_body_fingerprint: string;
  readonly outcome: WebhookAttemptOutcome;
  readonly resolved_addresses_fingerprint: string | null;
  readonly connected_address: string | null;
  readonly http_status: bigint | number | null;
  readonly response_bytes: bigint | number | null;
  readonly response_fingerprint: string | null;
  readonly ack_code: string | null;
  readonly error_code: string | null;
  readonly started_at: bigint | number;
  readonly finished_at: bigint | number | null;
}

interface SigningKeyRow {
  readonly key_version: bigint | number;
  readonly key_id: string;
  readonly secret_fingerprint: string;
  readonly activated_at: bigint | number;
  readonly retired_at: bigint | number | null;
}

function readActiveSigningKey(connection: DatabaseSync): WebhookSigningKey | null {
  const row = connection
    .prepare(
      `SELECT key_version, key_id, secret_fingerprint, activated_at, retired_at
         FROM webhook_signing_keys WHERE retired_at IS NULL`,
    )
    .get() as SigningKeyRow | undefined;
  return row ? mapSigningKey(row) : null;
}

function recoverExpiredLeases(connection: DatabaseSync, now: number): number {
  const rows = connection
    .prepare(
      `SELECT delivery_id, lease_token, attempt_count
         FROM webhook_deliveries
        WHERE status = 'LEASED' AND lease_expires_at <= ?
        ORDER BY lease_expires_at, delivery_id`,
    )
    .all(now) as Array<{
    delivery_id: string;
    lease_token: string;
    attempt_count: bigint | number;
  }>;
  let recovered = 0;
  for (const row of rows) {
    const attemptNumber = toSafeInteger(row.attempt_count, "webhook expired attempt count");
    const attemptUpdate = connection
      .prepare(
        `UPDATE webhook_attempts
            SET outcome = 'OUTCOME_UNKNOWN', error_code = 'lease_expired_outcome_unknown',
                finished_at = ?
          WHERE delivery_id = ? AND attempt_number = ? AND lease_token = ? AND outcome = 'STARTED'`,
      )
      .run(now, row.delivery_id, attemptNumber, row.lease_token);
    assertChangedOnce(attemptUpdate.changes, "webhook expired attempt recovery");
    const deliveryUpdate = connection
      .prepare(
        `UPDATE webhook_deliveries
            SET status = 'RETRY_WAIT', lease_token = NULL, lease_expires_at = NULL,
                next_attempt_at = ?, last_error_code = 'lease_expired_outcome_unknown',
                updated_at = ?
          WHERE delivery_id = ? AND status = 'LEASED' AND lease_token = ?`,
      )
      .run(now, now, row.delivery_id, row.lease_token);
    assertChangedOnce(deliveryUpdate.changes, "webhook expired delivery recovery");
    recovered += 1;
  }
  return recovered;
}

function deadLetterExhaustedDeliveries(
  connection: DatabaseSync,
  maximumAttempts: number,
  now: number,
): number {
  const result = connection
    .prepare(
      `UPDATE webhook_deliveries
          SET status = 'DEAD_LETTER', dead_lettered_at = max(updated_at, ?),
              last_error_code = 'maximum_attempts_reached', updated_at = max(updated_at, ?)
        WHERE status IN ('PENDING', 'RETRY_WAIT')
          AND attempt_count >= ?
          AND attempt_count >= 1`,
    )
    .run(now, now, maximumAttempts);
  return toSafeInteger(result.changes, "exhausted webhook delivery count");
}

function mapSigningKey(row: SigningKeyRow): WebhookSigningKey {
  return {
    keyVersion: toSafeInteger(row.key_version, "webhook key version"),
    keyId: row.key_id,
    secretFingerprint: row.secret_fingerprint,
    activatedAt: toSafeInteger(row.activated_at, "webhook key activation time"),
    retiredAt: row.retired_at === null ? null : toSafeInteger(row.retired_at, "webhook key retirement time"),
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    deliveryId: row.delivery_id,
    eventId: row.outbox_event_id,
    targetId: row.target_id,
    generation: toSafeInteger(row.generation, "webhook generation"),
    predecessorDeliveryId: row.predecessor_delivery_id,
    requestKey: row.request_key,
    requestedByType: row.requested_by_type,
    requestedByActorId: row.requested_by_actor_id,
    reason: row.reason,
    status: row.status,
    attemptCount: toSafeInteger(row.attempt_count, "webhook attempt count"),
    nextAttemptAt: toSafeInteger(row.next_attempt_at, "webhook next attempt time"),
    leaseExpiresAt: row.lease_expires_at === null
      ? null
      : toSafeInteger(row.lease_expires_at, "webhook lease expiry time"),
    acknowledgedAt: row.acknowledged_at === null ? null : toSafeInteger(row.acknowledged_at, "webhook acknowledgement time"),
    deadLetteredAt: row.dead_lettered_at === null ? null : toSafeInteger(row.dead_lettered_at, "webhook dead letter time"),
    lastErrorCode: row.last_error_code,
    createdAt: toSafeInteger(row.created_at, "webhook delivery creation time"),
    updatedAt: toSafeInteger(row.updated_at, "webhook delivery update time"),
  };
}

function mapEvent(row: EventRow): WebhookEvent {
  return {
    eventId: row.outbox_event_id,
    eventType: row.event_type,
    orderId: row.aggregate_id,
    orderVersion: toSafeInteger(row.aggregate_version, "webhook order version"),
    payloadJson: row.payload_json,
    payloadFingerprint: row.payload_fingerprint,
    createdAt: toSafeInteger(row.event_created_at, "webhook event time"),
  };
}

function mapTarget(row: {
  readonly target_id: string;
  readonly order_id: string;
  readonly api_client_id: string;
  readonly target_format: WebhookTargetFormat;
  readonly target_url: string;
  readonly allowed_origin: string;
  readonly url_fingerprint: string;
  readonly target_created_at: bigint | number;
}): WebhookTargetProjection {
  return {
    targetId: row.target_id,
    orderId: row.order_id,
    apiClientId: row.api_client_id,
    format: row.target_format,
    targetUrl: row.target_url,
    allowedOrigin: row.allowed_origin,
    urlFingerprint: row.url_fingerprint,
    createdAt: toSafeInteger(row.target_created_at, "webhook target time"),
  };
}

function mapAttempt(row: AttemptRow): WebhookAttempt {
  if (row.key_id === null) throw new Error("webhook attempt signing key is missing");
  return {
    attemptId: row.attempt_id,
    deliveryId: row.delivery_id,
    attemptNumber: toSafeInteger(row.attempt_number, "webhook attempt number"),
    leaseToken: row.lease_token,
    keyVersion: toSafeInteger(row.key_version, "webhook attempt key version"),
    keyId: row.key_id,
    requestTimestamp: toSafeInteger(row.request_timestamp, "webhook request timestamp"),
    requestBodyFingerprint: row.request_body_fingerprint,
    outcome: row.outcome,
    resolvedAddressesFingerprint: row.resolved_addresses_fingerprint,
    connectedAddress: row.connected_address,
    httpStatus: row.http_status === null ? null : toSafeInteger(row.http_status, "webhook HTTP status"),
    responseBytes: row.response_bytes === null ? null : toSafeInteger(row.response_bytes, "webhook response bytes"),
    responseFingerprint: row.response_fingerprint,
    ackCode: row.ack_code,
    errorCode: row.error_code,
    startedAt: toSafeInteger(row.started_at, "webhook attempt start time"),
    finishedAt: row.finished_at === null ? null : toSafeInteger(row.finished_at, "webhook attempt finish time"),
  };
}

function isTerminalAttemptOutcome(value: WebhookAttemptOutcome): value is Exclude<WebhookAttemptOutcome, "STARTED"> {
  return value !== "STARTED";
}

interface CompleteAttemptEvidence {
  readonly resolvedAddressesFingerprint: string | null;
  readonly connectedAddress: string | null;
  readonly httpStatus: number | null;
  readonly responseBytes: number | null;
  readonly responseFingerprint: string | null;
  readonly ackCode: string | null;
  readonly errorCode: string | null;
}

function validateCompleteAttemptEvidence(
  input: CompleteWebhookAttemptInput,
): CompleteAttemptEvidence {
  const evidence: CompleteAttemptEvidence = {
    resolvedAddressesFingerprint: input.resolvedAddressesFingerprint ?? null,
    connectedAddress: input.connectedAddress ?? null,
    httpStatus: input.httpStatus ?? null,
    responseBytes: input.responseBytes ?? null,
    responseFingerprint: input.responseFingerprint ?? null,
    ackCode: input.ackCode ?? null,
    errorCode: input.errorCode ?? null,
  };
  if (
    evidence.resolvedAddressesFingerprint !== null &&
    !FINGERPRINT_PATTERN.test(evidence.resolvedAddressesFingerprint)
  ) {
    throw new RangeError("webhook resolved-address fingerprint is invalid");
  }
  if (
    evidence.connectedAddress !== null &&
    (
      evidence.resolvedAddressesFingerprint === null ||
      isIP(evidence.connectedAddress) === 0 ||
      evidence.connectedAddress.length > 64
    )
  ) {
    throw new RangeError("webhook connected address is invalid");
  }
  if (
    evidence.httpStatus !== null &&
    (
      !Number.isSafeInteger(evidence.httpStatus) ||
      evidence.httpStatus < 100 ||
      evidence.httpStatus > 599
    )
  ) {
    throw new RangeError("webhook HTTP status is invalid");
  }
  if (
    evidence.responseBytes !== null &&
    (
      !Number.isSafeInteger(evidence.responseBytes) ||
      evidence.responseBytes < 0 ||
      evidence.responseBytes > MAX_WEBHOOK_RESPONSE_BYTES
    )
  ) {
    throw new RangeError("webhook response byte count is invalid");
  }
  if (
    evidence.responseFingerprint !== null &&
    !FINGERPRINT_PATTERN.test(evidence.responseFingerprint)
  ) {
    throw new RangeError("webhook response fingerprint is invalid");
  }
  for (const [name, value] of [
    ["ack code", evidence.ackCode],
    ["error code", evidence.errorCode],
  ] as const) {
    if (value !== null && !/^[a-z][a-z0-9_]{0,99}$/.test(value)) {
      throw new RangeError(`webhook ${name} is invalid`);
    }
  }
  const responseEvidence = [
    evidence.httpStatus,
    evidence.responseBytes,
    evidence.responseFingerprint,
  ].filter((value) => value !== null).length;
  if (responseEvidence !== 0 && responseEvidence !== 3) {
    throw new RangeError("webhook response evidence is incomplete");
  }
  if (evidence.ackCode !== null && responseEvidence !== 3) {
    throw new RangeError("webhook ACK evidence has no complete response");
  }
  if (input.outcome === "ACKNOWLEDGED") {
    if (
      evidence.httpStatus !== 200 ||
      evidence.ackCode !== "acknowledged" ||
      evidence.errorCode !== null ||
      evidence.resolvedAddressesFingerprint === null ||
      evidence.connectedAddress === null
    ) {
      throw new RangeError("acknowledged webhook attempt evidence is incomplete");
    }
  } else if (evidence.errorCode === null) {
    throw new RangeError("failed webhook attempt requires an error code");
  }
  return evidence;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} is invalid`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_V4_PATTERN.test(value)) throw new RangeError(`${label} is invalid`);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

function assertReason(value: string): void {
  if (!isValidWebhookReason(value)) {
    throw new RangeError("webhook replay reason is invalid");
  }
}

function assertActiveAllowedOrigin(value: string | null): void {
  if (value === null) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError("webhook active allowed origin is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new RangeError("webhook active allowed origin is invalid");
  }
}

function assertFingerprint(value: string, label: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) throw new RangeError(`${label} is invalid`);
}

function assertChangedOnce(changes: bigint | number, label: string): void {
  if (Number(changes) !== 1) throw new Error(`${label} changed an unexpected number of rows`);
}

function toSafeInteger(value: bigint | number, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside the safe integer range`);
  return result;
}
