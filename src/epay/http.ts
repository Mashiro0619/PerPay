// SPDX-License-Identifier: MIT
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppDependencies, AppEnvironment } from "../http/app.ts";
import { createOrderRequestSchema, type OrderProjection } from "../orders/model.ts";
import { OrderError } from "../orders/service.ts";
import { prepareReturnUrl } from "../orders/return-url.ts";
import { prepareWebhookTarget } from "../notifications/model.ts";
import { SiteError } from "../sites/store.ts";
import { siteClientIdSchema } from "../sites/model.ts";
import type { SettingsAuditContext } from "../settings/store.ts";
import { SettingsFieldError } from "../settings/validation.ts";
import { EpayStore, EpayError } from "./store.ts";
import { epayConfigurationInputSchema, type EpayCredentials, type EpayOrderMetadata, type EpaySiteSnapshot } from "./model.ts";
import {
  EpayProtocolError, appendEpayParameters, assertEpayTimestamp, buildEpayCallbackUrl,
  epayMoneyToCents, moneyFromCents, parseEpayParameters, signEpayV2,
  truncateEpayName, verifyEpayV1, verifyEpayV2, type EpayParameters, type EpayProtocol,
} from "./protocol.ts";

interface RouteOptions {
  readonly adminSession: MiddlewareHandler<AppEnvironment>;
  readonly financialWrite: MiddlewareHandler<AppEnvironment>;
  readonly audit: (context: Context<AppEnvironment>) => SettingsAuditContext;
  readonly readJson: <T>(context: Context<AppEnvironment>, schema: z.ZodType<T>, maximumBytes: number) => Promise<T>;
  readonly readBody: (context: Context<AppEnvironment>, maximumBytes: number) => Promise<Buffer>;
  readonly requireReady: () => void;
  readonly requireBackground: () => void;
  readonly rateLimit: (context: Context<AppEnvironment>) => void;
}

const exportSchema = z.object({
  protocol: z.enum(["native", "epay_v1", "epay_v2"]),
  site_revision: z.number().int().nonnegative(), epay_revision: z.number().int().nonnegative(),
  notify_url: z.string().min(1).max(4096), return_url: z.string().max(4096).optional(),
}).strict();

export function serializeEpay(configuration: EpaySiteSnapshot, publicOrigin: string) {
  return {
    client_id: configuration.siteId, pid: configuration.pid, revision: configuration.revision,
    v1_enabled: configuration.v1Enabled, v2_enabled: configuration.v2Enabled,
    v1_key_version: configuration.v1KeyVersion, merchant_key_version: configuration.merchantKeyVersion,
    platform_key_version: configuration.platformKeyVersion, public_origin: publicOrigin,
  };
}

export function registerEpayRoutes(app: Hono<AppEnvironment>, dependencies: AppDependencies, options: RouteOptions): void {
  const epay = dependencies.settings?.epayStore();
  if (!epay) return;
  const now = dependencies.clock ?? Date.now;
  const siteId = (context: Context<AppEnvironment>) => siteClientIdSchema.parse(context.req.param("clientId"));
  app.get("/api/admin/v1/sites/:clientId/epay", options.adminSession, context =>
    context.json({ data: serializeEpay(epay.get(siteId(context)), dependencies.config.publicOrigin) }));
  app.put("/api/admin/v1/sites/:clientId/epay", options.adminSession, options.financialWrite, async context => {
    const body = await options.readJson(context, epayConfigurationInputSchema, 1024);
    return context.json({ data: serializeEpay(epay.update(siteId(context), body, options.audit(context), now()), dependencies.config.publicOrigin) });
  });
  const purposes = { epay_v1: "v1_key", epay_merchant: "v2_merchant", epay_platform: "v2_platform" } as const;
  for (const [name, purpose] of Object.entries(purposes)) {
    app.post(`/api/admin/v1/sites/:clientId/secrets/${name}/actions/view`, options.adminSession, options.financialWrite, async context => {
      await options.readJson(context, z.object({}).strict(), 1024);
      const value = epay.reveal(siteId(context), purpose, options.audit(context), now());
      return context.json({ data: { secret: value.secret, public_key: value.publicKey } });
    });
    app.post(`/api/admin/v1/sites/:clientId/secrets/${name}/actions/rotate`, options.adminSession, options.financialWrite, async context => {
      const body = await options.readJson(context, z.object({ revision: z.number().int().nonnegative() }).strict(), 1024);
      const value = epay.rotate(siteId(context), purpose, body.revision, options.audit(context), now());
      const secret = purpose === "v1_key" ? value.credentials.v1Key :
        purpose === "v2_merchant" ? value.credentials.merchantPrivateKey : value.credentials.platformPrivateKey;
      const publicKey = purpose === "v1_key" ? null :
        purpose === "v2_merchant" ? value.credentials.merchantPublicKey : value.credentials.platformPublicKey;
      return context.json({ data: { configuration: serializeEpay(value.configuration, dependencies.config.publicOrigin),
        secret, public_key: publicKey } });
    });
  }
  app.post("/api/admin/v1/sites/:clientId/integration/export", options.adminSession, options.financialWrite, async context => {
    const body = await options.readJson(context, exportSchema, 12 * 1024);
    const id = siteId(context);
    const site = dependencies.sites?.get(id);
    if (!site) throw new SiteError("site_not_found", "业务网站不存在。");
    if (!site.configuration.notification_origin) throw new SettingsFieldError("notify_url", "请先保存网站通知来源。");
    let notifyUrl: string;
    let returnUrl = "";
    try {
      notifyUrl = prepareWebhookTarget(body.notify_url, site.configuration.notification_origin).url;
    } catch { throw new SettingsFieldError("notify_url", "通知地址须符合已保存的 HTTPS 来源。"); }
    validateExportCallback(notifyUrl, body.protocol, "notify_url");
    if (body.return_url) {
      try {
        returnUrl = prepareReturnUrl(body.return_url, site.configuration.return_origin);
      } catch { throw new SettingsFieldError("return_url", "返回地址须符合已保存的 HTTPS 来源。"); }
      validateExportCallback(returnUrl, body.protocol, "return_url");
    }
    const snapshot = epay.exportConfiguration(id, {
      protocol: body.protocol, siteRevision: body.site_revision, epayRevision: body.epay_revision,
    }, options.audit(context), now());
    const origin = dependencies.config.publicOrigin;
    const values: Record<string, string> = {
      PAYMENT_PROTOCOL: body.protocol, DEMO_NOTIFY_URL: notifyUrl,
      DEMO_RETURN_URL: returnUrl, DEMO_PORT: "3001",
      DEMO_DATA_DIR: `./data/${id}-${body.protocol}`,
    };
    if (body.protocol === "native") {
      Object.assign(values, { PERPAY_URL: origin, PERPAY_CLIENT_ID: snapshot.site.apiClientId,
        PERPAY_API_SECRET: snapshot.apiSecret!, PERPAY_WEBHOOK_SECRET: snapshot.webhookSecret! });
    } else {
      Object.assign(values, { EPAY_URL: `${origin.replace(/\/$/, "")}/`, EPAY_PID: snapshot.configuration.pid });
      if (body.protocol === "epay_v1") values.EPAY_V1_KEY = snapshot.credentials!.v1Key!;
      else Object.assign(values, { EPAY_MERCHANT_PRIVATE_KEY: singleLineKey(snapshot.credentials!.merchantPrivateKey!),
        EPAY_PLATFORM_PUBLIC_KEY: singleLineKey(snapshot.credentials!.platformPublicKey!) });
    }
    const content = Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n";
    context.header("content-disposition", `attachment; filename="perpay-${id}-${body.protocol}.env"`);
    return context.text(content);
  });

  type Action = "create" | "submit" | "query" | "info" | "orders" | "legacy" | "unsupported";
  const handle = (protocol: EpayProtocol, action: Action) => async (context: Context<AppEnvironment>) => {
    let credentials: EpayCredentials | null = null;
    let authenticated = false;
    try {
      options.rateLimit(context);
      if (dependencies.demoMode) throw new EpayProtocolError("demo_read_only", "演示实例不接收外部付款请求。");
      let body: Buffer | undefined;
      if (context.req.method === "POST") {
        if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header("content-type") ?? "")) {
          throw new EpayProtocolError("invalid_encoding", "请使用 UTF-8 表单提交。");
        }
        body = await options.readBody(context, 16 * 1024);
      }
      const parameters = parseEpayParameters(new URL(context.req.url).search.slice(1), body);
      credentials = epay.credential(parameters.pid ?? "", { protocol, forCreation: action === "create" || action === "submit" });
      if (!credentials) throw new EpayProtocolError("authentication_failed", "商户不存在或当前协议未启用。");
      if (action === "legacy") {
        if (!sameSecret(parameters.key ?? "", credentials.v1Key ?? "")) throw new EpayProtocolError("authentication_failed", "商户密钥无效。");
      } else if (protocol === "epay_v1") {
        if (!credentials.v1Key || !verifyEpayV1(parameters, credentials.v1Key)) throw new EpayProtocolError("signature_invalid", "签名无效。");
      } else {
        assertEpayTimestamp(parameters, now());
        if (!credentials.merchantPublicKey || !verifyEpayV2(parameters, credentials.merchantPublicKey)) throw new EpayProtocolError("signature_invalid", "签名无效。");
      }
      const selected = action === "legacy" ? ({ query: "info", order: "query", orders: "orders" } as const)[parameters.act as "query" | "order" | "orders"] : action;
      let result: Record<string, unknown>;
      authenticated = true;
      const success = protocol === "epay_v1" ? 1 : 0;
      if (selected === "create" || selected === "submit") {
        options.requireReady();
        const order = createEpayOrder(dependencies, epay, credentials, protocol, parameters, selected === "submit", options.requireBackground);
        const checkout = new URL(`/checkout/${encodeURIComponent(order.checkoutToken)}`, dependencies.config.publicOrigin).href;
        if (selected === "submit") return context.redirect(checkout, 302);
        const metadata = epay.order(order.orderId)!;
        result = protocol === "epay_v1" ? { code: success, msg: "success", trade_no: metadata.tradeNo, payurl: checkout } :
          { code: success, msg: "success", trade_no: metadata.tradeNo, pay_type: "jump", pay_info: checkout };
      } else if (selected === "query") {
        const metadata = epay.findOrder(credentials.siteId, {
          ...(parameters.trade_no ? { tradeNo: parameters.trade_no } : { outTradeNo: parameters.out_trade_no ?? "" }),
        });
        if (!metadata) throw new EpayProtocolError("order_not_found", "订单不存在。");
        result = { code: success, msg: "success", ...orderResponse(dependencies, epay, metadata) };
      } else if (selected === "orders") {
        const limit = integerParameter(parameters.limit, 20, 1, 50);
        const offset = protocol === "epay_v1" ? (integerParameter(parameters.page, 1, 1, 1_000_000) - 1) * limit : integerParameter(parameters.offset, 0, 0, 50_000_000);
        const status = parameters.status === undefined || parameters.status === "" ? undefined : integerParameter(parameters.status, 0, 0, 1) as 0 | 1;
        result = { code: success, msg: "success", data: epay.orders(credentials.siteId, {
          limit, offset, ...(status === undefined ? {} : { status }),
        }).map(metadata => orderResponse(dependencies, epay, metadata)) };
      } else if (selected === "info") {
        const stats = epay.stats(credentials.siteId, now());
        const protocolEnabled = protocol === "epay_v1" ? credentials.v1Enabled : credentials.v2Enabled;
        const active = credentials.site.configuration.accepting_orders && protocolEnabled ? 1 : 0;
        result = protocol === "epay_v1" ? { code: 1, pid: credentials.pid, key: credentials.v1Key, active,
          money: "0.00", type: 1, account: "", username: "", orders: stats.total, order_today: stats.today, order_lastday: stats.yesterday } :
          { code: 0, msg: "success", pid: credentials.pid, status: 1, pay_status: active, settle_status: 0, money: "0.00",
            settle_type: 1, settle_account: "", settle_name: "", order_num: stats.total,
            order_num_today: stats.today, order_num_lastday: stats.yesterday,
            order_money_today: moneyFromCents(stats.todayAmountCents), order_money_lastday: moneyFromCents(stats.yesterdayAmountCents) };
      } else throw new EpayProtocolError("unsupported_action", "该接口暂不支持此操作。");
      return context.json(signedResponse(result, protocol, credentials, now()));
    } catch (error) {
      const known = error instanceof EpayProtocolError || error instanceof EpayError || error instanceof OrderError || error instanceof SiteError;
      const message = known ? error.message : error instanceof z.ZodError ? "订单参数无效。" : "请求暂时无法完成，请稍后重试。";
      return context.json(signedResponse({ code: -1, msg: message }, protocol, authenticated ? credentials : null, now()));
    }
  };
  app.on(["GET", "POST"], "/submit.php", handle("epay_v1", "submit"));
  app.post("/mapi.php", handle("epay_v1", "create"));
  app.on(["GET", "POST"], "/api.php", handle("epay_v1", "legacy"));
  app.on(["GET", "POST"], "/api/pay/submit", handle("epay_v2", "submit"));
  app.post("/api/pay/create", handle("epay_v2", "create"));
  app.post("/api/pay/query", handle("epay_v2", "query"));
  app.post("/api/merchant/info", handle("epay_v2", "info"));
  app.post("/api/merchant/orders", handle("epay_v2", "orders"));
  for (const path of ["/api/pay/refund", "/api/pay/close", "/api/transfer/create", "/api/merchant/settle"]) {
    app.post(path, handle("epay_v2", "unsupported"));
  }
  app.get("/api/public/v1/checkouts/:token/return", context => {
    options.rateLimit(context);
    const token = context.req.param("token");
    dependencies.orders.publicCheckout(token);
    const metadata = epay.order(dependencies.orders.publicCheckoutOrderId(token));
    if (!metadata?.returnUrl) return context.notFound();
    const credentials = epay.credentialsForSite(metadata.siteId);
    if (!credentials) return context.notFound();
    const order = dependencies.orders.forSite(metadata.siteId).get(metadata.orderId);
    if (order.payment.status !== "CONFIRMED") return context.redirect(new URL(metadata.returnUrl).href, 302);
    const key = metadata.protocol === "epay_v1" ? credentials.v1Key : credentials.platformPrivateKey;
    if (!key) throw new EpayError("epay_secret_missing", "商户通知密钥不可用。");
    const target = buildEpayCallbackUrl(metadata.returnUrl, { pid: metadata.pid, tradeNo: metadata.tradeNo, outTradeNo: order.merchantOrderNo,
      name: order.productName, moneyCents: order.requestedAmountCents, ...(metadata.param !== null ? { param: metadata.param } : {}) }, metadata.protocol, key, now());
    return context.redirect(target, 302);
  });
}

function validateExportCallback(value: string, protocol: "native" | EpayProtocol, field: "notify_url" | "return_url"): void {
  const keys = new Set<string>();
  for (const key of new URL(value).searchParams.keys()) {
    if (keys.has(key)) throw new SettingsFieldError(field, "回调地址的查询参数名不能重复。");
    keys.add(key);
  }
  if (protocol === "native") return;
  if (value.includes("&")) throw new SettingsFieldError(field, "易支付回调地址不能包含 &，请移除该字符或简化查询参数。");
  try { appendEpayParameters(value, {}); }
  catch (error) {
    if (error instanceof EpayProtocolError) throw new SettingsFieldError(field, error.message);
    throw error;
  }
}

function createEpayOrder(dependencies: AppDependencies, epay: EpayStore, credentials: EpayCredentials,
  protocol: EpayProtocol, parameters: EpayParameters, page: boolean, requireBackground: () => void): OrderProjection {
  if ((parameters.type && parameters.type !== "alipay") || (!page && parameters.type !== "alipay")) {
    throw new EpayProtocolError("unsupported_payment_type", "支付方式须为 alipay。");
  }
  if (protocol === "epay_v2" && !page && !["web", "jump"].includes(parameters.method ?? "")) {
    throw new EpayProtocolError("unsupported_method", "支付方法须为 web 或 jump。");
  }
  if (!parameters.notify_url || !parameters.name || !parameters.out_trade_no ||
      (page && protocol === "epay_v1" && !parameters.return_url)) throw new EpayProtocolError("missing_parameter", "缺少必要的下单参数。");
  appendEpayParameters(parameters.notify_url, {});
  if (parameters.return_url) appendEpayParameters(parameters.return_url, {});
  const money = epayMoneyToCents(parameters.money ?? "");
  const param = parameters.param ?? null;
  if (param !== null && (Buffer.byteLength(param) > 4096 || /\p{Cc}/u.test(param))) {
    throw new EpayProtocolError("invalid_parameter", "透传参数最多 4096 个 UTF-8 字节，且不能包含控制字符。");
  }
  const request = createOrderRequestSchema.parse({ idempotency_key: `epay:${parameters.out_trade_no}`, merchant_order_no: parameters.out_trade_no,
    amount_cents: money, product_name: truncateEpayName(parameters.name), notify_url: parameters.notify_url,
    ...(parameters.return_url ? { return_url: parameters.return_url } : {}) });
  const notificationKey = protocol === "epay_v1" ? credentials.v1Key! : credentials.platformPrivateKey!;
  const notificationUrl = buildEpayCallbackUrl(parameters.notify_url, {
    pid: credentials.pid, tradeNo: "9007199254740991", outTradeNo: request.merchant_order_no,
    name: request.product_name, moneyCents: money, ...(param === null ? {} : { param }),
  }, protocol, notificationKey);
  if (Buffer.byteLength(notificationUrl) > 16 * 1024) {
    throw new EpayProtocolError("invalid_parameter", "通知地址与支付参数组合后过长，请缩短地址或透传参数。");
  }
  const requestFingerprint = createHash("sha256").update(JSON.stringify([
    protocol, parameters.out_trade_no, parameters.name, money, parameters.notify_url, parameters.return_url ?? null, param,
  ])).digest("hex");
  const result = dependencies.orders.forSite(credentials.siteId).create(request, requireBackground, {
    siteId: credentials.siteId, protocol, configurationRevision: credentials.revision,
    requestFingerprint, param, returnUrl: parameters.return_url ?? null,
  });
  if (!epay.order(result.order.orderId)) throw new Error("compatibility order metadata is missing");
  dependencies.onOrderAvailable?.(result.order.orderId);
  return result.order;
}

function orderResponse(dependencies: AppDependencies, epay: EpayStore, metadata: EpayOrderMetadata): Record<string, unknown> {
  const order = dependencies.orders.forSite(metadata.siteId).get(metadata.orderId);
  const confirmedAt = order.payment.status === "CONFIRMED" ? epay.paymentConfirmedAt(metadata.orderId) : null;
  if (order.payment.status === "CONFIRMED" && confirmedAt === null) throw new Error("Confirmed compatibility order has no active settlement");
  return { trade_no: metadata.tradeNo, out_trade_no: order.merchantOrderNo, api_trade_no: "", type: "alipay", pid: metadata.pid,
    addtime: providerTime(order.createdAt), endtime: confirmedAt === null ? "" : providerTime(confirmedAt),
    name: order.productName, money: moneyFromCents(order.requestedAmountCents), status: order.payment.status === "CONFIRMED" ? 1 : 0,
    param: metadata.param ?? "", buyer: "", clientip: "" };
}

function signedResponse(value: Record<string, unknown>, protocol: EpayProtocol, credentials: EpayCredentials | null, now: number): Record<string, unknown> {
  if (protocol === "epay_v1" || !credentials?.platformPrivateKey) return value;
  const response = { ...value, timestamp: Math.floor(now / 1000), sign_type: "RSA" };
  return { ...response, sign: signEpayV2(response, credentials.platformPrivateKey) };
}
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function integerParameter(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new EpayProtocolError("invalid_pagination", "分页参数无效。");
  }
  return Number(value);
}
function singleLineKey(value: string): string { return value.replace(/-----[^-]+-----|\s/g, ""); }
function providerTime(value: number): string { return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " "); }
