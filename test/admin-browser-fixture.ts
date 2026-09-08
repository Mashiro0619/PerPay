import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { serve } from "@hono/node-server";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "perpay-admin-browser-"));
const configured = await createConfiguredHttpServices({
  directory: join(directory, "configured"),
  apiSecret: Buffer.alloc(32, 0xa7).toString("base64url"),
  collectionCodePayload: "https://qr.alipay.com/browser-fixture-only",
  publicUrl: "http://127.0.0.1:6194",
});
await configured.settings.saveWebhook({
  revision: configured.settings.view().revision,
  enabled: true,
  allowed_origin: "https://shop.example.com",
  timeout_milliseconds: 5000,
  maximum_attempts: 1,
  retry_base_seconds: 10,
  retry_maximum_seconds: 600,
}, { actorId: "admin", requestId: "browser-fixture", remoteAddressHash: "0".repeat(64) });

const ledger = new LedgerStore(configured.database);
const reconciliation = new ReconciliationStore(configured.database);
const webhooks = new WebhookStore(configured.database);
const fingerprint = configured.settings.snapshot().webhook.signingKeyFingerprint;
if (!fingerprint) throw new Error("fixture webhook signing key is missing");
webhooks.syncSigningKey({ secretFingerprint: fingerprint, now: Date.now() });
const providerAccountKey = configured.settings.snapshot().activeProviderAccountKey;
if (!providerAccountKey) throw new Error("fixture provider identity is missing");

function providerTime(timestamp: number): string {
  return new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

let sequence = 0;
function record(amount: string, direction: "CREDIT" | "DEBIT") {
  sequence += 1;
  const now = Date.now();
  const occurredAt = providerTime(now + 60_000);
  const accountLogId = `browser-fixture-${sequence}`;
  const run = ledger.startIngestRun({ providerAccountKey: providerAccountKey!, start: providerTime(now - 60_000 - sequence * 1000), end: providerTime(now + 3600_000), pageSize: 1, now });
  const page = ledger.recordPage({
    ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{
      raw: { account_log_id: accountLogId, amount, direction, occurred_at: occurredAt },
      accountLogId, occurredAt, amount, direction, alipayOrderNo: `TEST-${sequence}`,
      merchantOrderNo: null, transMemo: "仅用于前端验收的合成流水", otherAccount: "测试付款账户",
    }] },
    evidence: { httpStatus: 200, headers: { "alipay-request-id": accountLogId }, body: JSON.stringify({ accountLogId, amount, direction }), traceId: accountLogId, signatureVerified: true },
    now: now + 1,
  });
  const normalized = page.normalized[0];
  return normalized?.kind === "created" ? normalized.entry : null;
}

const products = ["测试 · 开发者支持计划", "测试 · 独立应用年度支持", "测试 · 文档订阅", "测试 · 项目赞助", "测试 · 云服务月度支持", "测试 · 个人站点维护"];
for (let index = 0; index < 26; index += 1) {
  const created = configured.orders.create(createOrderRequestSchema.parse({
    idempotency_key: `browser-order-${index}`,
    merchant_order_no: `DEMO-${String(index + 1).padStart(4, "0")}`,
    product_name: products[index % products.length],
    amount_cents: 990 + (index % 6) * 1600,
    note: "合成测试数据，不代表真实支付。",
    ...(index < 20 ? { notify_url: "https://shop.example.com/hooks/perpay" } : {}),
  })).order;
  if (index < 20) {
    const entry = record((created.payableAmountCents / 100).toFixed(2), "CREDIT");
    if (!entry) throw new Error("fixture ledger entry was not created");
    const matched = reconciliation.reconcileEntry(entry.ledgerEntryId);
    if (matched.kind !== "auto_settled") throw new Error(`unexpected fixture match: ${matched.kind}`);
  } else if (index < 23) {
    configured.orders.close(created.orderId);
  }
}
const unmatchedCredit = record("188.88", "CREDIT");
const unmatchedDebit = record("42.00", "DEBIT");
if (unmatchedCredit) reconciliation.reconcileEntry(unmatchedCredit.ledgerEntryId);
if (unmatchedDebit) reconciliation.reconcileEntry(unmatchedDebit.ledgerEntryId);
record("1.001", "CREDIT");
webhooks.materialize(100, Date.now());
for (let attempt = 0; attempt < 18; attempt += 1) {
  const claim = webhooks.claimNext({ now: Date.now(), leaseMilliseconds: 30000, maximumAttempts: 1 });
  if (!claim) break;
  const failed = attempt === 3;
  webhooks.completeAttempt({
    deliveryId: claim.delivery.deliveryId, attemptId: claim.attempt.attemptId, leaseToken: claim.attempt.leaseToken,
    outcome: failed ? "RETRYABLE_FAILURE" : "ACKNOWLEDGED", now: Date.now(), maximumAttempts: 1, retryBaseMilliseconds: 10000, retryMaximumMilliseconds: 600000,
    resolvedAddressesFingerprint: "b".repeat(64), connectedAddress: "203.0.113.10", httpStatus: failed ? 503 : 200,
    responseBytes: 2, responseFingerprint: createHash("sha256").update("{}").digest("hex"), ackCode: failed ? null : "acknowledged", errorCode: failed ? "http_server_error" : null,
  });
}

const freshConfig = loadConfig({ PERPAY_MASTER_KEY: "0123456789abcdef".repeat(4), PERPAY_DATA_DIR: join(directory, "fresh", "data"), PERPAY_BACKUP_DIR: join(directory, "fresh", "backups"), PERPAY_PUBLIC_URL: "http://127.0.0.1:6195" });
const freshDatabase = await AppDatabase.open(freshConfig.databasePath);
const freshIdentity = new IdentityService(freshDatabase);
await freshIdentity.initialize();
const freshSettings = new RuntimeSettingsService({ store: new RuntimeSettingsStore(freshDatabase, freshConfig.masterKey) });
freshSettings.initialize();

const healthy = () => ({ enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastErrorCode: null, consecutiveFailures: 0 });
const populatedApp = createApp({
  ...configured, ledger, reconciliation, webhookStore: webhooks, startedAt: new Date(),
  ledgerHealth: healthy,
  reconciliationHealth: () => ({ ...healthy(), pendingOrders: 3, continuationPending: false }),
  webhookHealth: () => ({ ...healthy(), pendingDeliveries: 2, deadLetters: 1 }),
});
const freshApp = createApp({ config: freshConfig, database: freshDatabase, identity: freshIdentity, settings: freshSettings, orders: new OrderService(freshDatabase, () => freshSettings.snapshot()), startedAt: new Date() });
const servers = [serve({ fetch: populatedApp.fetch, hostname: "127.0.0.1", port: 6194 }), serve({ fetch: freshApp.fetch, hostname: "127.0.0.1", port: 6195 })];
console.log("Isolated synthetic admin fixtures: http://127.0.0.1:6194/admin and http://127.0.0.1:6195/admin");
console.log("No provider or webhook transport is running. Do not use these fixtures for real payments.");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all(servers.map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  configured.database.close();
  freshDatabase.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("perpay-admin-browser-")) throw new Error("unexpected fixture cleanup target");
  rmSync(directory, { recursive: true, force: true });
}
process.on("SIGINT", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
