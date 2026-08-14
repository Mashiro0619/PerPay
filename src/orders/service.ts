import { createHash } from "node:crypto";

import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import {
  OrderClockError,
  OrderStore,
  type StoredOrderAggregate,
  type SyncCollectionProfileResult,
} from "../database/order-store.ts";
import { digestCheckoutToken, isCanonicalCheckoutToken } from "./checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "./collection-profile.ts";
import {
  prepareWebhookTarget,
  WebhookTargetError,
  type PreparedWebhookTarget,
  type WebhookTargetErrorCode,
} from "../notifications/model.ts";
import {
  IDEMPOTENCY_KEY_DIGEST_VERSION,
  fingerprintCreateOrderRequest,
  type CreateOrderRequest,
  type OrderProjection,
  type PublicCheckoutProjection,
} from "./model.ts";

export const IDEMPOTENCY_KEY_DIGEST_ALGORITHM = "sha256";
export {
  COLLECTION_PROFILE_FINGERPRINT_VERSION,
  fingerprintCollectionCodeProfile,
} from "./collection-profile.ts";

export type OrderErrorCode =
  | "order_not_found"
  | "idempotency_conflict"
  | "merchant_order_no_conflict"
  | "amount_slots_exhausted"
  | "checkout_not_found"
  | "order_clock_unavailable"
  | "webhook_disabled"
  | "webhook_target_invalid"
  | "webhook_target_not_allowed";

export class OrderError extends Error {
  readonly code: OrderErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: OrderErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "OrderError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CreateOrderResult {
  readonly created: boolean;
  readonly order: OrderProjection;
}

interface WebhookTargetDecision {
  readonly target: PreparedWebhookTarget | null;
  readonly rejection?: {
    readonly url: string;
    readonly code: WebhookTargetErrorCode;
  } | undefined;
}

export class OrderService {
  readonly #store: OrderStore;
  readonly #config: AppConfig;

  constructor(
    database: AppDatabase,
    config: AppConfig,
    physicalClock?: () => number,
  ) {
    this.#store = new OrderStore(database, physicalClock);
    this.#config = config;
  }

  initialize(): SyncCollectionProfileResult {
    const { payloadFingerprint, profileFingerprint } = fingerprintCollectionCodeProfile(
      this.#config.collectionCodePayload,
    );
    return this.#runStoreOperation(() =>
      this.#store.syncCollectionProfile({
        codePayload: this.#config.collectionCodePayload,
        payloadFingerprint,
        profileFingerprint,
      }),
    );
  }

  create(apiClientId: string, request: CreateOrderRequest): CreateOrderResult {
    const webhookTarget = this.#prepareWebhookTarget(request);
    const result = this.#runStoreOperation(() =>
      this.#store.createOrder({
        apiClientId,
        request,
        idempotencyKeyDigest: digestIdempotencyKey(apiClientId, request.idempotency_key),
        requestFingerprint: fingerprintCreateOrderRequest(request),
        ttlMilliseconds: this.#config.orderTtlSeconds * 1000,
        amountOffsetMaximumCents: this.#config.amountOffsetMaximumCents,
        webhookTarget: webhookTarget.target,
        webhookTargetRejection: webhookTarget.rejection,
      }),
    );
    switch (result.kind) {
      case "created":
        return { created: true, order: this.#projectOrder(result.aggregate) };
      case "existing":
        return { created: false, order: this.#projectOrder(result.aggregate) };
      case "idempotency_conflict":
        throw new OrderError(
          "idempotency_conflict",
          "幂等键已经用于不同的下单请求",
        );
      case "merchant_order_conflict":
        throw new OrderError(
          "merchant_order_no_conflict",
          "商户订单号已经存在",
        );
      case "webhook_target_rejected":
        throw webhookTargetOrderError(result.code);
      case "amount_slots_exhausted":
        throw new OrderError(
          "amount_slots_exhausted",
          "当前请求金额的可用尾差已经耗尽，请稍后重试",
          1,
        );
    }
  }

  get(apiClientId: string, orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() => this.#store.orderById(apiClientId, orderId));
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  getByMerchantOrderNumber(apiClientId: string, merchantOrderNo: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.orderByMerchantOrderNumber(apiClientId, merchantOrderNo),
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  close(apiClientId: string, orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() => this.#store.closeOrder(apiClientId, orderId));
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  publicCheckout(token: string): PublicCheckoutProjection {
    if (!isCanonicalCheckoutToken(token)) throw checkoutNotFound();
    const aggregate = this.#runStoreOperation(() =>
      this.#store.publicCheckoutByTokenDigest(digestCheckoutToken(token)),
    );
    if (!aggregate) throw checkoutNotFound();
    return {
      merchantOrderNo: aggregate.order.merchantOrderNo,
      requestedAmountCents: aggregate.order.requestedAmountCents,
      currency: aggregate.order.currency,
      description: aggregate.order.description,
      paymentInstructions:
        aggregate.order.checkoutStatus === "OPEN"
          ? {
              payableAmountCents: aggregate.order.payableAmountCents,
              currency: aggregate.order.currency,
              collectionCodePayload: aggregate.collectionProfile.codePayload,
            }
          : null,
      checkout: checkoutProjection(aggregate),
      payment: paymentProjection(aggregate),
      refund: { status: aggregate.order.refundStatus },
    };
  }

  #projectOrder(aggregate: StoredOrderAggregate): OrderProjection {
    return {
      orderId: aggregate.order.orderId,
      merchantOrderNo: aggregate.order.merchantOrderNo,
      requestedAmountCents: aggregate.order.requestedAmountCents,
      payableAmountCents: aggregate.order.payableAmountCents,
      receivedAmountCents: aggregate.order.receivedAmountCents,
      currency: aggregate.order.currency,
      description: aggregate.order.description,
      checkoutToken: aggregate.checkoutToken,
      checkout: checkoutProjection(aggregate),
      payment: paymentProjection(aggregate),
      refund: { status: aggregate.order.refundStatus },
      notification: {
        notifyUrl: aggregate.webhookTarget?.targetUrl ?? null,
      },
      createdAt: aggregate.order.createdAt,
      updatedAt: aggregate.order.updatedAt,
      version: aggregate.order.version,
    };
  }

  #runStoreOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof OrderClockError) {
        throw new OrderError(
          "order_clock_unavailable",
          "系统时钟与订单时钟偏差过大，请校准服务器时间后重试",
          30,
        );
      }
      throw error;
    }
  }

  #prepareWebhookTarget(request: CreateOrderRequest): WebhookTargetDecision {
    if (request.notify_url === undefined) return { target: null };
    if (!this.#config.webhook.enabled) {
      return {
        target: null,
        rejection: { url: request.notify_url, code: "webhook_disabled" },
      };
    }
    try {
      return {
        target: prepareWebhookTarget(request.notify_url, this.#config.webhook.allowedOrigin),
      };
    } catch (error) {
      if (!(error instanceof WebhookTargetError)) throw error;
      return {
        target: null,
        rejection: { url: request.notify_url, code: error.code },
      };
    }
  }
}

function webhookTargetOrderError(code: WebhookTargetErrorCode): OrderError {
  switch (code) {
    case "webhook_disabled":
      return new OrderError(
        code,
        "通知功能未启用，不能为新订单设置 notify_url",
      );
    case "webhook_target_not_allowed":
      return new OrderError(
        code,
        "notify_url 必须位于部署配置允许的 HTTPS origin",
      );
    case "webhook_target_invalid":
      return new OrderError(code, "notify_url 格式无效");
  }
}

export function digestIdempotencyKey(apiClientId: string, idempotencyKey: string): string {
  return createHash(IDEMPOTENCY_KEY_DIGEST_ALGORITHM)
    .update(`perpay:idempotency-key:v${IDEMPOTENCY_KEY_DIGEST_VERSION}`, "ascii")
    .update("\0", "ascii")
    .update(apiClientId, "utf8")
    .update("\0", "ascii")
    .update(idempotencyKey, "utf8")
    .digest("hex");
}

function checkoutProjection(aggregate: StoredOrderAggregate) {
  return {
    status: aggregate.order.checkoutStatus,
    expiresAt: aggregate.order.expiresAt,
    closedAt: aggregate.order.closedAt,
  } as const;
}

function paymentProjection(aggregate: StoredOrderAggregate) {
  return {
    status: aggregate.order.paymentStatus,
    basis: aggregate.order.paymentBasis,
    receivedAmountCents: aggregate.order.receivedAmountCents,
  } as const;
}

function orderNotFound(): OrderError {
  return new OrderError("order_not_found", "订单不存在");
}

function checkoutNotFound(): OrderError {
  return new OrderError("checkout_not_found", "收银台不存在");
}
