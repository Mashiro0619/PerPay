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
    assert.equal(COLLECTION_PROFILE_FINGERPRINT_VERSION, 2);
    assert.deepEqual(fingerprintCollectionCodeProfile("https://qr.example.test/profile-a"), {
      payloadFingerprint: "b1d6dcd20b3d44fabecddb945555e1c9280ba20d32397d0e526ae1a8812c2519",
      profileFingerprint: "d55fcc773d5fbb63e8118e083e8e26320a81a46f68b1999e6948dbcf8a8dcf10",
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

  it("reports when the earliest occupied amount slot can be retried", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-order-service-slots-"));
    const config = loadConfig({
      PERPAY_INITIAL_ADMIN_PASSWORD: "order-service-slots-password",
      PERPAY_API_SECRET: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      PERPAY_COLLECTION_CODE_PAYLOAD: "https://qr.local.invalid/service-slots",
      PERPAY_DATA_DIR: directory,
      PERPAY_AMOUNT_OFFSET_MAX_CENTS: "1",
      PERPAY_ORDER_TTL_SECONDS: "60",
    });
    const database = await AppDatabase.open(config.databasePath);
    try {
      await new IdentityService(database, config).initialize();
      const orders = new OrderService(database, config, () => 2_000_000_000_000);
      orders.initialize();
      orders.create(
        "default",
        createOrderRequestSchema.parse({
          idempotency_key: "service-slots-first",
          merchant_order_no: "service-slots-first",
          amount_cents: 2_300,
        }),
      );

      assert.throws(
        () => orders.create(
          "default",
          createOrderRequestSchema.parse({
            idempotency_key: "service-slots-second",
            merchant_order_no: "service-slots-second",
            amount_cents: 2_300,
          }),
        ),
        (error: unknown) =>
          error instanceof OrderError &&
          error.code === "amount_slots_exhausted" &&
          error.retryAfterSeconds === 60,
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates configured notification targets and preserves their idempotent identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-order-service-webhook-"));
    const baseEnvironment = {
      PERPAY_INITIAL_ADMIN_PASSWORD: "order-service-webhook-password",
      PERPAY_API_SECRET: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      PERPAY_COLLECTION_CODE_PAYLOAD: "https://qr.local.invalid/service-webhook",
      PERPAY_DATA_DIR: directory,
    } as const;
    const allowedOrigin = "https://hooks.local.invalid";
    const rotatedAllowedOrigin = "https://rotated-hooks.local.invalid";
    const config = loadConfig({
      ...baseEnvironment,
      PERPAY_WEBHOOK_ENABLED: "true",
      PERPAY_WEBHOOK_ALLOWED_ORIGIN: allowedOrigin,
      PERPAY_WEBHOOK_SECRET: Buffer.alloc(32, 55).toString("base64url"),
    });
    const database = await AppDatabase.open(config.databasePath);
    try {
      await new IdentityService(database, config).initialize();
      const orders = new OrderService(database, config);
      orders.initialize();
      const request = createOrderRequestSchema.parse({
        idempotency_key: "service-webhook-idempotency",
        merchant_order_no: "service-webhook-order",
        amount_cents: 3_000,
        notify_url: `${allowedOrigin}/paid?source=api`,
      });
      const created = orders.create("default", request);
      assert.equal(created.created, true);
      assert.equal(created.order.notification.notifyUrl, request.notify_url);
      assert.deepEqual(readWebhookOrderCounts(database), {
        orders: 1,
        targets: 1,
        deliveries: 0,
      });

      const disabled = new OrderService(database, loadConfig(baseEnvironment));
      const replayedWhileDisabled = disabled.create("default", request);
      assert.equal(replayedWhileDisabled.created, false);
      assert.equal(replayedWhileDisabled.order.orderId, created.order.orderId);

      const rotatedOrigin = new OrderService(database, loadConfig({
        ...baseEnvironment,
        PERPAY_WEBHOOK_ENABLED: "true",
        PERPAY_WEBHOOK_ALLOWED_ORIGIN: rotatedAllowedOrigin,
        PERPAY_WEBHOOK_SECRET: Buffer.alloc(32, 55).toString("base64url"),
      }));
      const replayedAfterOriginRotation = rotatedOrigin.create("default", request);
      assert.equal(replayedAfterOriginRotation.created, false);
      assert.equal(replayedAfterOriginRotation.order.orderId, created.order.orderId);

      assert.throws(
        () => rotatedOrigin.create("default", {
          ...request,
          notify_url: `${allowedOrigin}/paid?source=changed`,
        }),
        (error: unknown) => error instanceof OrderError && error.code === "idempotency_conflict",
      );
      assert.throws(
        () => rotatedOrigin.create("default", createOrderRequestSchema.parse({
          idempotency_key: "service-webhook-wrong-origin",
          merchant_order_no: "service-webhook-wrong-origin",
          amount_cents: 3_100,
          notify_url: `${allowedOrigin}/paid`,
        })),
        (error: unknown) =>
          error instanceof OrderError && error.code === "webhook_target_not_allowed",
      );

      assert.throws(
        () => disabled.create("default", createOrderRequestSchema.parse({
          idempotency_key: "service-webhook-disabled",
          merchant_order_no: "service-webhook-disabled",
          amount_cents: 3_200,
          notify_url: `${allowedOrigin}/paid`,
        })),
        (error: unknown) => error instanceof OrderError && error.code === "webhook_disabled",
      );
      assert.deepEqual(readWebhookOrderCounts(database), {
        orders: 1,
        targets: 1,
        deliveries: 0,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function readWebhookOrderCounts(database: AppDatabase): {
  readonly orders: number;
  readonly targets: number;
  readonly deliveries: number;
} {
  return database.read((connection) => {
    const row = connection.prepare(
      `SELECT
         (SELECT COUNT(*) FROM payment_orders) AS orders,
         (SELECT COUNT(*) FROM webhook_targets) AS targets,
         (SELECT COUNT(*) FROM webhook_deliveries) AS deliveries`,
    ).get() as Record<"orders" | "targets" | "deliveries", bigint | number>;
    return {
      orders: Number(row.orders),
      targets: Number(row.targets),
      deliveries: Number(row.deliveries),
    };
  });
}
