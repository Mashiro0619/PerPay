import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeController } from "../src/runtime/controller.ts";
import type { RuntimeSettingsSnapshot } from "../src/settings/model.ts";

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
