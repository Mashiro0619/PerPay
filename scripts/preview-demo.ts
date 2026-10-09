// SPDX-License-Identifier: MIT
// Disposable documentation data; never imports main.ts or starts external workers.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { IdentityService } from "../src/identity/service.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { OrderService } from "../src/orders/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore, type CompleteWebhookAttemptInput } from "../src/notifications/store.ts";
import { assessWebhookAck } from "../src/notifications/model.ts";
import { createApp } from "../src/http/app.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";
import { renderCollectionCodeSvg } from "../src/http/web/collection-code.ts";
import { UpdateCheckUnavailable } from "../src/update/checker.ts";
import type { SiteSnapshot } from "../src/sites/model.ts";
import { seedFinancialScenarios } from "./preview-financial-scenarios.ts";
import { seedNotificationScenarios } from "./preview-notification-scenarios.ts";

export const DEMO_QR_TEXT = "PerPay documentation demo - NOT A PAYMENT CODE";
const DAY = 86_400_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HISTORY_DAYS = 90;
const PRODUCTS = [
  ["演示商品 A · 月度方案", 1900],
  ["演示商品 B · 素材包", 2900],
  ["演示商品 C · 年度方案", 9900],
  ["演示商品 D · 季度方案", 4900],
  ["演示商品 E · 支持计划", 3900],
  ["演示商品 F · 永久授权", 12900],
  ["演示商品 G · 年度赞助", 19900],
  ["演示商品 H · 扩展包", 5900],
] as const;
const PRODUCT_MIX = [0, 1, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7];
const WEEKDAY_VOLUME = [0.84, 1.03, 1.08, 1.01, 1.13, 1.18, 0.92];
const sample = (day: number, key: string) => createHash("sha256").update("perpay-preview-history:" + day + ":" + key)
  .digest().readUInt32BE(0) / 0x1_0000_0000;
const beijing = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

export async function createPreviewDemo(options: { port?: number; now?: number } = {}) {
  const port = options.port ?? 6192;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("演示端口必须在 1024–65535 之间。");
  const capturedAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(capturedAt) || capturedAt < Date.UTC(2020, 0, 1)) throw new Error("演示日期无效。");
  const origin = "http://127.0.0.1:" + port;
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "perpay-preview-"));
  let database: AppDatabase | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    // Only remove the exact private directory allocated above, never a supplied data path.
    const target = realpathSync(directory);
    assert.equal(dirname(target), temporaryRoot);
    assert.ok(basename(target).startsWith("perpay-preview-"));
    database?.close();
    rmSync(target, { recursive: true, force: true });
    disposed = true;
  };
  try {
    // Deliberately do not merge process.env: production paths and secrets must not leak in.
    const config = loadConfig({
      PERPAY_MASTER_KEY: randomBytes(32).toString("hex"),
      PERPAY_DATA_DIR: join(directory, "data"),
      PERPAY_BACKUP_DIR: join(directory, "backups"),
      PERPAY_PUBLIC_URL: origin,
    });
    const db = await AppDatabase.open(config.databasePath);
    database = db;
    let liveStarted: number | null = null;
    const liveNow = () => capturedAt + (liveStarted === null ? 0 : Math.floor(performance.now() - liveStarted));
    const identity = new IdentityService(db, liveNow);
    await identity.initialize();
    // Fixed only for this loopback-only, disposable read-only demo; never used by main.ts.
    const password = "123456";
    await identity.setupAdmin(password);
    const settingsStore = new RuntimeSettingsStore(db, config.masterKey);
    const settings = new RuntimeSettingsService({ store: settingsStore });
    settings.initialize();
    const audit = { actorId: "admin", requestId: "documentation-fixture", remoteAddressHash: "0".repeat(64) };
    const application = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await settings.saveCollectionCode({
      revision: settings.instanceView().revision,
      code_payload: "https://qr.alipay.com/perpay-documentation-no-real-payment",
    }, audit);
    await settings.saveProvider({
      revision: settings.instanceView().revision, environment: "SANDBOX", app_id: "2026000000000001",
      private_key: application.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      platform_public_key: platform.publicKey.export({ format: "pem", type: "spki" }).toString(),
      timeout_milliseconds: 8000, scan_interval_seconds: 60, active_scan_interval_seconds: 8,
      safety_lag_seconds: 10, maximum_success_age_seconds: 120,
    }, audit);
    const midnight = Math.floor((capturedAt + 8 * 3_600_000) / DAY) * DAY - 8 * 3_600_000;
    let now = midnight - (HISTORY_DAYS - 1) * DAY;
    // Rebase only the empty, newly migrated order clock before creating any financial facts.
    db.write(connection => {
      assert.equal(Number(connection.prepare("SELECT COUNT(*) AS n FROM payment_orders").get()?.n), 0);
      const trigger = connection.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_clock_no_decrease'").get()?.sql;
      assert.equal(typeof trigger, "string");
      connection.exec("DROP TRIGGER order_clock_no_decrease");
      connection.prepare("UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1").run(now);
      connection.exec(trigger as string);
    });
    const sites = settingsStore.siteStore()!;
    function createSite(name: string, options: {
      notifications?: boolean; credentials?: boolean; acceptingOrders?: boolean;
      pendingOrderLimit?: number; origin?: string | null;
    } = {}) {
      const policy = sites.defaults().policy;
      const site = sites.create({ operation_id: randomUUID(), configuration: {
        name, accepting_orders: options.acceptingOrders ?? true, notifications_enabled: false,
        notification_origin: options.origin === undefined ? "https://shop.example.com" : options.origin,
        return_origin: options.origin === undefined ? "https://shop.example.com" : options.origin,
        policy: { ...policy, orders: { ...policy.orders, order_ttl_seconds: 1800,
          pending_order_limit: options.pendingOrderLimit ?? null }, display: { ...policy.display, checkout_name: name },
          notification_delivery: { ...policy.notification_delivery, retry_base_seconds: 1200, retry_maximum_seconds: 1200 } },
      } }, audit, now);
      if (options.credentials === false) return site;
      const api = sites.rotateSecret(site.clientId, "api_secret", site.revision, audit, now);
      if (options.notifications === false) return api.site;
      const webhook = sites.rotateSecret(site.clientId, "webhook_secret", api.site.revision, audit, now);
      return sites.update(site.clientId, { revision: webhook.site.revision,
        configuration: { ...webhook.site.configuration, notifications_enabled: true } }, audit, now);
    }
    const demoSites = [createSite("演示商店"), createSite("演示订阅网站")];
    const financialSite = createSite("演示财务处理", { origin: "https://finance.example.com" });
    const notificationSite = createSite("演示通知联调", { origin: "https://callbacks.example.com" });
    const pausedSite = createSite("演示暂停接单", { origin: "https://archive.example.com" });
    const unconfiguredSite = createSite("演示待接入网站", { credentials: false, acceptingOrders: false, origin: null });
    const noNotificationSite = createSite("演示通知关闭网站", { notifications: false, origin: null });
    const limitedSite = createSite("演示待支付限额", { pendingOrderLimit: 2 });
    const orders = new OrderService(db, () => settings.instanceSnapshot(), () => liveStarted === null ? now : liveNow(), sites);
    orders.initialize();
    const ledger = new LedgerStore(db);
    const reconciliation = new ReconciliationStore(db);
    const webhooks = new WebhookStore(db);
    const snapshot = settings.instanceSnapshot();
    assert.ok(snapshot.activeProviderAccountKey);
    const providerAccountKey = snapshot.activeProviderAccountKey;
    let sequence = 0;
    let ledgerSequence = 0;
    function credit(cents: number, product: string) {
      const n = ++ledgerSequence;
      const occurredAt = beijing(now);
      const amount = (cents / 100).toFixed(2);
      const id = "DEMO-LEDGER-" + String(n).padStart(6, "0");
      const run = ledger.startIngestRun({ providerAccountKey, start: beijing(now - MINUTE), end: beijing(now + 1000 + n), pageSize: 1, now });
      const result = ledger.recordPage({
        ingestRunId: run.ingestRunId,
        page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
          raw: { account_log_id: id, amount, direction: "CREDIT", occurred_at: occurredAt },
          accountLogId: id, occurredAt, amount, direction: "CREDIT",
          alipayOrderNo: "DEMO" + beijing(now).slice(0, 10).replaceAll("-", "") + String(n).padStart(10, "0"),
          merchantOrderNo: null, transMemo: product, otherAccount: "演示付款人 " + String(n % 28 + 1).padStart(2, "0"),
        }] },
        // Synthetic evidence, not a provider response or a real signature verification.
        evidence: { httpStatus: 200, headers: { "alipay-request-id": id }, body: JSON.stringify({ id, amount, occurredAt, synthetic: true }), traceId: id, signatureVerified: true },
        now: now + 1,
      });
      const entry = result.normalized[0];
      assert.ok(entry?.kind === "created");
      return entry.entry;
    }
    function deliver(clientId: string, outcome: CompleteWebhookAttemptInput["outcome"] = "ACKNOWLEDGED", maximumAttempts = 5, expectedOrderId?: string) {
      webhooks.materialize(100, now, clientId);
      const claim = webhooks.claimNext({ clientId, siteRevision: sites.get(clientId)!.revision, now, leaseMilliseconds: 30_000, maximumAttempts });
      if (!claim) return false;
      if (expectedOrderId !== undefined) assert.equal(claim.event.orderId, expectedOrderId, "Demo notification must belong to the intended order");
      const body = Buffer.from(JSON.stringify(outcome === "ACKNOWLEDGED" ? {
        schema: "perpay:webhook-ack:v1", ack: true, event_id: claim.event.eventId, delivery_id: claim.delivery.deliveryId,
      } : { error: "synthetic_receiver_failure" }));
      const httpStatus = outcome === "ACKNOWLEDGED" ? 200 : outcome === "PERMANENT_FAILURE" ? 410 : 503;
      const ack = assessWebhookAck({ status: httpStatus, contentType: "application/json", contentEncoding: null,
        body, eventId: claim.event.eventId, deliveryId: claim.delivery.deliveryId });
      assert.equal(ack.acknowledged, outcome === "ACKNOWLEDGED");
      webhooks.completeAttempt({
        deliveryId: claim.delivery.deliveryId, attemptId: claim.attempt.attemptId, leaseToken: claim.attempt.leaseToken,
        outcome, now: now + 120, maximumAttempts, retryBaseMilliseconds: 20 * MINUTE, retryMaximumMilliseconds: 20 * MINUTE,
        resolvedAddressesFingerprint: "b".repeat(64), connectedAddress: "203.0.113.10",
        httpStatus, responseBytes: body.byteLength,
        responseFingerprint: createHash("sha256").update(body).digest("hex"),
        ackCode: ack.code,
        errorCode: ack.acknowledged ? null : ack.code,
      });
      return true;
    }
    function create(productIndex: number, status: "paid" | "closed" | "expired" | "open" = "paid", notify = true, deliveryOutcome: CompleteWebhookAttemptInput["outcome"] = "ACKNOWLEDGED", options: {
      site?: SiteSnapshot; productName?: string; amountCents?: number; merchantOrderNo?: string; note?: string; returnUrl?: boolean;
    } = {}) {
      const [defaultProduct, defaultAmount] = PRODUCTS[productIndex % PRODUCTS.length]!;
      const product = options.productName ?? defaultProduct;
      const amount = options.amountCents ?? defaultAmount;
      const site = options.site ?? demoSites[sequence % demoSites.length]!;
      const siteOrders = orders.forSite(site.clientId);
      const order = siteOrders.create(createOrderRequestSchema.parse({
        idempotency_key: "readme-" + ++sequence,
        merchant_order_no: options.merchantOrderNo ?? "MG" + beijing(now).slice(0, 10).replaceAll("-", "") + "-" + String(sequence).padStart(4, "0"),
        product_name: product, amount_cents: amount, note: options.note ?? "示例商户 · 文档演示订单（非真实交易）",
        ...(notify ? { notify_url: site.configuration.notification_origin + "/api/payments/perpay" } : {}),
        ...(options.returnUrl ? { return_url: site.configuration.return_origin + "/orders/complete" } : {}),
      })).order;
      if (status === "paid") {
        now += 35_000 + (sequence % 5) * 12_000;
        const entry = credit(order.payableAmountCents, product);
        assert.equal(reconciliation.reconcileEntry(entry.ledgerEntryId, now + 2500).kind, "auto_settled");
        now += 3000;
        deliver(site.clientId, deliveryOutcome, deliveryOutcome === "PERMANENT_FAILURE" ? 1 : 5, notify ? order.orderId : undefined);
      } else if (status === "closed") {
        now += 8000;
        siteOrders.close(order.orderId);
      }
      return { ...order, apiClientId: site.clientId };
    }
    const setNow = (time: number) => {
      assert.ok(Number.isSafeInteger(time) && time >= now && time <= capturedAt, "Demo scenarios must advance within the captured timeline");
      now = time;
    };
    const assertIntegrity = (stage: string) => {
      const integrity = db.integrityCheck();
      assert.ok(integrity.ok, "Demo integrity after " + stage + ": " + JSON.stringify(integrity));
    };
    assertIntegrity("website setup");

    // Seed real order/payment events in chronological order. The daily basket
    // varies deterministically by date, weekday, product mix and a gentle trend.
    // Morning history leaves expired unpaid slots clear before afternoon cases.
    const history: { at: number; product: number; status: "paid" | "closed" | "expired"; notify: boolean }[] = [];
    for (let d = 0; d < HISTORY_DAYS; d++) {
      const day = midnight - (HISTORY_DAYS - 1 - d) * DAY;
      const weekday = new Date(day + 8 * HOUR).getUTCDay();
      const growth = 11 + 7 * d / (HISTORY_DAYS - 1);
      const count = Math.max(6, Math.round(growth * WEEKDAY_VOLUME[weekday]! + (sample(day, "volume") - 0.5) * 7));
      const start = day + 7 * HOUR + Math.floor(sample(day, "opening") * 30 * MINUTE);
      const span = 4 * HOUR;
      for (let i = 0; i < count; i++) {
        const at = Math.floor(start + span * (i + 0.15 + sample(day, "time:" + i) * 0.7) / count);
        // Today includes only elapsed time, with room for the live checkout cases.
        if (at + 2 * MINUTE > capturedAt - 120 * MINUTE) continue;
        const outcome = sample(day, "status:" + i);
        history.push({ at, product: PRODUCT_MIX[Math.floor(sample(day, "product:" + i) * PRODUCT_MIX.length)]!,
          status: outcome < 0.06 ? "closed" : outcome < 0.13 ? "expired" : "paid", notify: sample(day, "notify:" + i) >= 0.08 });
      }
    }
    let historyPosition = 0;
    const advanceTo = (time: number) => {
      while (historyPosition < history.length && history[historyPosition]!.at < time) {
        const item = history[historyPosition++]!;
        setNow(item.at);
        create(item.product, item.status, item.notify);
        assert.ok(now <= time, "Historical order processing must finish before the next scenario");
      }
      setNow(time);
    };
    const scheduleCases = (firstDay: number) => {
      let index = 0;
      return (_key: string) => {
        const day = firstDay + Math.floor(index / 2) * DAY;
        const hour = index++ % 2 === 0 ? 14 : 18;
        advanceTo(day + hour * HOUR);
      };
    };
    const scheduleFinancial = scheduleCases(midnight - 28 * DAY);
    const financial = seedFinancialScenarios({ database: db, orders, ledger, reconciliation, site: financialSite, audit,
      providerAccountKey, getNow: () => now, setNow, beforeScenario: key => {
        // Keep callback evidence on the same dates as the financial events.
        while (deliver(financialSite.clientId)) now += 250;
        scheduleFinancial(key);
      } });
    assertIntegrity("financial scenarios");
    assert.ok(now < midnight - 20 * DAY, "Financial scenarios exceeded their reserved dates");
    // Settle simulated callbacks for every financial event, including reversals and disputes.
    while (deliver(financialSite.clientId)) now += 250;

    const lifecycle: Record<string, string> = {};
    const notifications = seedNotificationScenarios({ orders, ledger, reconciliation, webhooks, sites, site: notificationSite,
      providerAccountKey, audit, getNow: () => now, setNow, capturedAt, beforeScenario: scheduleCases(midnight - 19 * DAY) });
    assertIntegrity("notification histories");
    assert.ok(now < midnight - 10 * DAY, "Notification scenarios exceeded their reserved dates");

    advanceTo(midnight - 9 * DAY + 14 * HOUR);
    lifecycle.pausedSiteHistory = create(4, "paid", true, "ACKNOWLEDGED", {
      site: pausedSite, productName: "暂停接单网站 · 历史付款仍可查", merchantOrderNo: "DEMO-LIFE-PAUSED-SITE",
    }).orderId;
    sites.update(pausedSite.clientId, { revision: pausedSite.revision,
      configuration: { ...pausedSite.configuration, accepting_orders: false } }, audit, now);
    advanceTo(midnight - 8 * DAY + 14 * HOUR);
    lifecycle.notificationsDisabled = create(5, "paid", false, "ACKNOWLEDGED", {
      site: noNotificationSite, productName: "网站未开启通知 · 已确认收款", merchantOrderNo: "DEMO-LIFE-NOTIFY-DISABLED",
    }).orderId;
    advanceTo(midnight - 7 * DAY + 14 * HOUR);
    lifecycle.noNotificationRequested = create(2, "paid", false, "ACKNOWLEDGED", {
      productName: "订单未配置回调 · 业务主动查单", merchantOrderNo: "DEMO-LIFE-NO-CALLBACK",
    }).orderId;
    advanceTo(midnight - 5 * DAY + 14 * HOUR);
    lifecycle.largeAmount = create(6, "paid", true, "ACKNOWLEDGED", {
      productName: "大额订单 · 团队年度方案", amountCents: 99_900, merchantOrderNo: "DEMO-LIFE-LARGE",
    }).orderId;
    advanceTo(midnight - 4 * DAY + 14 * HOUR);
    lifecycle.smallAmount = create(0, "paid", true, "ACKNOWLEDGED", {
      productName: "小额订单 · 一分钱体验", amountCents: 1, merchantOrderNo: "DEMO-LIFE-SMALL",
    }).orderId;
    advanceTo(midnight - 3 * DAY + 14 * HOUR);
    const failed = create(4, "paid", true, "PERMANENT_FAILURE", {
      productName: "收款成功 · 通知停止重试", merchantOrderNo: "DEMO-LIFE-CALLBACK-DEAD",
    });
    lifecycle.notificationFailed = failed.orderId;
    // Keep a small set of recent terminal checkouts inside the normal public
    // observation window; older cases remain available in administrator history.
    advanceTo(capturedAt - 98 * MINUTE);
    lifecycle.expired = create(2, "expired", true, "ACKNOWLEDGED", {
      productName: "过期未付款 · 收银台已失效", merchantOrderNo: "DEMO-LIFE-EXPIRED",
    }).orderId;
    setNow(capturedAt - 28 * MINUTE);
    lifecycle.expiringSoon = create(3, "open", true, "ACKNOWLEDGED", {
      productName: "即将超时 · 付款倒计时", merchantOrderNo: "DEMO-LIFE-EXPIRING",
    }).orderId;
    setNow(capturedAt - 20 * MINUTE);
    lifecycle.closed = create(1, "closed", true, "ACKNOWLEDGED", {
      productName: "用户取消 · 已关闭未付款", merchantOrderNo: "DEMO-LIFE-CLOSED",
    }).orderId;
    setNow(capturedAt - 16 * MINUTE);
    const disputed = create(1, "paid", true, "ACKNOWLEDGED", {
      productName: "近期争议 · 收款关联已撤销", merchantOrderNo: "DEMO-LIFE-DISPUTED",
    });
    const disputedMatch = reconciliation.paymentMatchDetailsForOrder(disputed.orderId)
      .find(item => item.paymentMatch.status === "SETTLED")?.paymentMatch;
    assert.ok(disputedMatch);
    now += 1000;
    reconciliation.reverseSettlement({ financialOperationId: randomUUID(), expectedClientId: disputed.apiClientId,
      paymentMatchId: disputedMatch.paymentMatchId, actorId: audit.actorId,
      reason: "近期演示：复核发现付款归属有争议，撤销收款关联并保留收银台状态。", now });
    while (deliver(disputed.apiClientId)) now += 250;
    lifecycle.disputed = disputed.orderId;
    setNow(capturedAt - 10 * MINUTE);
    const retry = create(7, "paid", true, "RETRYABLE_FAILURE", {
      productName: "收款成功 · 通知等待重试", merchantOrderNo: "DEMO-LIFE-CALLBACK-RETRY",
    });
    lifecycle.notificationRetry = retry.orderId;
    setNow(capturedAt - 8 * MINUTE);
    const checkout = create(0, "open", true, "ACKNOWLEDGED", {
      productName: "待支付 · 标准收银台", merchantOrderNo: "DEMO-LIFE-OPEN", returnUrl: true,
    });
    lifecycle.open = checkout.orderId;
    setNow(capturedAt - 7 * MINUTE);
    lifecycle.limitedFirst = create(1, "open", true, "ACKNOWLEDGED", {
      site: limitedSite, productName: "并发待支付限额 · 第一笔", merchantOrderNo: "DEMO-LIFE-LIMIT-1",
    }).orderId;
    setNow(capturedAt - 6 * MINUTE);
    lifecycle.limitedSecond = create(2, "open", true, "ACKNOWLEDGED", {
      site: limitedSite, productName: "并发待支付限额 · 第二笔", merchantOrderNo: "DEMO-LIFE-LIMIT-2",
    }).orderId;
    setNow(capturedAt - 5 * MINUTE);
    lifecycle.longDescription = create(3, "open", true, "ACKNOWLEDGED", {
      productName: "长文本示例 · 团队协作年度订阅（含扩展席位、数据迁移、跨时区协作与专属支持） / Team Annual Plan",
      merchantOrderNo: "DEMO-LIFE-LONG-TEXT",
      note: "模拟订单备注：" + "用于检查详情、表格、搜索结果及移动端的长中文与 English 混排。".repeat(5), returnUrl: true,
    }).orderId;
    setNow(capturedAt - 2 * MINUTE);
    const featured = create(5, "paid", true, "ACKNOWLEDGED", {
      site: demoSites[0]!, productName: "完整收款示例 · 已到账且通知成功", merchantOrderNo: "DEMO-LIFE-FULL-EVIDENCE",
      note: "模拟完整业务链：订单创建 → 支付流水入账 → 自动关联收款 → 业务通知确认。可查看付款人、账本凭据、通知请求与响应证据。", returnUrl: true,
    });
    lifecycle.fullEvidence = featured.orderId;
    setNow(capturedAt - 5000);
    notifications.finalize();
    setNow(capturedAt);
    assert.equal(historyPosition, history.length, "All scheduled history must be seeded");
    // Exercise the real expiry path, including the explicitly labelled expired order.
    for (const orderId of Object.values(lifecycle)) orders.adminGet(orderId);
    const stats = systemAnalytics(db, 30, now);
    assert.ok(stats.orders.created > 400);
    assert.ok(stats.pending.orders >= 4);
    assertIntegrity("all scenarios");
    const scenarios = { lifecycle, financial, notifications: { orders: notifications.orders, deliveries: notifications.deliveries },
      sites: { store: demoSites[0]!.clientId, subscriptions: demoSites[1]!.clientId,
        financial: financialSite.clientId, notifications: notificationSite.clientId, paused: pausedSite.clientId,
        unconfigured: unconfiguredSite.clientId, no_notifications: noNotificationSite.clientId, limited: limitedSite.clientId } };

    liveStarted = performance.now();
    // Health is explicitly simulated; no scheduler, provider client or webhook transport runs.
    const healthy = () => ({ enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: liveNow() - 3000, lastSuccessAt: liveNow() - 2000, lastErrorCode: null, consecutiveFailures: 0, paymentRevision: settings.instanceSnapshot().paymentRevision });
    const app = createApp({
      config, database: db, identity, settings, sites, orders, ledger, reconciliation, webhookStore: webhooks,
      startedAt: new Date(capturedAt - 8 * DAY), clock: liveNow, demoMode: true,
      ledgerHealth: healthy,
      reconciliationHealth: () => ({ ...healthy(), pendingOrders: systemAnalytics(db, 7, liveNow()).pending.orders, continuationPending: false }),
      webhookHealth: () => ({ ...healthy(), pendingDeliveries: webhooks.counts().pending, deadLetters: webhooks.counts().dead }),
      // Never claim a real update check has succeeded and never contact GitHub.
      updateChecker: { check: async () => { throw new UpdateCheckUnavailable(3600); } },
    });
    const preview = new Hono();
    preview.use("*", async (context, next) => {
      context.header("X-PerPay-Demo", "read-only; health=simulated");
      const sessionAction = context.req.method === "POST" && ["/api/admin/v1/session/login", "/api/admin/v1/session/logout"].includes(context.req.path);
      const exportRead = context.req.method === "POST" && /^\/api\/admin\/v1\/(?:sites\/[^/]+\/)?orders\/export$/.test(context.req.path);
      if (!["GET", "HEAD"].includes(context.req.method) && !sessionAction && !exportRead) {
        return context.json({ error: { code: "demo_read_only", message: "这是只读演示，不执行付款、设置或财务操作。" } }, 403);
      }
      await next();
    });
    // Replace the displayed code with plain text, so a screenshot can never initiate payment.
    // Gate through the real route first, preserving token/status checks and security headers.
    preview.get("/api/public/v1/checkouts/:token/qr.svg", async context => {
      const response = await app.fetch(context.req.raw);
      if (!response.ok) return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("etag");
      return new Response(renderCollectionCodeSvg(DEMO_QR_TEXT), { headers });
    });
    preview.route("/", app);
    return { app: preview, database: db, directory, origin, password, capturedAt, stats, scenarios, featured: featured.orderId, failed: failed.orderId, retry: retry.orderId, checkout: checkout.checkoutToken, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0 && (args.length !== 2 || args[0] !== "--port")) throw new Error("用法：npm run demo:preview -- [--port 6192]");
  for (const path of ["web-dist/admin/index.html", "web-dist/checkout/.vite/manifest.json"]) {
    if (!existsSync(resolve(path))) throw new Error("请先在仓库根目录执行 npm run build。");
  }
  const demo = await createPreviewDemo(args.length ? { port: Number(args[1]) } : {});
  const server = serve({ fetch: demo.app.fetch, hostname: "127.0.0.1", port: Number(new URL(demo.origin).port) }, () => {
    console.log("\nPerPay 只读演示 · 全部为合成数据 · 不向外部服务发请求");
    console.log(JSON.stringify({ origin: demo.origin, password: demo.password, capturedAt: demo.capturedAt, featured: demo.featured, retry: demo.retry, failed: demo.failed, checkout: demo.checkout, orders: demo.stats.orders, daily: demo.stats.daily, directory: demo.directory, scenarios: demo.scenarios }, null, 2));
    console.log("\n访问 " + demo.origin + "/admin/，按 Ctrl+C 退出并清理临时数据。");
  });
  server.on("error", error => { demo.dispose(); console.error(error.message); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => demo.dispose());
    if ("closeAllConnections" in server) server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error); process.exitCode = 1; });
}
