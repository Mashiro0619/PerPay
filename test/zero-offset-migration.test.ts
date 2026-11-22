import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { OrderStore } from "../src/database/order-store.ts";
import {
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
} from "../src/orders/model.ts";
import {
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
} from "../src/orders/service.ts";
import { seedFixedSite } from "./fixed-site-fixture.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

describe("zero-offset migration (v47 -> v48)", () => {
  it("upgrades a populated schema 47 database with active order children and unlocks zero-offset allocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-v48-migration-"));
    const databasePath = join(directory, "database.sqlite3");
    const now = 2_000_000_000_000;
    try {
      // Build an authentic schema 47 database with populated payment_orders, amount_slots, and order_events.
      const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readBigInts: true });
      try {
        legacy.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        const insertMigration = legacy.prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        );
        for (const migration of migrations) {
          if (migration.version > 47) continue;
          legacy.exec("BEGIN IMMEDIATE");
          try {
            legacy.exec(migration.sql);
            insertMigration.run(migration.version, migration.name, migrationChecksum(migration), now);
            legacy.exec("COMMIT");
          } catch (error) {
            legacy.exec("ROLLBACK");
            throw error;
          }
        }
      } finally {
        legacy.close();
      }

      // Open raw connection to seed a site + pre-existing +1 offset order with child rows under schema 47.
      const seededDb = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readBigInts: true });
      let preExistingOrderId = "";
      try {
        seededDb.prepare(
          "INSERT INTO checkout_token_keys(key_version, key_material, activated_at, retired_at) VALUES (1, ?, ?, NULL)",
        ).run(randomBytes(32), now);
        const owner = {
          instanceId: () => "11111111-1111-4111-8111-111111111111",
          read: <T>(fn: (c: DatabaseSync) => T) => fn(seededDb),
          write: <T>(fn: (c: DatabaseSync) => T) => {
            seededDb.exec("BEGIN IMMEDIATE");
            try {
              const result = fn(seededDb);
              seededDb.exec("COMMIT");
              return result;
            } catch (error) {
              seededDb.exec("ROLLBACK");
              throw error;
            }
          },
        };
        seedFixedSite(owner as unknown as AppDatabase, "site_v47", now);
        const legacyStore = new OrderStore(owner as unknown as AppDatabase, () => now);
        const payload = "https://qr.alipay.com/fkx_v47_upgrade";
        const { payloadFingerprint, profileFingerprint } = fingerprintCollectionCodeProfile(payload, "primary");
        legacyStore.syncCollectionProfile({
          providerAccountKey: "primary",
          codePayload: payload,
          payloadFingerprint,
          profileFingerprint,
        });
        const request = createOrderRequestSchema.parse({
          idempotency_key: "v47-idem",
          merchant_order_no: "v47-order",
          amount_cents: 500,
          product_name: "升级前订单",
        });
        const created = legacyStore.createOrder({
          apiClientId: "site_v47",
          request,
          idempotencyKeyDigest: digestIdempotencyKey("site_v47", request.idempotency_key),
          requestFingerprint: fingerprintCreateOrderRequest(request),
          ttlMilliseconds: 300_000,
          amountOffsetMaximumCents: 99,
        });
        assert.equal(created.kind, "created");
        if (created.kind !== "created") return;
        preExistingOrderId = created.aggregate.order.orderId;
        assert.equal(created.aggregate.order.payableAmountCents, 501);

        // Confirm schema 47 rejects 0-offset orders before migration.
        assert.throws(() => {
          const zeroRequest = createOrderRequestSchema.parse({
            idempotency_key: "v47-zero",
            merchant_order_no: "v47-zero",
            amount_cents: 1,
            product_name: "一分钱",
          });
          legacyStore.createOrder({
            apiClientId: "site_v47",
            request: zeroRequest,
            idempotencyKeyDigest: digestIdempotencyKey("site_v47", zeroRequest.idempotency_key),
            requestFingerprint: fingerprintCreateOrderRequest(zeroRequest),
            ttlMilliseconds: 300_000,
            amountOffsetMaximumCents: 0,
            allowZeroAmountOffset: true,
          });
        }, /CHECK constraint failed/i);
      } finally {
        seededDb.close();
      }

      // Now open with AppDatabase.open() which runs Migration v48 on the populated schema 47 database.
      const upgraded = await AppDatabase.open(databasePath);
      try {
        assert.equal(upgraded.integrityCheck().ok, true);
        const fkViolations = upgraded.read((c) => c.prepare("PRAGMA foreign_key_check").all());
        assert.deepEqual(fkViolations, []);
        const maxVersion = upgraded.read((c) =>
          Number((c.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: bigint }).v),
        );
        assert.equal(maxVersion, DATABASE_COMPATIBILITY.maximum);

        // Existing order, slot, and events survived migration untouched.
        const store = new OrderStore(upgraded, () => now + 1_000);
        const existing = store.orderById("site_v47", preExistingOrderId);
        assert.ok(existing);
        assert.equal(existing.order.payableAmountCents, 501);
        assert.equal(existing.order.merchantOrderNo, "v47-order");
        const eventCount = upgraded.read((c) =>
          Number((c.prepare("SELECT count(*) AS n FROM order_events WHERE order_id = ?").get(preExistingOrderId) as { n: bigint }).n),
        );
        assert.ok(eventCount >= 1);

        // Zero-offset exact-price order (¥0.01 -> ¥0.01) now succeeds after migration v48.
        const zeroRequest = createOrderRequestSchema.parse({
          idempotency_key: "v48-zero",
          merchant_order_no: "v48-zero",
          amount_cents: 1,
          product_name: "一分钱原价单",
        });
        const zeroCreated = store.createOrder({
          apiClientId: "site_v47",
          request: zeroRequest,
          idempotencyKeyDigest: digestIdempotencyKey("site_v47", zeroRequest.idempotency_key),
          requestFingerprint: fingerprintCreateOrderRequest(zeroRequest),
          ttlMilliseconds: 300_000,
          amountOffsetMaximumCents: 0,
          allowZeroAmountOffset: true,
        });
        assert.equal(zeroCreated.kind, "created");
        if (zeroCreated.kind !== "created") return;
        assert.equal(zeroCreated.aggregate.order.requestedAmountCents, 1);
        assert.equal(zeroCreated.aggregate.order.payableAmountCents, 1);
        assert.equal(upgraded.integrityCheck().ok, true);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
