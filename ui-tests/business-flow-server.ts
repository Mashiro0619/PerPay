// SPDX-License-Identifier: MIT
import { serve } from "@hono/node-server";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AlipayAccountService } from "../src/alipay-accounts/service.ts";
import type { AlipayAccountView } from "../src/alipay-accounts/model.ts";
import { ActivityRecorder } from "../src/audit/activity.ts";
import { createApp } from "../src/http/app.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { webhookSignature } from "../src/notifications/model.ts";
import { SiteWebhookProcessor } from "../src/notifications/site-processor.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import type { WebhookTransport } from "../src/notifications/transport.ts";
import { OrderService } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { createApiRequestNonce, signApiRequest } from "../src/security/api-signature.ts";
import { parsePlatformPublicKey, publicKeyFingerprint, type ProviderSettings } from "../src/settings/model.ts";
import { RuntimeSettingsService } from "../src/settings/service.ts";
import type { ProviderKeyVerifier } from "../src/settings/provider-key-verification.ts";
import { SettingsError } from "../src/settings/store.ts";
import type { AuditEventDetail, AuditEventPage } from "../src/shared/audit.ts";
import { UpdateCheckUnavailable } from "../src/update/checker.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "../test/http-fixture.ts";
import { recordLedgerEntry } from "../test/reconciliation-http-fixture.ts";
import type { AdminOrderDetail, FinancialException, Order, OrderWebhookDeliveryDetail, Site } from "../web/src/api/generated/types.gen.ts";

export type NotificationMode = "retryable-failure" | "success";
export interface ReceiverCall {
  readonly orderId: string; readonly deliveryId: string; readonly eventId: string;
  readonly attemptNumber: number; readonly status: 200 | 503; readonly signatureVerified: true;
}

/**
 * Writable loopback-only fixture. Hono, SQLite, validation, key generation,
 * allocation, ingestion, reconciliation, signing, retry and ACK handling are real.
 * Only the external Alipay verifier/statement page and notification transport are
 * synthetic. No RuntimeController or NodeWebhookTransport is started.
 */
export async function createBusinessFlowFixture(epoch = Date.now()) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing business fixture address");
  await new Promise<void>(done => probe.close(() => done()));
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), "perpay-business-browser-"));
  let ownedServices: Awaited<ReturnType<typeof createConfiguredHttpServices>> | undefined;
  let ownedActivity: ActivityRecorder | undefined, ownedServer: ReturnType<typeof serve> | undefined;
  let ownedHeartbeat: NodeJS.Timeout | undefined, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (ownedHeartbeat) clearInterval(ownedHeartbeat);
    const server = ownedServer;
    if (server) await new Promise<void>(done => { server.close(() => done()); if ("closeAllConnections" in server) server.closeAllConnections(); });
    ownedActivity?.stop(); ownedServices?.database.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("perpay-business-browser-")) throw new Error("Unexpected business fixture cleanup path");
    rmSync(directory, { recursive: true, force: true });
  };
  try {
  let offset = 0;
  const now = () => Math.max(epoch, Date.now()) + offset;
  const services = await createConfiguredHttpServices({ directory, publicUrl: origin, apiSecret: null,
    collectionCodePayload: "https://qr.alipay.com/isolated-legacy-business-fixture", identityClock: now });
  ownedServices = services;
  const platformPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const platformFingerprint = publicKeyFingerprint(parsePlatformPublicKey(platformPublicKey).publicKey);
  const appId = "2026110500000123", collectionCode = "https://qr.alipay.com/isolated-business-flow";
  const notificationOrigin = "https://business-flow.example.com", notificationUrl = notificationOrigin + "/perpay/notify";
  const store = services.settings.accountService()!.store();
  const verified = new Set<string>();
  const providerIdentity = (provider: ProviderSettings) => [provider.appId, provider.applicationKeyFingerprint, provider.platformKeyFingerprint].join(":");
  const verifyProviderApplicationKey: ProviderKeyVerifier = async (provider, options = {}) => {
    options.signal?.throwIfAborted();
    if (provider.appId !== appId || provider.platformKeyFingerprint !== platformFingerprint) {
      throw new SettingsError("provider_application_key_verification_failed", "隔离支付宝模拟器拒绝了不匹配的应用配置。");
    }
    verified.add(providerIdentity(provider));
  };
  const alipayAccounts = new AlipayAccountService({ store, verifyProviderApplicationKey });
  // Legacy settings endpoints must also stay inside the synthetic verifier.
  const settings = new RuntimeSettingsService({ store: services.settingsStore, verifyProviderApplicationKey });
  const accountReady = (id: string) => {
    const account = store.snapshot(id);
    return account.enabled && account.configured && account.provider !== null && verified.has(providerIdentity(account.provider));
  };
  const orders = new OrderService(services.database, () => services.settings.instanceSnapshot(), now, services.sites, "default",
    { accounts: () => store.snapshots(), available: accountReady });
  orders.initialize();
  const ledger = new LedgerStore(services.database), reconciliation = new ReconciliationStore(services.database);
  const webhooks = new WebhookStore(services.database), activity = new ActivityRecorder({ database: services.database, clock: now });
  ownedActivity = activity;
  let notificationMode: NotificationMode = "retryable-failure";
  const receiverCalls: ReceiverCall[] = [];
  const transport: WebhookTransport = { post: async input => {
    input.signal?.throwIfAborted();
    if (input.targetUrl !== notificationUrl) throw new Error("Fixture refused an unexpected notification target");
    const headers = input.headers, deliveryId = headers["x-perpay-webhook-delivery-id"]!, eventId = headers["x-perpay-webhook-event-id"]!;
    const detail = webhooks.delivery(deliveryId);
    if (!detail) throw new Error("Notification was not materialized by the real store");
    const secret = services.sites.notificationSecret(detail.target.apiClientId);
    if (!secret || webhookSignature({ secret, keyId: headers["x-perpay-webhook-key-id"]!, timestamp: Number(headers["x-perpay-webhook-timestamp"]),
      deliveryId, eventId, attemptNumber: Number(headers["x-perpay-webhook-attempt"]), body: input.body }) !== headers["x-perpay-webhook-signature"]) {
      throw new Error("Synthetic receiver rejected the real webhook signature");
    }
    const status = notificationMode === "success" ? 200 : 503;
    receiverCalls.push({ orderId: detail.event.orderId, deliveryId, eventId, attemptNumber: Number(headers["x-perpay-webhook-attempt"]), status, signatureVerified: true });
    const body = Buffer.from(JSON.stringify(status === 200 ? { schema: "perpay:webhook-ack:v1", ack: true, event_id: eventId, delivery_id: deliveryId } : { error: "synthetic_receiver_unavailable" }));
    return { status, contentType: "application/json; charset=utf-8", contentEncoding: null, body,
      responseFingerprint: createHash("sha256").update(body).digest("hex"), resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "192.0.2.10" };
  } };
  const processor = new SiteWebhookProcessor({ sites: services.sites, webhooks, activity, clock: now, transport: () => transport });
  let lastReconciliationAt = now();
  const sweep = () => { reconciliation.reconcilePending(64, now()); lastReconciliationAt = now(); };
  sweep();
  const heartbeat = setInterval(sweep, 1000); heartbeat.unref(); ownedHeartbeat = heartbeat;
  const healthy = () => ({ enabled: true, state: "healthy" as const, paymentRevision: services.settings.instanceSnapshot().paymentRevision,
    inFlight: false, lastAttemptAt: now(), lastSuccessAt: now(), lastErrorCode: null, consecutiveFailures: 0 });
  const app = createApp({ ...services, settings, orders, alipayAccounts, ledger, reconciliation, webhookStore: webhooks, activity,
    clock: now, startedAt: new Date(epoch), updateChecker: { check: async () => { throw new UpdateCheckUnavailable(3600); } },
    accountHealth: id => ({ state: accountReady(id) ? "healthy" : "unconfigured", lastSuccessAt: accountReady(id) ? now() : null,
      lastErrorCode: null, collectionReady: accountReady(id) }),
    runtimeStatus: () => ({ configured: store.snapshots().some(account => accountReady(account.id)), transitioning: false,
      paymentRevision: services.settings.instanceSnapshot().paymentRevision, activeProviderAccountKey: services.settings.instanceSnapshot().activeProviderAccountKey,
      scanIntervalMilliseconds: 1000, maximumSuccessAgeMilliseconds: 120_000 }),
    ledgerHealth: () => ({ ...healthy(), enabled: store.snapshots().some(account => accountReady(account.id)),
      lastSuccessAt: store.snapshots().some(account => accountReady(account.id)) ? now() : null }),
    reconciliationHealth: () => ({ ...healthy(), lastSuccessAt: lastReconciliationAt, pendingOrders: 0, continuationPending: false }),
    webhookHealth: () => ({ ...healthy(), pendingDeliveries: webhooks.counts().pending, deadLetters: webhooks.counts().dead }),
    onWebhookAvailable: () => undefined, // Tests explicitly tick the real processor to observe failure/retry states.
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: address.port }); ownedServer = server; await once(server, "listening");
  activity.start();
  const login = await app.request(origin + "/api/admin/v1/session/login", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error("Business fixture login failed");
  const csrfToken = ((await login.json()) as { data: { csrf_token: string } }).data.csrf_token;
  const cookies = login.headers.getSetCookie().map(cookie => {
    const entry = cookie.split(";", 1)[0]!, index = entry.indexOf("=");
    return { name: entry.slice(0, index), value: entry.slice(index + 1), url: origin, httpOnly: !entry.slice(0, index).includes("csrf"), sameSite: "Strict" as const };
  });
  const headers = { origin, cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), "content-type": "application/json", "x-csrf-token": csrfToken };
  async function api<T>(path: string): Promise<T> {
    const response = await app.request(origin + path, { headers });
    if (!response.ok) throw new Error(`Fixture API ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  function advance(milliseconds: number): number {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 300_000) throw new RangeError("Fixture advance must be 0..300000 ms");
    const expiry = services.database.read(db => db.prepare("SELECT MIN(expires_at) AS at FROM payment_orders WHERE checkout_status='OPEN' AND payment_status='UNPAID'").get()?.at);
    if (expiry !== null && expiry !== undefined && now() + milliseconds >= Number(expiry)) throw new Error("Clock advance would expire an unrelated unpaid order");
    offset += milliseconds; sweep(); return now();
  }
  async function income(accountId: string, amountCents: number) {
    if (!accountReady(accountId)) throw new Error("Income requires a configured and successfully checked synthetic account");
    const account = store.snapshot(accountId), occurredAt = Math.ceil((now() + 1000) / 1000) * 1000;
    advance(occurredAt - now() + 5);
    const timestamp = (value: number) => new Date(value + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    const entry = await activity.runTask("ledger.scan", { subjectType: "provider_account", subjectId: account.providerAccountKey! }, () => {
      const result = recordLedgerEntry(ledger, { start: timestamp(occurredAt - 60_000), end: timestamp(occurredAt + 60_000) },
        "business-flow-" + randomUUID(), amountCents, occurredAt, now(), "CREDIT", account.providerAccountKey!);
      const run = services.database.read(db => db.prepare("SELECT ingest_run_id FROM ingest_runs WHERE provider_account_key=? AND status='RUNNING' ORDER BY started_at DESC LIMIT 1").get(account.providerAccountKey!));
      if (run) ledger.completeIngestRun({ ingestRunId: String(run.ingest_run_id), now: now() });
      return result;
    });
    const result = await activity.runTask("reconciliation.sweep", {}, () => reconciliation.reconcileEntry(entry.ledgerEntryId, now()));
    lastReconciliationAt = now(); activity.flush();
    return { ledgerEntryId: entry.ledgerEntryId, result };
  }
  return {
    origin, cookies, csrfToken, platformPublicKey, collectionCode, appId, notificationOrigin, notificationUrl, now, advance,
    simulation: { alipay: "Synthetic verifier, statement page and healthy-provider heartbeat after a successful check; no Alipay network or signature acceptance evidence", notification: "In-memory transport with real request signature and ACK verification; no DNS/TLS/network evidence" },
    setNotificationMode(mode: NotificationMode) { notificationMode = mode; },
    flushAudit() { activity.flush(); },
    async settleOrder(orderId: string) {
      const order = orders.adminGet(orderId);
      if (order.payment.status !== "UNPAID") throw new Error("Only an unpaid order can receive fixture income");
      const settled = await income(order.alipayAccountId, order.payableAmountCents);
      if (settled.result.kind !== "auto_settled" || settled.result.orderId !== orderId) throw new Error(`Real reconciliation did not settle requested order: ${JSON.stringify(settled.result)}`);
      webhooks.materialize(100, now());
      return { orderId, ...settled, paymentMatchId: settled.result.paymentMatchId, candidateId: settled.result.candidateId };
    },
    async createUnmatchedIncome(accountId: string, input: { amountCents?: number } = {}) {
      const unmatched = await income(accountId, input.amountCents ?? 34_567_890);
      if (unmatched.result.kind !== "unmatched") throw new Error(`Expected a real unmatched exception, received ${unmatched.result.kind}`);
      return { ...unmatched, exceptionId: unmatched.result.exceptionId };
    },
    async dispatchNotification(options: { advanceToNextAttempt?: boolean } = {}) {
      webhooks.materialize(100, now());
      if (options.advanceToNextAttempt) {
        const due = services.database.read(db => db.prepare("SELECT MIN(next_attempt_at) AS at FROM webhook_deliveries WHERE status IN ('PENDING','RETRY_WAIT')").get()?.at);
        if (due !== null && due !== undefined && Number(due) > now()) advance(Number(due) - now());
      }
      const result = await processor.processOne(); activity.flush(); return result;
    },
    async createNotifiableOrder(siteId: string, input: { amountCents: number; merchantOrderNo?: string }) {
      const credential = services.sites.credential(siteId);
      if (!credential) throw new Error("Generate and enable the website API key through its real UI first");
      const merchantOrderNo = input.merchantOrderNo ?? "business-" + randomUUID();
      const body = Buffer.from(JSON.stringify({ idempotency_key: merchantOrderNo, merchant_order_no: merchantOrderNo, amount_cents: input.amountCents,
        product_name: "业务通知连续验收", notify_url: notificationUrl }));
      const signed = signApiRequest({ secret: Buffer.from(credential.secret, "base64url"), method: "POST", target: "/api/v1/orders", body,
        clientId: siteId, timestamp: String(Math.floor(Date.now() / 1000)), nonce: createApiRequestNonce() });
      const response = await app.request(origin + "/api/v1/orders", { method: "POST", headers: { "content-type": "application/json",
        "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId, "x-perpay-timestamp": signed.timestamp,
        "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature }, body });
      if (!response.ok) throw new Error(`Signed business API order failed: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { data: Order }).data;
    },
    async apiSnapshot(options: { orderId?: string } = {}) {
      activity.flush();
      const orderIds = services.database.read(db => options.orderId ? [options.orderId] : db.prepare("SELECT order_id FROM payment_orders ORDER BY created_at,order_id").all().map(row => String(row.order_id)));
      const orderDetails = await Promise.all(orderIds.map(id => api<{ data: AdminOrderDetail }>(`/api/admin/v1/orders/${id}`).then(value => value.data)));
      const deliveries = (await Promise.all(orderIds.map(id => api<{ data: OrderWebhookDeliveryDetail[] }>(`/api/admin/v1/orders/${id}/notifications/deliveries?limit=100`).then(value => value.data)))).flat();
      const exceptionIds = services.database.read(db => db.prepare("SELECT exception_id FROM financial_exceptions WHERE (? IS NULL OR order_id=?) ORDER BY created_at").all(options.orderId ?? null, options.orderId ?? null).map(row => String(row.exception_id)));
      const exceptions = await Promise.all(exceptionIds.map(id => api<{ data: FinancialException }>(`/api/admin/v1/reconciliation/exceptions/${id}`).then(value => value.data)));
      const audit: AuditEventDetail[] = [];
      let cursor: string | null = null;
      do {
        const page: AuditEventPage = await api("/api/admin/v1/audit-events?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
        for (const event of page.data) {
          const detail = (await api<{ data: AuditEventDetail }>(`/api/admin/v1/audit-events/${event.source}/${event.event_id}`)).data;
          if (!options.orderId || JSON.stringify(detail).includes(options.orderId) || deliveries.some(item => detail.subject_id === item.delivery.delivery_id)) audit.push(detail);
        }
        cursor = page.page.next_cursor;
      } while (cursor);
      return { now: now(), accounts: (await api<{ data: AlipayAccountView[] }>("/api/admin/v1/alipay-accounts")).data,
        sites: (await api<{ data: Site[] }>("/api/admin/v1/sites")).data, orders: orderDetails, deliveries,
        attempts: deliveries.flatMap(item => item.attempts), matches: orderDetails.flatMap(order => order.reconciliation.matches), exceptions,
        audit, auditIds: audit.map(event => event.event_id), receiverCalls: receiverCalls.filter(call => !options.orderId || call.orderId === options.orderId) };
    },
    close,
  };
  } catch (error) { await close(); throw error; }
}

export type BusinessFlowFixture = Awaited<ReturnType<typeof createBusinessFlowFixture>>;
