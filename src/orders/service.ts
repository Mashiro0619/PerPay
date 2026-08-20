import type { AppDatabase } from "../database/database.ts";
import {
  OrderClockError,
  OrderStore,
  type StoredAdminOrder,
  type StoredAdminOrderDetail,
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
  API_CLIENT_ID,
  type CollectionSettings,
  type RuntimeSettingsSnapshot,
} from "../settings/model.ts";
import {
  digestIdempotencyKey,
  fingerprintCreateOrderRequest,
  type AdminOrderCursor,
  type AdminOrderDetailProjection,
  type AdminOrderFilters,
  type AdminOrderPageProjection,
  type AdminOrderSummaryProjection,
  type CreateOrderRequest,
  type OrderProjection,
  type PublicCheckoutProjection,
} from "./model.ts";

export {
  COLLECTION_PROFILE_FINGERPRINT_VERSION,
  fingerprintCollectionCodeProfile,
} from "./collection-profile.ts";
export {
  IDEMPOTENCY_KEY_DIGEST_ALGORITHM,
  digestIdempotencyKey,
} from "./model.ts";

export type OrderErrorCode =
  | "order_not_found"
  | "idempotency_conflict"
  | "merchant_order_no_conflict"
  | "amount_slots_exhausted"
  | "checkout_not_found"
  | "order_clock_unavailable"
  | "system_not_configured"
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
  readonly #settings: () => RuntimeSettingsSnapshot;

  constructor(
    database: AppDatabase,
    settings: () => RuntimeSettingsSnapshot,
    physicalClock?: () => number,
  ) {
    this.#store = new OrderStore(database, physicalClock);
    this.#settings = settings;
  }

  initialize(): SyncCollectionProfileResult | null {
    const settings = this.#settings();
    if (settings.collection === null || settings.activeProviderAccountKey === null) return null;
    return this.syncCollectionProfile(settings.collection, settings.activeProviderAccountKey);
  }

  syncCollectionProfile(
    collection: CollectionSettings,
    providerAccountKey: string,
  ): SyncCollectionProfileResult {
    const { payloadFingerprint, profileFingerprint } = fingerprintCollectionCodeProfile(
      collection.codePayload,
      providerAccountKey,
    );
    return this.#runStoreOperation(() =>
      this.#store.syncCollectionProfile({
        providerAccountKey,
        codePayload: collection.codePayload,
        payloadFingerprint,
        profileFingerprint,
      }),
    );
  }

  create(
    request: CreateOrderRequest,
    beforeCreate?: (() => void) | undefined,
  ): CreateOrderResult {
    const settings = this.#configuredSettings();
    this.syncCollectionProfile(settings.collection, settings.providerAccountKey);
    const webhookTarget = this.#prepareWebhookTarget(request, settings.webhook);
    const result = this.#runStoreOperation(() =>
      this.#store.createOrder(
        {
          apiClientId: API_CLIENT_ID,
          request,
          idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
          requestFingerprint: fingerprintCreateOrderRequest(request),
          ttlMilliseconds: settings.collection.orderTtlSeconds * 1000,
          amountOffsetMaximumCents: settings.collection.amountOffsetMaximumCents,
          checkoutKeyRotationMilliseconds: settings.advanced.checkoutKeyRotationDays *
            24 * 60 * 60 * 1_000,
          checkoutTerminalObservationMilliseconds: settings.advanced
            .checkoutTerminalObservationSeconds * 1_000,
          webhookTarget: webhookTarget.target,
          webhookTargetRejection: webhookTarget.rejection,
        },
        beforeCreate,
      ),
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
          result.retryAfterSeconds,
        );
    }
  }

  get(orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.orderById(API_CLIENT_ID, orderId)
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  getByMerchantOrderNumber(merchantOrderNo: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.orderByMerchantOrderNumber(API_CLIENT_ID, merchantOrderNo),
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  adminPage(
    filters: AdminOrderFilters,
    cursor: AdminOrderCursor | null,
    limit: number,
  ): AdminOrderPageProjection {
    const page = this.#runStoreOperation(() =>
      this.#store.adminOrderPage(filters, cursor, limit),
    );
    return {
      orders: page.orders.map((order) => this.#projectAdminOrder(order)),
      nextCursor: page.nextCursor,
    };
  }

  adminGet(orderId: string): AdminOrderDetailProjection {
    const order = this.#runStoreOperation(() => this.#store.adminOrderById(orderId));
    if (!order) throw orderNotFound();
    return this.#projectAdminOrderDetail(order);
  }

  adminGetByMerchantOrderNumber(merchantOrderNo: string): AdminOrderDetailProjection {
    const order = this.#runStoreOperation(() =>
      this.#store.adminOrderByMerchantOrderNumber(API_CLIENT_ID, merchantOrderNo),
    );
    if (!order) throw orderNotFound();
    return this.#projectAdminOrderDetail(order);
  }

  close(orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.closeOrder(API_CLIENT_ID, orderId)
    );
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
      productName: aggregate.order.productName,
      paymentInstructions:
        aggregate.order.checkoutStatus === "OPEN" && aggregate.order.paymentStatus === "UNPAID"
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
      productName: aggregate.order.productName,
      note: aggregate.order.note,
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

  #projectAdminOrder(aggregate: StoredAdminOrder): AdminOrderSummaryProjection {
    return {
      orderId: aggregate.order.orderId,
      apiClientId: aggregate.order.apiClientId,
      merchantOrderNo: aggregate.order.merchantOrderNo,
      requestedAmountCents: aggregate.order.requestedAmountCents,
      payableAmountCents: aggregate.order.payableAmountCents,
      receivedAmountCents: aggregate.order.receivedAmountCents,
      currency: aggregate.order.currency,
      productName: aggregate.order.productName,
      checkout: checkoutProjection(aggregate),
      payment: paymentProjection(aggregate),
      refund: { status: aggregate.order.refundStatus },
      eligibleFrom: aggregate.order.eligibleFrom,
      createdAt: aggregate.order.createdAt,
      updatedAt: aggregate.order.updatedAt,
      version: aggregate.order.version,
    };
  }

  #projectAdminOrderDetail(aggregate: StoredAdminOrderDetail): AdminOrderDetailProjection {
    return {
      ...this.#projectAdminOrder(aggregate),
      note: aggregate.order.note,
      notification: { notifyUrl: aggregate.webhookTarget?.targetUrl ?? null },
      events: aggregate.events,
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

  #configuredSettings(): {
    readonly collection: CollectionSettings;
    readonly providerAccountKey: string;
    readonly webhook: RuntimeSettingsSnapshot["webhook"];
    readonly advanced: RuntimeSettingsSnapshot["advanced"];
  } {
    const settings = this.#settings();
    if (
      settings.collection === null ||
      settings.provider === null ||
      settings.apiSecret === null ||
      settings.activeProviderAccountKey === null
    ) {
      throw new OrderError(
        "system_not_configured",
        "收款系统尚未完成配置",
      );
    }
    return {
      collection: settings.collection,
      providerAccountKey: settings.activeProviderAccountKey,
      webhook: settings.webhook,
      advanced: settings.advanced,
    };
  }

  #prepareWebhookTarget(
    request: CreateOrderRequest,
    webhook: RuntimeSettingsSnapshot["webhook"],
  ): WebhookTargetDecision {
    if (request.notify_url === undefined) return { target: null };
    if (!webhook.enabled) {
      return {
        target: null,
        rejection: { url: request.notify_url, code: "webhook_disabled" },
      };
    }
    if (webhook.allowedOrigin === null || webhook.secret === null) {
      throw new OrderError(
        "system_not_configured",
        "通知功能尚未完成配置",
      );
    }
    try {
      return {
        target: prepareWebhookTarget(request.notify_url, webhook.allowedOrigin),
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

function checkoutProjection(aggregate: Pick<StoredOrderAggregate, "order">) {
  return {
    status: aggregate.order.checkoutStatus,
    expiresAt: aggregate.order.expiresAt,
    closedAt: aggregate.order.closedAt,
  } as const;
}

function paymentProjection(aggregate: Pick<StoredOrderAggregate, "order">) {
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
