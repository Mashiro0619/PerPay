import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { OrderStore, type StoredOrderAggregate } from "../src/database/order-store.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore, WebhookStoreError, prepareWebhookTarget, webhookDeliveryRequestFingerprint } from "../src/notifications/index.ts";
import { createOrderRequestSchema, fingerprintCreateOrderRequest } from "../src/orders/model.ts";
import { digestIdempotencyKey, fingerprintCollectionCodeProfile } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { SiteStore } from "../src/sites/store.ts";
import { PRODUCTION_PROVIDER_ENDPOINT } from "../src/settings/model.ts";
import { seedFixedSite } from "./fixed-site-fixture.ts";
import { seedHistoricalSandboxAccount } from "./historical-sandbox-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";

const START = 2_000_000_000_000;
const PAYMENT = START + 60_000;
const DELIVER = START + 90_000;
const CLIENT = "default";
const ORIGIN = "https://historical-hooks.example.test";
const production = { providerAccountKey: "primary", providerKind: "alipay", endpoint: PRODUCTION_PROVIDER_ENDPOINT, externalAccountId: "production-app" } as const;
const providerTime = (time: number) => new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

async function withHistory(run: (context: HistoryContext) => void | Promise<void>) {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "perpay-historical-processing-"));
  const database = await AppDatabase.open(join(directory, "state.sqlite3"));
  try {
    seedFixedSite(database, CLIENT, START);
    const ledger = new LedgerStore(database);
    ledger.bindProviderIdentity(production, START);
    seedHistoricalSandboxAccount(database, "default", "old-sandbox-app");
    const sandboxKey = database.read(connection => String(connection.prepare("SELECT provider_account_key FROM alipay_accounts WHERE account_id='default'").get()!.provider_account_key));
    const orders = new OrderStore(database, () => START);
    const reconciliation = new ReconciliationStore(database);
    const sites = new SiteStore(database, Buffer.alloc(32, 7));
    configureTestSiteNotifications(sites, CLIENT, { enabled: true, allowed_origin: ORIGIN });
    const notifications = new WebhookStore(database);
    const context = { database, ledger, orders, reconciliation, sites, notifications, sandboxKey, credits: 0 };
    await run(context);
    const integrity = database.integrityCheck();
    assert.equal(integrity.ok, true, JSON.stringify(integrity));
  } finally {
    database.close();
    assert.equal(dirname(realpathSync(directory)), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  }
}
type HistoryContext = {
  database: AppDatabase; ledger: LedgerStore; orders: OrderStore; reconciliation: ReconciliationStore;
  sites: SiteStore; notifications: WebhookStore; sandboxKey: string; credits: number;
};

function order(context: HistoryContext, name: string, source: string, amount: number, clientId = CLIENT) {
  const codePayload = "https://qr.alipay.com/historical-processing";
  const profile = context.orders.syncCollectionProfile({ codePayload, providerAccountKey: source, ...fingerprintCollectionCodeProfile(codePayload, source) });
  const request = createOrderRequestSchema.parse({ idempotency_key: name, merchant_order_no: name, product_name: name, amount_cents: amount, notify_url: ORIGIN + "/notify" });
  const result = context.orders.createOrder({ apiClientId: clientId, collectionProfileIds: [profile.profile.profileId], request,
    idempotencyKeyDigest: digestIdempotencyKey(clientId, name), requestFingerprint: fingerprintCreateOrderRequest(request),
    ttlMilliseconds: 300_000, amountOffsetMaximumCents: 99, webhookTarget: prepareWebhookTarget(request.notify_url!, ORIGIN) });
  assert.equal(result.kind, "created");
  if (result.kind !== "created") throw new Error("expected historical order");
  return result.aggregate;
}

function credit(context: HistoryContext, target: StoredOrderAggregate, name: string) {
  const source = target.collectionProfile.providerAccountKey;
  const sequence = context.credits++;
  const run = context.ledger.startIngestRun({ providerAccountKey: source, start: providerTime(START), end: providerTime(START + 3_600_000 + sequence * 1_000), pageSize: 1, now: PAYMENT + 1_000 });
  const amount = (target.order.payableAmountCents / 100).toFixed(2);
  const result = context.ledger.recordPage({ ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
      raw: { account_log_id: name, amount, direction: "CREDIT", occurred_at: providerTime(PAYMENT) },
      accountLogId: name, occurredAt: providerTime(PAYMENT), amount, direction: "CREDIT", alipayOrderNo: "trade-" + name, merchantOrderNo: null, transMemo: null, otherAccount: null,
    }] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify({ account_log_id: name, amount }), traceId: name, signatureVerified: true }, now: PAYMENT + 2_000,
  });
  const entry = result.normalized[0];
  assert.equal(entry?.kind, "created", JSON.stringify(result));
  if (entry?.kind !== "created") throw new Error("expected historical credit");
  context.ledger.completeIngestRun({ ingestRunId: run.ingestRunId, now: PAYMENT + 2_000 });
  return entry.entry;
}

function settle(context: HistoryContext, target: StoredOrderAggregate, name: string) {
  const entry = credit(context, target, name);
  context.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: target.order.orderId, ledgerEntryId: entry.ledgerEntryId,
    actorId: "admin", reason: "Recorded by an older release", now: PAYMENT + 3_000 });
  return entry;
}

function financialSnapshot(database: AppDatabase) {
  return database.read(connection => Object.fromEntries(["financial_operations", "financial_exceptions", "match_candidates", "payment_matches", "outbox_events", "order_clock"]
    .map(table => [table, connection.prepare("SELECT * FROM " + table).all()])));
}

// Persist old queue/lease records directly; the current store correctly refuses
// to create or claim sandbox deliveries. All schema triggers stay enabled.
function oldDelivery(context: HistoryContext, target: StoredOrderAggregate, status: "PENDING" | "RETRY_WAIT" | "LEASED" | "DEAD_LETTER", predecessor?: { deliveryId: string; requestKey: string }) {
  const deliveryId = randomUUID();
  const facts = context.database.read(connection => connection.prepare("SELECT outbox_event_id, payload_fingerprint FROM outbox_events WHERE aggregate_id=?").get(target.order.orderId)!);
  const eventId = String(facts.outbox_event_id);
  const generation = predecessor ? 2 : 1;
  const requestKey = predecessor?.requestKey ?? eventId;
  const fingerprint = webhookDeliveryRequestFingerprint({ eventId, targetId: target.webhookTarget!.targetId, generation,
    predecessorDeliveryId: predecessor?.deliveryId ?? null, requestedByType: predecessor ? "ADMIN" : "SYSTEM", requestedByActorId: predecessor ? "admin" : null, reason: predecessor ? "Retry historical notification" : null });
  const leaseToken = randomUUID(), attemptId = randomUUID();
  context.database.write(connection => {
    connection.prepare(`INSERT INTO webhook_deliveries(delivery_id,outbox_event_id,target_id,generation,predecessor_delivery_id,request_key,request_fingerprint,request_fingerprint_version,requested_by_type,requested_by_actor_id,reason,status,attempt_count,next_attempt_at,lease_token,lease_expires_at,acknowledged_at,dead_lettered_at,last_error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,'PENDING',0,?,NULL,NULL,NULL,NULL,NULL,?,?)`).run(deliveryId,eventId,target.webhookTarget!.targetId,generation,predecessor?.deliveryId??null,requestKey,fingerprint,predecessor?"ADMIN":"SYSTEM",predecessor?"admin":null,predecessor?"Retry historical notification":null,DELIVER,DELIVER,DELIVER);
    if (status === "PENDING") return;
    connection.prepare("UPDATE webhook_deliveries SET status='LEASED',attempt_count=1,lease_token=?,lease_expires_at=?,updated_at=? WHERE delivery_id=?").run(leaseToken, DELIVER + 1_000, DELIVER, deliveryId);
    const key = connection.prepare("SELECT key_version FROM webhook_signing_keys WHERE client_id=? AND retired_at IS NULL").get(CLIENT)!;
    connection.prepare(`INSERT INTO webhook_attempts(attempt_id,delivery_id,attempt_number,lease_token,key_version,request_timestamp,request_body_fingerprint,outcome,started_at)
      VALUES (?,?,1,?,?,?,?,'STARTED',?)`).run(attemptId,deliveryId,leaseToken,key.key_version!,DELIVER,String(facts.payload_fingerprint),DELIVER);
  });
  if (status === "RETRY_WAIT" || status === "DEAD_LETTER") context.notifications.completeAttempt({ deliveryId,attemptId,leaseToken,
    outcome: status === "RETRY_WAIT" ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE", now: DELIVER + 500, maximumAttempts: 3,
    retryBaseMilliseconds: 1_000, retryMaximumMilliseconds: 1_000, errorCode: "transport_timeout" });
  return deliveryId;
}

function claim(context: HistoryContext, maximumAttempts = 3) {
  return context.notifications.claimNext({ clientId: CLIENT, siteRevision: context.sites.get(CLIENT)!.revision, now: DELIVER + 60_000, leaseMilliseconds: 1_000, maximumAttempts });
}

describe("historical sandbox processing is frozen", () => {
  it("skips direct, sweep and order-based automatic matching without changing historical financial facts", async () => {
    await withHistory(context => {
      const legacy = order(context, "sandbox-unpaid", context.sandboxKey, 999);
      const historicalCredit = credit(context, legacy, "sandbox-credit");
      const current = order(context, "production-unpaid", production.providerAccountKey, 1_999);
      const liveCredit = credit(context, current, "production-credit");
      const before = financialSnapshot(context.database);
      assert.deepEqual(context.reconciliation.reconcileEntry(historicalCredit.ledgerEntryId, DELIVER), { kind: "ignored", ledgerEntryId: historicalCredit.ledgerEntryId });
      assert.deepEqual(context.reconciliation.reconcileOrder(legacy.order.orderId, 1, DELIVER), { processed: 0, results: [], hasMore: false });
      assert.deepEqual(financialSnapshot(context.database), before);
      const page = context.reconciliation.pendingLedgerPage(null, 1);
      assert.deepEqual(page.ledgerEntryIds, [liveCredit.ledgerEntryId]);
      assert.equal(page.hasMore, false);
      assert.equal(context.reconciliation.reconcilePending(1, DELIVER).results[0]?.kind, "auto_settled");
      assert.equal(context.orders.orderById(CLIENT, legacy.order.orderId)?.order.paymentStatus, "UNPAID");
      assert.equal(context.reconciliation.ledgerEntry(historicalCredit.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(context.orders.orderById(CLIENT, current.order.orderId)?.order.paymentStatus, "CONFIRMED");
    });
  });

  it("leaves old pending, retry and expired leases untouched while a formal notification remains claimable", async () => {
    await withHistory(context => {
      const legacy = ["PENDING", "RETRY_WAIT", "LEASED"] as const;
      const deliveries = legacy.map((status, index) => {
        const target = order(context, "legacy-" + status, context.sandboxKey, 999 + index * 1_000);
        settle(context, target, "credit-" + status);
        return oldDelivery(context, target, status);
      });
      const unmaterialized = order(context, "legacy-outbox", context.sandboxKey, 4_999);
      settle(context, unmaterialized, "credit-outbox");
      const current = order(context, "production-notify", production.providerAccountKey, 5_999);
      settle(context, current, "credit-production");
      // Simulate the same account moving back to a formal application. The
      // immutable original order identity must continue to freeze old items.
      context.database.write(connection => {
        connection.prepare("INSERT INTO alipay_account_generations VALUES (?,'default',?)").run(production.providerAccountKey, DELIVER);
        connection.prepare("UPDATE alipay_accounts SET environment='PRODUCTION',app_id=?,provider_account_key=?,revision=revision+1 WHERE account_id='default'").run(production.externalAccountId, production.providerAccountKey);
      });
      const before = deliveries.map(id => context.notifications.delivery(id));
      assert.equal(context.notifications.recoverExpired(DELIVER + 60_000), 0);
      assert.equal(context.notifications.materialize(1, DELIVER + 2_000, CLIENT), 1);
      const live = claim(context, 1);
      assert.equal(live?.target.orderId, current.order.orderId);
      assert.equal(claim(context, 1), null);
      assert.equal(context.notifications.materialize(1, DELIVER + 2_000, CLIENT), 0);
      assert.deepEqual(deliveries.map(id => context.notifications.delivery(id)), before);
    });
  });

  it("rejects new sandbox replays while preserving historical idempotent results and formal replays", async () => {
    await withHistory(context => {
      const legacy = order(context, "legacy-replay", context.sandboxKey, 999);
      settle(context, legacy, "legacy-replay-credit");
      const original = oldDelivery(context, legacy, "DEAD_LETTER");
      const input = { redeliveryId: randomUUID(), deliveryId: original, actorId: "admin", reason: "Retry historical notification", activeAllowedOrigin: ORIGIN, now: DELIVER + 2_000 };
      assert.throws(() => context.notifications.replay(input), error => error instanceof WebhookStoreError && error.code === "webhook_delivery_state_conflict" && error.message.includes("历史沙箱"));
      const existing = oldDelivery(context, legacy, "PENDING", { deliveryId: original, requestKey: input.redeliveryId });
      const historicalResult = context.notifications.replay(input);
      assert.equal(historicalResult.replayed, true);
      assert.equal(historicalResult.delivery.deliveryId, existing);
      assert.equal(claim(context), null);
      const current = order(context, "formal-replay", production.providerAccountKey, 1_999);
      settle(context, current, "formal-replay-credit");
      const formalOriginal = oldDelivery(context, current, "DEAD_LETTER");
      const formalResult = context.notifications.replay({ ...input, deliveryId: formalOriginal, redeliveryId: randomUUID() });
      assert.equal(formalResult.replayed, false);
      assert.equal(claim(context)?.delivery.deliveryId, formalResult.delivery.deliveryId);
    });
  });

  it("skips sites with only historical outbox or leased deliveries before choosing a formal site's work", async () => {
    await withHistory(context => {
      const legacy = order(context, "legacy-site", context.sandboxKey, 999);
      settle(context, legacy, "legacy-site-credit");
      assert.equal(context.sites.nextNotificationSite(null, DELIVER + 60_000), null);
      oldDelivery(context, legacy, "LEASED");
      assert.equal(context.sites.nextNotificationSite(null, DELIVER + 60_000), null);
      const clientId = "site_formal";
      seedFixedSite(context.database, clientId, START);
      configureTestSiteNotifications(context.sites, clientId, { enabled: true, allowed_origin: ORIGIN });
      const current = order(context, "formal-site", production.providerAccountKey, 1_999, clientId);
      settle(context, current, "formal-site-credit");
      assert.equal(context.sites.nextNotificationSite(null, DELIVER + 60_000), clientId);
      assert.equal(context.sites.nextNotificationSite(clientId, DELIVER + 60_000), clientId);
      assert.equal(context.notifications.materialize(1, DELIVER + 2_000, clientId), 1);
      assert.equal(context.sites.nextNotificationSite(null, DELIVER + 60_000), clientId);
    });
  });
});
