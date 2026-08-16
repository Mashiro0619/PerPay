import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { OrderStore } from "../src/database/order-store.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../src/orders/checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import {
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
  orderEventDetailsFingerprint,
} from "../src/orders/model.ts";
import { digestIdempotencyKey } from "../src/orders/service.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const API_CLIENT_ID = "default";

describe("checkout token key lifecycle", () => {
  it("rejects startup when a retired checkout key no longer reproduces its token", async () => {
    await withDirectory("perpay-retired-checkout-key-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const database = await AppDatabase.open(databasePath);
      const rotationMilliseconds = 60_000;
      let now = database.read((connection) => {
        const key = connection
          .prepare(
            `SELECT activated_at
               FROM checkout_token_keys
              WHERE retired_at IS NULL`,
          )
          .get() as { activated_at: bigint | number };
        const clock = connection
          .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
          .get() as { last_now_ms: bigint | number };
        return Math.max(Number(key.activated_at), Number(clock.last_now_ms));
      });
      try {
        initializeApiClient(database, now);
        const store = new OrderStore(database, () => now, rotationMilliseconds);
        syncProfile(store, "https://qr.example.test/retired-key-tamper");
        const first = store.createOrder(createStoredOrderInput(
          "retired-key-first",
          "retired-key-first",
          1_000,
        ));
        assert.equal(first.kind, "created");
        if (first.kind !== "created") return;

        const activatedAt = database.read((connection) => Number((connection
          .prepare("SELECT activated_at FROM checkout_token_keys WHERE key_version = 1")
          .get() as { activated_at: bigint | number }).activated_at));
        now = activatedAt + rotationMilliseconds;
        const second = store.createOrder(createStoredOrderInput(
          "retired-key-second",
          "retired-key-second",
          2_000,
        ));
        assert.equal(second.kind, "created");
        assert.deepEqual(
          database.read((connection) => connection
            .prepare(
              `SELECT key_version, retired_at IS NULL AS active
                 FROM checkout_token_keys
                ORDER BY key_version`,
            )
            .all()
            .map((row) => {
              const typed = row as Record<string, bigint | number>;
              return [Number(typed.key_version), Number(typed.active)] as const;
            })),
          [[1, 0], [2, 1]],
        );
      } finally {
        database.close();
      }

      const raw = new DatabaseSync(databasePath);
      try {
        const trigger = raw
          .prepare(
            `SELECT sql
               FROM sqlite_schema
              WHERE type = 'trigger' AND name = 'checkout_token_keys_valid_update'`,
          )
          .get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        raw.exec("DROP TRIGGER checkout_token_keys_valid_update");
        try {
          const result = raw
            .prepare(
              `UPDATE checkout_token_keys
                  SET key_material = zeroblob(32)
                WHERE key_version = 1 AND retired_at IS NOT NULL`,
            )
            .run();
          assert.equal(Number(result.changes), 1);
        } finally {
          raw.exec(trigger.sql);
        }
      } finally {
        raw.close();
      }

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /checkout token key history does not match persisted checkout sessions/,
      );
    });
  });

  it("upgrades a populated schema 11 checkout without changing its token", async () => {
    await withDirectory("perpay-schema-11-checkout-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const fixture = createSchemaElevenCheckoutDatabase(databasePath);
      const preMigrationBackupPath =
        `${databasePath}.pre-migration-v11-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;

      const upgraded = await AppDatabase.open(databasePath);
      try {
        assert.equal(readSchemaVersion(upgraded), DATABASE_COMPATIBILITY.maximum);
        assert.deepEqual(
          upgraded.read((connection) => {
            const session = connection
              .prepare(
                `SELECT token_key_version, terminal_observation_milliseconds
                   FROM checkout_sessions
                  WHERE order_id = ?`,
              )
              .get(fixture.orderId) as Record<string, bigint | number>;
            const key = connection
              .prepare(
                `SELECT hex(key_material) AS key_material, retired_at
                   FROM checkout_token_keys
                  WHERE key_version = 1`,
              )
              .get() as { key_material: string; retired_at: bigint | number | null };
            return {
              tokenKeyVersion: Number(session.token_key_version),
              terminalObservationMilliseconds: Number(
                session.terminal_observation_milliseconds,
              ),
              keyMaterial: key.key_material,
              retiredAt: key.retired_at,
            };
          }),
          {
            tokenKeyVersion: 1,
            terminalObservationMilliseconds: 24 * 60 * 60 * 1_000,
            keyMaterial: fixture.keyMaterial.toString("hex").toUpperCase(),
            retiredAt: null,
          },
        );
        const store = new OrderStore(upgraded, () => fixture.now);
        assert.equal(
          store.orderById(API_CLIENT_ID, fixture.orderId)?.checkoutToken,
          fixture.checkoutToken,
        );
      } finally {
        upgraded.close();
      }

      assert.equal(existsSync(preMigrationBackupPath), true);
      const backup = new DatabaseSync(preMigrationBackupPath, {
        readOnly: true,
        enableForeignKeyConstraints: true,
        readBigInts: true,
      });
      try {
        assert.equal(readRawSchemaVersion(backup), 11);
        assert.equal(tableExists(backup, "checkout_token_key"), true);
        assert.equal(tableExists(backup, "checkout_token_keys"), false);
        assert.equal(
          (backup
            .prepare("SELECT token_digest FROM checkout_sessions WHERE order_id = ?")
            .get(fixture.orderId) as { token_digest: string }).token_digest,
          digestCheckoutToken(fixture.checkoutToken),
        );
        assert.equal(inspectDatabaseIntegrity(backup).ok, true);
      } finally {
        backup.close();
      }

      const restoredPath = join(directory, "restored-schema-11.sqlite3");
      copyFileSync(preMigrationBackupPath, restoredPath);
      const restored = await AppDatabase.open(restoredPath);
      try {
        assert.equal(readSchemaVersion(restored), DATABASE_COMPATIBILITY.maximum);
        const store = new OrderStore(restored, () => fixture.now);
        assert.equal(
          store.orderById(API_CLIENT_ID, fixture.orderId)?.checkoutToken,
          fixture.checkoutToken,
        );
      } finally {
        restored.close();
      }
    });
  });
});

function createSchemaElevenCheckoutDatabase(databasePath: string): {
  readonly checkoutToken: string;
  readonly keyMaterial: Buffer;
  readonly now: number;
  readonly orderId: string;
} {
  const connection = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    readBigInts: true,
  });
  try {
    connection.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const record = connection.prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, '2026-08-16T00:00:00.000Z')`,
    );
    for (const migration of migrations.slice(0, 11)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }

    const orderClock = connection
      .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
      .get() as { last_now_ms: bigint | number };
    const now = Number(orderClock.last_now_ms);
    const orderId = "30000000-0000-4000-8000-000000000001";
    const checkoutId = "30000000-0000-4000-8000-000000000002";
    const profileId = "30000000-0000-4000-8000-000000000003";
    const activationId = "30000000-0000-4000-8000-000000000004";
    const slotId = "30000000-0000-4000-8000-000000000005";
    const eventId = "30000000-0000-4000-8000-000000000006";
    const keyMaterial = Buffer.alloc(32, 11);
    const checkoutToken = deriveCheckoutToken(keyMaterial, checkoutId);
    const codePayload = "https://qr.example.test/schema-11-checkout";
    const profile = fingerprintCollectionCodeProfile(codePayload);
    const request = createOrderRequestSchema.parse({
      idempotency_key: "schema-11-checkout",
      merchant_order_no: "schema-11-checkout",
      amount_cents: 1_000,
    });
    const detailsJson = '{"amount_offset_cents":1,"slot_generation":1}';

    connection.prepare(
      `INSERT INTO api_client_config(
         singleton_key, client_id, secret_fingerprint, key_version,
         enabled, created_at, updated_at
       ) VALUES (1, ?, ?, 1, 1, ?, ?)`,
    ).run(API_CLIENT_ID, "a".repeat(64), now, now);
    connection.prepare(
      `INSERT INTO api_client_keys(
         client_id, key_version, secret_fingerprint, activated_at, retired_at
       ) VALUES (?, 1, ?, ?, NULL)`,
    ).run(API_CLIENT_ID, "a".repeat(64), now);
    connection.prepare(
      `INSERT INTO collection_profiles(
         profile_id, version, provider_account_key, code_payload,
         payload_fingerprint, profile_fingerprint, evidence_policy, created_at
       ) VALUES (?, 1, 'primary', ?, ?, ?, 'UNIQUE_AMOUNT_AUTO', ?)`,
    ).run(
      profileId,
      codePayload,
      profile.payloadFingerprint,
      profile.profileFingerprint,
      now,
    );
    connection.prepare(
      `INSERT INTO active_collection_profile(singleton_key, profile_id, activated_at)
       VALUES (1, ?, ?)`,
    ).run(profileId, now);
    connection.prepare(
      `INSERT INTO collection_profile_activations(
         activation_id, sequence, profile_id, previous_profile_id, activated_at, reason
       ) VALUES (?, 1, ?, NULL, ?, 'CONFIG_SYNC')`,
    ).run(activationId, profileId, now);
    connection.prepare(
      `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
       VALUES (1, ?, ?)`,
    ).run(keyMaterial, now);
    connection.prepare(
      `INSERT INTO payment_orders(
         order_id, api_client_id, merchant_order_no, idempotency_key_digest,
         idempotency_key_digest_version, request_fingerprint,
         request_fingerprint_version, webhook_target_request_fingerprint,
         requested_amount_cents, payable_amount_cents, allocation_offset_max_cents,
         received_amount_cents, currency, description, collection_profile_id,
         checkout_status, payment_status, refund_status, payment_basis,
         eligible_from, created_at, expires_at, closed_at, updated_at, version
       ) VALUES (
         ?, ?, ?, ?, 1, ?, 1, NULL,
         1000, 1001, 99, NULL, 'CNY', NULL, ?,
         'OPEN', 'UNPAID', 'NONE', 'NONE', ?, ?, ?, NULL, ?, 1
       )`,
    ).run(
      orderId,
      API_CLIENT_ID,
      request.merchant_order_no,
      digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
      fingerprintCreateOrderRequest(request),
      profileId,
      now,
      now,
      now + 60 * 60 * 1_000,
      now,
    );
    connection.prepare(
      "INSERT INTO checkout_sessions(checkout_id, order_id, token_digest) VALUES (?, ?, ?)",
    ).run(checkoutId, orderId, digestCheckoutToken(checkoutToken));
    connection.prepare(
      `INSERT INTO amount_slots(
         slot_id, order_id, collection_profile_id, payable_amount_cents,
         generation, occupied_from, released_at, release_reason
       ) VALUES (?, ?, ?, 1001, 1, ?, NULL, NULL)`,
    ).run(slotId, orderId, profileId, now);
    connection.prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at,
         details_json, details_fingerprint
       ) VALUES (?, ?, 1, 'CREATED', ?, ?, ?)`,
    ).run(eventId, orderId, now, detailsJson, orderEventDetailsFingerprint(detailsJson));

    return { checkoutToken, keyMaterial, now, orderId };
  } finally {
    connection.close();
  }
}

function initializeApiClient(database: AppDatabase, now: number): void {
  database.write((connection) => {
    connection.prepare(
      `INSERT INTO api_client_config(
         singleton_key, client_id, secret_fingerprint, key_version,
         enabled, created_at, updated_at
       ) VALUES (1, ?, ?, 1, 1, ?, ?)`,
    ).run(API_CLIENT_ID, "a".repeat(64), now, now);
    connection.prepare(
      `INSERT INTO api_client_keys(
         client_id, key_version, secret_fingerprint, activated_at, retired_at
       ) VALUES (?, 1, ?, ?, NULL)`,
    ).run(API_CLIENT_ID, "a".repeat(64), now);
  });
}

function syncProfile(store: OrderStore, codePayload: string): void {
  const profile = fingerprintCollectionCodeProfile(codePayload);
  store.syncCollectionProfile({
    codePayload,
    payloadFingerprint: profile.payloadFingerprint,
    profileFingerprint: profile.profileFingerprint,
  });
}

function createStoredOrderInput(
  idempotencyKey: string,
  merchantOrderNumber: string,
  amountCents: number,
) {
  const request = createOrderRequestSchema.parse({
    idempotency_key: idempotencyKey,
    merchant_order_no: merchantOrderNumber,
    amount_cents: amountCents,
  });
  return {
    apiClientId: API_CLIENT_ID,
    request,
    idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
    requestFingerprint: fingerprintCreateOrderRequest(request),
    ttlMilliseconds: 300_000,
    amountOffsetMaximumCents: 99,
  } as const;
}

function readSchemaVersion(database: AppDatabase): number {
  return database.read((connection) => readRawSchemaVersion(connection));
}

function readRawSchemaVersion(connection: DatabaseSync): number {
  const row = connection
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: bigint | number };
  return Number(row.version);
}

function tableExists(connection: DatabaseSync, tableName: string): boolean {
  return connection
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

async function withDirectory(
  prefix: string,
  operation: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    await operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
