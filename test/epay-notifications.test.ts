// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertDatabaseIntegrity } from "../src/database/database.ts";
import type { EpayCredentials } from "../src/epay/model.ts";
import { EpayStore } from "../src/epay/store.ts";
import { parseEpayParameters, verifyEpayV1, verifyEpayV2, type EpayProtocol } from "../src/epay/protocol.ts";
import { adminOrderNotificationSummaries } from "../src/http/admin-order-notification-summary.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { webhookDeliveryRequestFingerprint } from "../src/notifications/model.ts";
import { SiteWebhookProcessor } from "../src/notifications/site-processor.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import type { WebhookTransport, WebhookTransportResponse } from "../src/notifications/transport.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createSitePaymentFixture>>;
type CompatibleOrder = ReturnType<typeof createOrder>;
const audit = { actorId: "admin" };
const origin = "https://merchant.example.com";
const target = `${origin}/notify?channel=shop%2Bweb`;
const emptyBodyFingerprint = createHash("sha256").update("").digest("hex");

function configure(f: Fixture, protocol: EpayProtocol, name: string = protocol) {
  const site = f.createSite(name);
  const epay = f.settings.epayStore()!;
  const initial = epay.get(site.clientId);
  assert.equal(initial.v1Enabled, true);
  assert.equal(initial.v2Enabled, true);
  assert.equal(initial.v1KeyVersion, 1);
  assert.equal(initial.merchantKeyVersion, 1);
  assert.equal(initial.platformKeyVersion, 1);
  epay.update(site.clientId, { revision: initial.revision, v1_enabled: protocol === "epay_v1", v2_enabled: protocol === "epay_v2" }, audit);
  f.sites.update(site.clientId, { revision: site.revision, configuration: {
    ...site.configuration, notifications_enabled: true, notification_origin: origin,
  } }, audit);
  f.setNow(Date.now());
  return epay.credentialsForSite(site.clientId)!;
}

function createOrder(f: Fixture, credentials: EpayCredentials, protocol: EpayProtocol) {
  const request = {
    merchant_order_no: `MERCHANT_${randomUUID()}`, idempotency_key: randomUUID(),
    amount_cents: 10000, product_name: "商品 A+B 中文", notify_url: target,
  };
  return f.orders.forSite(credentials.siteId).create(request, undefined, {
    siteId: credentials.siteId, protocol, configurationRevision: credentials.revision,
    requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    param: "0", returnUrl: null,
  }).order;
}

function timestamp(value: number): string {
  return new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
}

function confirmOrder(f: Fixture, order: CompatibleOrder) {
  const ledger = new LedgerStore(f.database);
  const now = order.createdAt + 2000;
  const run = ledger.startIngestRun({
    providerAccountKey: f.snapshot.activeProviderAccountKey!,
    start: timestamp(order.createdAt - 60000), end: timestamp(order.createdAt + 60000), pageSize: 1, now,
  });
  const id = randomUUID();
  const amount = (order.payableAmountCents / 100).toFixed(2);
  const occurredAt = timestamp(order.createdAt + 1000);
  const recorded = ledger.recordPage({
    ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
      raw: { account_log_id: id, amount, direction: "CREDIT", occurred_at: occurredAt },
      accountLogId: id, occurredAt, amount, direction: "CREDIT", alipayOrderNo: id,
      merchantOrderNo: null, transMemo: null, otherAccount: null,
    }] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify({ id, amount }), traceId: id, signatureVerified: true }, now,
  });
  const entry = recorded.normalized[0];
  assert.ok(entry && entry.kind === "created");
  const result = new ReconciliationStore(f.database).settleManually({
    financialOperationId: randomUUID(), orderId: order.orderId,
    ledgerEntryId: entry.entry.ledgerEntryId, actorId: "admin", now: now + 1,
  });
  f.setNow(now + 2);
  return result;
}

function response(status = 200, text = "success"): WebhookTransportResponse {
  const body = Buffer.from(text);
  return {
    status, contentType: "text/plain; charset=utf-8", contentEncoding: null, body,
    responseFingerprint: createHash("sha256").update(body).digest("hex"),
    resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8",
  };
}

function processor(f: Fixture, webhooks: WebhookStore, get: NonNullable<WebhookTransport["get"]>) {
  return new SiteWebhookProcessor({
    sites: f.sites, webhooks, epay: f.settings.epayStore()!, clock: f.now,
    transport: () => ({ get, async post() { throw new Error("EasyPay delivery must use GET"); } }),
  });
}

function verifies(url: string, protocol: EpayProtocol, credentials: EpayCredentials): boolean {
  const parameters = parseEpayParameters(new URL(url).search);
  return protocol === "epay_v1"
    ? verifyEpayV1(parameters, credentials.v1Key!)
    : verifyEpayV2(parameters, credentials.platformPublicKey!);
}

function requestFingerprint(url: string, keyId: string): string {
  return createHash("sha256").update(JSON.stringify([
    "perpay:epay-notification:v1", "GET", url, emptyBodyFingerprint, keyId,
  ])).digest("hex");
}

for (const protocol of ["epay_v1", "epay_v2"] as const) {
  test(`${protocol} alone admits compatible orders and delivers the confirmed original amount with a complete signed query`, async () => {
    const f = await createSitePaymentFixture();
    try {
      const credentials = configure(f, protocol);
      assert.equal(f.sites.notificationSecret(credentials.siteId), null);
      assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS count FROM webhook_signing_keys WHERE client_id = ?")
        .get(credentials.siteId)!.count), 0n);
      assert.throws(() => f.orders.forSite(credentials.siteId).create({
        merchant_order_no: randomUUID(), idempotency_key: randomUUID(), amount_cents: 10000,
        product_name: "原生通知需要独立密钥", notify_url: target,
      }), { code: "system_not_configured" });
      f.orders.forSite(credentials.siteId).create({
        merchant_order_no: randomUUID(), idempotency_key: randomUUID(), amount_cents: 10000, product_name: "占用原价金额",
      });
      const order = createOrder(f, credentials, protocol);
      assert.notEqual(order.payableAmountCents, order.requestedAmountCents);
      const webhooks = new WebhookStore(f.database);
      const sent: string[] = [];
      const service = processor(f, webhooks, async input => {
        input.beforeSend?.();
        sent.push(input.targetUrl);
        return response(202, " \nsuccess\r\n");
      });
      assert.equal((await service.processOne()).processed, false);
      assert.equal(sent.length, 0);
      const settlement = confirmOrder(f, order);
      const result = await service.processOne();
      assert.equal(result.outcome, "ACKNOWLEDGED");
      assert.ok(result.deliveryId);
      assert.equal(sent.length, 1);
      const url = sent[0]!;
      const parameters = parseEpayParameters(new URL(url).search);
      const metadata = f.settings.epayStore()!.order(order.orderId)!;
      assert.equal(parameters.pid, credentials.pid);
      assert.equal(parameters.trade_no, metadata.tradeNo);
      assert.equal(parameters.out_trade_no, order.merchantOrderNo);
      assert.equal(parameters.money, "100.00");
      assert.equal(parameters.trade_status, "TRADE_SUCCESS");
      assert.equal(parameters.name, order.productName);
      assert.equal(parameters.param, "0");
      assert.equal(parameters.channel, "shop+web");
      assert.equal(verifies(url, protocol, credentials), true);
      const tampered = new URL(url);
      tampered.searchParams.set("channel", "another-channel");
      assert.equal(verifies(tampered.href, protocol, credentials), false);
      const detail = webhooks.delivery(result.deliveryId)!;
      assert.equal(detail.target.format, protocol.toUpperCase());
      assert.equal(detail.event.eventType, "PAYMENT_CONFIRMED");
      const attempt = detail.attempts[0]!;
      const keyId = protocol === "epay_v1" ? credentials.v1KeyId! : credentials.platformKeyId!;
      assert.equal(attempt.protocol, protocol);
      assert.equal(attempt.requestMethod, "GET");
      assert.equal(attempt.requestUrl, url);
      assert.equal(attempt.keyId, keyId);
      assert.equal(attempt.requestBodyFingerprint, emptyBodyFingerprint);
      assert.equal(attempt.requestFingerprint, requestFingerprint(url, keyId));
      assert.equal(attempt.httpStatus, 202);
      assert.equal(attempt.responseFingerprint, response(202, " \nsuccess\r\n").responseFingerprint);
      assert.equal((await service.processOne()).processed, false);
      assert.equal(webhooks.materialize(64, f.now(), credentials.siteId), 0);
      assert.equal(sent.length, 1);
      new ReconciliationStore(f.database).reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: settlement.paymentMatch.paymentMatchId,
        actorId: "admin", reason: "已通知付款后撤销确认", now: f.now(),
      });
      assert.deepEqual(adminOrderNotificationSummaries(f.database, [order.orderId]).get(order.orderId), {
        status: "ACKNOWLEDGED", total_events: 1, acknowledged_events: 1,
      });
      assert.equal(f.sites.nextNotificationSite(null, f.now()), null);
      assert.equal((await service.processOne()).processed, false);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });

  test(`${protocol} retries with the current key after disabling new orders and preserves old evidence in backup`, async () => {
    const f = await createSitePaymentFixture();
    try {
      const original = configure(f, protocol);
      const order = createOrder(f, original, protocol);
      confirmOrder(f, order);
      const webhooks = new WebhookStore(f.database);
      const sent: string[] = [];
      const service = processor(f, webhooks, async input => {
        input.beforeSend?.();
        sent.push(input.targetUrl);
        return sent.length === 1 ? response(200, "ok") : response();
      });
      const first = await service.processOne();
      assert.equal(first.outcome, "RETRYABLE_FAILURE");
      assert.equal(first.errorCode, "ack_text_invalid");
      assert.ok(first.deliveryId);
      const initialAttempt = webhooks.delivery(first.deliveryId)!.attempts[0]!;
      const retryAt = webhooks.delivery(first.deliveryId)!.delivery.nextAttemptAt;
      f.setNow(retryAt - 1);
      assert.equal((await service.processOne()).processed, false);
      const epay = f.settings.epayStore()!;
      const rotated = epay.rotate(original.siteId, protocol === "epay_v1" ? "v1_key" : "v2_platform", original.revision, audit, f.now());
      epay.update(original.siteId, { revision: rotated.configuration.revision, v1_enabled: false, v2_enabled: false }, audit, f.now());
      assert.equal(epay.credential(original.pid, { protocol, forCreation: true }), null);
      const site = f.sites.get(original.siteId)!;
      const paused = f.sites.update(original.siteId, { revision: site.revision,
        configuration: { ...site.configuration, notifications_enabled: false } }, audit, f.now());
      f.sites.update(original.siteId, { revision: paused.revision, configuration: site.configuration }, audit, f.now());
      const current = epay.credentialsForSite(original.siteId)!;
      f.setNow(retryAt);
      const second = await service.processOne();
      assert.equal(second.deliveryId, first.deliveryId);
      assert.equal(second.outcome, "ACKNOWLEDGED");
      assert.equal(sent.length, 2);
      assert.equal(verifies(sent[0]!, protocol, original), true);
      assert.equal(verifies(sent[1]!, protocol, original), false);
      assert.equal(verifies(sent[1]!, protocol, current), true);
      const detail = webhooks.delivery(first.deliveryId)!;
      const finalAttempt = detail.attempts.find(attempt => attempt.attemptNumber === 2)!;
      assert.deepEqual(detail.attempts.find(attempt => attempt.attemptNumber === 1), initialAttempt);
      assert.equal(finalAttempt.keyVersion, initialAttempt.keyVersion + 1);
      assert.notEqual(finalAttempt.keyId, initialAttempt.keyId);
      assert.notEqual(finalAttempt.requestFingerprint, initialAttempt.requestFingerprint);
      if (protocol === "epay_v2") {
        const originalTimestamp = Number(new URL(sent[0]!).searchParams.get("timestamp"));
        const currentTimestamp = Number(new URL(sent[1]!).searchParams.get("timestamp"));
        assert.equal(currentTimestamp, Math.floor(f.now() / 1000));
        assert.ok(currentTimestamp > originalTimestamp);
      }
      assert.equal((await service.processOne()).processed, false);
      assert.equal(f.database.integrityCheck().ok, true);
      const path = join(f.config.backupDir, `${protocol}-attempts.sqlite3`);
      await f.database.backup(path);
      const backup = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true, readBigInts: true });
      try {
        assertDatabaseIntegrity(backup, "notification backup");
        const attempts = backup.prepare("SELECT request_url, epay_key_id FROM webhook_attempts WHERE delivery_id = ? ORDER BY attempt_number").all(first.deliveryId);
        assert.deepEqual(attempts.map(attempt => attempt.request_url), sent);
        assert.deepEqual(attempts.map(attempt => attempt.epay_key_id), [initialAttempt.keyId, finalAttempt.keyId]);
      } finally { backup.close(); }
    } finally { f.close(); }
  });
}

test("notification admission rejects a historical website with no signing key or only a V2 merchant request key", async context => {
  const f = await createSitePaymentFixture();
  try {
    // Reproduce a website saved before automatic credential initialization existed.
    const initialization = context.mock.method(EpayStore.prototype, "initializeSite", () => false);
    const site = f.createSite("商户请求密钥不能签通知");
    initialization.mock.restore();
    assert.equal(f.settings.epayStore()!.get(site.clientId).revision, 0);
    const configuration = { ...site.configuration, notifications_enabled: true, notification_origin: origin };
    assert.throws(() => f.sites.update(site.clientId, { revision: site.revision, configuration }, audit), { code: "site_secret_missing" });
    f.settings.epayStore()!.rotate(site.clientId, "v2_merchant", 0, audit);
    assert.throws(() => f.sites.update(site.clientId, { revision: site.revision, configuration }, audit), { code: "site_secret_missing" });
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("revoked confirmation permanently stops its retry and administrator replay", async () => {
  const f = await createSitePaymentFixture();
  try {
    const credentials = configure(f, "epay_v2");
    const order = createOrder(f, credentials, "epay_v2");
    const settlement = confirmOrder(f, order);
    const webhooks = new WebhookStore(f.database);
    let requests = 0;
    const service = processor(f, webhooks, async input => {
      input.beforeSend?.();
      requests++;
      return response(503, "unavailable");
    });
    const first = await service.processOne();
    assert.equal(first.status, "RETRY_WAIT");
    assert.ok(first.deliveryId);
    new ReconciliationStore(f.database).reverseSettlement({
      financialOperationId: randomUUID(), paymentMatchId: settlement.paymentMatch.paymentMatchId,
      actorId: "admin", reason: "撤销错误确认", now: f.now(),
    });
    f.setNow(webhooks.delivery(first.deliveryId)!.delivery.nextAttemptAt);
    const stopped = await service.processOne();
    assert.equal(stopped.status, "DEAD_LETTER");
    assert.equal(stopped.outcome, "PERMANENT_FAILURE");
    assert.equal(stopped.errorCode, "payment_confirmation_revoked");
    assert.equal(requests, 1);
    assert.deepEqual(adminOrderNotificationSummaries(f.database, [order.orderId]).get(order.orderId), {
      status: "DEAD_LETTER", total_events: 1, acknowledged_events: 0,
    });
    assert.equal(f.sites.nextNotificationSite(null, f.now()), null);
    const replay = webhooks.replay({
      expectedClientId: credentials.siteId, redeliveryId: randomUUID(), deliveryId: first.deliveryId,
      actorId: "admin", reason: "重试历史通知", activeAllowedOrigin: origin, now: f.now(),
    });
    const replayed = await service.processOne();
    assert.equal(replayed.deliveryId, replay.delivery.deliveryId);
    assert.equal(replayed.errorCode, "payment_confirmation_revoked");
    assert.equal(requests, 1);
    assert.equal(f.sites.nextNotificationSite(null, f.now()), null);
    assert.equal((await service.processOne()).processed, false);
    assert.equal(webhooks.listDeliveries({ limit: 10, cursor: null }).deliveries.length, 2);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("confirmation is checked again immediately before the transport sends", async () => {
  const f = await createSitePaymentFixture();
  try {
    const credentials = configure(f, "epay_v1");
    const settlement = confirmOrder(f, createOrder(f, credentials, "epay_v1"));
    const webhooks = new WebhookStore(f.database);
    let sent = false;
    const service = processor(f, webhooks, async input => {
      new ReconciliationStore(f.database).reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: settlement.paymentMatch.paymentMatchId,
        actorId: "admin", reason: "解析地址期间撤销确认", now: f.now(),
      });
      assert.ok(input.beforeSend);
      input.beforeSend();
      sent = true;
      return response();
    });
    const stopped = await service.processOne();
    assert.equal(stopped.outcome, "PERMANENT_FAILURE");
    assert.equal(stopped.errorCode, "payment_confirmation_revoked");
    assert.equal(sent, false);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("cross-site credentials and modified GET evidence are rejected by claims, immutable storage and backup inspection", async () => {
  const f = await createSitePaymentFixture();
  try {
    const first = configure(f, "epay_v1", "网站一");
    const other = configure(f, "epay_v1", "网站二");
    confirmOrder(f, createOrder(f, first, "epay_v1"));
    const webhooks = new WebhookStore(f.database);
    webhooks.materialize(64, f.now(), first.siteId);
    assert.throws(() => webhooks.claimNext({
      clientId: first.siteId, siteRevision: f.sites.get(first.siteId)!.revision,
      epayCredentials: other, now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 3,
    }), /ownership/);
    assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS count FROM webhook_attempts").get()!.count), 0n);
    const result = await processor(f, webhooks, async () => response()).processOne();
    assert.equal(result.outcome, "ACKNOWLEDGED");
    const attempt = webhooks.delivery(result.deliveryId!)!.attempts[0]!;
    assert.throws(() => f.database.write(db => db.prepare("UPDATE webhook_attempts SET request_url = ? WHERE attempt_id = ?")
      .run(`${attempt.requestUrl}&tampered=1`, attempt.attemptId)), /transition is invalid/);
    const updateEvidence = (keyId: string, url: string, fingerprint: string) => f.database.write(db => {
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'webhook_attempts_valid_update'").get()!.sql as string;
      db.exec("DROP TRIGGER webhook_attempts_valid_update");
      db.prepare("UPDATE webhook_attempts SET epay_key_id = ?, request_url = ?, request_fingerprint = ? WHERE attempt_id = ?")
        .run(keyId, url, fingerprint, attempt.attemptId);
      db.exec(trigger);
    });
    updateEvidence(other.v1KeyId!, attempt.requestUrl!, requestFingerprint(attempt.requestUrl!, other.v1KeyId!));
    assert.equal(f.database.integrityCheck().ok, false);
    assert.throws(() => f.database.read(db => assertDatabaseIntegrity(db, "cross-site evidence")), /cross-site evidence/);
    await assert.rejects(f.database.backup(join(f.config.backupDir, "invalid-epay-attempt.sqlite3")));
    updateEvidence(attempt.keyId, `${attempt.requestUrl}&tampered=1`, attempt.requestFingerprint!);
    assert.equal(f.database.integrityCheck().ok, false);
    updateEvidence(attempt.keyId, attempt.requestUrl!, attempt.requestFingerprint!);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("disputed events cannot become EasyPay deliveries and tampered backups fail integrity inspection", async () => {
  const f = await createSitePaymentFixture();
  try {
    const credentials = configure(f, "epay_v2");
    const order = createOrder(f, credentials, "epay_v2");
    const settlement = confirmOrder(f, order);
    new ReconciliationStore(f.database).reverseSettlement({
      financialOperationId: randomUUID(), paymentMatchId: settlement.paymentMatch.paymentMatchId,
      actorId: "admin", reason: "撤销后拒绝生成易支付争议通知", now: f.now(),
    });
    const ids = f.database.read(db => db.prepare(`
      SELECT event.outbox_event_id AS event_id, target.target_id FROM outbox_events AS event
      JOIN webhook_targets AS target ON target.order_id = event.aggregate_id
      WHERE event.aggregate_id = ? AND event.event_type = 'PAYMENT_DISPUTED'
    `).get(order.orderId)) as { event_id: string; target_id: string };
    const fingerprint = webhookDeliveryRequestFingerprint({
      eventId: ids.event_id, targetId: ids.target_id, generation: 1, predecessorDeliveryId: null,
      requestedByType: "SYSTEM", requestedByActorId: null, reason: null,
    });
    const insertDelivery = (db: DatabaseSync) => db.prepare(`
      INSERT INTO webhook_deliveries (
        delivery_id, outbox_event_id, target_id, generation, request_key, request_fingerprint,
        request_fingerprint_version, requested_by_type, status, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 'SYSTEM', 'PENDING', ?, ?, ?)
    `).run(randomUUID(), ids.event_id, ids.target_id, ids.event_id, fingerprint, f.now(), f.now(), f.now());
    assert.throws(() => f.database.write(insertDelivery), /require a payment confirmation event/);
    assert.equal(f.database.integrityCheck().ok, true);
    f.database.write(db => {
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'webhook_deliveries_epay_event_guard'").get()!.sql as string;
      db.exec("DROP TRIGGER webhook_deliveries_epay_event_guard");
      insertDelivery(db);
      db.exec(trigger);
    });
    assert.equal(f.database.integrityCheck().ok, false);
    assert.throws(() => f.database.read(db => assertDatabaseIntegrity(db, "invalid EasyPay event")), /invalid EasyPay event/);
    await assert.rejects(f.database.backup(join(f.config.backupDir, "invalid-epay-event.sqlite3")));
  } finally { f.close(); }
});
