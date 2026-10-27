import { systemAnalytics } from "../src/http/system-analytics.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { SiteWebhookProcessor } from "../src/notifications/site-processor.ts";
import { WebhookTransportError } from "../src/notifications/transport.ts";
import { webhookSignature } from "../src/notifications/model.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { countSiteDomainViolations } from "../src/sites/integrity.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createSitePaymentFixture>>;
const audit = { actorId: "admin" };
function configure(f: Fixture, name: string) {
  const site = f.createSite(name);
  const issued = f.sites.rotateSecret(site.clientId, "webhook_secret", 0, audit, f.now());
  const updated = f.sites.update(site.clientId, { revision: 1, configuration: { ...site.configuration, notifications_enabled: true, notification_origin: "https://" + name.toLowerCase() + ".example.com" } }, audit, f.now());
  return { ...updated, secret: issued.secret };
}
function timestamp(value: number) {
  return new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
}
function createEvent(f: Fixture, clientId: string, target: string) {
  const order = f.orders.forSite(clientId).create(createOrderRequestSchema.parse({ merchant_order_no: randomUUID(), idempotency_key: randomUUID(), amount_cents: 10000, product_name: "notification", notify_url: target })).order;
  const ledger = new LedgerStore(f.database);
  const occurredAt = order.createdAt + 1000;
  const now = order.createdAt + 2000;
  const run = ledger.startIngestRun({ providerAccountKey: f.snapshot.activeProviderAccountKey!, start: timestamp(order.createdAt - 60000), end: timestamp(order.createdAt + 60000), pageSize: 1, now });
  const id = randomUUID(), amount = (order.payableAmountCents / 100).toFixed(2), occurred = timestamp(occurredAt);
  const recorded = ledger.recordPage({
    ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{ raw: { account_log_id: id, amount, direction: "CREDIT", occurred_at: occurred }, accountLogId: id, occurredAt: occurred, amount, direction: "CREDIT", alipayOrderNo: id, merchantOrderNo: null, transMemo: null, otherAccount: null }] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify({ id, amount }), traceId: id, signatureVerified: true }, now,
  });
  const entry = recorded.normalized[0];
  assert.equal(entry?.kind, "created");
  if (!entry || entry.kind !== "created") throw new Error("missing test ledger entry");
  new ReconciliationStore(f.database).settleManually({ financialOperationId: randomUUID(), orderId: order.orderId, ledgerEntryId: entry.entry.ledgerEntryId, actorId: "admin", now: now + 1 });
  f.setNow(now + 2);
  return order;
}
function networkFailure(): never {
  throw new WebhookTransportError({ code: "transport_network", message: "controlled test failure", retryable: true });
}

describe("website notification processing", () => {
  it("retries an initial HTTP 401 only after backoff and acknowledges the same delivery on its second attempt", async () => {
    const f = await createSitePaymentFixture();
    try {
      const site = configure(f, "Retry");
      createEvent(f, site.clientId, "https://retry.example.com/notify");
      const webhooks = new WebhookStore(f.database);
      const sent: { deliveryId: string; eventId: string; attempt: number }[] = [];
      const processor = new SiteWebhookProcessor({
        sites: f.sites, webhooks, clock: f.now,
        transport: () => ({
          async post(input) {
            const deliveryId = input.headers["x-perpay-webhook-delivery-id"]!;
            const eventId = input.headers["x-perpay-webhook-event-id"]!;
            sent.push({ deliveryId, eventId, attempt: Number(input.headers["x-perpay-webhook-attempt"]) });
            const body = Buffer.from(sent.length === 1 ? "receiver credentials unavailable" : JSON.stringify({
              schema: "perpay:webhook-ack:v1", ack: true, event_id: eventId, delivery_id: deliveryId,
            }));
            return {
              status: sent.length === 1 ? 401 : 200,
              contentType: "application/json", contentEncoding: null, body,
              responseFingerprint: createHash("sha256").update(body).digest("hex"),
              resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8",
            };
          },
        }),
      });

      const first = await processor.processOne();
      assert.equal(first.status, "RETRY_WAIT");
      assert.equal(first.outcome, "RETRYABLE_FAILURE");
      assert.ok(first.deliveryId);
      assert.equal(sent.length, 1);
      const pending = webhooks.delivery(first.deliveryId)!;
      assert.equal(pending.delivery.attemptCount, 1);
      assert.equal(pending.attempts[0]?.httpStatus, 401);
      assert.ok(pending.delivery.nextAttemptAt > f.now());

      f.setNow(pending.delivery.nextAttemptAt - 1);
      assert.equal((await processor.processOne()).processed, false);
      assert.equal(sent.length, 1);
      assert.equal(webhooks.delivery(first.deliveryId)!.attempts.length, 1);

      f.setNow(pending.delivery.nextAttemptAt);
      const retried = await processor.processOne();
      assert.equal(retried.status, "ACKNOWLEDGED");
      assert.equal(retried.outcome, "ACKNOWLEDGED");
      assert.equal(retried.deliveryId, first.deliveryId);
      assert.deepEqual(sent, [
        { deliveryId: first.deliveryId, eventId: pending.event.eventId, attempt: 1 },
        { deliveryId: first.deliveryId, eventId: pending.event.eventId, attempt: 2 },
      ]);
      const completed = webhooks.delivery(first.deliveryId)!;
      assert.equal(completed.delivery.attemptCount, 2);
      assert.equal(completed.delivery.acknowledgedAt, f.now());
      assert.deepEqual(completed.attempts.map(attempt => [attempt.attemptNumber, attempt.httpStatus, attempt.outcome]), [
        [1, 401, "RETRYABLE_FAILURE"], [2, 200, "ACKNOWLEDGED"],
      ]);
      assert.equal(f.database.read(countSiteDomainViolations), 0);
    } finally { f.close(); }
  });

  it("rejects a cross-site signing reference at insertion and detects it if update protections were bypassed", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"), b = configure(f, "B");
      createEvent(f, a.clientId, "https://a.example.com/notify");
      const webhooks = new WebhookStore(f.database); webhooks.materialize(10, f.now(), a.clientId);
      const claim = webhooks.claimNext({ clientId: a.clientId, siteRevision: a.revision, now: f.now(), maximumAttempts: 3, leaseMilliseconds: 30000 });
      assert.ok(claim);
      const otherKey = f.database.read(db => Number(db.prepare("SELECT key_version FROM webhook_signing_keys WHERE client_id = ? AND retired_at IS NULL").get(b.clientId)?.key_version));
      assert.throws(() => f.database.write(db => db.prepare(`INSERT INTO webhook_attempts
        (attempt_id, delivery_id, attempt_number, lease_token, key_version, request_timestamp, request_body_fingerprint, outcome, started_at)
        SELECT ?, delivery_id, attempt_number, lease_token, ?, request_timestamp, request_body_fingerprint, outcome, started_at
        FROM webhook_attempts WHERE attempt_id = ?`).run(randomUUID(), otherKey, claim.attempt.attemptId)), /notification signing key belongs to another website/);
      const rewrite = (version: number | bigint) => f.database.write(db => {
        const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'webhook_attempts_valid_update'").get()!.sql);
        db.exec("DROP TRIGGER webhook_attempts_valid_update");
        db.prepare("UPDATE webhook_attempts SET key_version = ? WHERE attempt_id = ?").run(version, claim.attempt.attemptId);
        db.exec(trigger);
      });
      rewrite(otherKey);
      const integrity = f.database.integrityCheck(); assert.equal(integrity.schema, "ok"); assert.equal(integrity.ok, false); assert.ok(integrity.domainViolations > 0);
      rewrite(claim.key.keyVersion); assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("fairly selects sites and signs every attempt with its own website key", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"), b = configure(f, "B");
      createEvent(f, a.clientId, "https://a.example.com/notify");
      createEvent(f, a.clientId, "https://a.example.com/notify");
      createEvent(f, b.clientId, "https://b.example.com/notify");
      const secrets = new Map([[a.clientId, a.secret], [b.clientId, b.secret]]);
      const requests: string[] = [];
      const webhooks = new WebhookStore(f.database);
      const processor = new SiteWebhookProcessor({ sites: f.sites, webhooks, clock: f.now, transport: (clientId, origin) => ({
        async post(input) {
          requests.push(clientId);
          assert.equal(new URL(input.targetUrl).origin, origin);
          assert.equal(input.headers["x-perpay-webhook-signature"], webhookSignature({ secret: secrets.get(clientId)!, keyId: input.headers["x-perpay-webhook-key-id"]!, timestamp: Number(input.headers["x-perpay-webhook-timestamp"]), deliveryId: input.headers["x-perpay-webhook-delivery-id"]!, eventId: input.headers["x-perpay-webhook-event-id"]!, attemptNumber: Number(input.headers["x-perpay-webhook-attempt"]), body: input.body }));
          return networkFailure();
        },
      }) });
      for (let i = 0; i < 3; i++) assert.equal((await processor.processOne()).processed, true);
      assert.equal(new Set(requests.slice(0, 2)).size, 2);
      assert.equal(requests.filter(id => id === a.clientId).length, 2);
      assert.equal(requests.filter(id => id === b.clientId).length, 1);
      const aStats = systemAnalytics(f.database, 7, f.now(), a.clientId);
      const bStats = systemAnalytics(f.database, 7, f.now(), b.clientId);
      assert.equal(aStats.confirmations.count, 2);
      assert.equal(bStats.confirmations.count, 1);
      assert.equal(aStats.notifications.pending, 2);
      assert.equal(bStats.notifications.pending, 1);
      const aDeliveries = webhooks.listDeliveries({ apiClientId: a.clientId, limit: 10 });
      const bDeliveries = webhooks.listDeliveries({ apiClientId: b.clientId, limit: 10 });
      assert.equal(aDeliveries.deliveries.length, 2);
      assert.equal(bDeliveries.deliveries.length, 1);
      const aIds = new Set(aDeliveries.deliveries.map(item => item.delivery.deliveryId));
      assert.ok(bDeliveries.deliveries.every(item => !aIds.has(item.delivery.deliveryId)));
      assert.equal(aStats.daily.reduce((sum, day) => sum + day.confirmations, 0), 2);
      assert.equal(bStats.daily.reduce((sum, day) => sum + day.confirmations, 0), 1);
      assert.equal((await processor.processOne()).processed, false);
      assert.equal(f.database.read(countSiteDomainViolations), 0);
      assert.throws(() => webhooks.claimNext({ now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 3 }), /website scope/);
    } finally { f.close(); }
  });
  it("keeps events while disabled and resumes only that site's delivery", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"); createEvent(f, a.clientId, "https://a.example.com/notify");
      f.sites.update(a.clientId, { revision: a.revision, configuration: { ...a.configuration, notifications_enabled: false } }, audit, f.now());
      let calls = 0;
      const processor = new SiteWebhookProcessor({ sites: f.sites, webhooks: new WebhookStore(f.database), clock: f.now, transport: () => ({ async post() { calls++; return networkFailure(); } }) });
      assert.equal((await processor.processOne()).processed, false); assert.equal(calls, 0);
      const current = f.sites.get(a.clientId)!;
      f.sites.update(a.clientId, { revision: current.revision, configuration: { ...current.configuration, notifications_enabled: true } }, audit, f.now());
      assert.equal((await processor.processOne()).processed, true); assert.equal(calls, 1);
    } finally { f.close(); }
  });
  it("does not claim with a stale website configuration or mismatched signing fingerprint", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"); createEvent(f, a.clientId, "https://a.example.com/notify");
      const webhooks = new WebhookStore(f.database); webhooks.materialize(10, f.now(), a.clientId);
      assert.equal(webhooks.claimNext({ clientId: a.clientId, siteRevision: a.revision - 1, now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 12 }), null);
      assert.equal(webhooks.claimNext({ clientId: a.clientId, siteRevision: a.revision, secretFingerprint: "0".repeat(64), now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 12 }), null);
      assert.equal(f.database.read(c => c.prepare("SELECT count(*) AS total FROM webhook_attempts").get()?.total), 0n);
    } finally { f.close(); }
  });
  it("keeps an in-flight signing snapshot and uses the rotated key on retry", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"); createEvent(f, a.clientId, "https://a.example.com/notify");
      const sent: string[] = []; let rotated = false;
      const webhooks = new WebhookStore(f.database);
      const processor = new SiteWebhookProcessor({ sites: f.sites, webhooks, clock: f.now, transport: () => ({
        async post(input) {
          sent.push(input.headers["x-perpay-webhook-key-id"]!);
          if (!rotated) {
            f.sites.rotateSecret(a.clientId, "webhook_secret", a.revision, audit, f.now());
            rotated = true;
          }
          return networkFailure();
        },
      }) });
      await processor.processOne();
      f.setNow(f.now() + 10000);
      await processor.processOne();
      assert.equal(sent.length, 2); assert.notEqual(sent[0], sent[1]);
      const attempts = f.database.read(c => c.prepare("SELECT key_version FROM webhook_attempts ORDER BY attempt_number").all());
      assert.deepEqual(attempts.map(row => row.key_version), [1n, 2n]);
      assert.equal(f.database.read(countSiteDomainViolations), 0);
    } finally { f.close(); }
  });
  it("does not apply one site's reduced attempt budget to another site's retry", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"), b = configure(f, "B");
      createEvent(f, a.clientId, "https://a.example.com/notify");
      createEvent(f, b.clientId, "https://b.example.com/notify");
      const webhooks = new WebhookStore(f.database);
      webhooks.materialize(10, f.now(), a.clientId); webhooks.materialize(10, f.now(), b.clientId);
      const claimed = webhooks.claimNext({ clientId: b.clientId, siteRevision: b.revision, now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 10 });
      assert.ok(claimed);
      webhooks.completeAttempt({ deliveryId: claimed.delivery.deliveryId, attemptId: claimed.attempt.attemptId, leaseToken: claimed.attempt.leaseToken, outcome: "RETRYABLE_FAILURE", now: f.now(), maximumAttempts: 10, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 1000, errorCode: "transport_network" });
      const next = webhooks.claimNext({ clientId: a.clientId, siteRevision: a.revision, now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 1 });
      assert.ok(next);
      assert.equal(f.database.read(c => c.prepare("SELECT status FROM webhook_deliveries WHERE delivery_id = ?").get(claimed.delivery.deliveryId)?.status), "RETRY_WAIT");
    } finally { f.close(); }
  });

  it("replays under the target website's current policy, not a supplied global origin", async () => {
    const f = await createSitePaymentFixture();
    try {
      const a = configure(f, "A"), b = configure(f, "B");
      createEvent(f, a.clientId, "https://a.example.com/notify");
      const webhooks = new WebhookStore(f.database);
      webhooks.materialize(10, f.now(), a.clientId);
      const claimed = webhooks.claimNext({ clientId: a.clientId, siteRevision: a.revision, now: f.now(), leaseMilliseconds: 30000, maximumAttempts: 1 });
      assert.ok(claimed);
      webhooks.completeAttempt({ deliveryId: claimed.delivery.deliveryId, attemptId: claimed.attempt.attemptId, leaseToken: claimed.attempt.leaseToken, outcome: "PERMANENT_FAILURE", now: f.now(), maximumAttempts: 1, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 1000, errorCode: "transport_network" });
      const request = { redeliveryId: randomUUID(), deliveryId: claimed.delivery.deliveryId, actorId: "admin", reason: "重新发送", activeAllowedOrigin: b.configuration.notification_origin, now: f.now() };
      const disabled = f.sites.update(a.clientId, { revision: a.revision, configuration: { ...a.configuration, notifications_enabled: false } }, audit, f.now());
      assert.throws(() => webhooks.replay(request), { code: "webhook_disabled" });
      const moved = f.sites.update(a.clientId, { revision: disabled.revision, configuration: { ...disabled.configuration, notifications_enabled: true, notification_origin: "https://new.example.com" } }, audit, f.now());
      assert.throws(() => webhooks.replay({ ...request, activeAllowedOrigin: "https://a.example.com" }), { code: "webhook_target_inactive" });
      const restored = f.sites.update(a.clientId, { revision: moved.revision, configuration: a.configuration }, audit, f.now());
      const result = webhooks.replay({ ...request, activeAllowedOrigin: null });
      assert.equal(result.replayed, false);
      f.sites.update(a.clientId, { revision: restored.revision, configuration: { ...a.configuration, notifications_enabled: false } }, audit, f.now());
      assert.equal(webhooks.replay(request).replayed, true);
    } finally { f.close(); }
  });

});
