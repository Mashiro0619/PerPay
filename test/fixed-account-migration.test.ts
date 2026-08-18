import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { ADMIN_USERNAME } from "../src/database/identity-store.ts";
import { API_CLIENT_ID } from "../src/settings/model.ts";
import { normalizeProviderIdentity } from "../src/ledger/model.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../src/orders/checkout-token.ts";
import { orderEventDetailsFingerprint } from "../src/orders/model.ts";
import { prepareWebhookTarget } from "../src/notifications/model.ts";
import { OrderStore } from "../src/database/order-store.ts";
import { digestIdempotencyKey } from "../src/orders/service.ts";
import {
  fingerprintCreateOrderRequest,
  type CreateOrderRequest,
} from "../src/orders/model.ts";

const provider = normalizeProviderIdentity({
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
});
const checkoutKey = Buffer.alloc(32, 0x44);
const LEGACY_NOTIFY_URL = "https://hooks.example.test/orders/paid?tenant=legacy";
const legacyRequest: CreateOrderRequest = Object.freeze({
  idempotency_key: "legacy-idempotency-key",
  merchant_order_no: "legacy-order",
  amount_cents: 1_000,
  notify_url: LEGACY_NOTIFY_URL,
});
const legacyWebhookTarget = prepareWebhookTarget(
  LEGACY_NOTIFY_URL,
  "https://hooks.example.test",
);

describe("fixed account namespace migration", () => {
  it("normalizes legacy administrator and API client identifiers without exposing secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-fixed-account-migration-"));
    const databasePath = join(directory, "database.sqlite3");
    createSchemaThirteenDatabase(databasePath);
    const database = await AppDatabase.open(databasePath);
    try {
      const state = database.read((connection) => ({
        admin: connection.prepare("SELECT username, password_hash, session_generation FROM admin_identity").get() as Record<string, unknown>,
        client: connection.prepare("SELECT client_id FROM api_client_config").get() as Record<string, unknown>,
        keyClients: connection.prepare("SELECT client_id FROM api_client_keys ORDER BY key_version").all() as Array<Record<string, unknown>>,
        nonceClients: connection.prepare("SELECT client_id FROM api_nonces").all() as Array<Record<string, unknown>>,
        orderClient: connection.prepare("SELECT api_client_id FROM payment_orders").get() as Record<string, unknown>,
        webhookClient: connection.prepare("SELECT api_client_id FROM webhook_targets").get() as Record<string, unknown>,
        legacyReferences: Number((connection.prepare(
          `SELECT
             (SELECT COUNT(*) FROM api_client_config WHERE client_id = 'legacy-client') +
             (SELECT COUNT(*) FROM api_client_keys WHERE client_id = 'legacy-client') +
             (SELECT COUNT(*) FROM api_nonces WHERE client_id = 'legacy-client') +
             (SELECT COUNT(*) FROM payment_orders WHERE api_client_id = 'legacy-client') +
             (SELECT COUNT(*) FROM webhook_targets WHERE api_client_id = 'legacy-client') AS count`,
        ).get() as { count: bigint }).count),
        schemaVersion: Number((connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: bigint }).version),
      }));
      assert.equal(state.admin.username, ADMIN_USERNAME);
      assert.equal(state.admin.password_hash, "$perpay$scrypt$" + "a".repeat(64));
      assert.equal(state.admin.session_generation, 7n);
      assert.equal(state.client.client_id, API_CLIENT_ID);
      assert.deepEqual(state.keyClients.map((row) => ({ client_id: String(row.client_id) })), [{ client_id: API_CLIENT_ID }]);
      assert.deepEqual(state.nonceClients.map((row) => ({ client_id: String(row.client_id) })), [{ client_id: API_CLIENT_ID }]);
      assert.equal(state.orderClient.api_client_id, API_CLIENT_ID);
      assert.equal(state.webhookClient.api_client_id, API_CLIENT_ID);
      assert.equal(state.legacyReferences, 0);
      assert.equal(state.schemaVersion, 14);
      assert.equal(database.integrityCheck().ok, true);
      const historicalOrder = new OrderStore(database).orderById(
        API_CLIENT_ID,
        "33333333-3333-4333-8333-333333333314",
      );
      assert.equal(historicalOrder?.order.merchantOrderNo, "legacy-order");
      assert.equal(historicalOrder?.webhookTarget?.apiClientId, API_CLIENT_ID);
      const replay = new OrderStore(database).createOrder({
        apiClientId: API_CLIENT_ID,
        request: legacyRequest,
        idempotencyKeyDigest: digestIdempotencyKey(
          API_CLIENT_ID,
          legacyRequest.idempotency_key,
        ),
        requestFingerprint: fingerprintCreateOrderRequest(legacyRequest),
        ttlMilliseconds: 300_000,
        amountOffsetMaximumCents: 99,
        webhookTarget: legacyWebhookTarget,
      }, () => {
        throw new Error("exact migrated replay must not attempt a new order");
      });
      assert.equal(replay.kind, "existing");
      if (replay.kind === "existing") {
        assert.equal(replay.aggregate.order.orderId, "33333333-3333-4333-8333-333333333314");
      }
      const changedRequest = { ...legacyRequest, amount_cents: 1_001 };
      const reusedLegacyKey = new OrderStore(database).createOrder({
        apiClientId: API_CLIENT_ID,
        request: changedRequest,
        idempotencyKeyDigest: digestIdempotencyKey(
          API_CLIENT_ID,
          changedRequest.idempotency_key,
        ),
        requestFingerprint: fingerprintCreateOrderRequest(changedRequest),
        ttlMilliseconds: 300_000,
        amountOffsetMaximumCents: 99,
        webhookTarget: legacyWebhookTarget,
      });
      assert.equal(reusedLegacyKey.kind, "idempotency_conflict");
      const differentIdempotencyKey = new OrderStore(database).createOrder({
        apiClientId: API_CLIENT_ID,
        request: { ...legacyRequest, idempotency_key: "different-idempotency-key" },
        idempotencyKeyDigest: digestIdempotencyKey(
          API_CLIENT_ID,
          "different-idempotency-key",
        ),
        requestFingerprint: fingerprintCreateOrderRequest({
          ...legacyRequest,
          idempotency_key: "different-idempotency-key",
        }),
        ttlMilliseconds: 300_000,
        amountOffsetMaximumCents: 99,
        webhookTarget: legacyWebhookTarget,
      });
      assert.equal(differentIdempotencyKey.kind, "merchant_order_conflict");
      assert.equal(database.read((connection) => connection.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE sql LIKE '%legacy-client-secret%'",
      ).get() as { count: bigint }).count, 0n);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createSchemaThirteenDatabase(databasePath: string): void {
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
       VALUES (?, ?, ?, '2026-08-19T00:00:00.000Z')`,
    );
    for (const migration of migrations.slice(0, 13)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    const now = Number((connection.prepare(
      "SELECT last_now_ms FROM order_clock WHERE singleton_key = 1",
    ).get() as { last_now_ms: bigint }).last_now_ms);
    connection.prepare(
      `INSERT INTO checkout_token_keys(
         key_version, key_material, activated_at, retired_at
       ) VALUES (1, ?, ?, NULL)`,
    ).run(checkoutKey, now);
    connection.prepare(
      `INSERT INTO provider_account_bindings(
         provider_account_key, provider_kind, provider_endpoint,
         external_account_id, identity_fingerprint_version,
         identity_fingerprint, bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      provider.providerAccountKey, provider.providerKind, provider.endpoint,
      provider.externalAccountId, provider.identityFingerprintVersion,
      provider.identityFingerprint, now,
    );
    const codePayload = "https://qr.example.test/legacy-primary";
    const profile = fingerprintCollectionCodeProfile(codePayload, provider.providerAccountKey);
    connection.prepare(
      `INSERT INTO collection_profiles(
         profile_id, version, provider_account_key, code_payload,
         payload_fingerprint, profile_fingerprint, evidence_policy, created_at
       ) VALUES (?, 1, ?, ?, ?, ?, 'UNIQUE_AMOUNT_AUTO', ?)`,
    ).run(
      "11111111-1111-4111-8111-111111111114", provider.providerAccountKey,
      codePayload, profile.payloadFingerprint, profile.profileFingerprint, now,
    );
    connection.prepare(
      `INSERT INTO active_collection_profile(singleton_key, profile_id, activated_at)
       VALUES (1, ?, ?)`,
    ).run("11111111-1111-4111-8111-111111111114", now);
    connection.prepare(
      `INSERT INTO collection_profile_activations(
         activation_id, sequence, profile_id, previous_profile_id,
         activated_at, reason
       ) VALUES (?, 1, ?, NULL, ?, 'CONFIG_SYNC')`,
    ).run(
      "22222222-2222-4222-8222-222222222214",
      "11111111-1111-4111-8111-111111111114", now,
    );
    connection.prepare(
      `INSERT INTO admin_identity(
         singleton_key, username, password_hash, session_generation,
         password_changed_at, created_at, updated_at
       ) VALUES (1, 'legacy-admin', ?, 7, ?, ?, ?)`,
    ).run("$perpay$scrypt$" + "a".repeat(64), now, now, now);
    connection.prepare(
      `INSERT INTO api_client_config(
         singleton_key, client_id, secret_fingerprint, key_version,
         enabled, created_at, updated_at
       ) VALUES (1, 'legacy-client', ?, 1, 1, ?, ?)`,
    ).run("b".repeat(64), now, now);
    connection.prepare(
      `INSERT INTO api_client_keys(
         client_id, key_version, secret_fingerprint, activated_at, retired_at
       ) VALUES ('legacy-client', 1, ?, ?, NULL)`,
    ).run("b".repeat(64), now);
    const requestTimestamp = Math.floor(now / 1_000);
    connection.prepare(
      `INSERT INTO api_nonces(
         client_id, key_version, nonce, request_timestamp_seconds,
         expires_at, created_at
       ) VALUES ('legacy-client', 1, ?, ?, ?, ?)`,
    ).run("A".repeat(43), requestTimestamp, requestTimestamp * 1_000 + 301_000, now);

    const orderId = "33333333-3333-4333-8333-333333333314";
    const checkoutId = "44444444-4444-4444-8444-444444444414";
    const targetId = "55555555-5555-4555-8555-555555555514";
    const slotId = "66666666-6666-4666-8666-666666666614";
    const eventId = "77777777-7777-4777-8777-777777777714";
    const target = legacyWebhookTarget;
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
         ?, 'legacy-client', 'legacy-order', ?, 1, ?, 1, ?,
         1000, 1001, 99, NULL, 'CNY', NULL, ?,
         'OPEN', 'UNPAID', 'NONE', 'NONE', ?, ?, ?, NULL, ?, 1
       )`,
    ).run(
      orderId,
      digestIdempotencyKey("legacy-client", legacyRequest.idempotency_key),
      fingerprintCreateOrderRequest(legacyRequest),
      target.requestFingerprint,
      "11111111-1111-4111-8111-111111111114", now, now, now + 300_000, now,
    );
    connection.prepare(
      `INSERT INTO webhook_targets(
         target_id, order_id, api_client_id, target_format, target_url,
         allowed_origin, url_fingerprint, request_fingerprint,
         request_fingerprint_version, created_at
       ) VALUES (?, ?, 'legacy-client', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      targetId, orderId, target.format, target.url, target.allowedOrigin,
      target.urlFingerprint, target.requestFingerprint,
      target.requestFingerprintVersion, now,
    );
    const checkoutToken = deriveCheckoutToken(checkoutKey, checkoutId);
    connection.prepare(
      `INSERT INTO checkout_sessions(
         checkout_id, order_id, token_digest, token_key_version,
         terminal_observation_milliseconds
       ) VALUES (?, ?, ?, 1, 86400000)`,
    ).run(checkoutId, orderId, digestCheckoutToken(checkoutToken));
    connection.prepare(
      `INSERT INTO amount_slots(
         slot_id, order_id, collection_profile_id, payable_amount_cents,
         generation, occupied_from, released_at, release_reason
       ) VALUES (?, ?, ?, 1001, 1, ?, NULL, NULL)`,
    ).run(slotId, orderId, "11111111-1111-4111-8111-111111111114", now);
    const eventDetails = '{"amount_offset_cents":1,"slot_generation":1}';
    connection.prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at,
         details_json, details_fingerprint
       ) VALUES (?, ?, 1, 'CREATED', ?, ?, ?)`,
    ).run(
      eventId, orderId, now, eventDetails,
      orderEventDetailsFingerprint(eventDetails),
    );
  } finally {
    connection.close();
  }
}
