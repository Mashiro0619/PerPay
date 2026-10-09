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

  function paidOrder(key: string, title: string, explanation: string, notify = true): OrderProjection {
    context.beforeScenario?.(key);
    const number = ++sequence;
    const price = ORDER_PRICES_CENTS[number - 1];
    assert.ok(price !== undefined, "Every notification scenario needs an explicit typical product price");
    const order = context.orders.forSite(clientId).create(createOrderRequestSchema.parse({
      idempotency_key: "preview-notification-" + key,
      merchant_order_no: "DEMO-NOTIFY-" + String(number).padStart(2, "0") + "-" + key.toUpperCase(),
      product_name: "通知演示 · " + title,
      amount_cents: price,
      note: explanation + "；仅为本地合成演示，不会进行真实支付或发送通知。",
      ...(notify ? { notify_url: origin + "/api/payments/perpay" } : {}),
    })).order;
    scenarioOrders[key] = order.orderId;
    advance(8_000);
    const now = context.getNow();
    const occurredAt = beijing(now);
    const amount = (order.payableAmountCents / 100).toFixed(2);
    const id = "DEMO-NOTIFY-CREDIT-" + String(number).padStart(3, "0");
    const run = ledger.startIngestRun({ providerAccountKey, start: beijing(now - MINUTE), end: beijing(now + 1_000), pageSize: 1, now });
    const recorded = ledger.recordPage({
      ingestRunId: run.ingestRunId,
      page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
        raw: { account_log_id: id, amount, direction: "CREDIT", occurred_at: occurredAt, synthetic: true },
        accountLogId: id, occurredAt, amount, direction: "CREDIT",
        alipayOrderNo: id, merchantOrderNo: order.merchantOrderNo,
        transMemo: "本地通知场景：" + title, otherAccount: "演示付款人 · 通知 " + number,
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
    } : result.invalidAck ? { success: true, message: "模拟业务方返回了非协议格式" } : { error: "synthetic_receiver_failure" }));
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

  function begin(key: string, title: string, explanation: string): WebhookDelivery {
    return materialize(key, paidOrder(key, title, explanation));
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

  attempt(begin("acknowledged", "首次送达并确认", "首次投递即收到合法 ACK，可查看完整付款依据和通知请求记录"), { kind: "ack" });

  let delivery = begin("retrySucceeded", "重试后成功", "先遇到请求超时，再收到 HTTP 503，第三次投递成功确认");
  delivery = attempt(delivery, { kind: "transport", errorCode: "transport_timeout", outcome: "OUTCOME_UNKNOWN" });
  delivery = attempt(delivery, { kind: "http", status: 503 });
  attempt(delivery, { kind: "ack" });

  delivery = begin("deadLetter", "连续五次失败", "业务接口持续返回 HTTP 503，耗尽五次自动尝试后停止重试");
  for (let count = 0; count < MAXIMUM_ATTEMPTS; count++) delivery = attempt(delivery, { kind: "http", status: 503 });
  assert.equal(delivery.status, "DEAD_LETTER");

  delivery = begin("invalidAck", "业务确认格式错误", "接口返回 HTTP 200，但 ACK 格式不符合协议，连续五次失败后停止重试");
  for (let count = 0; count < MAXIMUM_ATTEMPTS; count++) delivery = attempt(delivery, { kind: "http", status: 200, invalidAck: true });
  assert.equal(delivery.lastErrorCode, "ack_shape_invalid");

  attempt(begin("httpRejected", "通知地址返回 404", "通知路径配置错误，HTTP 404 属于不可重试错误"), { kind: "http", status: 404, permanent: true });
  attempt(begin("tlsFailure", "HTTPS 证书验证失败", "接收网站的 TLS 证书验证失败，需要修复证书后人工重投"), { kind: "transport", errorCode: "tls_verification_failed", outcome: "PERMANENT_FAILURE" });
  attempt(begin("forbiddenTarget", "目标地址不被允许", "模拟通知目标解析到被限制的地址，安全校验拒绝发送"), { kind: "transport", errorCode: "target_address_forbidden", outcome: "PERMANENT_FAILURE" });

  delivery = begin("leaseRecovered", "执行中断后恢复", "投递任务中断，租约到期后记录结果未知，随后重试成功");
  const interrupted = claim(delivery, 2_000);
  context.setNow(interrupted.delivery.leaseExpiresAt! + 1);
  assert.equal(webhooks.recoverExpired(context.getNow()), 1);
  delivery = webhooks.delivery(delivery.deliveryId)!.delivery;
  attempt(delivery, { kind: "ack" });

  delivery = begin("manualReplaySucceeded", "人工重投成功", "原投递返回 HTTP 410；修复业务接收端后，由管理员发起第二代通知并确认成功");
  delivery = attempt(delivery, { kind: "http", status: 410, permanent: true });
  scenarioDeliveries.manualReplayOriginal = delivery.deliveryId;
  advance(1_000);
  delivery = replay("manualReplaySucceeded", delivery, "本地演示：业务接收端已修复，人工补发付款确认通知。");
  attempt(delivery, { kind: "ack" });

  delivery = begin("replayHistory", "多次人工重投历史", "展示三代投递记录、两次失败、密钥轮换和最终确认，历史失败不会覆盖最新结果");
  delivery = attempt(delivery, { kind: "http", status: 410, permanent: true });
  scenarioDeliveries.replayHistoryOriginal = delivery.deliveryId;
  advance(1_000);
  sites.rotateSecret(clientId, "webhook_secret", sites.get(clientId)!.revision, audit, context.getNow());
  delivery = replay("replayHistorySecond", delivery, "本地演示：轮换签名密钥后第一次人工补发。");
  delivery = attempt(delivery, { kind: "http", status: 200, invalidEncoding: true, permanent: true });
  advance(1_000);
  delivery = replay("replayHistory", delivery, "本地演示：接收端已修复 ACK 编码，第二次人工补发并确认。");
  attempt(delivery, { kind: "ack" });

  const replayPendingOriginal = attempt(begin("replayPending", "人工补发等待投递", "原通知已成功，管理员为业务数据补偿发起新一代投递，当前等待执行"), { kind: "ack" });
  scenarioDeliveries.replayPendingOriginal = replayPendingOriginal.deliveryId;
  paidOrder("disabled", "订单未配置通知", "此订单未填写通知 URL，已有收款依据，但不会产生通知投递", false);

  // Build every order before the caller creates its latest complete example.
  // Preserve this queue order for finalize; no later materialization is allowed
  // for this site, so the final unmaterialized example keeps its empty history.
  const retrying = begin("retrying", "超时后等待重试", "业务请求超时，暂未确认接收结果，保留自动重试计划");
  const dnsRetry = begin("dnsRetry", "域名解析失败待重试", "通知域名解析失败，未建立 HTTP 连接，等待下一次自动尝试");
  const leased = begin("leased", "通知投递进行中", "已开始一次投递，仍在等待业务端返回 ACK");
  begin("pending", "等待首次投递", "已生成业务通知，尚未进行第一次尝试");
  paidOrder("unmaterialized", "已配置但尚无投递记录", "付款已确认且配置了通知，通知尚未出队生成投递记录");
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
    replay("replayPending", replayPendingOriginal, "本地演示：核对业务数据后补发已确认通知，新一代投递等待执行。");
    assert.ok(context.getNow() - startedAt <= 4_000, "Finalizing notification scenarios should advance less than four seconds");
  }

  return { orders: scenarioOrders, deliveries: scenarioDeliveries, finalize };
}
