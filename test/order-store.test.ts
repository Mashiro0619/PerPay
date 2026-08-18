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
import { MAX_COLLECTION_CODE_PAYLOAD_BYTES } from "../src/orders/collection-profile.ts";
import {
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
} from "../src/orders/service.ts";
import { prepareWebhookTarget } from "../src/notifications/model.ts";

const API_CLIENT_ID = "default";
const TEST_START_MS = 2_000_000_000_000;

describe("OrderStore", () => {
  it("enforces the QR payload byte capacity in the database baseline", async () => {
    await withStore(async ({ store }) => {
      assert.doesNotThrow(() =>
        syncProfile(store, "x".repeat(MAX_COLLECTION_CODE_PAYLOAD_BYTES))
      );
      assert.throws(
        () => syncProfile(store, "y".repeat(MAX_COLLECTION_CODE_PAYLOAD_BYTES + 1)),
        /constraint|collection_profiles/i,
      );
    });
  });

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
        const persisted = connection.prepare("SELECT * FROM checkout_sessions").get() as
          Record<string, unknown>;
        assert.equal(Object.values(persisted).includes(first.aggregate.checkoutToken), false);
      });
    });
  });

  it("rotates checkout token keys at the configured boundary and preserves historical tokens", async () => {
    const rotationMilliseconds = 60_000;
    await withStore(
      async ({ database, databasePath, store, setNow, close }) => {
        const initial = database.read((connection) => {
          const key = connection
            .prepare(
              `SELECT key_version, activated_at
                 FROM checkout_token_keys
                WHERE retired_at IS NULL`,
            )
            .get() as { key_version: bigint | number; activated_at: bigint | number };
          const clock = connection
            .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
            .get() as { last_now_ms: bigint | number };
          return {
            version: Number(key.key_version),
            activatedAt: Number(key.activated_at),
            baseline: Math.max(Number(key.activated_at), Number(clock.last_now_ms)),
          };
        });
        assert.equal(initial.version, 1);
        assert.ok(initial.baseline - initial.activatedAt < rotationMilliseconds);

        setNow(initial.baseline);
        syncProfile(store, "https://qr.example.test/profile-key-rotation");
        const firstRequest = requestFor("idem-key-1", "merchant-key-1", 1_000);
        const first = store.createOrder(
          createInput(firstRequest),
        );
        assert.equal(first.kind, "created");
        if (first.kind !== "created") return;

        setNow(initial.activatedAt + rotationMilliseconds - 1);
        const beforeBoundary = store.createOrder(
          createInput(requestFor("idem-key-2", "merchant-key-2", 2_000)),
        );
        assert.equal(beforeBoundary.kind, "created");
        if (beforeBoundary.kind !== "created") return;

        setNow(initial.activatedAt + rotationMilliseconds);
        const rotated = store.createOrder(
          createInput(requestFor("idem-key-3", "merchant-key-3", 3_000)),
        );
        assert.equal(rotated.kind, "created");
        if (rotated.kind !== "created") return;

        const versions = database.read((connection) =>
          connection
            .prepare(
              `SELECT orders.merchant_order_no, checkout.token_key_version
                 FROM payment_orders AS orders
                 JOIN checkout_sessions AS checkout ON checkout.order_id = orders.order_id
                ORDER BY orders.merchant_order_no`,
            )
            .all() as unknown as Array<{
              merchant_order_no: string;
              token_key_version: bigint | number;
            }>,
        );
        assert.deepEqual(
          versions.map((row) => [row.merchant_order_no, Number(row.token_key_version)]),
          [
            ["merchant-key-1", 1],
            ["merchant-key-2", 1],
            ["merchant-key-3", 2],
          ],
        );
        assert.equal(
          store.orderById(API_CLIENT_ID, first.aggregate.order.orderId)?.checkoutToken,
          first.aggregate.checkoutToken,
        );

        setNow(initial.activatedAt + 2 * rotationMilliseconds);
        const replay = store.createOrder(createInput(firstRequest));
        assert.equal(replay.kind, "existing");
        if (replay.kind !== "existing") return;
        assert.equal(replay.aggregate.order.orderId, first.aggregate.order.orderId);
        assert.equal(replay.aggregate.checkoutToken, first.aggregate.checkoutToken);
        assert.deepEqual(
          database.read((connection) => {
            const row = connection
              .prepare(
                `SELECT COUNT(*) AS key_count,
                        MAX(key_version) AS maximum_version,
                        SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END) AS active_count
                   FROM checkout_token_keys`,
              )
              .get() as Record<string, bigint | number>;
            return Object.fromEntries(
              Object.entries(row).map(([key, value]) => [key, Number(value)]),
            );
          }),
          { key_count: 2, maximum_version: 2, active_count: 1 },
        );

        const backupPath = join(databasePath, "..", "rotated-backup.sqlite3");
        await database.backupDetailed(backupPath);
        close();
        const reopened = await AppDatabase.open(databasePath);
        try {
          const restartedStore = new OrderStore(
            reopened,
            () => initial.activatedAt + rotationMilliseconds,
            rotationMilliseconds,
          );
          assert.equal(
            restartedStore.orderById(API_CLIENT_ID, first.aggregate.order.orderId)?.checkoutToken,
            first.aggregate.checkoutToken,
          );
          assert.equal(
            restartedStore.orderById(API_CLIENT_ID, rotated.aggregate.order.orderId)?.checkoutToken,
            rotated.aggregate.checkoutToken,
          );
        } finally {
          reopened.close();
        }

        const restored = await AppDatabase.open(backupPath);
        try {
          const restoredStore = new OrderStore(
            restored,
            () => initial.activatedAt + rotationMilliseconds,
            rotationMilliseconds,
          );
          assert.equal(
            restoredStore.orderById(API_CLIENT_ID, first.aggregate.order.orderId)?.checkoutToken,
            first.aggregate.checkoutToken,
          );
          assert.equal(
            restoredStore.orderById(API_CLIENT_ID, rotated.aggregate.order.orderId)?.checkoutToken,
            rotated.aggregate.checkoutToken,
          );
        } finally {
          restored.close();
        }
      },
      { checkoutKeyRotationMilliseconds: rotationMilliseconds },
    );
  });

  it("serializes concurrent boundary creates into one checkout key rotation", async () => {
    const rotationMilliseconds = 60_000;
    await withStore(
      async ({ database, store, setNow }) => {
        const initial = database.read((connection) => {
          const key = connection
            .prepare(
              `SELECT key_version, activated_at
                 FROM checkout_token_keys
                WHERE retired_at IS NULL`,
            )
            .get() as { key_version: bigint | number; activated_at: bigint | number };
          const clock = connection
            .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
            .get() as { last_now_ms: bigint | number };
          return {
            version: Number(key.key_version),
            activatedAt: Number(key.activated_at),
            baseline: Math.max(Number(key.activated_at), Number(clock.last_now_ms)),
          };
        });
        assert.equal(initial.version, 1);

        setNow(initial.baseline);
        syncProfile(store, "https://qr.example.test/profile-key-boundary");
        setNow(initial.activatedAt + rotationMilliseconds);

        const results = await Promise.all(
          Array.from({ length: 24 }, (_, index) =>
            Promise.resolve().then(() =>
              store.createOrder(
                createInput(
                  requestFor(
                    `idem-key-boundary-${index}`,
                    `merchant-key-boundary-${index}`,
                    10_000 + index * 100,
                  ),
                ),
              ),
            ),
          ),
        );
        assert.equal(results.every((result) => result.kind === "created"), true);

        const keyHistory = database.read((connection) =>
          connection
            .prepare(
              `SELECT key_version, activated_at, retired_at
                 FROM checkout_token_keys
                ORDER BY key_version`,
            )
            .all() as unknown as Array<{
              key_version: bigint | number;
              activated_at: bigint | number;
              retired_at: bigint | number | null;
            }>,
        );
        assert.deepEqual(
          keyHistory.map((row) => ({
            version: Number(row.key_version),
            activatedAt: Number(row.activated_at),
            retiredAt: row.retired_at === null ? null : Number(row.retired_at),
          })),
          [
            {
              version: 1,
              activatedAt: initial.activatedAt,
              retiredAt: initial.activatedAt + rotationMilliseconds,
            },
            {
              version: 2,
              activatedAt: initial.activatedAt + rotationMilliseconds,
              retiredAt: null,
            },
          ],
        );
        assert.deepEqual(
          database.read((connection) =>
            connection
              .prepare(
                `SELECT token_key_version, COUNT(*) AS session_count
                   FROM checkout_sessions
                  GROUP BY token_key_version
                  ORDER BY token_key_version`,
              )
              .all()
              .map((row) => {
                const typed = row as Record<string, bigint | number>;
                return {
                  version: Number(typed.token_key_version),
                  count: Number(typed.session_count),
                };
              }),
          ),
          [{ version: 2, count: 24 }],
        );
      },
      { checkoutKeyRotationMilliseconds: rotationMilliseconds },
    );
  });

  it("irreversibly revokes terminal checkout links after the observation window", async () => {
    const observationMilliseconds = 10 * 60 * 1_000;
    await withStore(
      async ({ databasePath, store, setNow, close }) => {
        syncProfile(store, "https://qr.example.test/profile-terminal-link");
        const created = store.createOrder(
          createInput(requestFor("idem-terminal-link", "merchant-terminal-link", 1_000)),
        );
        assert.equal(created.kind, "created");
        if (created.kind !== "created") return;

        const tokenDigest = digestCheckoutToken(created.aggregate.checkoutToken);
        const closedAt = TEST_START_MS + 1_000;
        setNow(closedAt);
        assert.equal(
          store.closeOrder(API_CLIENT_ID, created.aggregate.order.orderId)?.order.checkoutStatus,
          "CLOSED",
        );

        setNow(closedAt + observationMilliseconds - 1);
        assert.equal(store.publicCheckoutByTokenDigest(tokenDigest)?.order.checkoutStatus, "CLOSED");

        setNow(closedAt + observationMilliseconds);
        assert.equal(store.publicCheckoutByTokenDigest(tokenDigest), undefined);

        setNow(closedAt + 100);
        assert.equal(store.publicCheckoutByTokenDigest(tokenDigest), undefined);

        close();
        const reopened = await AppDatabase.open(databasePath);
        try {
          const expandedWindowStore = new OrderStore(
            reopened,
            () => closedAt + 100,
            undefined,
            observationMilliseconds * 2,
          );
          assert.equal(expandedWindowStore.publicCheckoutByTokenDigest(tokenDigest), undefined);
        } finally {
          reopened.close();
        }
      },
      { checkoutTerminalObservationMilliseconds: observationMilliseconds },
    );
  });

  it("anchors lazily expired checkout observation to the scheduled expiry", async () => {
    const observationMilliseconds = 60_000;
    await withStore(
      async ({ store, setNow }) => {
        syncProfile(store, "https://qr.example.test/profile-expired-link");
        const createExpiringOrder = (suffix: string) => {
          const created = store.createOrder(
            createInput(
              requestFor(`idem-expired-link-${suffix}`, `merchant-expired-link-${suffix}`, 1_000),
              99,
              1_000,
            ),
          );
          assert.equal(created.kind, "created");
          if (created.kind !== "created") throw new Error("order creation failed");
          return created.aggregate;
        };

        const justInside = createExpiringOrder("inside");
        setNow(justInside.order.expiresAt + observationMilliseconds - 1);
        const expired = store.publicCheckoutByTokenDigest(
          digestCheckoutToken(justInside.checkoutToken),
        );
        assert.equal(expired?.order.checkoutStatus, "EXPIRED");
        assert.equal(expired?.order.closedAt, justInside.order.expiresAt + observationMilliseconds - 1);

        const atBoundary = createExpiringOrder("boundary");
        setNow(atBoundary.order.expiresAt + observationMilliseconds);
        assert.equal(
          store.publicCheckoutByTokenDigest(digestCheckoutToken(atBoundary.checkoutToken)),
          undefined,
        );

        const longExpired = createExpiringOrder("long-expired");
        setNow(longExpired.order.expiresAt + 7 * 24 * 60 * 60 * 1_000);
        assert.equal(
          store.publicCheckoutByTokenDigest(digestCheckoutToken(longExpired.checkoutToken)),
          undefined,
        );
      },
      { checkoutTerminalObservationMilliseconds: observationMilliseconds },
    );
  });

  it("rejects an order event whose persisted evidence has no fingerprint", async () => {
    await withStore(async ({ database, store }) => {
      syncProfile(store, "https://qr.example.test/profile-a");
      const created = store.createOrder(
        createInput(requestFor("idem-event-fingerprint", "merchant-event-fingerprint", 100)),
      );
      assert.equal(created.kind, "created");
      if (created.kind !== "created") return;

      assert.throws(
        () => database.write((connection) => {
          connection.exec("DROP TRIGGER order_events_valid_insert");
          connection.prepare(
            `INSERT INTO order_events(
               event_id, order_id, sequence, event_type, occurred_at, details_json
             ) VALUES (?, ?, 2, 'CHECKOUT_CLOSED', ?, '{}')`,
          ).run(
            "99999999-9999-4999-8999-999999999999",
            created.aggregate.order.orderId,
            TEST_START_MS + 1,
          );
        }),
        /order event details fingerprint is required/,
      );
      assert.equal(database.integrityCheck().ok, true);
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
      const first = store.createOrder(
        createInput(requestFor("idem-a", "merchant-a", 100), 2, 120_000),
      );
      const second = store.createOrder(
        createInput(requestFor("idem-b", "merchant-b", 100), 2, 60_000),
      );
      assert.equal(first.kind, "created");
      assert.equal(second.kind, "created");
      if (first.kind !== "created" || second.kind !== "created") return;
      assert.equal(first.aggregate.order.payableAmountCents, 101);
      assert.equal(second.aggregate.order.payableAmountCents, 102);

      const exhausted = store.createOrder(
        createInput(requestFor("idem-c", "merchant-c", 100), 2),
      );
      assert.deepEqual(exhausted, {
        kind: "amount_slots_exhausted",
        retryAfterSeconds: 60,
      });

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

  it("never returns overdue orders as OPEN when the expiry backlog exceeds one sweep", async () => {
    await withStore(async ({ database, setNow, store }) => {
      syncProfile(store, "https://qr.example.test/admin-expiry-backlog");
      for (let index = 0; index < 300; index += 1) {
        const created = store.createOrder(
          createInput(
            requestFor(
              `backlog-idempotency-${index}`,
              `backlog-merchant-${index}`,
              10_000 + index * 100,
            ),
            99,
            60_000,
          ),
        );
        assert.equal(created.kind, "created");
      }
      setNow(TEST_START_MS + 60_000);

      const page = store.adminOrderPage(
        { checkoutStatus: "OPEN", paymentStatus: null },
        null,
        200,
      );
      assert.deepEqual(page.orders, []);
      assert.equal(page.nextCursor, null);

      const remainingStoredAsOpen = database.read((connection) =>
        Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM payment_orders WHERE checkout_status = 'OPEN'",
        ).get() as { count: bigint | number }).count)
      );
      assert.equal(remainingStoredAsOpen, 44);
    });
  });

  it("merges stored and lazily expired administrator orders in stable descending pages", async () => {
    await withStore(async ({ database, setNow, store }) => {
      syncProfile(store, "https://qr.example.test/admin-expired-merge");
      const createdOrderIds: string[] = [];
      for (let index = 0; index < 270; index += 1) {
        const created = store.createOrder(
          createInput(
            requestFor(
              `expired-merge-idempotency-${index}`,
              `expired-merge-merchant-${index}`,
              20_000 + index * 100,
            ),
            99,
            index < 135 ? 60_000 : 120_000,
          ),
        );
        assert.equal(created.kind, "created");
        if (created.kind === "created") createdOrderIds.push(created.aggregate.order.orderId);
      }
      const expectedOrderIds = createdOrderIds.toSorted((left, right) => {
        if (left === right) return 0;
        return left > right ? -1 : 1;
      });
      setNow(TEST_START_MS + 120_000);

      const firstPage = store.adminOrderPage(
        { checkoutStatus: "EXPIRED", paymentStatus: "UNPAID" },
        null,
        200,
      );
      assert.deepEqual(
        firstPage.orders.map((entry) => entry.order.orderId),
        expectedOrderIds.slice(0, 200),
      );
      assert.equal(
        firstPage.orders.every((entry) => entry.order.checkoutStatus === "EXPIRED"),
        true,
      );
      assert.deepEqual(firstPage.nextCursor, {
        createdAt: TEST_START_MS,
        orderId: expectedOrderIds[199],
      });

      const secondPage = store.adminOrderPage(
        { checkoutStatus: "EXPIRED", paymentStatus: "UNPAID" },
        firstPage.nextCursor,
        200,
      );
      assert.deepEqual(
        secondPage.orders.map((entry) => entry.order.orderId),
        expectedOrderIds.slice(200),
      );
      assert.equal(
        secondPage.orders.every((entry) => entry.order.checkoutStatus === "EXPIRED"),
        true,
      );
      assert.equal(secondPage.nextCursor, null);

      const remainingStoredAsOpen = database.read((connection) =>
        Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM payment_orders WHERE checkout_status = 'OPEN'",
        ).get() as { count: bigint | number }).count)
      );
      assert.equal(remainingStoredAsOpen, 0);
    });
  });

  it("keeps the expiry sweep and both expired-order branches on ordered indexes", async () => {
    await withStore(async ({ database }) => {
      const plans = database.read((connection) => [
        {
          index: "payment_orders_checkout_expiry_idx",
          rows: connection.prepare(
            `EXPLAIN QUERY PLAN
             SELECT order_id
               FROM payment_orders INDEXED BY payment_orders_checkout_expiry_idx
              WHERE checkout_status = 'OPEN' AND expires_at <= ?
              ORDER BY expires_at, order_id
              LIMIT ?`,
          ).all(TEST_START_MS + 120_000, 256),
        },
        {
          index: "payment_orders_checkout_created_idx",
          rows: connection.prepare(
            `EXPLAIN QUERY PLAN
             SELECT orders.order_id
               FROM payment_orders AS orders
                    INDEXED BY payment_orders_checkout_created_idx
               JOIN checkout_sessions AS checkout ON checkout.order_id = orders.order_id
               JOIN collection_profiles AS profile
                 ON profile.profile_id = orders.collection_profile_id
               LEFT JOIN webhook_targets AS target ON target.order_id = orders.order_id
              WHERE orders.checkout_status = 'EXPIRED'
                AND (orders.created_at, orders.order_id) < (?, ?)
              ORDER BY orders.created_at DESC, orders.order_id DESC
              LIMIT ?`,
          ).all(TEST_START_MS, "ffffffff-ffff-4fff-bfff-ffffffffffff", 201),
        },
        {
          index: "payment_orders_checkout_payment_created_idx",
          rows: connection.prepare(
            `EXPLAIN QUERY PLAN
             SELECT orders.order_id
               FROM payment_orders AS orders
                    INDEXED BY payment_orders_checkout_payment_created_idx
               JOIN checkout_sessions AS checkout ON checkout.order_id = orders.order_id
               JOIN collection_profiles AS profile
                 ON profile.profile_id = orders.collection_profile_id
               LEFT JOIN webhook_targets AS target ON target.order_id = orders.order_id
              WHERE orders.checkout_status = 'OPEN'
                AND orders.expires_at <= ?
                AND orders.payment_status = 'UNPAID'
                AND (orders.created_at, orders.order_id) < (?, ?)
              ORDER BY orders.created_at DESC, orders.order_id DESC
              LIMIT ?`,
          ).all(
            TEST_START_MS + 120_000,
            TEST_START_MS,
            "ffffffff-ffff-4fff-bfff-ffffffffffff",
            201,
          ),
        },
      ] as const);

      for (const plan of plans) {
        const details = plan.rows
          .map((row) => String((row as { detail?: unknown }).detail ?? ""))
          .join("\n");
        assert.match(details, new RegExp(`USING (?:COVERING )?INDEX ${plan.index}`));
        assert.doesNotMatch(details, /TEMP B-TREE|MULTI-INDEX OR/);
      }
    });
  });

  it("pages administrator orders from newest to oldest", async () => {
    await withStore(async ({ store, setNow }) => {
      syncProfile(store, "https://qr.example.test/admin-recent-orders");
      const createdOrderIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        setNow(TEST_START_MS + index * 1_000);
        const created = store.createOrder(createInput(requestFor(
          `admin-page-idempotency-${index}`,
          `admin-page-merchant-${index}`,
          10_000 + index * 100,
        )));
        assert.equal(created.kind, "created");
        if (created.kind === "created") createdOrderIds.push(created.aggregate.order.orderId);
      }

      const firstPage = store.adminOrderPage(
        { checkoutStatus: null, paymentStatus: null },
        null,
        2,
      );
      assert.deepEqual(
        firstPage.orders.map((entry) => entry.order.orderId),
        [createdOrderIds[2], createdOrderIds[1]],
      );
      assert.notEqual(firstPage.nextCursor, null);

      const secondPage = store.adminOrderPage(
        { checkoutStatus: null, paymentStatus: null },
        firstPage.nextCursor,
        2,
      );
      assert.deepEqual(
        secondPage.orders.map((entry) => entry.order.orderId),
        [createdOrderIds[0]],
      );
      assert.equal(secondPage.nextCursor, null);
    });
  });
});

async function withStore(
  operation: (context: {
    readonly database: AppDatabase;
    readonly databasePath: string;
    readonly store: OrderStore;
    readonly setNow: (value: number) => void;
    readonly close: () => void;
  }) => Promise<void> | void,
  options: {
    readonly checkoutKeyRotationMilliseconds?: number;
    readonly checkoutTerminalObservationMilliseconds?: number;
  } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-order-store-"));
  const databasePath = join(directory, "database.sqlite3");
  const database = await AppDatabase.open(databasePath);
  let now = TEST_START_MS;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    database.close();
  };
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
      connection
        .prepare(
          `INSERT INTO api_client_keys(
             client_id, key_version, secret_fingerprint, activated_at, retired_at
           ) VALUES (?, 1, ?, ?, NULL)`,
        )
        .run(API_CLIENT_ID, "a".repeat(64), now);
    });
    await operation({
      database,
      databasePath,
      store: new OrderStore(
        database,
        () => now,
        options.checkoutKeyRotationMilliseconds,
        options.checkoutTerminalObservationMilliseconds,
      ),
      setNow(value) {
        now = value;
      },
      close,
    });
  } finally {
    close();
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
