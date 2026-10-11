// SPDX-License-Identifier: MIT
// Synthetic local evidence only. No transport or notification worker is started.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import type { LedgerStore } from "../src/ledger/store.ts";
import { assessWebhookAck, type WebhookDelivery } from "../src/notifications/model.ts";
import type { ClaimedWebhookAttempt, WebhookStore } from "../src/notifications/store.ts";
import { createOrderRequestSchema, type OrderProjection } from "../src/orders/model.ts";
import type { OrderService } from "../src/orders/service.ts";
import type { ReconciliationStore } from "../src/reconciliation/store.ts";
import type { SettingsAuditContext } from "../src/settings/store.ts";
import type { SiteSnapshot } from "../src/sites/model.ts";
import type { SiteStore } from "../src/sites/store.ts";
import { previewLedgerNumber, previewOrderNumber, previewPayer, previewTradeNumber } from "./preview-identities.ts";

export interface NotificationScenarioContext {
  readonly orders: OrderService;
  readonly ledger: LedgerStore;
  readonly reconciliation: ReconciliationStore;
  readonly webhooks: WebhookStore;
  readonly sites: SiteStore;
  readonly site: SiteSnapshot;
  readonly providerAccountKey: string;
  readonly audit: SettingsAuditContext;
  readonly getNow: () => number;
  readonly setNow: (now: number) => void;
  readonly capturedAt: number;
  /** Advance to the next historical slot before this scenario creates any order evidence. */
  readonly beforeScenario?: (key: string) => void;
}

type AttemptResult =
  | { readonly kind: "ack" }
  | { readonly kind: "http"; readonly status: number; readonly permanent?: boolean; readonly invalidAck?: boolean; readonly invalidEncoding?: boolean }
  | { readonly kind: "transport"; readonly errorCode: string; readonly outcome: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "OUTCOME_UNKNOWN" };

const MINUTE = 60_000;
const MAXIMUM_ATTEMPTS = 5;
const RETRY_BASE = 5_000;
const RETRY_MAXIMUM = 20_000;
// Typical product prices, deliberately varied and independent of the scenario number.
const ORDER_PRICES_CENTS = [
  2_900, 4_900, 8_800, 3_900, 5_900, 12_900, 7_900, 4_500, 6_900,
  14_900, 9_900, 3_500, 15_900, 5_500, 8_900, 11_900, 19_900,
] as const;
const DEMO_ADDRESS = "203.0.113.10";
const fingerprint = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const beijing = (now: number) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

/** Finalize only after other fixture deliveries have been claimed and completed. */
export function seedNotificationScenarios(context: NotificationScenarioContext): {
  readonly orders: Record<string, string>;
  readonly deliveries: Record<string, string>;
  readonly finalize: () => void;
} {
  const { ledger, reconciliation, webhooks, sites, audit, providerAccountKey } = context;
  const clientId = context.site.clientId;
  assert.ok(context.site.configuration.notifications_enabled, "Notification fixture needs its own enabled website");
  assert.ok(context.site.configuration.notification_origin);
  const origin = context.site.configuration.notification_origin;
  const scenarioOrders: Record<string, string> = {};
  const scenarioDeliveries: Record<string, string> = {};
  let sequence = 0;
  let finalized = false;

  function advance(milliseconds: number) {
    const now = context.getNow() + milliseconds;
    assert.ok(now <= context.capturedAt, "Notification fixture must not create future evidence");
    context.setNow(now);
    return now;
  }

  // Keep the displayed site policy consistent with the accelerated fixture history.
  const current = sites.get(clientId)!;
  sites.update(clientId, { revision: current.revision, configuration: {
    ...current.configuration,
    policy: { ...current.configuration.policy, notification_delivery: {
      ...current.configuration.policy.notification_delivery,
      maximum_attempts: MAXIMUM_ATTEMPTS,
      retry_base_seconds: RETRY_BASE / 1000,
      retry_maximum_seconds: RETRY_MAXIMUM / 1000,
    } },
  } }, audit, context.getNow());

  function paidOrder(key: string, productName: string, note: string, notify = true): OrderProjection {
    context.beforeScenario?.(key);
    const number = ++sequence;
    const price = ORDER_PRICES_CENTS[number - 1];
    assert.ok(price !== undefined, "Every notification scenario needs an explicit typical product price");
    const order = context.orders.forSite(clientId).create(createOrderRequestSchema.parse({
      idempotency_key: "preview-notification-" + key,
      merchant_order_no: previewOrderNumber(context.getNow(), number, 30),
      product_name: productName,
      amount_cents: price,
      note,
      ...(notify ? { notify_url: origin + "/api/payments/perpay" } : {}),
    })).order;
    scenarioOrders[key] = order.orderId;
    advance(8_000);
    const now = context.getNow();
    const occurredAt = beijing(now);
    const amount = (order.payableAmountCents / 100).toFixed(2);
    const id = previewLedgerNumber(now, number, 30);
    const tradeNumber = previewTradeNumber(now, number, 30);
    const payer = previewPayer(number);
    const run = ledger.startIngestRun({ providerAccountKey, start: beijing(now - MINUTE), end: beijing(now + 1_000), pageSize: 1, now });
    const recorded = ledger.recordPage({
      ingestRunId: run.ingestRunId,
      page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
        raw: {
          account_log_id: id, amount, direction: "CREDIT", occurred_at: occurredAt,
          alipay_order_no: tradeNumber, merchant_order_no: order.merchantOrderNo,
          trans_memo: productName, other_account: payer, synthetic: true,
        },
        accountLogId: id, occurredAt, amount, direction: "CREDIT",
        alipayOrderNo: tradeNumber, merchantOrderNo: order.merchantOrderNo,
        transMemo: productName, otherAccount: payer,
      }] },
      evidence: {
        httpStatus: 200, headers: { "alipay-request-id": id },
        body: JSON.stringify({ id, amount, occurredAt, synthetic: true }),
        traceId: id, signatureVerified: true,
      },
      now: advance(10),
    });
    const entry = recorded.normalized[0];
    assert.ok(entry?.kind === "created", "Notification scenario must have its own receipt");
    assert.equal(reconciliation.reconcileEntry(entry.entry.ledgerEntryId, advance(10)).kind, "auto_settled");
    return order;
  }

  function materialize(key: string, order: OrderProjection): WebhookDelivery {
    assert.equal(webhooks.materialize(100, context.getNow(), clientId), 1, "Only the next scenario should be awaiting materialization");
    const detail = webhooks.listDeliveriesForOrder({ orderId: order.orderId, limit: 10 }).deliveries[0];
    assert.ok(detail);
    scenarioDeliveries[key] = detail.delivery.deliveryId;
    return detail.delivery;
  }

  function claim(delivery: WebhookDelivery, leaseMilliseconds = 30_000): ClaimedWebhookAttempt {
    if (delivery.nextAttemptAt > context.getNow()) context.setNow(delivery.nextAttemptAt);
    const claimed = webhooks.claimNext({
      clientId, siteRevision: sites.get(clientId)!.revision,
      now: context.getNow(), leaseMilliseconds, maximumAttempts: MAXIMUM_ATTEMPTS,
    });
    assert.ok(claimed, "Notification scenario should have a claimable delivery");
    assert.equal(claimed.delivery.deliveryId, delivery.deliveryId, "A scenario must not consume another scenario's delivery");
    return claimed;
  }

  function finish(claimed: ClaimedWebhookAttempt, result: AttemptResult, retryBase = RETRY_BASE, retryMaximum = RETRY_MAXIMUM): WebhookDelivery {
    const input = {
      deliveryId: claimed.delivery.deliveryId, attemptId: claimed.attempt.attemptId,
      leaseToken: claimed.attempt.leaseToken, now: advance(120), maximumAttempts: MAXIMUM_ATTEMPTS,
      retryBaseMilliseconds: retryBase, retryMaximumMilliseconds: retryMaximum,
    };
    if (result.kind === "transport") {
      return webhooks.completeAttempt({ ...input, outcome: result.outcome, errorCode: result.errorCode });
    }
    const body = Buffer.from(JSON.stringify(result.kind === "ack" ? {
      schema: "perpay:webhook-ack:v1", ack: true,
      event_id: claimed.event.eventId, delivery_id: claimed.delivery.deliveryId,
    } : result.invalidAck ? { success: true, message: "付款状态已更新" } : { error: "synthetic_receiver_failure" }));
    const httpStatus = result.kind === "ack" ? 200 : result.status;
    const ack = assessWebhookAck({
      status: httpStatus, contentType: "application/json; charset=utf-8",
      contentEncoding: result.kind === "http" && result.invalidEncoding ? "gzip" : null,
      body, eventId: claimed.event.eventId, deliveryId: claimed.delivery.deliveryId,
    });
    assert.equal(ack.acknowledged, result.kind === "ack");
    return webhooks.completeAttempt({
      ...input,
      outcome: result.kind === "ack" ? "ACKNOWLEDGED" : result.permanent ? "PERMANENT_FAILURE" : "RETRYABLE_FAILURE",
      resolvedAddressesFingerprint: fingerprint(JSON.stringify([DEMO_ADDRESS])), connectedAddress: DEMO_ADDRESS,
      httpStatus, responseBytes: body.byteLength, responseFingerprint: fingerprint(body),
      ackCode: ack.code, errorCode: ack.acknowledged ? null : ack.code,
    });
  }

  function attempt(delivery: WebhookDelivery, result: AttemptResult): WebhookDelivery {
    return finish(claim(delivery), result);
  }

  function begin(key: string, productName: string, note: string): WebhookDelivery {
    return materialize(key, paidOrder(key, productName, note));
  }

  function replay(key: string, predecessor: WebhookDelivery, reason: string): WebhookDelivery {
    const replayed = webhooks.replay({
      expectedClientId: clientId, redeliveryId: randomUUID(), deliveryId: predecessor.deliveryId,
      actorId: audit.actorId, reason, activeAllowedOrigin: origin, now: context.getNow(),
      requestId: audit.requestId, remoteAddressHash: audit.remoteAddressHash,
    });
    assert.equal(replayed.replayed, false);
    scenarioDeliveries[key] = replayed.delivery.deliveryId;
    return replayed.delivery;
  }

  attempt(begin("acknowledged", "笔记云同步月度会员", "老用户续订一个月，延续原有云同步空间。"), { kind: "ack" });

  let delivery = begin("retrySucceeded", "摄影调色预设包", "摄影工作室购买暖色系调色预设，授权单人使用。");
  delivery = attempt(delivery, { kind: "transport", errorCode: "transport_timeout", outcome: "OUTCOME_UNKNOWN" });
  delivery = attempt(delivery, { kind: "http", status: 503 });
  attempt(delivery, { kind: "ack" });

  delivery = begin("deadLetter", "个人作品集模板", "个人作品集模板，包含桌面和手机端布局。");
  for (let count = 0; count < MAXIMUM_ATTEMPTS; count++) delivery = attempt(delivery, { kind: "http", status: 503 });
  assert.equal(delivery.status, "DEAD_LETTER");

  delivery = begin("invalidAck", "轻量云盘月度会员", "扩容至 100 GB，保留原账号中的文件。");
  for (let count = 0; count < MAXIMUM_ATTEMPTS; count++) delivery = attempt(delivery, { kind: "http", status: 200, invalidAck: true });
  assert.equal(delivery.lastErrorCode, "ack_shape_invalid");

  attempt(begin("httpRejected", "效率工具年度授权", "效率工具个人版授权，绑定当前购买账号。"), { kind: "http", status: 404, permanent: true });
  attempt(begin("tlsFailure", "设计素材季度会员", "季度会员续费，保留已收藏的设计素材。"), { kind: "transport", errorCode: "tls_verification_failed", outcome: "PERMANENT_FAILURE" });
  attempt(begin("forbiddenTarget", "网页插画素材合集", "网站改版使用，包含插画源文件与商用授权。"), { kind: "transport", errorCode: "target_address_forbidden", outcome: "PERMANENT_FAILURE" });

  delivery = begin("leaseRecovered", "项目管理模板包", "项目看板和周计划模板，供个人工作空间使用。");
  const interrupted = claim(delivery, 2_000);
  context.setNow(interrupted.delivery.leaseExpiresAt! + 1);
  assert.equal(webhooks.recoverExpired(context.getNow()), 1);
  delivery = webhooks.delivery(delivery.deliveryId)!.delivery;
  attempt(delivery, { kind: "ack" });

  delivery = begin("manualReplaySucceeded", "团队协作空间月度订阅", "三人协作空间续费，沿用现有团队成员。");
  delivery = attempt(delivery, { kind: "http", status: 410, permanent: true });
  scenarioDeliveries.manualReplayOriginal = delivery.deliveryId;
  advance(1_000);
  delivery = replay("manualReplaySucceeded", delivery, "业务接收端的通知路径已修复，补发付款确认通知。");
  attempt(delivery, { kind: "ack" });

  delivery = begin("replayHistory", "商业字体授权包", "购买商业字体授权，开票抬头与账户资料一致。");
  delivery = attempt(delivery, { kind: "http", status: 410, permanent: true });
  scenarioDeliveries.replayHistoryOriginal = delivery.deliveryId;
  advance(1_000);
  sites.rotateSecret(clientId, "webhook_secret", sites.get(clientId)!.revision, audit, context.getNow());
  delivery = replay("replayHistorySecond", delivery, "已完成签名密钥轮换，使用新密钥补发付款通知。");
  delivery = attempt(delivery, { kind: "http", status: 200, invalidEncoding: true, permanent: true });
  advance(1_000);
  delivery = replay("replayHistory", delivery, "接收端已修复确认响应的压缩编码，重新补发付款通知。");
  attempt(delivery, { kind: "ack" });

  const replayPendingOriginal = attempt(begin("replayPending", "云笔记年度会员", "续订一年，沿用原有笔记和共享设置。"), { kind: "ack" });
  scenarioDeliveries.replayPendingOriginal = replayPendingOriginal.deliveryId;
  paidOrder("disabled", "生活记账模板", "购买年度记账模板，付款后由客服发送下载方式。", false);

  // Build every order before the caller creates its latest complete example.
  // Preserve this queue order for finalize; no later materialization is allowed
  // for this site, so the final unmaterialized example keeps its empty history.
  const retrying = begin("retrying", "设计资源年度会员", "年度素材会员升级，包含图标和幻灯片模板。");
  const dnsRetry = begin("dnsRetry", "播客剪辑音效包", "播客后期剪辑使用，包含商用音效授权。");
  const leased = begin("leased", "剪辑工具个人授权", "剪辑工具个人授权，绑定当前账号。");
  begin("pending", "团队知识库季度订阅", "团队知识库续费三个月，保留原有空间。");
  paidOrder("unmaterialized", "设计工具专业版年度订阅", "设计工具年度续费，使用当前专业版账号。");
  assert.ok(context.getNow() <= context.capturedAt - 20 * MINUTE, "Notification history must leave time for the remaining fixtures");

  function finalize() {
    assert.equal(finalized, false, "Notification scenarios should only be finalized once");
    finalized = true;
    const startedAt = context.getNow();
    assert.ok(startedAt >= context.capturedAt - 5_000 && startedAt <= context.capturedAt - 4_000, "Finalize notification scenarios in the last five seconds of the fixture");
    const latestSite = sites.get(clientId)!;
    sites.update(clientId, { revision: latestSite.revision, configuration: {
      ...latestSite.configuration,
      policy: { ...latestSite.configuration.policy, notification_delivery: {
        ...latestSite.configuration.policy.notification_delivery,
        retry_base_seconds: 600, retry_maximum_seconds: 600,
      } },
    } }, audit, startedAt);
    const delayed = finish(claim(retrying), { kind: "transport", errorCode: "transport_timeout", outcome: "OUTCOME_UNKNOWN" }, 10 * MINUTE, 10 * MINUTE);
    const dnsDelayed = finish(claim(dnsRetry), { kind: "transport", errorCode: "dns_failed", outcome: "RETRYABLE_FAILURE" }, 10 * MINUTE, 10 * MINUTE);
    assert.ok(delayed.nextAttemptAt > context.capturedAt && dnsDelayed.nextAttemptAt > context.capturedAt);

    const inFlight = claim(leased, 120_000);
    assert.ok(inFlight.delivery.leaseExpiresAt! > context.capturedAt);
    replay("replayPending", replayPendingOriginal, "业务订单尚未同步付款状态，核对后补发已确认的付款通知。");
    assert.ok(context.getNow() - startedAt <= 4_000, "Finalizing notification scenarios should advance less than four seconds");
  }

  return { orders: scenarioOrders, deliveries: scenarioDeliveries, finalize };
}
