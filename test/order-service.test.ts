import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { IdentityService } from "../src/identity/service.ts";
import {
  COLLECTION_PROFILE_FINGERPRINT_VERSION,
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
  OrderError,
  OrderService,
} from "../src/orders/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";

describe("order service fingerprints", () => {
  it("keeps the versioned collection profile fingerprints stable", () => {
    assert.equal(COLLECTION_PROFILE_FINGERPRINT_VERSION, 1);
    assert.deepEqual(fingerprintCollectionCodeProfile("https://qr.example.test/profile-a"), {
      payloadFingerprint: "b1d6dcd20b3d44fabecddb945555e1c9280ba20d32397d0e526ae1a8812c2519",
      profileFingerprint: "ff9c5bea0f2c8cb18065804a8f3d53aa6671ef3fb1598b95627126e01c6e1b6d",
    });
  });

  it("keeps idempotency digests stable and scoped to the API client", () => {
    assert.equal(
      digestIdempotencyKey("default", "http-order-attempt-1"),
      "926a16c81169c3333e95b09fccd39354e1d5b9f1a7ab5aa58c6066ec7b923446",
    );
    assert.notEqual(
      digestIdempotencyKey("default", "http-order-attempt-1"),
      digestIdempotencyKey("other-client", "http-order-attempt-1"),
    );
  });

  it("removes payment instructions from an expired public checkout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-order-service-public-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "order-service-test-password",
      PERPAY_API_SECRET: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      PERPAY_COLLECTION_CODE_PAYLOAD: "https://qr.local.invalid/service-test",
      PERPAY_DATA_DIR: directory,
    });
    let now = Date.now();
    const database = await AppDatabase.open(config.databasePath);
    try {
      await new IdentityService(database, config).initialize();
      const orders = new OrderService(database, config, () => now);
      orders.initialize();
      const created = orders.create(
        "default",
        createOrderRequestSchema.parse({
          idempotency_key: "service-expiry-idempotency",
          merchant_order_no: "service-expiry-order",
          amount_cents: 2_000,
        }),
      );
      now += config.orderTtlSeconds * 1000 + 1_000;
      const publicCheckout = orders.publicCheckout(created.order.checkoutToken);
      assert.equal(publicCheckout.checkout.status, "EXPIRED");
      assert.equal(publicCheckout.paymentInstructions, null);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps an unsafe order clock to a retryable service error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-order-service-clock-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "order-service-clock-password",
      PERPAY_API_SECRET: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      PERPAY_COLLECTION_CODE_PAYLOAD: "https://qr.local.invalid/service-clock",
      PERPAY_DATA_DIR: directory,
    });
    let now = Date.now();
    const database = await AppDatabase.open(config.databasePath);
    try {
      await new IdentityService(database, config).initialize();
      const orders = new OrderService(database, config, () => now);
      orders.initialize();
      now += 24 * 60 * 60 * 1000;
      orders.create(
        "default",
        createOrderRequestSchema.parse({
          idempotency_key: "service-clock-first",
          merchant_order_no: "service-clock-first",
          amount_cents: 2_100,
        }),
      );
      now -= 24 * 60 * 60 * 1000;
      assert.throws(
        () =>
          orders.create(
            "default",
            createOrderRequestSchema.parse({
              idempotency_key: "service-clock-second",
              merchant_order_no: "service-clock-second",
              amount_cents: 2_200,
            }),
          ),
        (error: unknown) =>
          error instanceof OrderError &&
          error.code === "order_clock_unavailable" &&
          error.retryAfterSeconds === 30,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
