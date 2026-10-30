import { SiteError, type SiteStore } from "../sites/store.ts";
import type { AlipayAccountSnapshot } from "../alipay-accounts/model.ts";
import { collectionCandidates } from "./account-allocation.ts";
import { siteClientIdSchema, type SiteSnapshot } from "../sites/model.ts";
import type { ListQuery, OrderSort } from "../shared/list-query.ts";
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
import { prepareReturnUrl, ReturnUrlError, type ReturnUrlErrorCode } from "./return-url.ts";
import {
  prepareWebhookTarget,
  WebhookTargetError,
  type PreparedWebhookTarget,
  type WebhookTargetErrorCode,
} from "../notifications/model.ts";
import {
  API_CLIENT_ID,
  isProductionProvider,
  type CollectionSettings,
  type RuntimeSettingsSnapshot,
  type InstanceRuntimeSettingsSnapshot,
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
  | "alipay_accounts_unavailable"
  | "webhook_disabled"
  | "webhook_target_invalid"
  | "webhook_target_not_allowed"
  | ReturnUrlErrorCode;

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

interface ReturnUrlDecision {
  readonly url: string | null;
  readonly rejection?: {
    readonly url: string;
    readonly code: ReturnUrlErrorCode;
  } | undefined;
}

export interface OrderAccountOptions {
  readonly accounts: () => readonly AlipayAccountSnapshot[];
  readonly available?: (accountId: string) => boolean;
  readonly random?: () => number;
}

export class OrderService {
  readonly #store: OrderStore;
  readonly #settings: () => RuntimeSettingsSnapshot | InstanceRuntimeSettingsSnapshot;
  readonly #database: AppDatabase;
  readonly #physicalClock: (() => number) | undefined;
  readonly #sites: SiteStore | undefined;
  readonly #clientId: string | undefined;
  readonly #accounts: OrderAccountOptions | undefined;

  constructor(
    database: AppDatabase,
    settings: () => RuntimeSettingsSnapshot | InstanceRuntimeSettingsSnapshot,
    physicalClock?: () => number,
    sites?: SiteStore,
    clientId?: string,
    accounts?: OrderAccountOptions,
  ) {
    this.#store = new OrderStore(database, physicalClock);
    this.#settings = settings;
    this.#database = database;
    this.#physicalClock = physicalClock;
    this.#sites = sites;
    this.#clientId = clientId;
    this.#accounts = accounts;
  }

  forSite(clientId: string): OrderService {
    siteClientIdSchema.parse(clientId);
    if (!this.#sites) throw new Error("website order service is not configured");
    return new OrderService(this.#database, this.#settings, this.#physicalClock, this.#sites, clientId, this.#accounts);
  }

  #owner(): string {
    return this.#site()?.clientId ?? API_CLIENT_ID;
  }

  #site(): SiteSnapshot | null {
    if (!this.#sites) return null;
    if (!this.#clientId) throw new SiteError("site_not_found", "请明确选择业务网站。");
    const site = this.#sites.get(this.#clientId);
    if (!site) throw new SiteError("site_not_found", "业务网站不存在。");
    return site;
  }

  initialize(): SyncCollectionProfileResult | null {
    if (this.#accounts) {
      for (const account of this.#accounts.accounts()) {
        if (account.environment === "PRODUCTION" && account.codePayload && account.providerAccountKey) this.syncAccountCollectionProfile(account);
      }
      return null;
    }
    const settings = this.#settings();
    if (settings.collection === null || !isProductionProvider(settings.provider) || settings.activeProviderAccountKey === null) return null;
    return this.syncCollectionProfile(settings.collection, settings.activeProviderAccountKey);
  }

  syncCollectionProfile(
    collection: Pick<CollectionSettings, "codePayload">,
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

  syncAccountCollectionProfile(account: AlipayAccountSnapshot): SyncCollectionProfileResult {
    if (!account.codePayload || !account.providerAccountKey) throw new OrderError("system_not_configured", "支付宝账号还未完成配置。");
    return this.#runStoreOperation(() => this.#store.syncCollectionProfile({
      alipayAccountId: account.id, providerAccountKey: account.providerAccountKey!, codePayload: account.codePayload!,
      ...fingerprintCollectionCodeProfile(account.codePayload!, account.providerAccountKey!), activate: false,
    }));
  }

  create(
    request: CreateOrderRequest,
    beforeCreate?: (() => void) | undefined,
  ): CreateOrderResult {
    const site = this.#site();
    const settings = this.#configuredSettings(site);
    const clientId = site?.clientId ?? API_CLIENT_ID;
    const webhook = settings.webhook;
    const candidates = this.#accounts && site ? collectionCandidates(site.configuration.collection,
      this.#accounts.accounts(), this.#accounts.available ?? (() => true), this.#accounts.random) : null;
    const collectionProfileIds = candidates?.map(account => this.syncAccountCollectionProfile(account).profile.profileId);
    if (candidates === null) this.syncCollectionProfile(settings.collection, settings.providerAccountKey);
    const webhookTarget = this.#prepareWebhookTarget(request, webhook);
    const returnUrl = this.#prepareReturnUrl(request, site ? site.configuration.return_origin : webhook.allowedOrigin);
    const result = this.#runStoreOperation(() =>
      this.#store.createOrder(
        {
          apiClientId: clientId,
          ...(collectionProfileIds ? { collectionProfileIds } : {}),
          ...(site ? { siteRevision: site.revision } : {}),
          request,
          idempotencyKeyDigest: digestIdempotencyKey(clientId, request.idempotency_key),
          requestFingerprint: fingerprintCreateOrderRequest(request),
          ttlMilliseconds: settings.collection.orderTtlSeconds * 1000,
          amountOffsetMaximumCents: settings.collection.amountOffsetMaximumCents,
          amountReuseCooldownSeconds: settings.collection.amountReuseCooldownSeconds,
          checkoutKeyRotationMilliseconds: settings.advanced.checkoutKeyRotationDays *
            24 * 60 * 60 * 1_000,
          checkoutTerminalObservationMilliseconds: settings.advanced
            .checkoutTerminalObservationSeconds * 1_000,
          webhookTarget: webhookTarget.target,
          webhookTargetRejection: webhookTarget.rejection,
          returnUrl: returnUrl.url,
          returnUrlRejection: returnUrl.rejection,
        },
        () => {
          beforeCreate?.();
          if (candidates?.length === 0) throw new OrderError("alipay_accounts_unavailable", "这个网站的收款账号当前都不可用，请检查账号配置和查账状态。", 30);
        },
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
      case "return_url_rejected":
        throw returnUrlOrderError(result.code);
      case "amount_slots_exhausted":
        throw new OrderError(
          "amount_slots_exhausted",
          "当前金额暂时没有可用的应付金额，请稍后重试",
          result.retryAfterSeconds,
        );
    }
  }

  get(orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.orderById(this.#owner(), orderId)
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  getByMerchantOrderNumber(merchantOrderNo: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.orderByMerchantOrderNumber(this.#owner(), merchantOrderNo),
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  adminPage(
    filters: AdminOrderFilters,
    cursor: AdminOrderCursor | null,
    limit: number,
    query?: ListQuery<OrderSort>,
  ): AdminOrderPageProjection {
    const page = this.#runStoreOperation(() =>
      this.#store.adminOrderPage(filters, cursor, limit, query),
    );
    return {
      orders: page.orders.map((order) => this.#projectAdminOrder(order)),
      nextCursor: page.nextCursor,
    };
  }

  adminCheckoutToken(orderId: string): string {
    const token = this.#store.adminCheckoutToken(orderId);
    if (!token) throw orderNotFound();
    return token;
  }

  adminGet(orderId: string): AdminOrderDetailProjection {
    const order = this.#runStoreOperation(() => this.#store.adminOrderById(orderId));
    if (!order) throw orderNotFound();
    return this.#projectAdminOrderDetail(order);
  }

  adminGetByMerchantOrderNumber(merchantOrderNo: string): AdminOrderDetailProjection {
    const order = this.#runStoreOperation(() =>
      this.#store.adminOrderByMerchantOrderNumber(this.#owner(), merchantOrderNo),
    );
    if (!order) throw orderNotFound();
    return this.#projectAdminOrderDetail(order);
  }

  close(orderId: string): OrderProjection {
    const aggregate = this.#runStoreOperation(() =>
      this.#store.closeOrder(this.#owner(), orderId)
    );
    if (!aggregate) throw orderNotFound();
    return this.#projectOrder(aggregate);
  }

  publicCheckoutOrderId(token: string): string {
    if (!isCanonicalCheckoutToken(token)) throw checkoutNotFound();
    const aggregate = this.#runStoreOperation(() => this.#store.publicCheckoutByTokenDigest(digestCheckoutToken(token)));
    if (!aggregate) throw checkoutNotFound();
    return aggregate.order.orderId;
  }

  publicCheckout(token: string): PublicCheckoutProjection {
    if (!isCanonicalCheckoutToken(token)) throw checkoutNotFound();
    const aggregate = this.#runStoreOperation(() =>
      this.#store.publicCheckoutByTokenDigest(digestCheckoutToken(token)),
    );
    if (!aggregate) throw checkoutNotFound();
    const site = this.#sites?.get(aggregate.order.apiClientId);
    if (this.#sites && !site) throw new Error("checkout website configuration is missing");
    return {
      ...(site ? { display: { name: site.configuration.policy.display.checkout_name, helpUrl: site.configuration.policy.display.checkout_help_url, showProductName: site.configuration.policy.display.checkout_show_product_name } } : {}),
      merchantOrderNo: aggregate.order.merchantOrderNo,
      requestedAmountCents: aggregate.order.requestedAmountCents,
      currency: aggregate.order.currency,
      productName: aggregate.order.productName,
      // Navigation is not proof of payment; non-success states also need a way back.
      returnUrl: aggregate.order.returnUrl,
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
      returnUrl: aggregate.order.returnUrl,
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
      alipayAccountId: aggregate.order.alipayAccountId,
      alipayAccountName: this.#accounts?.accounts().find(account => account.id === aggregate.order.alipayAccountId)?.name ?? null,
      providerAccountKey: aggregate.order.providerAccountKey,
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

  #configuredSettings(site: SiteSnapshot | null): {
    readonly collection: CollectionSettings;
    readonly providerAccountKey: string;
    readonly webhook: RuntimeSettingsSnapshot["webhook"];
    readonly advanced: RuntimeSettingsSnapshot["advanced"];
  } {
    const settings = this.#settings();
    if (!this.#accounts && (
      settings.collection === null ||
      !isProductionProvider(settings.provider) ||
      settings.activeProviderAccountKey === null
    )) {
      throw new OrderError(
        "system_not_configured",
        "收款配置未完成",
      );
    }
    const policy = site?.configuration.policy;
    let collection: CollectionSettings;
    if (policy) {
      collection = { codePayload: settings.collection?.codePayload ?? "", orderTtlSeconds: policy.orders.order_ttl_seconds, amountOffsetMaximumCents: policy.orders.amount_offset_maximum_cents, amountReuseCooldownSeconds: policy.orders.amount_reuse_cooldown_seconds };
    } else if ("webhook" in settings) {
      if (!settings.collection) throw new OrderError("system_not_configured", "收款配置未完成");
      collection = settings.collection;
    } else {
      throw new Error("website order policy is required");
    }
    const webhook = site && policy ? {
      enabled: site.configuration.notifications_enabled, allowedOrigin: site.configuration.notification_origin,
      secret: this.#sites!.notificationSecret(site.clientId), signingKeyFingerprint: null,
      timeoutMilliseconds: policy.notification_delivery.timeout_milliseconds, maximumAttempts: policy.notification_delivery.maximum_attempts,
      retryBaseMilliseconds: policy.notification_delivery.retry_base_seconds * 1000, retryMaximumMilliseconds: policy.notification_delivery.retry_maximum_seconds * 1000,
    } : "webhook" in settings ? settings.webhook : null;
    if (!webhook) throw new Error("website notification policy is required");
    return {
      collection,
      providerAccountKey: settings.activeProviderAccountKey ?? "primary",
      webhook,
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

  #prepareReturnUrl(
    request: CreateOrderRequest,
    allowedOrigin: string | null,
  ): ReturnUrlDecision {
    if (request.return_url === undefined) return { url: null };
    try {
      return { url: prepareReturnUrl(request.return_url, allowedOrigin) };
    } catch (error) {
      if (!(error instanceof ReturnUrlError)) throw error;
      return {
        url: null,
        rejection: { url: request.return_url, code: error.code },
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

function returnUrlOrderError(code: ReturnUrlErrorCode): OrderError {
  switch (code) {
    case "return_url_invalid":
      return new OrderError(code, "return_url 格式无效");
    case "return_url_not_allowed":
      return new OrderError(code, "return_url 必须位于后台配置允许的 HTTPS origin");
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
