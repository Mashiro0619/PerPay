import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { IdentityStore } from "../src/database/identity-store.ts";
import { LEDGER_PROVIDER_KIND } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import {
  COLLECTION_PROFILE_FINGERPRINT_VERSION,
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
  OrderError,
  OrderService,
} from "../src/orders/service.ts";
import type {
  CollectionSettings,
  RuntimeSettingsSnapshot,
  WebhookSettings,
} from "../src/settings/model.ts";

const apiSecret = Buffer.alloc(32, 7).toString("base64url");
const webhookSecret = Buffer.alloc(32, 55).toString("base64url");
const providerKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const defaultCollection: CollectionSettings = Object.freeze({
  codePayload: "https://qr.local.invalid/service-test",
  orderTtlSeconds: 300,
  amountOffsetMaximumCents: 9,
});
const disabledWebhook: WebhookSettings = Object.freeze({
  enabled: false,
  allowedOrigin: null,
  secret: null,
  signingKeyFingerprint: null,
  timeoutMilliseconds: 5_000,
  maximumAttempts: 8,
  retryBaseMilliseconds: 5_000,
  retryMaximumMilliseconds: 300_000,
});

describe("order service", () => {
  it("keeps the versioned collection profile fingerprints stable", () => {
    assert.equal(COLLECTION_PROFILE_FINGERPRINT_VERSION, 2);
    assert.deepEqual(fingerprintCollectionCodeProfile("https://qr.example.test/profile-a"), {
      payloadFingerprint: "b1d6dcd20b3d44fabecddb945555e1c9280ba20d32397d0e526ae1a8812c2519",
      profileFingerprint: "d55fcc773d5fbb63e8118e083e8e26320a81a46f68b1999e6948dbcf8a8dcf10",
    });
  });

  it("keeps idempotency digests stable and scoped to the persisted API client dimension", () => {
    assert.equal(
      digestIdempotencyKey("default", "http-order-attempt-1"),
      "926a16c81169c3333e95b09fccd39354e1d5b9f1a7ab5aa58c6066ec7b923446",
    );
    assert.notEqual(
      digestIdempotencyKey("default", "http-order-attempt-1"),
      digestIdempotencyKey("another-client", "http-order-attempt-1"),
    );
  });

  it("rejects new orders until all required runtime settings are configured", async () => {
    await withDatabase("unconfigured", async (database) => {
      const settings = runtimeSettings({
        collection: null,
        provider: null,
        apiSecret: null,
        apiSecretFingerprint: null,
        activeProviderAccountKey: null,
      });
      const orders = new OrderService(database, () => settings);

      assert.equal(orders.initialize(), null);
      assert.throws(
        () => orders.create(orderRequest("service-unconfigured", 2_000)),
        (error: unknown) =>
          error instanceof OrderError && error.code === "system_not_configured",
      );
      assert.throws(
        () => orders.get("00000000-0000-4000-8000-000000000000"),
        (error: unknown) => error instanceof OrderError && error.code === "order_not_found",
      );
    });
  });

  it("reads current collection parameters while preserving each order's collection profile", async () => {
    await withDatabase("dynamic-collection", async (database) => {
      const now = 2_000_000_000_000;
      let settings = runtimeSettings({
        collection: {
          codePayload: "https://qr.local.invalid/collection-a",
          orderTtlSeconds: 60,
          amountOffsetMaximumCents: 1,
        },
      });
      const orders = new OrderService(database, () => settings, () => now);
      const initialProfile = orders.initialize();
      assert.ok(initialProfile);

      const first = orders.create(orderRequest("service-dynamic-first", 2_300));
      assert.equal(first.order.payableAmountCents, 2_301);
      assert.equal(first.order.checkout.expiresAt - first.order.createdAt, 60_000);

      settings = runtimeSettings({
        revision: 2,
        paymentRevision: 2,
        collection: {
          codePayload: "https://qr.local.invalid/collection-b",
          orderTtlSeconds: 120,
          amountOffsetMaximumCents: 2,
        },
      });
      const nextProfile = orders.syncCollectionProfile(
        settings.collection!,
        settings.activeProviderAccountKey!,
      );
      assert.equal(nextProfile.changed, true);

      const second = orders.create(orderRequest("service-dynamic-second", 2_300));
      assert.equal(second.order.payableAmountCents, 2_302);
      assert.equal(second.order.checkout.expiresAt - second.order.createdAt, 120_000);
      assert.equal(
        orders.publicCheckout(first.order.checkoutToken).paymentInstructions?.collectionCodePayload,
        "https://qr.local.invalid/collection-a",
      );
      assert.equal(
        orders.publicCheckout(second.order.checkoutToken).paymentInstructions?.collectionCodePayload,
        "https://qr.local.invalid/collection-b",
      );

      assert.equal(orders.get(first.order.orderId).orderId, first.order.orderId);
      assert.equal(
        orders.getByMerchantOrderNumber("service-dynamic-first").orderId,
        first.order.orderId,
      );
      assert.equal(
        orders.adminGetByMerchantOrderNumber("service-dynamic-first").apiClientId,
        "default",
      );
    });
  });

  it("reads advanced checkout policy for each new order without rewriting existing sessions", async () => {
    await withDatabase("dynamic-advanced", async (database) => {
      let now = Date.now();
      let settings = runtimeSettings({
        advanced: {
          checkoutKeyRotationDays: 90,
          checkoutTerminalObservationSeconds: 60,
        },
      });
      const orders = new OrderService(database, () => settings, () => now);
      orders.initialize();
      const initialKey = database.read((connection) => connection.prepare(
        `SELECT key_version, activated_at FROM checkout_token_keys
          WHERE retired_at IS NULL`,
      ).get() as { key_version: bigint; activated_at: bigint });
      now = Math.max(now, Number(initialKey.activated_at));

      const firstRequest = orderRequest("service-advanced-first", 2_500);
      const first = orders.create(firstRequest);
      settings = runtimeSettings({
        revision: 2,
        advanced: {
          checkoutKeyRotationDays: 1,
          checkoutTerminalObservationSeconds: 120,
        },
      });
      now = Number(initialKey.activated_at) + 24 * 60 * 60 * 1_000;
      const second = orders.create(orderRequest("service-advanced-second", 2_600));

      assert.deepEqual(database.read((connection) => connection.prepare(
        `SELECT order_id, token_key_version, terminal_observation_milliseconds
           FROM checkout_sessions
          WHERE order_id IN (?, ?)
          ORDER BY order_id`,
      ).all(first.order.orderId, second.order.orderId).map((row) => ({
        orderId: String((row as { order_id: string }).order_id),
        keyVersion: Number((row as { token_key_version: bigint }).token_key_version),
        observationMilliseconds: Number(
          (row as { terminal_observation_milliseconds: bigint }).terminal_observation_milliseconds,
        ),
      }))), [
        {
          orderId: first.order.orderId,
          keyVersion: Number(initialKey.key_version),
          observationMilliseconds: 60_000,
        },
        {
          orderId: second.order.orderId,
          keyVersion: Number(initialKey.key_version) + 1,
          observationMilliseconds: 120_000,
        },
      ].sort((left, right) => left.orderId.localeCompare(right.orderId)));

      settings = runtimeSettings({
        revision: 3,
        advanced: {
          checkoutKeyRotationDays: 3_650,
          checkoutTerminalObservationSeconds: 604_800,
        },
      });
      const replay = orders.create(firstRequest);
      assert.equal(replay.created, false);
      assert.equal(replay.order.checkoutToken, first.order.checkoutToken);
      const preserved = database.read((connection) => connection.prepare(
        `SELECT terminal_observation_milliseconds FROM checkout_sessions
          WHERE order_id = ?`,
      ).get(first.order.orderId) as { terminal_observation_milliseconds: bigint });
      assert.equal(Number(preserved.terminal_observation_milliseconds), 60_000);
    });
  });

  it("includes the provider account generation in collection profile identity", async () => {
    await withDatabase("provider-generation", async (database) => {
      const ledger = new LedgerStore(database);
      const generationA = "source:11111111-1111-4111-8111-111111111111";
      const generationB = "source:22222222-2222-4222-8222-222222222222";
      const collection = {
        codePayload: "https://qr.local.invalid/same-code",
        orderTtlSeconds: 300,
        amountOffsetMaximumCents: 9,
      } satisfies CollectionSettings;
      const orders = new OrderService(
        database,
        () => runtimeSettings({ collection, activeProviderAccountKey: generationB }),
        () => 2_000_000_000_000,
      );

      bindProvider(ledger, generationA, "provider-app-a");
      const first = orders.syncCollectionProfile(collection, generationA);
      bindProvider(ledger, generationB, "provider-app-b");
      const second = orders.syncCollectionProfile(collection, generationB);

      assert.equal(first.profile.providerAccountKey, generationA);
      assert.equal(second.profile.providerAccountKey, generationB);
      assert.equal(first.profile.payloadFingerprint, second.profile.payloadFingerprint);
      assert.notEqual(first.profile.profileFingerprint, second.profile.profileFingerprint);
      assert.equal(second.profile.version, first.profile.version + 1);

      const created = orders.create(orderRequest("service-generation-b", 2_400));
      const profileId = database.read((connection) => {
        const row = connection.prepare(
          "SELECT collection_profile_id FROM payment_orders WHERE order_id = ?",
        ).get(created.order.orderId) as { collection_profile_id: string };
        return row.collection_profile_id;
      });
      assert.equal(profileId, second.profile.profileId);
    });
  });

  it("removes payment instructions from an expired public checkout", async () => {
    await withDatabase("public-expiry", async (database) => {
      let now = Date.now();
      const settings = runtimeSettings({
        collection: { ...defaultCollection, orderTtlSeconds: 60 },
      });
      const orders = new OrderService(database, () => settings, () => now);
      orders.initialize();
      const created = orders.create(orderRequest("service-expiry-order", 2_000));

      now += settings.collection!.orderTtlSeconds * 1_000 + 1_000;
      const publicCheckout = orders.publicCheckout(created.order.checkoutToken);
      assert.equal(publicCheckout.checkout.status, "EXPIRED");
      assert.equal(publicCheckout.paymentInstructions, null);
    });
  });

  it("maps an unsafe order clock to a retryable service error", async () => {
    await withDatabase("clock", async (database) => {
      let now = Date.now();
      const settings = runtimeSettings();
      const orders = new OrderService(database, () => settings, () => now);
      orders.initialize();
      now += 24 * 60 * 60 * 1_000;
      orders.create(orderRequest("service-clock-first", 2_100));
      now -= 24 * 60 * 60 * 1_000;

      assert.throws(
        () => orders.create(orderRequest("service-clock-second", 2_200)),
        (error: unknown) =>
          error instanceof OrderError &&
          error.code === "order_clock_unavailable" &&
          error.retryAfterSeconds === 30,
      );
    });
  });

  it("reports when the earliest occupied amount slot can be retried", async () => {
    await withDatabase("slots", async (database) => {
      const settings = runtimeSettings({
        collection: {
          ...defaultCollection,
          orderTtlSeconds: 60,
          amountOffsetMaximumCents: 1,
        },
      });
      const orders = new OrderService(database, () => settings, () => 2_000_000_000_000);
      orders.initialize();
      orders.create(orderRequest("service-slots-first", 2_300));

      assert.throws(
        () => orders.create(orderRequest("service-slots-second", 2_300)),
        (error: unknown) =>
          error instanceof OrderError &&
          error.code === "amount_slots_exhausted" &&
          error.retryAfterSeconds === 60,
      );
    });
  });

  it("reads notification enablement and allowed-origin rotations dynamically", async () => {
    await withDatabase("webhook", async (database) => {
      const allowedOrigin = "https://hooks.local.invalid";
      const rotatedAllowedOrigin = "https://rotated-hooks.local.invalid";
      let settings = runtimeSettings({ webhook: enabledWebhook(allowedOrigin) });
      const orders = new OrderService(database, () => settings);
      orders.initialize();
      const request = orderRequest(
        "service-webhook-order",
        3_000,
        `${allowedOrigin}/paid?source=api`,
      );
      const requestWithReturnUrl = createOrderRequestSchema.parse({
        ...request,
        return_url: `${allowedOrigin}/orders/service-webhook-order?paid=1`,
      });
      const created = orders.create(requestWithReturnUrl);
      assert.equal(created.order.notification.notifyUrl, request.notify_url);
      assert.equal(
        created.order.returnUrl,
        `${allowedOrigin}/orders/service-webhook-order?paid=1`,
      );
      assert.deepEqual(readWebhookOrderCounts(database), {
        orders: 1,
        targets: 1,
        deliveries: 0,
      });

      settings = runtimeSettings({ revision: 2, webhook: disabledWebhook });
      const replayedWhileDisabled = orders.create(requestWithReturnUrl);
      assert.equal(replayedWhileDisabled.created, false);
      assert.equal(replayedWhileDisabled.order.orderId, created.order.orderId);
      assert.throws(
        () => orders.create(
          orderRequest("service-webhook-disabled", 3_100, `${allowedOrigin}/paid`),
        ),
        (error: unknown) => error instanceof OrderError && error.code === "webhook_disabled",
      );

      settings = runtimeSettings({
        revision: 3,
        webhook: enabledWebhook(rotatedAllowedOrigin),
      });
      const replayedAfterRotation = orders.create(requestWithReturnUrl);
      assert.equal(replayedAfterRotation.created, false);
      assert.equal(replayedAfterRotation.order.orderId, created.order.orderId);
      assert.throws(
        () => orders.create(
          orderRequest("service-webhook-old-origin", 3_200, `${allowedOrigin}/paid`),
        ),
        (error: unknown) =>
          error instanceof OrderError && error.code === "webhook_target_not_allowed",
      );
      const rotated = orders.create(orderRequest(
        "service-webhook-new-origin",
        3_300,
        `${rotatedAllowedOrigin}/paid`,
      ));
      assert.equal(rotated.order.notification.notifyUrl, `${rotatedAllowedOrigin}/paid`);
      assert.deepEqual(readWebhookOrderCounts(database), {
        orders: 2,
        targets: 2,
        deliveries: 0,
      });
    });
  });
});

function runtimeSettings(
  overrides: Partial<RuntimeSettingsSnapshot> = {},
): RuntimeSettingsSnapshot {
  const privateKeyPem = providerKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = providerKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    revision: 1,
    paymentRevision: 1,
    updatedAt: 2_000_000_000_000,
    collection: defaultCollection,
    provider: {
      environment: "PRODUCTION",
      endpoint: "https://openapi.alipay.com",
      appId: "provider-app",
      privateKey: providerKeys.privateKey,
      publicKey: providerKeys.publicKey,
      privateKeyPem,
      publicKeyPem,
      applicationKeyFingerprint: "1".repeat(64),
      platformKeyFingerprint: "2".repeat(64),
      timeoutMilliseconds: 10_000,
      scanIntervalMilliseconds: 30_000,
      safetyLagMilliseconds: 10_000,
      maximumSuccessAgeMilliseconds: 120_000,
    },
    apiSecret,
    apiSecretFingerprint: "3".repeat(64),
    webhook: disabledWebhook,
    advanced: {
      checkoutKeyRotationDays: 90,
      checkoutTerminalObservationSeconds: 86_400,
    },
    activeProviderAccountKey: "primary",
    ...overrides,
  };
}

function enabledWebhook(allowedOrigin: string): WebhookSettings {
  return {
    ...disabledWebhook,
    enabled: true,
    allowedOrigin,
    secret: webhookSecret,
    signingKeyFingerprint: "4".repeat(64),
  };
}

function orderRequest(key: string, amountCents: number, notifyUrl?: string) {
  return createOrderRequestSchema.parse({
    idempotency_key: `${key}-idempotency`,
    merchant_order_no: key,
    amount_cents: amountCents,
    product_name: key,
    ...(notifyUrl === undefined ? {} : { notify_url: notifyUrl }),
  });
}

function bindProvider(ledger: LedgerStore, providerAccountKey: string, appId: string): void {
  ledger.bindProviderIdentity({
    providerAccountKey,
    providerKind: LEDGER_PROVIDER_KIND,
    endpoint: "https://openapi.alipay.com",
    externalAccountId: appId,
  });
}

async function withDatabase(
  name: string,
  operation: (database: AppDatabase) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `perpay-order-service-${name}-`));
  const database = await AppDatabase.open(join(directory, "perpay.sqlite"));
  try {
    new IdentityStore(database).transaction((transaction) => {
      transaction.syncApiClient("default", "3".repeat(64), Date.now());
    });
    await operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

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
