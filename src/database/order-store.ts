import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";

import {
  CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
  IDEMPOTENCY_KEY_DIGEST_VERSION,
  MAX_REQUESTED_AMOUNT_CENTS,
  MAX_ORDER_CLOCK_AHEAD_MILLISECONDS,
  orderEventDetailsFingerprint,
  type AdminOrderCursor,
  type AdminOrderFilters,
  type AdminOrderEventProjection,
  type CheckoutSession,
  type CheckoutStatus,
  type CreateOrderRequest,
  type PaymentBasis,
  type PaymentOrder,
  type PaymentStatus,
  type RefundStatus,
} from "../orders/model.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../orders/checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "../orders/collection-profile.ts";
import {
  prepareWebhookTarget,
  WEBHOOK_TARGET_FINGERPRINT_VERSION,
  type PreparedWebhookTarget,
  type WebhookTargetErrorCode,
  type WebhookTargetFormat,
} from "../notifications/model.ts";
import type { AppDatabase } from "./database.ts";

const MAX_PAYABLE_AMOUNT_CENTS = MAX_REQUESTED_AMOUNT_CENTS + 1;
const EXPIRY_SWEEP_LIMIT = 256;
const DEFAULT_CHECKOUT_KEY_ROTATION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_CHECKOUT_TERMINAL_OBSERVATION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

export interface CollectionProfile {
  readonly profileId: string;
  readonly version: number;
  readonly providerAccountKey: "primary";
  readonly codePayload: string;
  readonly payloadFingerprint: string;
  readonly profileFingerprint: string;
  readonly evidencePolicy: "UNIQUE_AMOUNT_AUTO";
  readonly createdAt: number;
}

export interface StoredOrderAggregate {
  readonly order: PaymentOrder;
  readonly checkout: CheckoutSession;
  readonly collectionProfile: CollectionProfile;
  readonly webhookTarget: StoredWebhookTarget | null;
  readonly checkoutToken: string;
}

export interface StoredAdminOrder {
  readonly order: PaymentOrder;
  readonly webhookTarget: StoredWebhookTarget | null;
}

export interface StoredAdminOrderDetail extends StoredAdminOrder {
  readonly events: readonly AdminOrderEventProjection[];
}

export interface StoredAdminOrderPage {
  readonly orders: readonly StoredAdminOrder[];
  readonly nextCursor: AdminOrderCursor | null;
}

export interface StoredWebhookTarget {
  readonly targetId: string;
  readonly orderId: string;
  readonly apiClientId: string;
  readonly format: WebhookTargetFormat;
  readonly targetUrl: string;
  readonly allowedOrigin: string;
  readonly urlFingerprint: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: typeof WEBHOOK_TARGET_FINGERPRINT_VERSION;
  readonly createdAt: number;
}

export interface SyncCollectionProfileInput {
  readonly codePayload: string;
  readonly payloadFingerprint: string;
  readonly profileFingerprint: string;
}

export interface SyncCollectionProfileResult {
  readonly profile: CollectionProfile;
  readonly changed: boolean;
  readonly created: boolean;
  readonly previousProfileId: string | null;
  readonly activatedAt: number;
}

export interface CreateStoredOrderInput {
  readonly apiClientId: string;
  readonly request: CreateOrderRequest;
  readonly idempotencyKeyDigest: string;
  readonly requestFingerprint: string;
  readonly ttlMilliseconds: number;
  readonly amountOffsetMaximumCents: number;
  readonly webhookTarget?: PreparedWebhookTarget | null;
  readonly webhookTargetRejection?: {
    readonly url: string;
    readonly code: WebhookTargetErrorCode;
  } | undefined;
}

export type CreateStoredOrderResult =
  | { readonly kind: "created"; readonly aggregate: StoredOrderAggregate }
  | { readonly kind: "existing"; readonly aggregate: StoredOrderAggregate }
  | { readonly kind: "idempotency_conflict"; readonly orderId: string }
  | { readonly kind: "merchant_order_conflict"; readonly orderId: string }
  | {
      readonly kind: "webhook_target_rejected";
      readonly code: WebhookTargetErrorCode;
    }
  | {
      readonly kind: "amount_slots_exhausted";
      readonly retryAfterSeconds: number;
    };

export class OrderClockError extends Error {
  constructor() {
    super("the persisted order clock is too far ahead of the system clock");
    this.name = "OrderClockError";
  }
}

export class OrderStore {
  readonly #database: DatabaseOwner;
  readonly #physicalClock: (() => number) | undefined;
  readonly #checkoutKeyRotationMilliseconds: number;
  readonly #checkoutTerminalObservationMilliseconds: number;
  readonly #wallClockAnchorMs: number;
  readonly #monotonicAnchorMs: number;

  constructor(
    database: DatabaseOwner,
    physicalClock?: () => number,
    checkoutKeyRotationMilliseconds = DEFAULT_CHECKOUT_KEY_ROTATION_MILLISECONDS,
    checkoutTerminalObservationMilliseconds =
      DEFAULT_CHECKOUT_TERMINAL_OBSERVATION_MILLISECONDS,
  ) {
    assertPositiveSafeInteger(
      checkoutKeyRotationMilliseconds,
      "checkout token key rotation interval",
    );
    assertPositiveSafeInteger(
      checkoutTerminalObservationMilliseconds,
      "checkout terminal observation interval",
    );
    this.#database = database;
    this.#physicalClock = physicalClock;
    this.#checkoutKeyRotationMilliseconds = checkoutKeyRotationMilliseconds;
    this.#checkoutTerminalObservationMilliseconds = checkoutTerminalObservationMilliseconds;
    this.#wallClockAnchorMs = Date.now();
    this.#monotonicAnchorMs = performance.now();
  }

  syncCollectionProfile(input: SyncCollectionProfileInput): SyncCollectionProfileResult {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      const active = readActiveCollectionProfile(connection);
      if (active?.profileFingerprint === input.profileFingerprint) {
        return {
          profile: active,
          changed: false,
          created: false,
          previousProfileId: active.profileId,
          activatedAt: now,
        };
      }

      let profile = readCollectionProfileByFingerprint(connection, input.profileFingerprint);
      let created = false;
      if (!profile) {
        const versionRow = connection
          .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM collection_profiles")
          .get() as { version: bigint | number };
        const version = toSafeInteger(versionRow.version, "collection profile version");
        const profileId = randomUUID();
        const inserted = connection
          .prepare(
            `INSERT INTO collection_profiles(
               profile_id, version, provider_account_key, code_payload,
               payload_fingerprint, profile_fingerprint, evidence_policy, created_at
             ) VALUES (?, ?, 'primary', ?, ?, ?, 'UNIQUE_AMOUNT_AUTO', ?)`,
          )
          .run(
            profileId,
            version,
            input.codePayload,
            input.payloadFingerprint,
            input.profileFingerprint,
            now,
          );
        assertChangedOnce(inserted.changes, "collection profile insert");
        profile = readCollectionProfileById(connection, profileId);
        if (!profile) throw new Error("inserted collection profile cannot be read");
        created = true;
      }

      const activationTime = Math.max(now, active?.createdAt ?? 0);
      if (active) {
        const updated = connection
          .prepare(
            `UPDATE active_collection_profile
                SET profile_id = ?, activated_at = ?
              WHERE singleton_key = 1`,
          )
          .run(profile.profileId, activationTime);
        assertChangedOnce(updated.changes, "collection profile activation");
      } else {
        const inserted = connection
          .prepare(
            `INSERT INTO active_collection_profile(singleton_key, profile_id, activated_at)
             VALUES (1, ?, ?)`,
          )
          .run(profile.profileId, activationTime);
        assertChangedOnce(inserted.changes, "initial collection profile activation");
      }

      const activationSequenceRow = connection
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM collection_profile_activations",
        )
        .get() as { sequence: bigint | number };
      const activationInsert = connection
        .prepare(
          `INSERT INTO collection_profile_activations(
             activation_id, sequence, profile_id, previous_profile_id, activated_at, reason
           ) VALUES (?, ?, ?, ?, ?, 'CONFIG_SYNC')`,
        )
        .run(
          randomUUID(),
          toSafeInteger(activationSequenceRow.sequence, "profile activation sequence"),
          profile.profileId,
          active?.profileId ?? null,
          activationTime,
        );
      assertChangedOnce(activationInsert.changes, "collection profile activation history insert");

      return {
        profile,
        changed: true,
        created,
        previousProfileId: active?.profileId ?? null,
        activatedAt: activationTime,
      };
    });
  }

  createOrder(
    input: CreateStoredOrderInput,
    beforeCreate?: (() => void) | undefined,
  ): CreateStoredOrderResult {
    validateWebhookTargetInput(input);
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      expireDueOrders(connection, now, EXPIRY_SWEEP_LIMIT);

      let idempotent = readAggregateByIdempotencyDigest(
        connection,
        input.apiClientId,
        input.idempotencyKeyDigest,
      );
      if (idempotent) {
        if (
          idempotent.order.checkoutStatus === "OPEN" &&
          idempotent.order.expiresAt <= now
        ) {
          expireOrder(connection, idempotent.order.orderId, now);
          idempotent = readAggregateByIdempotencyDigest(
            connection,
            input.apiClientId,
            input.idempotencyKeyDigest,
          );
          if (!idempotent) throw new Error("expired idempotent order cannot be read");
        }
        if (
          idempotent.order.requestFingerprint !== input.requestFingerprint ||
          idempotent.order.requestFingerprintVersion !==
            CREATE_ORDER_REQUEST_FINGERPRINT_VERSION ||
          !sameWebhookTargetRequest(
            idempotent.webhookTarget,
            input.webhookTarget ?? null,
            input.webhookTargetRejection,
          )
        ) {
          return { kind: "idempotency_conflict", orderId: idempotent.order.orderId };
        }
        return { kind: "existing", aggregate: withCheckoutToken(connection, idempotent) };
      }

      beforeCreate?.();

      if (input.webhookTargetRejection) {
        return {
          kind: "webhook_target_rejected",
          code: input.webhookTargetRejection.code,
        };
      }

      const merchantOrder = readAggregateByMerchantOrderNumber(
        connection,
        input.apiClientId,
        input.request.merchant_order_no,
      );
      if (merchantOrder) {
        return { kind: "merchant_order_conflict", orderId: merchantOrder.order.orderId };
      }

      const profile = readActiveCollectionProfile(connection);
      if (!profile) throw new Error("collection profile is not initialized");

      const allocation = allocateAmountSlot(
        connection,
        input.request.amount_cents,
        input.amountOffsetMaximumCents,
        now,
      );
      if (allocation.kind === "exhausted") {
        return {
          kind: "amount_slots_exhausted",
          retryAfterSeconds: allocation.retryAfterSeconds,
        };
      }

      const expiresAt = now + input.ttlMilliseconds;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
        throw new RangeError("order expiry is outside the safe integer range");
      }

      const orderId = randomUUID();
      const checkoutId = randomUUID();
      const slotId = randomUUID();
      const key = readOrRotateActiveCheckoutTokenKey(
        connection,
        now,
        this.#checkoutKeyRotationMilliseconds,
      );
      const checkoutToken = deriveCheckoutToken(key.material, checkoutId);
      const tokenDigest = digestCheckoutToken(checkoutToken);

      const orderInsert = connection
        .prepare(
          `INSERT INTO payment_orders(
             order_id, api_client_id, merchant_order_no, idempotency_key_digest,
             idempotency_key_digest_version,
             request_fingerprint, request_fingerprint_version,
             webhook_target_request_fingerprint,
             requested_amount_cents, payable_amount_cents,
             allocation_offset_max_cents, received_amount_cents, currency,
             description, collection_profile_id, checkout_status, payment_status,
             refund_status, payment_basis, eligible_from, created_at, expires_at,
             closed_at, updated_at, version
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'CNY', ?, ?,
             'OPEN', 'UNPAID', 'NONE', 'NONE', ?, ?, ?, NULL, ?, 1
           )`,
        )
        .run(
          orderId,
          input.apiClientId,
          input.request.merchant_order_no,
          input.idempotencyKeyDigest,
          IDEMPOTENCY_KEY_DIGEST_VERSION,
          input.requestFingerprint,
          CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
          input.webhookTarget?.requestFingerprint ?? null,
          input.request.amount_cents,
          allocation.payableAmountCents,
          input.amountOffsetMaximumCents,
          input.request.description ?? null,
          profile.profileId,
          now,
          now,
          expiresAt,
          now,
        );
      assertChangedOnce(orderInsert.changes, "payment order insert");

      if (input.webhookTarget) {
        const targetInsert = connection
          .prepare(
            `INSERT INTO webhook_targets(
               target_id, order_id, api_client_id, target_format, target_url,
               allowed_origin, url_fingerprint, request_fingerprint,
               request_fingerprint_version, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            orderId,
            input.apiClientId,
            input.webhookTarget.format,
            input.webhookTarget.url,
            input.webhookTarget.allowedOrigin,
            input.webhookTarget.urlFingerprint,
            input.webhookTarget.requestFingerprint,
            input.webhookTarget.requestFingerprintVersion,
            now,
          );
        assertChangedOnce(targetInsert.changes, "webhook target insert");
      }

      const checkoutInsert = connection
        .prepare(
          `INSERT INTO checkout_sessions(
             checkout_id, order_id, token_digest, token_key_version,
             terminal_observation_milliseconds
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          checkoutId,
          orderId,
          tokenDigest,
          key.version,
          this.#checkoutTerminalObservationMilliseconds,
        );
      assertChangedOnce(checkoutInsert.changes, "checkout session insert");

      const slotInsert = connection
        .prepare(
          `INSERT INTO amount_slots(
             slot_id, order_id, collection_profile_id, payable_amount_cents,
             generation, occupied_from, released_at, release_reason
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          slotId,
          orderId,
          profile.profileId,
          allocation.payableAmountCents,
          allocation.generation,
          now,
        );
      assertChangedOnce(slotInsert.changes, "amount slot insert");

      insertOrderEvent(connection, {
        orderId,
        sequence: 1,
        type: "CREATED",
        occurredAt: now,
        details: {
          amount_offset_cents: allocation.payableAmountCents - input.request.amount_cents,
          slot_generation: allocation.generation,
        },
      });

      const aggregate = readAggregateById(connection, input.apiClientId, orderId);
      if (!aggregate) throw new Error("inserted order aggregate cannot be read");
      return {
        kind: "created",
        aggregate: { ...aggregate, checkoutToken },
      };
    });
  }

  orderById(apiClientId: string, orderId: string): StoredOrderAggregate | undefined {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      expireOrderByIdIfDue(connection, apiClientId, orderId, now);
      const aggregate = readAggregateById(connection, apiClientId, orderId);
      return aggregate ? withCheckoutToken(connection, aggregate) : undefined;
    });
  }

  orderByMerchantOrderNumber(
    apiClientId: string,
    merchantOrderNo: string,
  ): StoredOrderAggregate | undefined {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      const current = readAggregateByMerchantOrderNumber(connection, apiClientId, merchantOrderNo);
      if (!current) return undefined;
      expireOrderByIdIfDue(connection, apiClientId, current.order.orderId, now);
      const aggregate = readAggregateById(connection, apiClientId, current.order.orderId);
      return aggregate ? withCheckoutToken(connection, aggregate) : undefined;
    });
  }

  adminOrderPage(
    filters: AdminOrderFilters,
    cursor: AdminOrderCursor | null,
    limit: number,
  ): StoredAdminOrderPage {
    validateAdminOrderPageInput(filters, cursor, limit);
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      expireDueOrders(connection, now, EXPIRY_SWEEP_LIMIT);
      if (filters.checkoutStatus === "EXPIRED") {
        let rows = readExpiredAdminOrderRows(
          connection,
          filters.paymentStatus,
          cursor,
          now,
          limit + 1,
        );
        let expiredSelectedOrder = false;
        for (const row of rows) {
          if (
            row.checkout_status === "OPEN" &&
            toSafeInteger(row.expires_at, "order expiry") <= now
          ) {
            expireOrder(connection, row.order_id, now);
            expiredSelectedOrder = true;
          }
        }
        if (expiredSelectedOrder) {
          rows = readExpiredAdminOrderRows(
            connection,
            filters.paymentStatus,
            cursor,
            now,
            limit + 1,
          );
        }
        return buildStoredAdminOrderPage(rows, limit);
      }

      const where: string[] = [];
      const parameters: Array<string | number> = [];
      if (filters.checkoutStatus !== null) {
        if (filters.checkoutStatus === "OPEN") {
          where.push("orders.checkout_status = 'OPEN' AND orders.expires_at > ?");
          parameters.push(now);
        } else {
          where.push("orders.checkout_status = 'CLOSED'");
        }
      }
      if (filters.paymentStatus !== null) {
        where.push("orders.payment_status = ?");
        parameters.push(filters.paymentStatus);
      }
      if (cursor !== null) {
        where.push("(orders.created_at, orders.order_id) < (?, ?)");
        parameters.push(cursor.createdAt, cursor.orderId);
      }
      const statement = connection.prepare(
        `${AGGREGATE_SELECT}
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY orders.created_at DESC, orders.order_id DESC
         LIMIT ?`,
      );
      const readRows = () =>
        statement.all(...parameters, limit + 1) as unknown as AggregateRow[];
      let rows = readRows();
      let expiredSelectedOrder = false;
      for (const row of rows) {
        if (
          row.checkout_status === "OPEN" &&
          toSafeInteger(row.expires_at, "order expiry") <= now
        ) {
          expireOrder(connection, row.order_id, now);
          expiredSelectedOrder = true;
        }
      }
      if (expiredSelectedOrder) rows = readRows();
      return buildStoredAdminOrderPage(rows, limit);
    });
  }

  adminOrderById(orderId: string): StoredAdminOrderDetail | undefined {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      let aggregate = readAggregateByAdminId(connection, orderId);
      if (!aggregate) return undefined;
      expireOrderByIdIfDue(connection, aggregate.order.apiClientId, orderId, now);
      aggregate = readAggregateByAdminId(connection, orderId);
      if (!aggregate) throw new Error("administrator order aggregate cannot be read");
      return {
        ...mapStoredAdminOrder(aggregate),
        events: readAdminOrderEvents(connection, orderId),
      };
    });
  }

  adminOrderByMerchantOrderNumber(
    apiClientId: string,
    merchantOrderNo: string,
  ): StoredAdminOrderDetail | undefined {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      let aggregate = readAggregateByMerchantOrderNumber(connection, apiClientId, merchantOrderNo);
      if (!aggregate) return undefined;
      expireOrderByIdIfDue(connection, apiClientId, aggregate.order.orderId, now);
      aggregate = readAggregateByMerchantOrderNumber(connection, apiClientId, merchantOrderNo);
      if (!aggregate) throw new Error("administrator merchant order aggregate cannot be read");
      return {
        ...mapStoredAdminOrder(aggregate),
        events: readAdminOrderEvents(connection, aggregate.order.orderId),
      };
    });
  }

  closeOrder(apiClientId: string, orderId: string): StoredOrderAggregate | undefined {
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      let aggregate = readAggregateById(connection, apiClientId, orderId);
      if (!aggregate) return undefined;

      if (aggregate.order.checkoutStatus === "OPEN") {
        if (aggregate.order.expiresAt <= now) {
          expireOrder(connection, aggregate.order.orderId, now);
        } else {
          const result = connection
            .prepare(
              `UPDATE payment_orders
                  SET checkout_status = 'CLOSED',
                      closed_at = ?,
                      updated_at = ?,
                      version = version + 1
                WHERE order_id = ?
                  AND api_client_id = ?
                  AND checkout_status = 'OPEN'
                  AND expires_at > ?`,
            )
            .run(now, now, orderId, apiClientId, now);
          assertChangedOnce(result.changes, "checkout close");
          insertOrderEvent(connection, {
            orderId,
            sequence: aggregate.order.version + 1,
            type: "CHECKOUT_CLOSED",
            occurredAt: now,
            details: { reason: "api_request" },
          });
        }
        aggregate = readAggregateById(connection, apiClientId, orderId);
        if (!aggregate) throw new Error("closed order aggregate cannot be read");
      }
      return withCheckoutToken(connection, aggregate);
    });
  }

  publicCheckoutByTokenDigest(tokenDigest: string): StoredOrderAggregate | undefined {
    const current = this.#database.read((connection) => {
      const aggregate = readAggregateByTokenDigest(connection, tokenDigest);
      if (!aggregate) return { kind: "missing" } as const;
      const logicalNow = readOrderClock(connection);
      if (
        aggregate.order.checkoutStatus !== "OPEN" &&
        !isTerminalCheckoutObservable(aggregate, logicalNow)
      ) {
        return { kind: "missing" } as const;
      }
      const physicalNow = this.#readPhysicalTime(connection);
      assertOrderClockIsUsable(logicalNow, physicalNow);
      const now = Math.max(logicalNow, physicalNow);
      if (aggregate.order.checkoutStatus !== "OPEN") {
        return isTerminalCheckoutObservable(aggregate, now)
          ? { kind: "current", aggregate: withCheckoutToken(connection, aggregate) } as const
          : { kind: "terminal" } as const;
      }
      if (aggregate.order.expiresAt > now) {
        return { kind: "current", aggregate: withCheckoutToken(connection, aggregate) } as const;
      }
      return { kind: "expired" } as const;
    });
    if (current.kind === "missing") return undefined;
    if (current.kind === "current") return current.aggregate;

    // Terminal reads advance the persisted logical clock. Once the observation
    // window has elapsed, a later system-clock rollback cannot revive the link.
    return this.#database.write((connection) => {
      const now = this.#logicalNow(connection);
      let aggregate = readAggregateByTokenDigest(connection, tokenDigest);
      if (!aggregate) return undefined;
      if (aggregate.order.checkoutStatus === "OPEN" && aggregate.order.expiresAt <= now) {
        expireOrder(connection, aggregate.order.orderId, now);
        aggregate = readAggregateByTokenDigest(connection, tokenDigest);
        if (!aggregate) throw new Error("expired checkout aggregate cannot be read");
      }
      if (
        aggregate.order.checkoutStatus !== "OPEN" &&
        !isTerminalCheckoutObservable(aggregate, now)
      ) {
        return undefined;
      }
      return withCheckoutToken(connection, aggregate);
    });
  }

  #logicalNow(connection: DatabaseSync): number {
    const physicalNow = this.#readPhysicalTime(connection);
    assertOrderClockIsUsable(readOrderClock(connection), physicalNow);
    const row = connection
      .prepare(
        `UPDATE order_clock
            SET last_now_ms = max(last_now_ms, ?)
          WHERE singleton_key = 1
          RETURNING last_now_ms`,
      )
      .get(physicalNow) as { last_now_ms: bigint | number } | undefined;
    if (!row) throw new Error("order clock is not initialized");
    return toSafeInteger(row.last_now_ms, "logical order time");
  }

  #readPhysicalTime(connection: DatabaseSync): number {
    const physicalNow = this.#physicalClock ? this.#physicalClock() : readDatabaseTime(connection);
    if (!Number.isSafeInteger(physicalNow) || physicalNow < 0) {
      throw new RangeError("order clock must return a non-negative safe integer");
    }
    if (!this.#physicalClock) {
      const expectedPhysical =
        this.#wallClockAnchorMs + (performance.now() - this.#monotonicAnchorMs);
      if (Math.abs(physicalNow - expectedPhysical) > MAX_ORDER_CLOCK_AHEAD_MILLISECONDS) {
        throw new OrderClockError();
      }
    }
    return physicalNow;
  }
}

function assertOrderClockIsUsable(logicalNow: number, physicalNow: number): void {
  if (logicalNow - physicalNow > MAX_ORDER_CLOCK_AHEAD_MILLISECONDS) {
    throw new OrderClockError();
  }
}

type AmountAllocationResult =
  | {
      readonly kind: "allocated";
      readonly payableAmountCents: number;
      readonly generation: number;
    }
  | {
      readonly kind: "exhausted";
      readonly retryAfterSeconds: number;
    };

function allocateAmountSlot(
  connection: DatabaseSync,
  requestedAmountCents: number,
  maximumOffsetCents: number,
  now: number,
): AmountAllocationResult {
  let earliestAvailableAt: number | undefined;
  for (let offset = 1; offset <= maximumOffsetCents; offset += 1) {
    const payableAmountCents = requestedAmountCents + offset;
    if (payableAmountCents > MAX_PAYABLE_AMOUNT_CENTS) break;

    const open = connection
      .prepare(
        `SELECT order_id, expires_at
           FROM payment_orders
          WHERE payable_amount_cents = ? AND checkout_status = 'OPEN'`,
      )
      .get(payableAmountCents) as
      | { order_id: string; expires_at: bigint | number }
      | undefined;
    if (open) {
      const expiresAt = toSafeInteger(open.expires_at, "order expiry");
      if (expiresAt <= now) {
        expireOrder(connection, open.order_id, now);
      } else {
        earliestAvailableAt = minimumDefined(earliestAvailableAt, expiresAt);
        continue;
      }
    }

    const latest = connection
      .prepare(
        `SELECT generation, released_at
           FROM amount_slots
          WHERE payable_amount_cents = ?
          ORDER BY generation DESC
          LIMIT 1`,
      )
      .get(payableAmountCents) as
      | { generation: bigint | number; released_at: bigint | number | null }
      | undefined;
    if (latest?.released_at === null) {
      throw new Error("active amount slot is detached from its open order");
    }
    if (latest !== undefined) {
      const releasedAt = toSafeInteger(latest.released_at, "amount slot release time");
      if (releasedAt > now) {
        earliestAvailableAt = minimumDefined(earliestAvailableAt, releasedAt);
        continue;
      }
    }
    const generation = latest
      ? toSafeInteger(latest.generation, "amount slot generation") + 1
      : 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("amount slot generation is outside the safe integer range");
    }
    return { kind: "allocated", payableAmountCents, generation };
  }
  if (earliestAvailableAt === undefined || earliestAvailableAt <= now) {
    throw new Error("exhausted amount slots have no future release time");
  }
  return {
    kind: "exhausted",
    retryAfterSeconds: Math.max(1, Math.ceil((earliestAvailableAt - now) / 1_000)),
  };
}

function minimumDefined(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

function expireDueOrders(connection: DatabaseSync, now: number, limit: number): void {
  const rows = connection
    .prepare(
      `SELECT order_id
         FROM payment_orders
        WHERE checkout_status = 'OPEN' AND expires_at <= ?
        ORDER BY expires_at, order_id
        LIMIT ?`,
    )
    .all(now, limit) as Array<{ order_id: string }>;
  for (const row of rows) expireOrder(connection, row.order_id, now);
}

function expireOrderByIdIfDue(
  connection: DatabaseSync,
  apiClientId: string,
  orderId: string,
  now: number,
): void {
  const row = connection
    .prepare(
      `SELECT expires_at
         FROM payment_orders
        WHERE order_id = ? AND api_client_id = ? AND checkout_status = 'OPEN'`,
    )
    .get(orderId, apiClientId) as { expires_at: bigint | number } | undefined;
  if (row && toSafeInteger(row.expires_at, "order expiry") <= now) {
    expireOrder(connection, orderId, now);
  }
}

function expireOrder(connection: DatabaseSync, orderId: string, now: number): void {
  const row = connection
    .prepare(
      `SELECT version, expires_at
         FROM payment_orders
        WHERE order_id = ? AND checkout_status = 'OPEN'`,
    )
    .get(orderId) as
    | { version: bigint | number; expires_at: bigint | number }
    | undefined;
  if (!row || toSafeInteger(row.expires_at, "order expiry") > now) return;
  const sequence = toSafeInteger(row.version, "order version") + 1;
  const result = connection
    .prepare(
      `UPDATE payment_orders
          SET checkout_status = 'EXPIRED',
              closed_at = ?,
              updated_at = ?,
              version = version + 1
        WHERE order_id = ?
          AND checkout_status = 'OPEN'
          AND expires_at <= ?`,
    )
    .run(now, now, orderId, now);
  assertChangedOnce(result.changes, "checkout expiry");
  insertOrderEvent(connection, {
    orderId,
    sequence,
    type: "CHECKOUT_EXPIRED",
    occurredAt: now,
    details: { reason: "ttl_elapsed" },
  });
}

function insertOrderEvent(
  connection: DatabaseSync,
  input: {
    readonly orderId: string;
    readonly sequence: number;
    readonly type: "CREATED" | "CHECKOUT_CLOSED" | "CHECKOUT_EXPIRED";
    readonly occurredAt: number;
    readonly details: Readonly<Record<string, unknown>>;
  },
): void {
  const detailsJson = JSON.stringify(input.details);
  const result = connection
    .prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at,
         details_json, details_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.orderId,
      input.sequence,
      input.type,
      input.occurredAt,
      detailsJson,
      orderEventDetailsFingerprint(detailsJson),
    );
  assertChangedOnce(result.changes, "order event insert");
}

type AggregateRow = {
  order_id: string;
  api_client_id: string;
  merchant_order_no: string;
  idempotency_key_digest: string;
  idempotency_key_digest_version: bigint | number;
  request_fingerprint: string;
  request_fingerprint_version: bigint | number;
  requested_amount_cents: bigint | number;
  payable_amount_cents: bigint | number;
  allocation_offset_max_cents: bigint | number;
  received_amount_cents: bigint | number | null;
  currency: "CNY";
  description: string | null;
  collection_profile_id: string;
  checkout_status: CheckoutStatus;
  payment_status: PaymentStatus;
  refund_status: RefundStatus;
  payment_basis: PaymentBasis;
  eligible_from: bigint | number;
  created_at: bigint | number;
  expires_at: bigint | number;
  closed_at: bigint | number | null;
  updated_at: bigint | number;
  order_version: bigint | number;
  checkout_id: string;
  token_digest: string;
  token_key_version: bigint | number;
  terminal_observation_milliseconds: bigint | number;
  profile_version: bigint | number;
  provider_account_key: "primary";
  code_payload: string;
  payload_fingerprint: string;
  profile_fingerprint: string;
  evidence_policy: "UNIQUE_AMOUNT_AUTO";
  profile_created_at: bigint | number;
  webhook_target_request_fingerprint: string | null;
  target_id: string | null;
  target_format: WebhookTargetFormat | null;
  target_url: string | null;
  target_allowed_origin: string | null;
  target_url_fingerprint: string | null;
  target_request_fingerprint: string | null;
  target_request_fingerprint_version: bigint | number | null;
  target_created_at: bigint | number | null;
};

const AGGREGATE_SELECT = `
  SELECT
    orders.order_id,
    orders.api_client_id,
    orders.merchant_order_no,
    orders.idempotency_key_digest,
    orders.idempotency_key_digest_version,
    orders.request_fingerprint,
    orders.request_fingerprint_version,
    orders.requested_amount_cents,
    orders.payable_amount_cents,
    orders.allocation_offset_max_cents,
    orders.received_amount_cents,
    orders.currency,
    orders.description,
    orders.collection_profile_id,
    orders.checkout_status,
    orders.payment_status,
    orders.refund_status,
    orders.payment_basis,
    orders.eligible_from,
    orders.created_at,
    orders.expires_at,
    orders.closed_at,
    orders.updated_at,
    orders.version AS order_version,
    checkout.checkout_id,
    checkout.token_digest,
    checkout.token_key_version,
    checkout.terminal_observation_milliseconds,
    profile.version AS profile_version,
    profile.provider_account_key,
    profile.code_payload,
    profile.payload_fingerprint,
    profile.profile_fingerprint,
    profile.evidence_policy,
    profile.created_at AS profile_created_at,
    orders.webhook_target_request_fingerprint,
    target.target_id,
    target.target_format,
    target.target_url,
    target.allowed_origin AS target_allowed_origin,
    target.url_fingerprint AS target_url_fingerprint,
    target.request_fingerprint AS target_request_fingerprint,
    target.request_fingerprint_version AS target_request_fingerprint_version,
    target.created_at AS target_created_at
  FROM payment_orders AS orders
  JOIN checkout_sessions AS checkout ON checkout.order_id = orders.order_id
  JOIN collection_profiles AS profile ON profile.profile_id = orders.collection_profile_id
  LEFT JOIN webhook_targets AS target ON target.order_id = orders.order_id
`;

const ADMIN_ORDER_CHECKOUT_SELECT = AGGREGATE_SELECT.replace(
  "FROM payment_orders AS orders",
  "FROM payment_orders AS orders INDEXED BY payment_orders_checkout_created_idx",
);

const ADMIN_ORDER_CHECKOUT_PAYMENT_SELECT = AGGREGATE_SELECT.replace(
  "FROM payment_orders AS orders",
  "FROM payment_orders AS orders INDEXED BY payment_orders_checkout_payment_created_idx",
);

function readExpiredAdminOrderRows(
  connection: DatabaseSync,
  paymentStatus: PaymentStatus | null,
  cursor: AdminOrderCursor | null,
  now: number,
  limit: number,
): AggregateRow[] {
  const storedExpired = readAdminOrderCheckoutBranch(
    connection,
    "EXPIRED",
    paymentStatus,
    cursor,
    null,
    limit,
  );
  const overdueOpen = readAdminOrderCheckoutBranch(
    connection,
    "OPEN",
    paymentStatus,
    cursor,
    now,
    limit,
  );
  return mergeAdminOrderRows(storedExpired, overdueOpen, limit);
}

function readAdminOrderCheckoutBranch(
  connection: DatabaseSync,
  checkoutStatus: "OPEN" | "EXPIRED",
  paymentStatus: PaymentStatus | null,
  cursor: AdminOrderCursor | null,
  expiresAtMaximum: number | null,
  limit: number,
): AggregateRow[] {
  const where = ["orders.checkout_status = ?"];
  const parameters: Array<string | number> = [checkoutStatus];
  if (expiresAtMaximum !== null) {
    where.push("orders.expires_at <= ?");
    parameters.push(expiresAtMaximum);
  }
  if (paymentStatus !== null) {
    where.push("orders.payment_status = ?");
    parameters.push(paymentStatus);
  }
  if (cursor !== null) {
    where.push("(orders.created_at, orders.order_id) < (?, ?)");
    parameters.push(cursor.createdAt, cursor.orderId);
  }
  const aggregateSelect = paymentStatus === null
    ? ADMIN_ORDER_CHECKOUT_SELECT
    : ADMIN_ORDER_CHECKOUT_PAYMENT_SELECT;
  return connection
    .prepare(
      `${aggregateSelect}
       WHERE ${where.join(" AND ")}
       ORDER BY orders.created_at DESC, orders.order_id DESC
       LIMIT ?`,
    )
    .all(...parameters, limit) as unknown as AggregateRow[];
}

function mergeAdminOrderRows(
  left: readonly AggregateRow[],
  right: readonly AggregateRow[],
  limit: number,
): AggregateRow[] {
  const merged: AggregateRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (merged.length < limit && (leftIndex < left.length || rightIndex < right.length)) {
    const leftRow = left[leftIndex];
    const rightRow = right[rightIndex];
    if (
      leftRow !== undefined &&
      (rightRow === undefined || compareAdminOrderRows(leftRow, rightRow) <= 0)
    ) {
      merged.push(leftRow);
      leftIndex += 1;
    } else if (rightRow !== undefined) {
      merged.push(rightRow);
      rightIndex += 1;
    }
  }
  return merged;
}

function compareAdminOrderRows(left: AggregateRow, right: AggregateRow): number {
  const leftCreatedAt = toSafeInteger(left.created_at, "administrator order creation time");
  const rightCreatedAt = toSafeInteger(right.created_at, "administrator order creation time");
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt > rightCreatedAt ? -1 : 1;
  if (left.order_id === right.order_id) return 0;
  return left.order_id > right.order_id ? -1 : 1;
}

function buildStoredAdminOrderPage(
  rows: readonly AggregateRow[],
  limit: number,
): StoredAdminOrderPage {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return Object.freeze({
    orders: Object.freeze(selected.map((row) => mapStoredAdminOrder(mapAggregate(row)))),
    nextCursor: rows.length > limit && last
      ? Object.freeze({
          createdAt: toSafeInteger(last.created_at, "administrator order cursor time"),
          orderId: last.order_id,
        })
      : null,
  });
}

function readAggregateById(
  connection: DatabaseSync,
  apiClientId: string,
  orderId: string,
): Omit<StoredOrderAggregate, "checkoutToken"> | undefined {
  const row = connection
    .prepare(`${AGGREGATE_SELECT} WHERE orders.api_client_id = ? AND orders.order_id = ?`)
    .get(apiClientId, orderId) as AggregateRow | undefined;
  return row ? mapAggregate(row) : undefined;
}

function readAggregateByAdminId(
  connection: DatabaseSync,
  orderId: string,
): Omit<StoredOrderAggregate, "checkoutToken"> | undefined {
  const row = connection
    .prepare(`${AGGREGATE_SELECT} WHERE orders.order_id = ?`)
    .get(orderId) as AggregateRow | undefined;
  return row ? mapAggregate(row) : undefined;
}

function readAggregateByMerchantOrderNumber(
  connection: DatabaseSync,
  apiClientId: string,
  merchantOrderNo: string,
): Omit<StoredOrderAggregate, "checkoutToken"> | undefined {
  const row = connection
    .prepare(
      `${AGGREGATE_SELECT}
       WHERE orders.api_client_id = ? AND orders.merchant_order_no = ?`,
    )
    .get(apiClientId, merchantOrderNo) as AggregateRow | undefined;
  return row ? mapAggregate(row) : undefined;
}

function readAggregateByIdempotencyDigest(
  connection: DatabaseSync,
  apiClientId: string,
  digest: string,
): Omit<StoredOrderAggregate, "checkoutToken"> | undefined {
  const row = connection
    .prepare(
      `${AGGREGATE_SELECT}
       WHERE orders.api_client_id = ? AND orders.idempotency_key_digest = ?`,
    )
    .get(apiClientId, digest) as AggregateRow | undefined;
  return row ? mapAggregate(row) : undefined;
}

function readAggregateByTokenDigest(
  connection: DatabaseSync,
  digest: string,
): Omit<StoredOrderAggregate, "checkoutToken"> | undefined {
  const row = connection
    .prepare(`${AGGREGATE_SELECT} WHERE checkout.token_digest = ?`)
    .get(digest) as AggregateRow | undefined;
  return row ? mapAggregate(row) : undefined;
}

function mapAggregate(row: AggregateRow): Omit<StoredOrderAggregate, "checkoutToken"> {
  const idempotencyDigestVersion = toSafeInteger(
    row.idempotency_key_digest_version,
    "idempotency key digest version",
  );
  if (idempotencyDigestVersion !== IDEMPOTENCY_KEY_DIGEST_VERSION) {
    throw new Error(`unsupported idempotency key digest version ${idempotencyDigestVersion}`);
  }
  const fingerprintVersion = toSafeInteger(
    row.request_fingerprint_version,
    "request fingerprint version",
  );
  if (fingerprintVersion !== CREATE_ORDER_REQUEST_FINGERPRINT_VERSION) {
    throw new Error(`unsupported request fingerprint version ${fingerprintVersion}`);
  }
  const order: PaymentOrder = {
    orderId: row.order_id,
    apiClientId: row.api_client_id,
    merchantOrderNo: row.merchant_order_no,
    idempotencyKeyDigest: row.idempotency_key_digest,
    idempotencyKeyDigestVersion: IDEMPOTENCY_KEY_DIGEST_VERSION,
    requestFingerprint: row.request_fingerprint,
    requestFingerprintVersion: CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
    requestedAmountCents: toSafeInteger(row.requested_amount_cents, "requested amount"),
    payableAmountCents: toSafeInteger(row.payable_amount_cents, "payable amount"),
    allocationOffsetMaximumCents: toSafeInteger(
      row.allocation_offset_max_cents,
      "allocation offset maximum",
    ),
    receivedAmountCents: nullableSafeInteger(row.received_amount_cents, "received amount"),
    currency: row.currency,
    description: row.description,
    collectionProfileId: row.collection_profile_id,
    checkoutStatus: row.checkout_status,
    paymentStatus: row.payment_status,
    refundStatus: row.refund_status,
    paymentBasis: row.payment_basis,
    eligibleFrom: toSafeInteger(row.eligible_from, "eligible time"),
    createdAt: toSafeInteger(row.created_at, "created time"),
    expiresAt: toSafeInteger(row.expires_at, "expiry time"),
    closedAt: nullableSafeInteger(row.closed_at, "checkout end time"),
    updatedAt: toSafeInteger(row.updated_at, "updated time"),
    version: toSafeInteger(row.order_version, "order version"),
  };
  return {
    order,
    checkout: {
      checkoutId: row.checkout_id,
      orderId: row.order_id,
      tokenDigest: row.token_digest,
      tokenKeyVersion: toSafeInteger(row.token_key_version, "checkout token key version"),
      terminalObservationMilliseconds: toSafeInteger(
        row.terminal_observation_milliseconds,
        "checkout terminal observation interval",
      ),
    },
    collectionProfile: {
      profileId: row.collection_profile_id,
      version: toSafeInteger(row.profile_version, "collection profile version"),
      providerAccountKey: row.provider_account_key,
      codePayload: row.code_payload,
      payloadFingerprint: row.payload_fingerprint,
      profileFingerprint: row.profile_fingerprint,
      evidencePolicy: row.evidence_policy,
      createdAt: toSafeInteger(row.profile_created_at, "collection profile creation time"),
    },
    webhookTarget: mapWebhookTarget(row),
  };
}

function mapStoredAdminOrder(
  aggregate: Omit<StoredOrderAggregate, "checkoutToken">,
): StoredAdminOrder {
  return Object.freeze({
    order: aggregate.order,
    webhookTarget: aggregate.webhookTarget,
  });
}

type AdminOrderEventRow = {
  readonly event_id: string;
  readonly sequence: bigint | number;
  readonly event_type: AdminOrderEventProjection["eventType"];
  readonly occurred_at: bigint | number;
  readonly details_json: string;
};

function readAdminOrderEvents(
  connection: DatabaseSync,
  orderId: string,
): readonly AdminOrderEventProjection[] {
  const rows = connection
    .prepare(
      `SELECT event_id, sequence, event_type, occurred_at, details_json
         FROM order_events
        WHERE order_id = ?
        ORDER BY sequence`,
    )
    .all(orderId) as unknown as AdminOrderEventRow[];
  return Object.freeze(rows.map((row) => Object.freeze({
    eventId: row.event_id,
    sequence: toSafeInteger(row.sequence, "administrator order event sequence"),
    eventType: row.event_type,
    occurredAt: toSafeInteger(row.occurred_at, "administrator order event time"),
    detailsJson: row.details_json,
  })));
}

function mapWebhookTarget(row: AggregateRow): StoredWebhookTarget | null {
  const values = [
    row.target_id,
    row.target_format,
    row.target_url,
    row.target_allowed_origin,
    row.target_url_fingerprint,
    row.target_request_fingerprint,
    row.target_request_fingerprint_version,
    row.target_created_at,
  ];
  if (values.every((value) => value === null)) {
    if (row.webhook_target_request_fingerprint !== null) {
      throw new Error("webhook target commitment has no target");
    }
    return null;
  }
  if (row.webhook_target_request_fingerprint === null) {
    throw new Error("webhook target has no order commitment");
  }
  if (values.some((value) => value === null)) {
    throw new Error("webhook target projection is incomplete");
  }
  const prepared = prepareWebhookTarget(
    row.target_url as string,
    row.target_allowed_origin as string,
  );
  if (
    row.target_format !== prepared.format ||
    row.target_url_fingerprint !== prepared.urlFingerprint ||
    row.target_request_fingerprint !== prepared.requestFingerprint ||
    row.webhook_target_request_fingerprint !== prepared.requestFingerprint ||
    toSafeInteger(
      row.target_request_fingerprint_version as bigint | number,
      "webhook target fingerprint version",
    ) !== prepared.requestFingerprintVersion
  ) {
    throw new Error("webhook target fingerprints do not match its URL");
  }
  return {
    targetId: row.target_id as string,
    orderId: row.order_id,
    apiClientId: row.api_client_id,
    format: prepared.format,
    targetUrl: prepared.url,
    allowedOrigin: prepared.allowedOrigin,
    urlFingerprint: prepared.urlFingerprint,
    requestFingerprint: prepared.requestFingerprint,
    requestFingerprintVersion: prepared.requestFingerprintVersion,
    createdAt: toSafeInteger(row.target_created_at as bigint | number, "webhook target time"),
  };
}

function sameWebhookTarget(
  stored: StoredWebhookTarget | null,
  requested: PreparedWebhookTarget | null,
): boolean {
  if (!stored || !requested) return stored === null && requested === null;
  return stored.format === requested.format &&
    stored.targetUrl === requested.url &&
    stored.allowedOrigin === requested.allowedOrigin &&
    stored.urlFingerprint === requested.urlFingerprint &&
    stored.requestFingerprint === requested.requestFingerprint &&
    stored.requestFingerprintVersion === requested.requestFingerprintVersion;
}

function sameWebhookTargetRequest(
  stored: StoredWebhookTarget | null,
  requested: PreparedWebhookTarget | null,
  rejected: CreateStoredOrderInput["webhookTargetRejection"],
): boolean {
  if (!rejected) return sameWebhookTarget(stored, requested);
  if (!stored || requested) return false;
  try {
    return sameWebhookTarget(
      stored,
      prepareWebhookTarget(rejected.url, stored.allowedOrigin),
    );
  } catch {
    return false;
  }
}

function validateWebhookTargetInput(input: CreateStoredOrderInput): void {
  const requestedUrl = input.request.notify_url ?? null;
  const target = input.webhookTarget ?? null;
  const rejected = input.webhookTargetRejection;
  if (target && rejected) {
    throw new RangeError("order webhook target input is ambiguous");
  }
  if (requestedUrl === null) {
    if (target || rejected) throw new RangeError("order webhook target has no request URL");
    return;
  }
  if (rejected) {
    if (rejected.url !== requestedUrl) {
      throw new RangeError("rejected order webhook target does not match the request");
    }
    return;
  }
  if (!target) throw new RangeError("order webhook target is missing");
  const prepared = prepareWebhookTarget(requestedUrl, target.allowedOrigin);
  if (
    target.format !== prepared.format ||
    target.url !== prepared.url ||
    target.allowedOrigin !== prepared.allowedOrigin ||
    target.urlFingerprint !== prepared.urlFingerprint ||
    target.requestFingerprint !== prepared.requestFingerprint ||
    target.requestFingerprintVersion !== prepared.requestFingerprintVersion
  ) {
    throw new RangeError("order webhook target does not match the request");
  }
}

function withCheckoutToken(
  connection: DatabaseSync,
  aggregate: Omit<StoredOrderAggregate, "checkoutToken">,
): StoredOrderAggregate {
  const checkoutToken = deriveCheckoutToken(
    readCheckoutTokenKey(connection, aggregate.checkout.tokenKeyVersion),
    aggregate.checkout.checkoutId,
  );
  if (digestCheckoutToken(checkoutToken) !== aggregate.checkout.tokenDigest) {
    throw new Error("checkout token key does not match the persisted token digest");
  }
  return {
    ...aggregate,
    checkoutToken,
  };
}

interface CheckoutTokenKey {
  readonly version: number;
  readonly material: Buffer;
  readonly activatedAt: number;
}

function readCheckoutTokenKey(connection: DatabaseSync, version: number): Buffer {
  const row = connection
    .prepare("SELECT key_material FROM checkout_token_keys WHERE key_version = ?")
    .get(version) as { key_material: Uint8Array } | undefined;
  if (!row || !(row.key_material instanceof Uint8Array) || row.key_material.byteLength !== 32) {
    throw new Error(`checkout token key version ${version} is missing or invalid`);
  }
  return Buffer.from(row.key_material);
}

function readOrRotateActiveCheckoutTokenKey(
  connection: DatabaseSync,
  now: number,
  rotationMilliseconds: number,
): CheckoutTokenKey {
  const row = connection
    .prepare(
      `SELECT key_version, key_material, activated_at
         FROM checkout_token_keys
        WHERE retired_at IS NULL`,
    )
    .get() as
      | {
          key_version: bigint | number;
          key_material: Uint8Array;
          activated_at: bigint | number;
        }
      | undefined;
  if (!row || !(row.key_material instanceof Uint8Array) || row.key_material.byteLength !== 32) {
    throw new Error("active checkout token key is missing or invalid");
  }

  const current: CheckoutTokenKey = {
    version: toSafeInteger(row.key_version, "checkout token key version"),
    material: Buffer.from(row.key_material),
    activatedAt: toSafeInteger(row.activated_at, "checkout token key activation time"),
  };
  if (now - current.activatedAt < rotationMilliseconds) return current;

  const nextVersion = current.version + 1;
  if (!Number.isSafeInteger(nextVersion)) {
    throw new Error("checkout token key version is outside the safe integer range");
  }
  const retired = connection
    .prepare(
      `UPDATE checkout_token_keys
          SET retired_at = ?
        WHERE key_version = ? AND retired_at IS NULL`,
    )
    .run(now, current.version);
  assertChangedOnce(retired.changes, "checkout token key retirement");

  const material = randomBytes(32);
  const inserted = connection
    .prepare(
      `INSERT INTO checkout_token_keys(
         key_version, key_material, activated_at, retired_at
       ) VALUES (?, ?, ?, NULL)`,
    )
    .run(nextVersion, material, now);
  assertChangedOnce(inserted.changes, "checkout token key rotation");
  return { version: nextVersion, material, activatedAt: now };
}

function isTerminalCheckoutObservable(
  aggregate: Omit<StoredOrderAggregate, "checkoutToken">,
  now: number,
): boolean {
  const closedAt = aggregate.order.closedAt;
  if (closedAt === null) {
    throw new Error("terminal checkout is missing its close time");
  }
  const terminalAt = aggregate.order.checkoutStatus === "EXPIRED"
    ? aggregate.order.expiresAt
    : closedAt;
  return now - terminalAt < aggregate.checkout.terminalObservationMilliseconds;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function readActiveCollectionProfile(connection: DatabaseSync): CollectionProfile | undefined {
  const row = connection
    .prepare(
      `SELECT profile.profile_id, profile.version, profile.provider_account_key,
              profile.code_payload, profile.payload_fingerprint,
              profile.profile_fingerprint, profile.evidence_policy, profile.created_at
         FROM active_collection_profile AS active
         JOIN collection_profiles AS profile ON profile.profile_id = active.profile_id
        WHERE active.singleton_key = 1`,
    )
    .get() as CollectionProfileRow | undefined;
  return row ? mapCollectionProfile(row) : undefined;
}

function readCollectionProfileByFingerprint(
  connection: DatabaseSync,
  fingerprint: string,
): CollectionProfile | undefined {
  const row = connection
    .prepare(
      `SELECT profile_id, version, provider_account_key, code_payload,
              payload_fingerprint, profile_fingerprint, evidence_policy, created_at
         FROM collection_profiles
        WHERE profile_fingerprint = ?`,
    )
    .get(fingerprint) as CollectionProfileRow | undefined;
  return row ? mapCollectionProfile(row) : undefined;
}

function readCollectionProfileById(
  connection: DatabaseSync,
  profileId: string,
): CollectionProfile | undefined {
  const row = connection
    .prepare(
      `SELECT profile_id, version, provider_account_key, code_payload,
              payload_fingerprint, profile_fingerprint, evidence_policy, created_at
         FROM collection_profiles
        WHERE profile_id = ?`,
    )
    .get(profileId) as CollectionProfileRow | undefined;
  return row ? mapCollectionProfile(row) : undefined;
}

interface CollectionProfileRow {
  readonly profile_id: string;
  readonly version: bigint | number;
  readonly provider_account_key: "primary";
  readonly code_payload: string;
  readonly payload_fingerprint: string;
  readonly profile_fingerprint: string;
  readonly evidence_policy: "UNIQUE_AMOUNT_AUTO";
  readonly created_at: bigint | number;
}

function mapCollectionProfile(row: CollectionProfileRow): CollectionProfile {
  const expected = fingerprintCollectionCodeProfile(row.code_payload);
  if (
    row.payload_fingerprint !== expected.payloadFingerprint ||
    row.profile_fingerprint !== expected.profileFingerprint
  ) {
    throw new Error("collection profile fingerprints do not match its code payload");
  }
  return {
    profileId: row.profile_id,
    version: toSafeInteger(row.version, "collection profile version"),
    providerAccountKey: row.provider_account_key,
    codePayload: row.code_payload,
    payloadFingerprint: row.payload_fingerprint,
    profileFingerprint: row.profile_fingerprint,
    evidencePolicy: row.evidence_policy,
    createdAt: toSafeInteger(row.created_at, "collection profile creation time"),
  };
}

function readDatabaseTime(connection: DatabaseSync): number {
  const row = connection
    .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
    .get() as { now_ms: bigint | number };
  return toSafeInteger(row.now_ms, "database time");
}

function readOrderClock(connection: DatabaseSync): number {
  const row = connection
    .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
    .get() as { last_now_ms: bigint | number } | undefined;
  if (!row) throw new Error("order clock is not initialized");
  return toSafeInteger(row.last_now_ms, "logical order time");
}

function assertChangedOnce(changes: bigint | number, action: string): void {
  if (Number(changes) !== 1) throw new Error(`${action} changed ${String(changes)} rows`);
}

function nullableSafeInteger(value: bigint | number | null, label: string): number | null {
  return value === null ? null : toSafeInteger(value, label);
}

function validateAdminOrderPageInput(
  filters: AdminOrderFilters,
  cursor: AdminOrderCursor | null,
  limit: number,
): void {
  if (
    filters.checkoutStatus !== null &&
    !["OPEN", "EXPIRED", "CLOSED"].includes(filters.checkoutStatus)
  ) {
    throw new RangeError("administrator checkout status filter is invalid");
  }
  if (
    filters.paymentStatus !== null &&
    !["UNPAID", "CONFIRMED", "DISPUTED"].includes(filters.paymentStatus)
  ) {
    throw new RangeError("administrator payment status filter is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("administrator order page limit is invalid");
  }
  if (
    cursor !== null &&
    (!Number.isSafeInteger(cursor.createdAt) ||
      cursor.createdAt < 0 ||
      !ORDER_ID_PATTERN.test(cursor.orderId))
  ) {
    throw new RangeError("administrator order cursor is invalid");
  }
}

function toSafeInteger(value: bigint | number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is outside the safe integer range`);
  return number;
}
