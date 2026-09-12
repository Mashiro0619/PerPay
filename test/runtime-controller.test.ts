import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { RuntimeController } from "../src/runtime/controller.ts";
import { parseProviderKeys, type RuntimeSettingsSnapshot } from "../src/settings/model.ts";
import { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
import { ReconciliationScheduler } from "../src/reconciliation/scheduler.ts";

const unconfiguredSettings: RuntimeSettingsSnapshot = Object.freeze({
  revision: 0,
  paymentRevision: 0,
  updatedAt: 0,
  collection: null,
  provider: null,
  apiSecret: null,
  apiSecretFingerprint: null,
  webhook: Object.freeze({
    enabled: false,
    allowedOrigin: null,
    secret: null,
    signingKeyFingerprint: null,
    timeoutMilliseconds: 5_000,
    maximumAttempts: 12,
    retryBaseMilliseconds: 5_000,
    retryMaximumMilliseconds: 3_600_000,
  }),
  advanced: Object.freeze({
    checkoutKeyRotationDays: 90,
    checkoutTerminalObservationSeconds: 86_400,
  }),
  activeProviderAccountKey: null,
});

describe("runtime settings controller", () => {
  it("refreshes cadence before waiting for order reconciliation and replaces workers on timing updates", async (t) => {
    const applicationKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const platformKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = parseProviderKeys({
      environment: "PRODUCTION", appId: "test-app",
      privateKey: applicationKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKey: platformKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
      timeoutMilliseconds: 8_000, scanIntervalMilliseconds: 30_000, activeScanIntervalMilliseconds: 5_000,
      safetyLagMilliseconds: 10_000, maximumSuccessAgeMilliseconds: 120_000,
    });
    const snapshot: RuntimeSettingsSnapshot = {
      ...unconfiguredSettings, revision: 1, paymentRevision: 1, provider,
      collection: { codePayload: "https://qr.alipay.com/runtime-cadence", orderTtlSeconds: 300, amountOffsetMaximumCents: 99 },
      apiSecret: "a".repeat(43), activeProviderAccountKey: "primary",
    };
    const started: LedgerIngestScheduler[] = [];
    const events: string[] = [];
    let finishReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => { finishReconciliation = resolve; });
    // Keep this wiring test offline; concrete timer and database policies have separate tests.
    t.mock.method(LedgerIngestScheduler.prototype, "start", function (this: LedgerIngestScheduler) {
      started.push(this);
    });
    t.mock.method(LedgerIngestScheduler.prototype, "refreshSchedule", function (this: LedgerIngestScheduler) {
      events.push("refresh:" + started.indexOf(this));
    });
    t.mock.method(ReconciliationScheduler.prototype, "start", async () => {});
    t.mock.method(ReconciliationScheduler.prototype, "triggerOrder", () => {
      events.push("reconcile");
      return reconciliation;
    });
    const runtime = new RuntimeController({
      database: {} as never, orders: { initialize() {} } as never,
      ledger: { activeProviderIdentity: () => ({ providerAccountKey: "primary", activatedAt: 1 }) } as never,
      reconciliation: {} as never, webhooks: {} as never,
    });
    try {
      await runtime.start(snapshot);
      const triggered = runtime.triggerOrder("11111111-1111-4111-8111-111111111111");
      assert.deepEqual(events, ["refresh:0", "reconcile"]);
      finishReconciliation();
      await triggered;
      await runtime.apply({
        ...snapshot, revision: 2, paymentRevision: 2,
        provider: { ...provider, scanIntervalMilliseconds: 60_000, activeScanIntervalMilliseconds: 10_000 },
      });
      assert.equal(started.length, 2);
      assert.equal(started[0]?.health().state, "stopped");
      assert.equal(runtime.status().scanIntervalMilliseconds, 60_000);
      await runtime.triggerOrder("11111111-1111-4111-8111-111111111111");
      assert.deepEqual(events.slice(-2), ["refresh:1", "reconcile"]);
    } finally {
      finishReconciliation();
      await runtime.stop();
    }
  });

  it("pauses every scheduler before a payment configuration transaction proceeds", async () => {
    const runtime = new RuntimeController({
      database: {} as never,
      orders: { initialize() {} } as never,
      ledger: {} as never,
      reconciliation: {} as never,
      webhooks: { counts: () => ({ pending: 0, dead: 0 }) } as never,
    });

    await runtime.start(unconfiguredSettings);
    await runtime.beginPaymentTransition();
    assert.equal(runtime.status().transitioning, true);
    assert.equal(runtime.ledgerHealth().enabled, false);
    assert.equal(runtime.reconciliationHealth().enabled, false);

    await runtime.apply(unconfiguredSettings);
    assert.equal(runtime.status().transitioning, false);
    await runtime.stop();
  });

  it("keeps payment entry closed when replacement fails", async () => {
    const runtime = new RuntimeController({
      database: {} as never,
      orders: {
        initialize() {
          throw new Error("injected order initialization failure");
        },
      } as never,
      ledger: {} as never,
      reconciliation: {} as never,
      webhooks: {} as never,
    });

    await assert.rejects(
      runtime.start(unconfiguredSettings),
      /injected order initialization failure/,
    );
    assert.equal(runtime.status().transitioning, true);
    await runtime.stop();
  });

  it("does not replace payment workers for a runtime-irrelevant revision change", async () => {
    let initializations = 0;
    const runtime = new RuntimeController({
      database: {} as never,
      orders: {
        initialize() {
          initializations += 1;
        },
      } as never,
      ledger: {} as never,
      reconciliation: {} as never,
      webhooks: { counts: () => ({ pending: 0, dead: 0 }) } as never,
    });

    await runtime.start(unconfiguredSettings);
    assert.equal(initializations, 1);
    await runtime.apply(Object.freeze({
      ...unconfiguredSettings,
      revision: 1,
      advanced: Object.freeze({
        checkoutKeyRotationDays: 180,
        checkoutTerminalObservationSeconds: 172_800,
      }),
    }));
    assert.equal(initializations, 1);
    assert.equal(runtime.status().transitioning, false);
    await runtime.stop();
  });
});
