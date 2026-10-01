// SPDX-License-Identifier: MIT
// Disposable documentation data; never imports main.ts or starts external workers.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
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
import { createApp } from "../src/http/app.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";
import { renderCollectionCodeSvg } from "../src/http/web/collection-code.ts";
import { UpdateCheckUnavailable } from "../src/update/checker.ts";

export const DEMO_QR_TEXT = "PerPay documentation demo - NOT A PAYMENT CODE";
const DAY = 86_400_000;
const MINUTE = 60_000;
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
const COUNTS = [8, 11, 9, 14, 17, 12, 6, 10, 13, 18, 15, 21, 9, 7, 16, 14, 19, 23, 12, 18, 22, 16, 11, 20, 26, 17, 24, 21, 28, 12];
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
    const identity = new IdentityService(db);
    await identity.initialize();
    const password = "preview-" + randomBytes(12).toString("hex");
    await identity.setupAdmin(password);
    const settingsStore = new RuntimeSettingsStore(db, config.masterKey);
    const settings = new RuntimeSettingsService({ store: settingsStore });
    settings.initialize();
    const audit = { actorId: "admin", requestId: "documentation-fixture", remoteAddressHash: "0".repeat(64) };
    const application = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await settings.saveCollection({
      revision: settings.view().revision,
      code_payload: "https://qr.alipay.com/perpay-documentation-no-real-payment",
      order_ttl_seconds: 1800, amount_offset_maximum_cents: 99,
    }, audit);
    await settings.saveProvider({
      revision: settings.view().revision, environment: "SANDBOX", app_id: "2026000000000001",
      private_key: application.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      platform_public_key: platform.publicKey.export({ format: "pem", type: "spki" }).toString(),
      timeout_milliseconds: 8000, scan_interval_seconds: 60, active_scan_interval_seconds: 8,
      safety_lag_seconds: 10, maximum_success_age_seconds: 120,
    }, audit);
    settingsStore.saveApiSecret(randomBytes(32).toString("base64url"), settings.view().revision, audit);
    await settings.saveWebhook({
      revision: settings.view().revision, enabled: true, allowed_origin: "https://shop.example.com",
      timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600,
    }, audit);
    const midnight = Math.floor((capturedAt + 8 * 3_600_000) / DAY) * DAY - 8 * 3_600_000;
    let now = midnight - 29 * DAY;
    // Rebase only the empty, newly migrated order clock before creating any financial facts.
    db.write(connection => {
      assert.equal(Number(connection.prepare("SELECT COUNT(*) AS n FROM payment_orders").get()?.n), 0);
      const trigger = connection.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_clock_no_decrease'").get()?.sql;
      assert.equal(typeof trigger, "string");
      connection.exec("DROP TRIGGER order_clock_no_decrease");
      connection.prepare("UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1").run(now);
      connection.exec(trigger as string);
    });
    const orders = new OrderService(db, () => settings.snapshot(), () => now);
    orders.initialize();
    const ledger = new LedgerStore(db);
    const reconciliation = new ReconciliationStore(db);
    const webhooks = new WebhookStore(db);
    const snapshot = settings.snapshot();
    assert.ok(snapshot.webhook.signingKeyFingerprint);
    assert.ok(snapshot.activeProviderAccountKey);
    webhooks.syncSigningKey({ secretFingerprint: snapshot.webhook.signingKeyFingerprint, now });
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
    function deliver(outcome: CompleteWebhookAttemptInput["outcome"] = "ACKNOWLEDGED", maximumAttempts = 5) {
      webhooks.materialize(100, now);
      const claim = webhooks.claimNext({ now, leaseMilliseconds: 30_000, maximumAttempts });
      if (!claim) return;
      webhooks.completeAttempt({
        deliveryId: claim.delivery.deliveryId, attemptId: claim.attempt.attemptId, leaseToken: claim.attempt.leaseToken,
        outcome, now: now + 120, maximumAttempts, retryBaseMilliseconds: 600_000, retryMaximumMilliseconds: 600_000,
        resolvedAddressesFingerprint: "b".repeat(64), connectedAddress: "203.0.113.10",
        httpStatus: outcome === "ACKNOWLEDGED" ? 200 : 503, responseBytes: 2,
        responseFingerprint: createHash("sha256").update("{}").digest("hex"),
        ackCode: outcome === "ACKNOWLEDGED" ? "acknowledged" : null,
        errorCode: outcome === "ACKNOWLEDGED" ? null : "http_server_error",
      });
    }
    function create(productIndex: number, status: "paid" | "closed" | "expired" | "open" = "paid", notify = true, deliveryOutcome: CompleteWebhookAttemptInput["outcome"] = "ACKNOWLEDGED") {
      const [product, amount] = PRODUCTS[productIndex % PRODUCTS.length]!;
      const order = orders.create(createOrderRequestSchema.parse({
        idempotency_key: "readme-" + ++sequence,
        merchant_order_no: "MG" + beijing(now).slice(0, 10).replaceAll("-", "") + "-" + String(sequence).padStart(4, "0"),
        product_name: product, amount_cents: amount, note: "示例商户 · 文档演示订单（非真实交易）",
        ...(notify ? { notify_url: "https://shop.example.com/api/payments/perpay" } : {}),
      })).order;
      if (status === "paid") {
        now += 35_000 + (sequence % 5) * 12_000;
        const entry = credit(order.payableAmountCents, product);
        assert.equal(reconciliation.reconcileEntry(entry.ledgerEntryId, now + 2500).kind, "auto_settled");
        now += 3000;
        deliver(deliveryOutcome, deliveryOutcome === "PERMANENT_FAILURE" ? 1 : 5);
      } else if (status === "closed") {
        now += 8000;
        orders.close(order.orderId);
      }
      return order;
    }
    // Seed complete prior days; today's small batch leaves room for recent scenarios.
    // Just after midnight, keep today's historical batch on the previous evening.
    const earlyMorning = capturedAt - midnight < 60 * MINUTE;
    for (let d = 0; d < COUNTS.length; d++) {
      const begin = midnight - (29 - d) * DAY;
      const start = d === 29 ? (earlyMorning ? midnight - 2 * 3_600_000 : midnight) : begin + 9 * 3_600_000;
      const end = d === 29 ? (earlyMorning ? midnight - 60 * MINUTE : capturedAt - 25 * MINUTE) : begin + 21 * 3_600_000;
      for (let i = 0; i < COUNTS[d]!; i++) {
        now = Math.floor(start + (end - start) * i / COUNTS[d]!);
        create((i * 3 + d + Math.floor(i / 4)) % PRODUCTS.length, sequence % 17 === 7 ? "closed" : sequence % 13 === 4 ? "expired" : "paid", sequence % 11 !== 0);
      }
    }
    now = capturedAt - 12 * MINUTE;
    const featured = create(5);
    now = capturedAt - 10 * MINUTE;
    create(2);
    now = capturedAt - 8 * MINUTE;
    create(1, "closed");
    now = capturedAt - 7 * MINUTE;
    const failed = create(4, "paid", true, "PERMANENT_FAILURE");
    now = capturedAt - 5 * MINUTE;
    const retry = create(7, "paid", true, "RETRYABLE_FAILURE");
    now = capturedAt - 3 * MINUTE;
    const unmatched = credit(8800, "手工核对 · 未找到对应订单");
    reconciliation.reconcileEntry(unmatched.ledgerEntryId, now + 3000);
    now = capturedAt - 150_000;
    const checkout = create(0, "open");
    for (const index of [3, 4, 6]) { now += 20_000; create(index, "open"); }
    now = capturedAt;
    orders.get(checkout.orderId);
    const stats = systemAnalytics(db, 30, now);
    assert.ok(stats.orders.created > 400);
    assert.equal(stats.pending.orders, 4);
    assert.ok(db.integrityCheck().ok, "Demo data must satisfy production integrity checks");

    // Health is explicitly simulated; no scheduler, provider client or webhook transport runs.
    const healthy = () => ({ enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: now - 3000, lastSuccessAt: now - 2000, lastErrorCode: null, consecutiveFailures: 0, paymentRevision: settings.snapshot().paymentRevision });
    const app = createApp({
      config, database: db, identity, settings, orders, ledger, reconciliation, webhookStore: webhooks,
      startedAt: new Date(capturedAt - 8 * DAY), clock: () => now,
      ledgerHealth: healthy,
      reconciliationHealth: () => ({ ...healthy(), pendingOrders: 4, continuationPending: false }),
      webhookHealth: () => ({ ...healthy(), pendingDeliveries: stats.pending.notifications, deadLetters: 1 }),
      // Never claim a real update check has succeeded and never contact GitHub.
      updateChecker: { check: async () => { throw new UpdateCheckUnavailable(3600); } },
    });
    const preview = new Hono();
    preview.use("*", async (context, next) => {
      const sessionAction = context.req.method === "POST" && ["/api/admin/v1/session/login", "/api/admin/v1/session/logout"].includes(context.req.path);
      if (!["GET", "HEAD"].includes(context.req.method) && !sessionAction) {
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
    return { app: preview, database: db, directory, origin, password, capturedAt, stats, featured: featured.orderId, failed: failed.orderId, retry: retry.orderId, checkout: checkout.checkoutToken, dispose };
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
    console.log(JSON.stringify({ origin: demo.origin, password: demo.password, capturedAt: demo.capturedAt, featured: demo.featured, retry: demo.retry, failed: demo.failed, checkout: demo.checkout, orders: demo.stats.orders, directory: demo.directory }, null, 2));
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
