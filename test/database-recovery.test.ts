import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { loadConfig, type AppConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { IdentityService } from "../src/identity/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";

const API_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const COLLECTION_CODE = "https://qr.local.invalid/recovery-test";

describe("database recovery boundaries", () => {
  it("rejects a missing migration-owned trigger even when migration checksums remain valid", async () => {
    await withDirectory("perpay-schema-catalog-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const database = await AppDatabase.open(databasePath);
      database.close();

      const raw = new DatabaseSync(databasePath);
      raw.exec("DROP TRIGGER payment_orders_snapshot_immutable");
      raw.close();

      await assert.rejects(() => AppDatabase.open(databasePath), /schema=invalid/);
    });
  });

  it("does not replace a lost checkout token key after orders exist", async () => {
    await withOrderDatabase("perpay-key-loss-", async ({ databasePath, close }) => {
      close();
      const raw = new DatabaseSync(databasePath);
      withTriggerDisabled(raw, "checkout_token_key_no_delete", () => {
        raw.exec("DELETE FROM checkout_token_key");
      });
      raw.close();

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /checkout token key is missing from a database that already contains orders/,
      );
    });
  });

  it("rejects a checkout key that cannot reproduce persisted token digests", async () => {
    await withOrderDatabase("perpay-key-mismatch-", async ({ databasePath, close }) => {
      close();
      const raw = new DatabaseSync(databasePath);
      withTriggerDisabled(raw, "checkout_token_key_no_update", () => {
        raw.exec("UPDATE checkout_token_key SET key_material = zeroblob(32)");
      });
      raw.close();

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /checkout token key does not match persisted checkout sessions/,
      );
    });
  });

  it("rejects a collection payload that no longer matches its persisted fingerprints", async () => {
    await withOrderDatabase("perpay-profile-mismatch-", async ({ databasePath, close }) => {
      close();
      const raw = new DatabaseSync(databasePath);
      withTriggerDisabled(raw, "collection_profiles_no_update", () => {
        raw.prepare("UPDATE collection_profiles SET code_payload = ?")
          .run("https://qr.local.invalid/tampered-payload");
      });
      raw.close();

      await assert.rejects(() => AppDatabase.open(databasePath), /domain_violations=1/);
    });
  });

  it("restores an order and its stable checkout token from a self-contained backup", async () => {
    await withOrderDatabase(
      "perpay-order-backup-",
      async ({ database, databasePath, config, order, close, directory }) => {
        const backupPath = join(directory, "backups", "order.sqlite3");
        await database.backupDetailed(backupPath);
        const backupNames = readdirSync(join(directory, "backups"));
        assert.deepEqual(backupNames, ["order.sqlite3"]);
        close();

        const restored = await AppDatabase.open(backupPath);
        try {
          const restoredOrders = new OrderService(restored, config);
          restoredOrders.initialize();
          const restoredOrder = restoredOrders.getByMerchantOrderNumber("default", "recovery-1");
          assert.equal(restoredOrder.orderId, order.orderId);
          assert.equal(restoredOrder.checkoutToken, order.checkoutToken);
        } finally {
          restored.close();
        }
        assert.equal(existsSync(`${databasePath}.pre-migration-v3-to-v3.sqlite3`), false);
      },
    );
  });

  it("upgrades a populated v2 database and publishes one restorable pre-migration backup", async () => {
    await withDirectory("perpay-v2-upgrade-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionTwoDatabase(databasePath);

      const upgraded = await AppDatabase.open(databasePath);
      try {
        const state = upgraded.read((connection) =>
          connection
            .prepare(
              `SELECT
                 (SELECT MAX(version) FROM schema_migrations) AS schema_version,
                 (SELECT COUNT(*) FROM admin_identity) AS administrators,
                 (SELECT COUNT(*) FROM admin_sessions) AS sessions,
                 (SELECT COUNT(*) FROM api_nonces) AS nonces,
                 (SELECT COUNT(*) FROM audit_events) AS audit_events,
                 (SELECT COUNT(*) FROM checkout_token_key) AS checkout_keys`,
            )
            .get() as Record<string, bigint | number>,
        );
        assert.deepEqual(
          Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Number(value)])),
          {
            schema_version: 3,
            administrators: 1,
            sessions: 1,
            nonces: 1,
            audit_events: 1,
            checkout_keys: 1,
          },
        );
      } finally {
        upgraded.close();
      }

      const backupPath = `${databasePath}.pre-migration-v2-to-v3.sqlite3`;
      assert.equal(existsSync(backupPath), true);
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number(
            (backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
              version: bigint;
            }).version,
          ),
          2,
        );
        assert.equal(
          Number(
            (backup.prepare("SELECT COUNT(*) AS count FROM admin_sessions").get() as {
              count: bigint;
            }).count,
          ),
          1,
        );
      } finally {
        backup.close();
      }
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.includes("pre-migration")),
        ["database.sqlite3.pre-migration-v2-to-v3.sqlite3"],
      );
    });
  });

  it("replaces one stable pre-migration backup instead of accumulating on restart failure", async () => {
    await withDirectory("perpay-migration-retry-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionTwoDatabase(databasePath);
      const migration = migrations[2] as { sql: string };
      const originalSql = migration.sql;
      migration.sql = `${originalSql}\nTHIS IS NOT VALID SQL;`;
      try {
        await assert.rejects(() => AppDatabase.open(databasePath), /database migration 3/);
        await assert.rejects(() => AppDatabase.open(databasePath), /database migration 3/);
      } finally {
        migration.sql = originalSql;
      }

      assert.deepEqual(
        readdirSync(directory).filter((name) => name.includes("pre-migration")),
        ["database.sqlite3.pre-migration-v2-to-v3.sqlite3"],
      );
    });
  });
});

async function withOrderDatabase(
  prefix: string,
  operation: (context: {
    readonly directory: string;
    readonly databasePath: string;
    readonly database: AppDatabase;
    readonly config: AppConfig;
    readonly order: ReturnType<OrderService["get"]>;
    readonly close: () => void;
  }) => Promise<void>,
): Promise<void> {
  await withDirectory(prefix, async (directory) => {
    const databasePath = join(directory, "database.sqlite3");
    const config = testConfig(directory);
    const database = await AppDatabase.open(databasePath);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      database.close();
    };
    try {
      const identity = new IdentityService(database, config);
      await identity.initialize();
      const orders = new OrderService(database, config);
      orders.initialize();
      const created = orders.create(
        "default",
        createOrderRequestSchema.parse({
          idempotency_key: "recovery-idempotency-1",
          merchant_order_no: "recovery-1",
          amount_cents: 10_000,
          description: "recovery boundary",
        }),
      );
      await operation({
        directory,
        databasePath,
        database,
        config,
        order: created.order,
        close,
      });
    } finally {
      close();
    }
  });
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

function testConfig(directory: string): AppConfig {
  return loadConfig({
    PERPAY_INITIAL_ADMIN_PASSWORD: "recovery-test-password-2026",
    PERPAY_API_SECRET: API_SECRET,
    PERPAY_COLLECTION_CODE_PAYLOAD: COLLECTION_CODE,
    PERPAY_DATA_DIR: directory,
  });
}

function createVersionTwoDatabase(databasePath: string): void {
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
       VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')`,
    );
    for (const migration of migrations.slice(0, 2)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }

    const now = 1_800_000_000_000;
    connection
      .prepare(
        `INSERT INTO admin_identity(
           singleton_key, username, password_hash, session_generation,
           password_changed_at, created_at, updated_at
         ) VALUES (1, 'admin', ?, 1, ?, ?, ?)`,
      )
      .run(`$perpay$scrypt$${"a".repeat(64)}`, now, now, now);
    connection
      .prepare(
        `INSERT INTO admin_sessions(
           session_id, admin_key, token_digest, csrf_digest, generation,
           created_at, last_seen_at, idle_expires_at, absolute_expires_at
         ) VALUES (?, 1, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        "b".repeat(64),
        "c".repeat(64),
        now,
        now,
        now + 60_000,
        now + 120_000,
      );
    connection
      .prepare(
        `INSERT INTO api_client_config(
           singleton_key, client_id, secret_fingerprint, key_version,
           enabled, created_at, updated_at
         ) VALUES (1, 'default', ?, 1, 1, ?, ?)`,
      )
      .run("d".repeat(64), now, now);
    connection
      .prepare(
        `INSERT INTO api_nonces(
           client_id, nonce, request_timestamp_seconds, expires_at, created_at
         ) VALUES ('default', ?, ?, ?, ?)`,
      )
      .run("A".repeat(43), 1_800_000_000, now + 301_000, now);
    connection
      .prepare(
        `INSERT INTO audit_events(
           event_id, occurred_at, actor_type, actor_id, action, outcome,
           subject_type, subject_id, request_id, remote_address_hash,
           details_json, previous_hash, event_hash
         ) VALUES (?, ?, 'SYSTEM', NULL, 'fixture.created', 'SUCCESS',
                   NULL, NULL, NULL, NULL, '{}', NULL, ?)`,
      )
      .run("22222222-2222-4222-8222-222222222222", now, "e".repeat(64));
  } finally {
    connection.close();
  }
}

function withTriggerDisabled(
  connection: DatabaseSync,
  triggerName: string,
  mutation: () => void,
): void {
  const row = connection
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
    .get(triggerName) as { sql: string } | undefined;
  assert.ok(row?.sql);
  connection.exec(`DROP TRIGGER ${triggerName}`);
  try {
    mutation();
  } finally {
    connection.exec(row.sql);
  }
}
