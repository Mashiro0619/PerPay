import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { AlipayLedgerProvider } from "../src/infrastructure/alipay/provider.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

it("blocks readiness and new payments until an actual provider scan succeeds", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-first-collection-"));
  const services = await createConfiguredHttpServices({
    directory, apiSecret: randomBytes(32).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/first-scan-test",
  });
  const ledger = new LedgerStore(services.database);
  const reconciliation = new ReconciliationStore(services.database);
  const webhooks = new WebhookStore(services.database);
  let now = ledger.activeProviderIdentity()!.activatedAt;
  const provider = context.mock.method(AlipayLedgerProvider.prototype, "queryPage", async (input: Parameters<AlipayLedgerProvider["queryPage"]>[0]) => ({
    pageNo: 1, pageSize: input.pageSize, totalSize: 0, hasMore: false, details: [], traceId: "first-scan-test",
    rawResponse: { status: 200, headers: {}, body: "{\"total_size\":0}", traceId: "first-scan-test", signatureVerified: true },
  }));
  const runtime = new RuntimeController({ database: services.database, orders: services.orders, ledger, reconciliation, webhooks, clock: () => now });
  try {
    await runtime.start(services.settings.snapshot());
    await runtime.triggerReconciliation("first-scan-test");
    await new Promise<void>((done) => setImmediate(done));
    const app = createApp({
      ...services, ledger, reconciliation, webhookStore: webhooks, startedAt: new Date(now), clock: () => now,
      runtimeStatus: () => runtime.status(), ledgerHealth: () => runtime.ledgerHealth(),
      reconciliationHealth: () => runtime.reconciliationHealth(), webhookHealth: () => runtime.webhookHealth(),
    });
    assert.equal(provider.mock.callCount(), 0);
    assert.equal(runtime.ledgerHealth().lastSuccessAt, null);
    assert.equal((await app.request("/readyz")).status, 503);
    const login = await app.request("/api/admin/v1/session/login", {
      method: "POST", headers: { origin: services.config.publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
    });
    const authentication = await login.json() as { data: { csrf_token: string } };
    const headers = {
      origin: services.config.publicOrigin, "content-type": "application/json",
      cookie: login.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "),
      "x-csrf-token": authentication.data.csrf_token,
    };
    const create = () => app.request("/api/admin/v1/test-payments", {
      method: "POST", headers, body: JSON.stringify({ amount_cents: 1, test_payment_id: randomUUID() }),
    });
    assert.equal((await create()).status, 503);
    assert.equal(provider.mock.callCount(), 0);
    now += 30_000;
    await runtime.beginPaymentTransition();
    await runtime.apply(services.settings.snapshot());
    for (let attempt = 0; attempt < 50 && runtime.ledgerHealth().lastSuccessAt === null; attempt++) {
      await new Promise<void>((done) => setImmediate(done));
    }
    await runtime.triggerReconciliation("after-first-scan");
    assert.ok(provider.mock.callCount() > 0);
    assert.equal(runtime.ledgerHealth().lastSuccessAt, now);
    assert.equal((await app.request("/readyz")).status, 200);
    assert.equal((await create()).status, 201);
  } finally {
    await runtime.stop();
    services.database.close();
    assert.equal(resolve(directory, ".."), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
