import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { AlipayAccountStore, AlipayAccountService, AlipayAccountError, type AlipayAccountView } from "../src/alipay-accounts/index.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { OrderService, OrderError } from "../src/orders/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { collectionCandidates } from "../src/orders/account-allocation.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { readAdminLedgerDetail, readAdminLedgerPage } from "../src/ledger/admin-query.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import { ReconciliationScheduler } from "../src/reconciliation/scheduler.ts";
import { WebhookScheduler } from "../src/notifications/scheduler.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { createApp } from "../src/http/app.ts";
import { loadConfig } from "../src/config.ts";
import { IdentityService } from "../src/identity/service.ts";
import type { SiteCollection } from "../src/sites/model.ts";
import { keyMaster, privatePem, platformPem, keyAudit } from "./application-key-fixture.ts";

const BASE = 2_000_000_000_000;
const code = (name: string) => "https://qr.alipay.com/" + name;
const request = (name: string, amount = 2000) => createOrderRequestSchema.parse({
  merchant_order_no: name, idempotency_key: name, amount_cents: amount, product_name: "多账号收款测试",
});
const fixed = (id: string): SiteCollection => ({ mode: "FIXED", accounts: [{ account_id: id, weight: 1 }] });
const edit = (account: AlipayAccountView, patch: Record<string, unknown> = {}) => ({
  revision: account.revision, name: account.name, enabled: account.enabled, code_payload: account.code_payload,
  app_id: account.app_id, environment: account.environment, ...patch,
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-multi-account-"));
  const database = await AppDatabase.open(join(directory, "state.sqlite3"), { masterKey: keyMaster });
  const settings = new RuntimeSettingsStore(database, keyMaster);
  settings.initialize();
  const store = new AlipayAccountStore(database, keyMaster);
  const accounts = new AlipayAccountService({ store, verifyProviderApplicationKey: async () => undefined });
  const first = await accounts.create({ name: "主账号", app_id: "multi-account-a", private_key: privatePem, platform_public_key: platformPem, code_payload: code("account-a") }, keyAudit());
  const second = await accounts.create({ name: "备用账号", app_id: "multi-account-b", private_key: privatePem, platform_public_key: platformPem, code_payload: code("account-b") }, keyAudit());
  const sites = settings.siteStore()!;
  const unavailable = new Set<string>();
  let time = BASE;
  const orders = new OrderService(database, () => settings.instanceSnapshot(), () => time, sites, undefined, {
    accounts: () => store.snapshots(), available: id => !unavailable.has(id), random: () => 0,
  });
  const site = (name: string, collection: SiteCollection, offsets = 1) => {
    const defaults = sites.defaults().policy;
    return sites.create({ operation_id: randomUUID(), configuration: {
      name, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, collection,
      policy: { ...defaults, orders: { ...defaults.orders, order_ttl_seconds: 300, amount_offset_maximum_cents: offsets } },
    } }, keyAudit(), time);
  };
  return { database, settings, store, accounts, first, second, sites, orders, unavailable, site, directory,
    clock: () => time, advance: (milliseconds: number) => { time += milliseconds; },
    close() { database.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()))); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe("multi-account collection", () => {
  it("shares amount capacity between sites of one account and isolates different accounts", async () => {
    const f = await fixture();
    try {
      const a = f.site("A", fixed(f.first.id), 2);
      const b = f.site("B", fixed(f.second.id), 2);
      const c = f.site("C", fixed(f.first.id), 2);
      const first = f.orders.forSite(a.clientId).create(request("same-amount-a"));
      const second = f.orders.forSite(b.clientId).create(request("same-amount-b"));
      const shared = f.orders.forSite(c.clientId).create(request("same-amount-c"));
      assert.equal(first.order.payableAmountCents, 2001);
      assert.equal(second.order.payableAmountCents, 2001);
      assert.equal(shared.order.payableAmountCents, 2002);
      assert.equal(f.orders.adminGet(first.order.orderId).alipayAccountId, f.first.id);
      assert.equal(f.orders.adminGet(second.order.orderId).alipayAccountId, f.second.id);
      assert.equal(f.orders.adminPage({ alipayAccountId: f.second.id, checkoutStatus: null, paymentStatus: null }, null, 20).orders.length, 1);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });

  it("uses weighted draws and skips paused, incomplete, or unhealthy selected accounts", async () => {
    const f = await fixture();
    try {
      const [a, b] = f.store.snapshots();
      const rule: SiteCollection = { mode: "WEIGHTED", accounts: [{ account_id: a!.id, weight: 1 }, { account_id: b!.id, weight: 3 }] };
      assert.equal(collectionCandidates(rule, [a!, b!], () => true, () => 0.249)[0]!.id, a!.id);
      assert.equal(collectionCandidates(rule, [a!, b!], () => true, () => 0.25)[0]!.id, b!.id);
      assert.deepEqual(collectionCandidates(rule, [a!, b!], id => id !== a!.id).map(account => account.id), [b!.id]);
      assert.deepEqual(collectionCandidates(rule, [{ ...a!, enabled: false }, b!], () => true).map(account => account.id), [b!.id]);
      assert.deepEqual(collectionCandidates(rule, [{ ...a!, configured: false }, b!], () => true).map(account => account.id), [b!.id]);
      const uniform = { ...rule, mode: "RANDOM" as const };
      assert.equal(collectionCandidates(uniform, [a!, b!], () => true, () => 0.49)[0]!.id, a!.id);
      assert.equal(collectionCandidates(uniform, [a!, b!], () => true, () => 0.5)[0]!.id, b!.id);
    } finally { f.close(); }
  });

  it("tries the remaining random candidates after capacity fills, while fixed mode stays fixed", async () => {
    const f = await fixture();
    try {
      const a = f.site("占用主账号", fixed(f.first.id));
      f.orders.forSite(a.clientId).create(request("fill-first"));
      const pool = f.site("随机网站", { mode: "RANDOM", accounts: [{ account_id: f.first.id, weight: 1 }, { account_id: f.second.id, weight: 1 }] });
      const result = f.orders.forSite(pool.clientId).create(request("fallback"));
      assert.equal(f.orders.adminGet(result.order.orderId).alipayAccountId, f.second.id);
      assert.throws(() => f.orders.forSite(a.clientId).create(request("fixed-full")), error => error instanceof OrderError && error.code === "amount_slots_exhausted");
      f.unavailable.add(f.first.id); f.unavailable.add(f.second.id);
      assert.equal(f.orders.forSite(pool.clientId).create(request("fallback")).order.orderId, result.order.orderId);
      assert.throws(() => f.orders.forSite(pool.clientId).create(request("unavailable")), error => error instanceof OrderError && error.code === "alipay_accounts_unavailable");
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });

  it("pins account, QR code, and amount across edits and preserves cooldown within the account", async () => {
    const f = await fixture();
    try {
      let site = f.site("二维码网站", fixed(f.first.id));
      const scoped = f.orders.forSite(site.clientId);
      const original = scoped.create(request("qr-before"));
      await f.accounts.update(f.first.id, edit(f.first, { code_payload: code("changed"), enabled: false }), keyAudit());
      site = f.sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, collection: fixed(f.second.id) } }, keyAudit(), f.clock());
      const used = f.accounts.get(f.first.id);
      assert.equal(used.sites.length, 0);
      assert.equal(used.deletable, false);
      await assert.rejects(f.accounts.remove(used.id, { revision: used.revision }, keyAudit()),
        error => error instanceof AlipayAccountError && error.code === "alipay_account_in_use");
      const repeated = scoped.create(request("qr-before"));
      assert.equal(repeated.created, false);
      assert.equal(repeated.order.orderId, original.order.orderId);
      assert.equal(f.orders.publicCheckout(original.order.checkoutToken).paymentInstructions!.collectionCodePayload, code("account-a"));
      const next = scoped.create(request("qr-after"));
      assert.equal(f.orders.adminGet(next.order.orderId).alipayAccountId, f.second.id);
      assert.equal(f.orders.publicCheckout(next.order.checkoutToken).paymentInstructions!.collectionCodePayload, code("account-b"));
      scoped.close(next.order.orderId);
      assert.throws(() => scoped.create(request("cooldown")), error => error instanceof OrderError && error.code === "amount_slots_exhausted");
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });

  it("keeps ingestion and settlement account-scoped after pausing and separates equal external ledger IDs", async () => {
    const f = await fixture();
    try {
      const a = f.site("待收主账号", fixed(f.first.id));
      const b = f.site("待收备用", fixed(f.second.id));
      const orderA = f.orders.forSite(a.clientId).create(request("paid-a"));
      const orderB = f.orders.forSite(b.clientId).create(request("paid-b"));
      await f.accounts.update(f.first.id, edit(f.first, { enabled: false }), keyAudit());
      const ledger = new LedgerStore(f.database);
      const reconciliation = new ReconciliationStore(f.database);
      f.advance(10_000);
      const entryA = credit(ledger, f.store.snapshot(f.first.id).providerAccountKey!, "same-external-id", 2001, f.clock());
      assert.equal(reconciliation.reconcileEntry(entryA, f.clock() + 1000).kind, "auto_settled");
      assert.equal(f.orders.adminGet(orderA.order.orderId).payment.status, "CONFIRMED");
      assert.equal(f.orders.adminGet(orderB.order.orderId).payment.status, "UNPAID");
      const entryB = credit(ledger, f.store.snapshot(f.second.id).providerAccountKey!, "same-external-id", 2001, f.clock());
      assert.equal(reconciliation.reconcileEntry(entryB, f.clock() + 1000).kind, "auto_settled");
      const page = readAdminLedgerPage(f.database, { environment: null, limit: 1 });
      assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
      const next = readAdminLedgerPage(f.database, { environment: null, limit: 1, cursor: page.next_cursor });
      assert.equal(next.items.length, 1); assert.equal(next.next_cursor, null);
      assert.notEqual(page.items[0]!.alipay_account_id, next.items[0]!.alipay_account_id);
      assert.equal(page.items[0]!.external_event_id, "same-external-id");
      assert.equal(page.items[0]!.source_record_count, 1);
      const filtered = readAdminLedgerPage(f.database, { environment: null, alipayAccountId: f.first.id, q: "same-external", sortBy: "amount_cents" });
      assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0]!.alipay_account_id, f.first.id);
      assert.equal(readAdminLedgerDetail(f.database, "PRODUCTION", entryA, true)!.sources.length, 1);
      const sandbox = await f.accounts.create({ name: "沙箱账号", app_id: "multi-account-a", environment: "SANDBOX",
        private_key: privatePem, platform_public_key: platformPem, code_payload: code("sandbox") }, keyAudit());
      credit(ledger, f.store.snapshot(sandbox.id).providerAccountKey!, "same-external-id", 2001, f.clock());
      assert.equal(f.accounts.get(sandbox.id).deletable, false);
      await assert.rejects(f.accounts.remove(sandbox.id, { revision: sandbox.revision }, keyAudit()),
        error => error instanceof AlipayAccountError && error.code === "alipay_account_in_use");
      const environments = readAdminLedgerPage(f.database, { environment: null });
      assert.equal(environments.items.length, 3);
      assert.equal(environments.items.find(item => item.alipay_account_id === sandbox.id)!.environment, "SANDBOX");
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });

  it("replaces only the edited account worker and directs checkout checks to that order's account", async t => {
    const f = await fixture();
    const started: LedgerIngestScheduler[] = [];
    const triggered: LedgerIngestScheduler[] = [];
    t.mock.method(LedgerIngestScheduler.prototype, "start", function(this: LedgerIngestScheduler) { started.push(this); });
    t.mock.method(LedgerIngestScheduler.prototype, "health", () => ({ state: "healthy", inFlight: false, lastAttemptAt: BASE, lastSuccessAt: BASE, lastErrorCode: null, consecutiveFailures: 0 }));
    t.mock.method(LedgerIngestScheduler.prototype, "trigger", async function(this: LedgerIngestScheduler) { triggered.push(this); return { status: "COMPLETED", normalCompleted: true }; });
    t.mock.method(ReconciliationScheduler.prototype, "start", async () => {});
    t.mock.method(ReconciliationScheduler.prototype, "verifyOrder", async () => {});
    t.mock.method(WebhookScheduler.prototype, "start", async () => {});
    const runtime = new RuntimeController({ database: f.database, orders: f.orders, ledger: new LedgerStore(f.database),
      reconciliation: new ReconciliationStore(f.database), webhooks: new WebhookStore(f.database), sites: f.sites,
      accounts: () => f.store.snapshots(), clock: f.clock });
    try {
      const site = f.site("查账网站", fixed(f.second.id));
      const order = f.orders.forSite(site.clientId).create(request("check-account-b"));
      await runtime.start(f.settings.instanceSnapshot());
      assert.equal(started.length, 2);
      assert.equal(runtime.accountHealth(f.second.id).collectionReady, true);
      assert.ok(runtime.status().maximumSuccessAgeMilliseconds);
      await runtime.beginAccountTransition(f.first.id);
      assert.equal(runtime.accountHealth(f.second.id).collectionReady, true);
      await f.accounts.update(f.first.id, edit(f.first, { enabled: false }), keyAudit());
      await runtime.applyAccounts(f.first.id);
      assert.equal(started.length, 3);
      assert.equal(runtime.accountHealth(f.first.id).collectionReady, false);
      assert.equal(runtime.ledgerManualScan(f.first.id).available, true);
      assert.equal(runtime.ledgerManualScan().available, false);
      runtime.requestCheckoutVerification(order.order.orderId);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(triggered[0], started[1]);
      assert.equal(runtime.checkoutVerification(order.order.orderId)!.state, "COMPLETED");
      runtime.requestLedgerScan(f.first.id);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(triggered.at(-1), started[2]);
      await runtime.beginAccountTransition(f.first.id);
      await runtime.beginAccountTransition(f.second.id);
      await runtime.applyAccounts(f.first.id);
      assert.equal(started.length, 4);
      assert.equal(runtime.accountHealth(f.second.id).state, "transitioning");
      assert.equal(runtime.ledgerManualScan(f.second.id).available, false);
      await runtime.applyAccounts(f.second.id);
      assert.equal(started.length, 5);
      const pause = runtime.beginPaymentTransition();
      assert.equal(runtime.accountHealth(f.second.id).collectionReady, false);
      await pause;
      await runtime.applyAccounts(f.first.id);
      assert.equal(started.length, 5);
      await runtime.apply(f.settings.instanceSnapshot());
      assert.equal(started.length, 7);
      assert.equal(runtime.accountHealth(f.second.id).collectionReady, true);
    } finally { await runtime.stop(); f.close(); }
  });
});

describe("multi-account HTTP payment readiness", () => {
  it("returns the selected test-payment account and keeps old checkout, QR, and checks available when every account is paused", async () => {
    const f = await httpFixture();
    try {
      const site = f.site("备用账号测试", fixed(f.second.id));
      const input = { api_client_id: site.clientId, amount_cents: 2000, test_payment_id: randomUUID() };
      f.unavailable.add(f.first.id);
      const created = await f.admin("test-payments", "POST", input);
      assert.equal(created.status, 201);
      const data = (await created.json() as { data: { order_id: string; alipay_account_id: string; alipay_account_name: string; checkout: { token: string } } }).data;
      assert.equal(data.alipay_account_id, f.second.id);
      assert.equal(data.alipay_account_name, f.second.name);
      for (const account of f.accounts.list()) await f.accounts.update(account.id, edit(account, { enabled: false }), keyAudit());
      f.unavailable.clear();
      const replay = await f.admin("test-payments", "POST", input);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as { data: { order_id: string } }).data.order_id, data.order_id);
      const token = data.checkout.token;
      assert.equal((await f.app.request(`/api/public/v1/checkouts/${token}`)).status, 200);
      assert.equal((await f.app.request(`/api/public/v1/checkouts/${token}/qr.svg`)).status, 200);
      const check = await f.app.request(`/api/public/v1/checkouts/${token}/check`, { method: "POST", headers: { origin: f.config.publicOrigin, "content-type": "application/json" }, body: "{}" });
      assert.equal(check.status, 200);
      assert.equal(f.checked.at(-1), data.order_id);
      const next = await f.admin("test-payments", "POST", { ...input, test_payment_id: randomUUID() });
      assert.equal(next.status, 503);
      assert.equal((await next.json() as { error: { code: string } }).error.code, "alipay_accounts_unavailable");
      const scan = await f.admin("system/ledger/scan", "POST", { alipay_account_id: f.second.id });
      assert.equal(scan.status, 202);
      assert.equal(f.scanned.at(-1), f.second.id);
      assert.equal((await f.admin("system/ledger/scan", "POST", {})).status, 503);
      const account = (await (await f.admin(`alipay-accounts/${f.second.id}`)).json() as { data: { manual_scan: { request: { id: string } } } }).data;
      assert.equal(account.manual_scan.request.id, (await scan.json() as { data: { id: string } }).data.id);
      f.unavailable.add(f.second.id);
      assert.equal((await f.app.request(`/api/public/v1/checkouts/${token}`)).status, 503);
    } finally { f.close(); }
  });

  it("lists and summarizes conflicts and unmatched income across all accounts with scope-bound pagination", async () => {
    const f = await httpFixture();
    try {
      const keys = [f.first, f.second].map(account => f.store.snapshot(account.id).providerAccountKey!);
      const ledger = new LedgerStore(f.database);
      const reconciliation = new ReconciliationStore(f.database);
      f.advance(10_000);
      for (const [index, key] of keys.entries()) {
        const entry = credit(ledger, key, `unmatched-${index}`, 9001, f.clock());
        assert.equal(reconciliation.reconcileEntry(entry, f.clock() + 1000).kind, "unmatched");
        isolatedIncome(ledger, key, `invalid-${index}`, f.clock());
      }
      for (const endpoint of ["ledger/conflicts", "reconciliation/exceptions"]) {
        const first = await f.admin(endpoint + "?limit=1");
        assert.equal(first.status, 200);
        const firstPage = await first.json() as IssuePageJson;
        assert.equal(firstPage.data.length, 1); assert.ok(firstPage.page.next_cursor);
        const second = await f.admin(endpoint + "?limit=1&cursor=" + encodeURIComponent(firstPage.page.next_cursor));
        assert.equal(second.status, 200);
        const secondPage = await second.json() as IssuePageJson;
        assert.equal(secondPage.data.length, 1); assert.equal(secondPage.page.next_cursor, null);
        assert.notEqual(firstPage.data[0]!.provider_account_key, secondPage.data[0]!.provider_account_key);
        const mismatch = await f.admin(endpoint + "?limit=1&provider_account_key=" + encodeURIComponent(keys[0]!) + "&cursor=" + encodeURIComponent(firstPage.page.next_cursor));
        assert.equal(mismatch.status, 422);
        assert.equal((await (await f.admin(endpoint + "?provider_account_key=" + encodeURIComponent(keys[0]!))).json() as IssuePageJson).data.length, 1);
      }
      const status = (await (await f.admin("system/status")).json() as { data: { ledger: { conflicts: SummaryJson }; reconciliation: { exceptions: SummaryJson } } }).data;
      assert.equal(status.ledger.conflicts.provider_account_key, null);
      assert.equal(status.ledger.conflicts.open, 2);
      assert.equal(status.reconciliation.exceptions.provider_account_key, null);
      assert.equal(status.reconciliation.exceptions.open, 2);
      const generations = (await (await f.admin("settings")).json() as { data: { provider_generations: unknown[] } }).data.provider_generations;
      assert.equal(generations.length, 2);
    } finally { f.close(); }
  });
});

async function httpFixture() {
  const f = await fixture();
  f.advance(Date.now() - f.clock());
  const config = loadConfig({ PERPAY_MASTER_KEY: Buffer.from(keyMaster).toString("hex"), PERPAY_PUBLIC_URL: "http://localhost:6190",
    PERPAY_DATA_DIR: join(f.directory, "data"), PERPAY_BACKUP_DIR: join(f.directory, "backups") });
  const identity = new IdentityService(f.database, f.clock);
  await identity.initialize(); await identity.setupAdmin("multi-account-secure-password");
  const session = await identity.login("multi-account-secure-password");
  const headers = { cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}`, "x-csrf-token": session.csrfToken, origin: config.publicOrigin, "content-type": "application/json" };
  const health = () => ({ state: "healthy" as const, enabled: true, inFlight: false, lastAttemptAt: f.clock(), lastSuccessAt: f.clock(), lastErrorCode: null, consecutiveFailures: 0 });
  const checked: string[] = [], scanned: string[] = [];
  const scans = new Map<string, { id: string; state: "COMPLETED"; requested_at: string; started_at: string; finished_at: string; next_attempt_at: null; outcome: "COMPLETED"; error_code: null; ingest_run_id: null }>();
  const { RuntimeSettingsService } = await import("../src/settings/service.ts");
  const settings = new RuntimeSettingsService({ store: f.settings, alipayAccounts: f.accounts });
  const app = createApp({ config, database: f.database, identity, settings, orders: f.orders, sites: f.sites, alipayAccounts: f.accounts,
    ledger: new LedgerStore(f.database), reconciliation: new ReconciliationStore(f.database), startedAt: new Date(f.clock()), clock: f.clock,
    runtimeStatus: () => ({ configured: f.store.snapshots().some(account => account.enabled && account.configured), transitioning: false,
      paymentRevision: f.settings.instanceSnapshot().paymentRevision, activeProviderAccountKey: null, scanIntervalMilliseconds: 10_000, maximumSuccessAgeMilliseconds: 60_000 }),
    accountHealth: id => ({ state: f.unavailable.has(id) ? "degraded" : "healthy", lastSuccessAt: f.clock(), lastErrorCode: f.unavailable.has(id) ? "offline" : null,
      collectionReady: !f.unavailable.has(id) && f.store.snapshot(id).enabled }),
    ledgerHealth: health, reconciliationHealth: () => ({ ...health(), pendingOrders: 0, continuationPending: false }),
    ledgerManualScan: id => ({ available: !!id, unavailable_reason: id ? null : "not_configured", request: id ? scans.get(id) ?? null : null }),
    requestLedgerScan: id => { if (!id) throw new Error("select account"); scanned.push(id); const now = new Date(f.clock()).toISOString(); const scan = { id: randomUUID(), state: "COMPLETED" as const, requested_at: now, started_at: now, finished_at: now, next_attempt_at: null, outcome: "COMPLETED" as const, error_code: null, ingest_run_id: null }; scans.set(id, scan); return scan; },
    requestCheckoutVerification: id => { checked.push(id); return { id: randomUUID(), state: "COMPLETED", requested_at: new Date(f.clock()).toISOString(), retry_after_seconds: 0 }; },
  });
  const admin = (path: string, method = "GET", body?: unknown) => app.request("/api/admin/v1/" + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ...f, config, identity, app, admin, checked, scanned };
}

interface IssuePageJson { data: { provider_account_key: string }[]; page: { next_cursor: string | null } }
interface SummaryJson { provider_account_key: string | null; open: number }

function isolatedIncome(ledger: LedgerStore, providerAccountKey: string, externalEventId: string, at: number): void {
  const timestamp = (value: number) => new Date(value + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const run = ledger.startIngestRun({ providerAccountKey, pageSize: 100, start: timestamp(at - 60_000), end: timestamp(at + 60_000), now: at });
  const detail = { accountLogId: externalEventId, occurredAt: timestamp(at), amount: "invalid", direction: "CREDIT",
    alipayOrderNo: null, merchantOrderNo: null, transMemo: null, otherAccount: null, raw: { account_log_id: externalEventId, trans_amount: "invalid", direction: "CREDIT", trans_dt: timestamp(at) } };
  ledger.recordPage({ ingestRunId: run.ingestRunId, page: { pageNo: 1, pageSize: 100, totalSize: 1, hasMore: false, details: [detail] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(detail), traceId: "multi-account-invalid", signatureVerified: true }, now: at });
}

function credit(ledger: LedgerStore, providerAccountKey: string, externalEventId: string, amount: number, at: number): string {
  const timestamp = (value: number) => new Date(value + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const run = ledger.startIngestRun({ providerAccountKey, pageSize: 100, start: timestamp(at - 60_000), end: timestamp(at + 60_000), now: at });
  const detail = { accountLogId: externalEventId, occurredAt: timestamp(at), amount: (amount / 100).toFixed(2), direction: "CREDIT",
    alipayOrderNo: null, merchantOrderNo: null, transMemo: null, otherAccount: null,
    raw: { account_log_id: externalEventId, trans_amount: (amount / 100).toFixed(2), direction: "CREDIT", trans_dt: timestamp(at) } };
  const result = ledger.recordPage({ ingestRunId: run.ingestRunId, page: { pageNo: 1, pageSize: 100, totalSize: 1, hasMore: false, details: [detail] },
    evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(detail), traceId: "multi-account-test", signatureVerified: true }, now: at });
  assert.notEqual(result.kind, "variant");
  if (result.kind === "variant") throw new Error("unexpected page variant");
  const normalized = result.normalized[0]!;
  assert.equal(normalized.kind, "created");
  if (normalized.kind !== "created") throw new Error("expected new ledger entry");
  return normalized.entry.ledgerEntryId;
}
