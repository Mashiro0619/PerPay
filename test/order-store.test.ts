import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { OrderClockError, OrderStore } from "../src/database/order-store.ts";
import { digestCheckoutToken, isCanonicalCheckoutToken } from "../src/orders/checkout-token.ts";
import {
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
  type CreateOrderRequest,
} from "../src/orders/model.ts";
import {
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
} from "../src/orders/service.ts";
import { prepareWebhookTarget } from "../src/notifications/model.ts";

const API_CLIENT_ID = "default";
const TEST_START_MS = 2_000_000_000_000;

describe("OrderStore", () => {
  it("creates one complete aggregate and replays the exact idempotent request", async () => {
    await withStore(async ({ database, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const request = requestFor("idem-1", "merchant-1", 10_000, "测试订单");

      const first = store.createOrder(createInput(request));
      assert.equal(first.kind, "created");
      if (first.kind !== "created") return;
      assert.equal(first.aggregate.order.payableAmountCents, 10_001);
      assert.equal(first.aggregate.order.checkoutStatus, "OPEN");
      assert.equal(first.aggregate.order.paymentStatus, "UNPAID");
      assert.equal(first.aggregate.collectionProfile.codePayload, "https://qr.example.test/profile-a");
      assert.equal(isCanonicalCheckoutToken(first.aggregate.checkoutToken), true);

      const replay = store.createOrder(createInput(request));
      assert.equal(replay.kind, "existing");
      if (replay.kind !== "existing") return;
      assert.equal(replay.aggregate.order.orderId, first.aggregate.order.orderId);
      assert.equal(replay.aggregate.checkoutToken, first.aggregate.checkoutToken);

      database.read((connection) => {
        const counts = connection
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM payment_orders) AS orders,
               (SELECT COUNT(*) FROM checkout_sessions) AS checkouts,
               (SELECT COUNT(*) FROM amount_slots) AS slots,
               (SELECT COUNT(*) FROM order_events) AS events`,
          )
          .get() as Record<string, bigint | number>;
        assert.deepEqual(
          Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
          { orders: 1, checkouts: 1, slots: 1, events: 1 },
        );
        const persisted = JSON.stringify(
          connection.prepare("SELECT * FROM checkout_sessions").get(),
        );
        assert.equal(persisted.includes(first.aggregate.checkoutToken), false);
      });
    });
  });

  it("distinguishes idempotency conflicts from merchant order number conflicts", async () => {
    await withStore(async ({ store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const original = requestFor("idem-original", "merchant-original", 500);
      const created = store.createOrder(createInput(original));
      assert.equal(created.kind, "created");

      const changed = requestFor("idem-original", "merchant-original", 501);
      assert.equal(store.createOrder(createInput(changed)).kind, "idempotency_conflict");

      const duplicateMerchant = requestFor("idem-other", "merchant-original", 500);
      assert.equal(
        store.createOrder(createInput(duplicateMerchant)).kind,
        "merchant_order_conflict",
      );
    });
  });

  it("persists one immutable notification target and binds it to idempotent replay", async () => {
    await withStore(async ({ database, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const allowedOrigin = "https://hooks.example.test";
      const targetUrl = `${allowedOrigin}/orders/paid?tenant=personal`;
      const request = createOrderRequestSchema.parse({
        idempotency_key: "idem-webhook-target",
        merchant_order_no: "merchant-webhook-target",
        amount_cents: 800,
        notify_url: targetUrl,
      });
      const input = {
        ...createInput(request),
        webhookTarget: prepareWebhookTarget(targetUrl, allowedOrigin),
      };

      const created = store.createOrder(input);
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;
      assert.equal(created.aggregate.webhookTarget?.targetUrl, targetUrl);
      assert.equal(created.aggregate.webhookTarget?.orderId, created.aggregate.order.orderId);

      const replay = store.createOrder(input);
      assert.equal(replay.kind, "existing");
      if (replay.kind !== "existing") return;
      assert.equal(
        replay.aggregate.webhookTarget?.targetId,
        created.aggregate.webhookTarget?.targetId,
      );

      assert.equal(
        store.createOrder(createInput(createOrderRequestSchema.parse({
          idempotency_key: request.idempotency_key,
          merchant_order_no: request.merchant_order_no,
          amount_cents: request.amount_cents,
        }))).kind,
        "idempotency_conflict",
      );
      assert.equal(
        store.createOrder({
          ...createInput(request),
          webhookTargetRejection: {
            url: targetUrl,
            code: "webhook_disabled",
          },
        }).kind,
        "existing",
      );
      const changedTargetUrl = `${allowedOrigin}/orders/paid?tenant=changed`;
      assert.equal(
        store.createOrder({
          ...createInput({ ...request, notify_url: changedTargetUrl }),
          webhookTarget: prepareWebhookTarget(changedTargetUrl, allowedOrigin),
        }).kind,
        "idempotency_conflict",
      );
      assert.deepEqual(
        store.createOrder({
          ...createInput(createOrderRequestSchema.parse({
            idempotency_key: "idem-webhook-rejected-new",
            merchant_order_no: "merchant-webhook-rejected-new",
            amount_cents: 900,
            notify_url: targetUrl,
          })),
          webhookTargetRejection: {
            url: targetUrl,
            code: "webhook_disabled",
          },
        }),
        { kind: "webhook_target_rejected", code: "webhook_disabled" },
      );

      database.read((connection) => {
        const row = connection
          .prepare("SELECT COUNT(*) AS count FROM webhook_targets")
          .get() as { count: bigint | number };
        assert.equal(Number(row.count), 1);
      });
    });
  });

  it("allocates distinct active amounts, exhausts the configured range, and reuses by generation", async () => {
    await withStore(async ({ database, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const first = store.createOrder(createInput(requestFor("idem-a", "merchant-a", 100), 2));
      const second = store.createOrder(createInput(requestFor("idem-b", "merchant-b", 100), 2));
      assert.equal(first.kind, "created");
      assert.equal(second.kind, "created");
      if (first.kind !== "created" || second.kind !== "created") return;
      assert.equal(first.aggregate.order.payableAmountCents, 101);
      assert.equal(second.aggregate.order.payableAmountCents, 102);

      const exhausted = store.createOrder(
        createInput(requestFor("idem-c", "merchant-c", 100), 2),
      );
      assert.deepEqual(exhausted, { kind: "amount_slots_exhausted" });

      const closed = store.closeOrder(API_CLIENT_ID, first.aggregate.order.orderId);
      assert.equal(closed?.order.checkoutStatus, "CLOSED");
      const closedAgain = store.closeOrder(API_CLIENT_ID, first.aggregate.order.orderId);
      assert.equal(closedAgain?.order.checkoutStatus, "CLOSED");
      assert.equal(closedAgain?.order.version, closed?.order.version);
      const reused = store.createOrder(
        createInput(requestFor("idem-d", "merchant-d", 100), 2),
      );
      assert.equal(reused.kind, "created");
      if (reused.kind !== "created") return;
      assert.equal(reused.aggregate.order.payableAmountCents, 101);

      database.read((connection) => {
        const generations = connection
          .prepare(
            `SELECT generation, released_at
               FROM amount_slots
              WHERE payable_amount_cents = 101
              ORDER BY generation`,
          )
          .all() as Array<{ generation: bigint | number; released_at: bigint | number | null }>;
        assert.deepEqual(
          generations.map((row) => ({
            generation: Number(row.generation),
            active: row.released_at === null,
          })),
          [
            { generation: 1, active: false },
            { generation: 2, active: true },
          ],
        );
      });
    });
  });

  it("serializes a burst of same-amount creates into unique payable amounts", async () => {
    await withStore(async ({ store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          Promise.resolve().then(() =>
            store.createOrder(
              createInput(
                requestFor(`idem-burst-${index}`, `merchant-burst-${index}`, 5_000),
                40,
              ),
            ),
          ),
        ),
      );
      assert.equal(results.every((result) => result.kind === "created"), true);
      const amounts = results.map((result) => {
        assert.equal(result.kind, "created");
        return result.kind === "created" ? result.aggregate.order.payableAmountCents : -1;
      });
      assert.equal(new Set(amounts).size, 40);
      assert.deepEqual(amounts.toSorted((left, right) => left - right),
        Array.from({ length: 40 }, (_, index) => 5_001 + index));
    });
  });

  it("expires lazily and keeps slot intervals valid across a physical clock rollback", async () => {
    await withStore(async ({ database, setNow, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const first = store.createOrder(
        createInput(requestFor("idem-expire", "merchant-expire", 900), 1, 60_000),
      );
      assert.equal(first.kind, "created");
      if (first.kind !== "created") return;

      setNow(TEST_START_MS + 60_000);
      const expired = store.orderById(API_CLIENT_ID, first.aggregate.order.orderId);
      assert.equal(expired?.order.checkoutStatus, "EXPIRED");
      assert.equal(expired?.order.closedAt, TEST_START_MS + 60_000);

      setNow(TEST_START_MS - 10_000);
      const reused = store.createOrder(
        createInput(requestFor("idem-after-rollback", "merchant-after-rollback", 900), 1),
      );
      assert.equal(reused.kind, "created");
      if (reused.kind !== "created") return;
      assert.equal(reused.aggregate.order.createdAt, TEST_START_MS + 60_000);

      database.read((connection) => {
        const generations = connection
          .prepare(
            `SELECT generation, occupied_from, released_at
               FROM amount_slots
              WHERE payable_amount_cents = 901
              ORDER BY generation`,
          )
          .all() as Array<Record<string, bigint | number | null>>;
        assert.equal(Number(generations[0]?.released_at), Number(generations[1]?.occupied_from));
        assert.deepEqual(generations.map((row) => Number(row.generation)), [1, 2]);
      });
    });
  });

  it("fails closed after a clock rollback larger than the bounded tolerance", async () => {
    await withStore(async ({ setNow, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      setNow(TEST_START_MS + 24 * 60 * 60 * 1000);
      const created = store.createOrder(
        createInput(requestFor("idem-clock-jump", "merchant-clock-jump", 1_500)),
      );
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;

      setNow(TEST_START_MS);
      assert.throws(
        () => store.orderById(API_CLIENT_ID, created.aggregate.order.orderId),
        OrderClockError,
      );
      assert.throws(
        () =>
          store.publicCheckoutByTokenDigest(
            digestCheckoutToken(created.aggregate.checkoutToken),
          ),
        OrderClockError,
      );
      assert.throws(
        () =>
          store.createOrder(
            createInput(requestFor("idem-clock-blocked", "merchant-clock-blocked", 1_600)),
          ),
        OrderClockError,
      );
    });
  });

  it("resolves a close request at the expiry boundary as EXPIRED", async () => {
    await withStore(async ({ setNow, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const created = store.createOrder(
        createInput(requestFor("idem-close-expiry", "merchant-close-expiry", 700), 1, 60_000),
      );
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;

      setNow(TEST_START_MS + 60_000);
      const terminal = store.closeOrder(API_CLIENT_ID, created.aggregate.order.orderId);
      assert.equal(terminal?.order.checkoutStatus, "EXPIRED");
      assert.equal(terminal?.order.version, 2);
      const repeated = store.closeOrder(API_CLIENT_ID, created.aggregate.order.orderId);
      assert.equal(repeated?.order.checkoutStatus, "EXPIRED");
      assert.equal(repeated?.order.version, 2);
    });
  });

  it("freezes collection profiles per order and records every actual activation", async () => {
    await withStore(async ({ database, store }) => {
      const profileA = "https://qr.example.test/profile-a";
      const profileB = "https://qr.example.test/profile-b";
      const firstSync = syncProfile(store, profileA);
      assert.equal(firstSync.created, true);
      assert.equal(syncProfile(store, profileA).changed, false);

      const firstOrder = store.createOrder(
        createInput(requestFor("idem-profile-a", "merchant-profile-a", 1_000)),
      );
      assert.equal(firstOrder.kind, "created");
      const secondSync = syncProfile(store, profileB);
      assert.equal(secondSync.created, true);
      const secondOrder = store.createOrder(
        createInput(requestFor("idem-profile-b", "merchant-profile-b", 2_000)),
      );
      assert.equal(secondOrder.kind, "created");
      const restored = syncProfile(store, profileA);
      assert.equal(restored.created, false);
      assert.equal(restored.profile.profileId, firstSync.profile.profileId);

      if (firstOrder.kind !== "created" || secondOrder.kind !== "created") return;
      assert.equal(firstOrder.aggregate.collectionProfile.codePayload, profileA);
      assert.equal(secondOrder.aggregate.collectionProfile.codePayload, profileB);
      assert.equal(
        store.orderById(API_CLIENT_ID, firstOrder.aggregate.order.orderId)?.collectionProfile
          .codePayload,
        profileA,
      );

      database.read((connection) => {
        const rows = connection
          .prepare(
            `SELECT sequence, profile_id, previous_profile_id
               FROM collection_profile_activations
              ORDER BY sequence`,
          )
          .all() as Array<Record<string, bigint | number | string | null>>;
        assert.deepEqual(rows.map((row) => Number(row.sequence)), [1, 2, 3]);
        assert.equal(rows[0]?.previous_profile_id, null);
        assert.equal(rows[2]?.profile_id, firstSync.profile.profileId);
      });
    });
  });

  it("does not reveal whether an order belongs to another API client", async () => {
    await withStore(async ({ store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const created = store.createOrder(
        createInput(requestFor("idem-private", "merchant-private", 10)),
      );
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;
      assert.equal(store.orderById("different-client", created.aggregate.order.orderId), undefined);
      assert.equal(
        store.orderByMerchantOrderNumber("different-client", "merchant-private"),
        undefined,
      );
      assert.equal(store.closeOrder("different-client", created.aggregate.order.orderId), undefined);
    });
  });
});

async function withStore(
  operation: (context: {
    readonly database: AppDatabase;
    readonly store: OrderStore;
    readonly setNow: (value: number) => void;
  }) => Promise<void> | void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-order-store-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  let now = TEST_START_MS;
  try {
    database.write((connection) => {
      connection
        .prepare(
          `INSERT INTO api_client_config(
             singleton_key, client_id, secret_fingerprint, key_version,
             enabled, created_at, updated_at
           ) VALUES (1, ?, ?, 1, 1, ?, ?)`,
        )
        .run(API_CLIENT_ID, "a".repeat(64), now, now);
    });
    await operation({
      database,
      store: new OrderStore(database, () => now),
      setNow(value) {
        now = value;
      },
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function syncProfile(store: OrderStore, codePayload: string) {
  const { payloadFingerprint, profileFingerprint } = fingerprintCollectionCodeProfile(codePayload);
  return store.syncCollectionProfile({ codePayload, payloadFingerprint, profileFingerprint });
}

function requestFor(
  idempotencyKey: string,
  merchantOrderNo: string,
  amountCents: number,
  description?: string,
): CreateOrderRequest {
  return createOrderRequestSchema.parse({
    idempotency_key: idempotencyKey,
    merchant_order_no: merchantOrderNo,
    amount_cents: amountCents,
    ...(description === undefined ? {} : { description }),
  });
}

function createInput(
  request: CreateOrderRequest,
  amountOffsetMaximumCents = 99,
  ttlMilliseconds = 300_000,
) {
  return {
    apiClientId: API_CLIENT_ID,
    request,
    idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
    requestFingerprint: fingerprintCreateOrderRequest(request),
    ttlMilliseconds,
    amountOffsetMaximumCents,
  } as const;
}
