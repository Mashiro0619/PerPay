import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import { IdentityService } from "../src/identity/service.ts";
import { AlipayLedgerProvider } from "../src/infrastructure/alipay/provider.ts";
import type { AccountLogPage } from "../src/infrastructure/alipay/types.ts";
import { parseOccurredAt } from "../src/ledger/model.ts";
import { LedgerIngestService } from "../src/ledger/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { OrderService } from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { createConfiguredLegacyHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

it("keeps readiness and both payment entry points closed until a restarted scanner catches up", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-catchup-http-"));
  const historicalNow = Date.now() - 30 * 86_400_000;
  const apiSecret = randomBytes(32).toString("base64url");
  let database: AppDatabase | undefined;
  let runtime: RuntimeController | undefined;
  let resumeScans!: () => void;
  const scansPaused = new Promise<void>((done) => { resumeScans = done; });

  // Create genuine historical state with matching application and SQLite clocks.
  // Close these connections before restoring the real clocks and reopening.
  const clock = context.mock.method(Date, "now", () => historicalNow);
  const originalExec = DatabaseSync.prototype.exec;
  const historicalConnections = new WeakSet<DatabaseSync>();
  const sqliteClock = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (!historicalConnections.has(this)) {
      this.function("unixepoch", (_modifier) => historicalNow / 1_000);
      historicalConnections.add(this);
    }
    return originalExec.call(this, sql);
  });
  const emptyPage = async (input: Parameters<AlipayLedgerProvider["queryPage"]>[0]): Promise<AccountLogPage> => ({
    pageNo: 1, pageSize: input.pageSize, totalSize: 0, hasMore: false, details: [], traceId: "catchup-http-test",
    rawResponse: { status: 200, headers: {}, body: "{\"total_size\":0}", traceId: "catchup-http-test", signatureVerified: true },
  });
  try {
    const historical = await createConfiguredLegacyHttpServices({
      directory, apiSecret, collectionCodePayload: "https://qr.alipay.com/catchup-http-test",
    });
    database = historical.database;
    const historicalLedger = new LedgerStore(database);
    const binding = historicalLedger.activeProviderIdentity()!;
    const scanner = new LedgerIngestService({
      provider: { queryPage: emptyPage }, store: historicalLedger,
      providerAccountKey: binding.providerAccountKey, pageSize: 2_000,
      initialWindowStartMilliseconds: binding.activatedAt,
      clock: () => historicalNow + 30_000,
    });
    assert.equal((await scanner.run("before-downtime")).status, "COMPLETED");
    const previousEnd = historicalLedger.getCursor(binding.providerAccountKey)!.windowEnd;
    database.close();
    clock.mock.restore();
    sqliteClock.mock.restore();

    database = await AppDatabase.open(historical.config.databasePath, { masterKey: historical.config.masterKey });
    const settingsStore = new RuntimeSettingsStore(database, historical.config.masterKey);
    const settings = new RuntimeSettingsService({ store: settingsStore });
    settings.initialize();
    const sites = settingsStore.siteStore()!;
    const identity = new IdentityService(database);
    await identity.initialize();
    const orders = new OrderService(database, () => settings.instanceSnapshot(), undefined, sites, "default");
    const ledger = new LedgerStore(database);
    const reconciliation = new ReconciliationStore(database);
    const webhooks = new WebhookStore(database);
    const now = Date.now();
    let requests = 0;
    context.mock.method(AlipayLedgerProvider.prototype, "queryPage", async (input: Parameters<AlipayLedgerProvider["queryPage"]>[0]) => {
      if (++requests > 1) await scansPaused;
      return emptyPage(input);
    });
    runtime = new RuntimeController({ database, orders, ledger, reconciliation, webhooks, clock: () => now });
    const controller = runtime;
    const app = createApp({
      config: historical.config, database, identity, settings, orders, sites,
      ledger, reconciliation, webhookStore: webhooks, startedAt: new Date(now), clock: () => now,
      runtimeStatus: () => controller.status(), ledgerHealth: () => controller.ledgerHealth(),
      reconciliationHealth: () => controller.reconciliationHealth(), webhookHealth: () => controller.webhookHealth(),
    });
    const login = await app.request("/api/admin/v1/session/login", {
      method: "POST", headers: { origin: historical.config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const authentication = await login.json() as { data: { csrf_token: string } };
    const adminHeaders = {
      origin: historical.config.publicOrigin, "content-type": "application/json",
      cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; "),
      "x-csrf-token": authentication.data.csrf_token,
    };
    const createTestPayment = () => app.request("/api/admin/v1/test-payments", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ amount_cents: 1, api_client_id: "default", test_payment_id: randomUUID() }),
    });
    const createApiPayment = () => {
      const path = "/api/v1/orders";
      const body = Buffer.from(JSON.stringify({
        amount_cents: 1_000, product_name: "Catch-up test", merchant_order_no: randomUUID(), idempotency_key: randomUUID(),
      }));
      const signed = signApiRequest({
        clientId: "default", secret: Buffer.from(apiSecret, "base64url"), method: "POST", target: path, body,
        timestamp: String(Math.floor(now / 1_000)), nonce: randomBytes(32).toString("base64url"),
      });
      return app.request(path, { method: "POST", body, headers: {
        "content-type": "application/json", "x-perpay-client-id": signed.clientId,
        "x-perpay-signature-version": signed.version, "x-perpay-timestamp": signed.timestamp,
        "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature,
      } });
    };

    await runtime.start(settings.instanceSnapshot());
    await waitUntil(() => ledger.getCursor(binding.providerAccountKey)?.windowEnd !== previousEnd);
    await runtime.triggerReconciliation("after-first-historical-window");
    const cursor = ledger.getCursor(binding.providerAccountKey)!;
    assert.ok(now - parseOccurredAt(cursor.windowEnd) > 28 * 86_400_000);
    const notReady = await app.request("/readyz");
    assert.equal(notReady.status, 503, "a completed historical window cannot reopen payment admission");
    assert.deepEqual(await notReady.json(), { status: "not_ready", code: "reconciliation_not_ready" });
    assert.equal(runtime.ledgerHealth().lastSuccessAt, null);
    for (const response of [await createTestPayment(), await createApiPayment()]) {
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "reconciliation_not_ready");
    }
    assert.equal(database.read(connection => Number(connection.prepare("SELECT COUNT(*) AS count FROM payment_orders").get()!.count)), 0);

    resumeScans();
    await waitUntil(() => controller.ledgerHealth().lastSuccessAt !== null);
    await runtime.triggerReconciliation("after-current-tail");
    const currentCursor = ledger.getCursor(binding.providerAccountKey)!;
    assert.ok(parseOccurredAt(currentCursor.windowEnd) >= Math.floor((now - 10_000) / 1_000) * 1_000);
    assert.ok(requests >= 30, "all bounded historical windows must be scanned");
    assert.equal(runtime.ledgerHealth().lastSuccessAt, now);
    assert.equal((await app.request("/readyz")).status, 200);
    assert.equal((await createTestPayment()).status, 201);
    assert.equal((await createApiPayment()).status, 201);
    assert.equal(database.integrityCheck().ok, true);
  } finally {
    clock.mock.restore();
    sqliteClock.mock.restore();
    resumeScans();
    await runtime?.stop();
    database?.close();
    assert.equal(resolve(directory, ".."), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt++) {
    await new Promise<void>(done => setTimeout(done, 5));
  }
  assert.ok(predicate(), "background scan did not reach the expected state");
}
