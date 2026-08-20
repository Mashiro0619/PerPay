import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs, { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { loadConfig, type AppConfig } from "../src/config.ts";
import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { calculateAuditEventHash } from "../src/database/audit-chain.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { IdentityService } from "../src/identity/service.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import {
  conflictFingerprint,
  legacySemanticFingerprintV1,
  normalizeProviderIdentity,
  parseOccurredAtWithPrecision,
  payloadFingerprint,
  requestFingerprint,
  responseFingerprint,
  semanticFingerprint,
} from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { deriveCheckoutToken, digestCheckoutToken } from "../src/orders/checkout-token.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import { createOrderRequestSchema, orderEventDetailsFingerprint } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import {
  candidateEvidence,
  candidateFingerprint,
  financialExceptionDetailsFingerprint,
  financialExceptionFingerprint,
  financialExceptionResolutionFingerprint,
  financialOperationEvidence,
  financialOperationFingerprint,
  outboxPayloadFingerprint,
} from "../src/reconciliation/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import {
  parseProviderKeys,
  RuntimeSettingsService,
  RuntimeSettingsStore,
} from "../src/settings/index.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const API_SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const COLLECTION_CODE = "https://qr.local.invalid/recovery-test";
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;
const RECOVERY_APPLICATION_KEYS = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const RECOVERY_PLATFORM_KEYS = generateKeyPairSync("rsa", { modulusLength: 2_048 });

const LEGACY_API_NONCES_TABLE_SQL = migrationObjectSql(
  2,
  "table",
  "api_nonces",
);
const LEGACY_API_NONCES_INDEX_SQL = migrationObjectSql(
  2,
  "index",
  "api_nonces_expiry_idx",
);
const LEGACY_CHECKOUT_TOKEN_KEY_TABLE_SQL = migrationObjectSql(
  3,
  "table",
  "checkout_token_key",
);
const LEGACY_CHECKOUT_TOKEN_KEY_NO_UPDATE_SQL = migrationObjectSql(
  3,
  "trigger",
  "checkout_token_key_no_update",
);
const LEGACY_CHECKOUT_TOKEN_KEY_NO_DELETE_SQL = migrationObjectSql(
  3,
  "trigger",
  "checkout_token_key_no_delete",
);
const LEGACY_CHECKOUT_SESSIONS_TABLE_SQL = migrationObjectSql(
  3,
  "table",
  "checkout_sessions",
);
const LEGACY_CHECKOUT_SESSIONS_NO_UPDATE_SQL = migrationObjectSql(
  3,
  "trigger",
  "checkout_sessions_no_update",
);
const LEGACY_CHECKOUT_SESSIONS_NO_DELETE_SQL = migrationObjectSql(
  3,
  "trigger",
  "checkout_sessions_no_delete",
);
const LEGACY_LEDGER_CONFLICTS_TABLE_SQL = migrationObjectSql(
  4,
  "table",
  "ledger_conflicts",
);
const LEGACY_LEDGER_CONFLICTS_OPEN_INDEX_SQL = migrationObjectSql(
  4,
  "index",
  "ledger_conflicts_open_idx",
);
const LEGACY_LEDGER_CONFLICTS_VALID_INSERT_SQL = migrationObjectSql(
  4,
  "trigger",
  "ledger_conflicts_valid_insert",
);
const LEGACY_LEDGER_CONFLICTS_EVIDENCE_IMMUTABLE_SQL = migrationObjectSql(
  4,
  "trigger",
  "ledger_conflicts_evidence_immutable",
);
const LEGACY_LEDGER_CONFLICTS_RESOLUTION_CONSISTENT_SQL = migrationObjectSql(
  4,
  "trigger",
  "ledger_conflicts_resolution_consistent",
);
const LEGACY_LEDGER_CONFLICTS_NO_DELETE_SQL = migrationObjectSql(
  4,
  "trigger",
  "ledger_conflicts_no_delete",
);
const LEGACY_REJECTED_VARIANT_VALID_INSERT_SQL = migrationObjectSql(
  7,
  "trigger",
  "ingest_run_page_observations_rejected_variant_valid_insert",
);
const LEGACY_PAYMENT_MATCH_VALID_INSERT_SQL = migrationObjectSql(
  5,
  "trigger",
  "payment_matches_valid_insert",
);
const LEGACY_MATCH_CANDIDATE_VALID_INSERT_SQL = migrationObjectSql(
  5,
  "trigger",
  "match_candidates_valid_insert",
);
const LEGACY_PROVIDER_ACCOUNT_BINDINGS_TABLE_SQL = migrationObjectSql(
  4,
  "table",
  "provider_account_bindings",
);
const LEGACY_PROVIDER_ACCOUNT_BINDINGS_NO_UPDATE_SQL = migrationObjectSql(
  4,
  "trigger",
  "provider_account_bindings_no_update",
);
const LEGACY_PROVIDER_ACCOUNT_BINDINGS_NO_DELETE_SQL = migrationObjectSql(
  4,
  "trigger",
  "provider_account_bindings_no_delete",
);

describe("database recovery boundaries", () => {
  it("refuses to invent operation history for a terminal schema 12 ledger conflict", async () => {
    await withDirectory("perpay-schema-12-terminal-conflict-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      await createVersionTwelveTerminalConflictDatabase(
        databasePath,
        join(directory, "source.sqlite3"),
      );
      const backupPath =
        `${databasePath}.pre-migration-v12-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /database migration 13 \(ledger_conflict_operations\) failed/,
      );
      assert.equal(existsSync(backupPath), true);

      for (const path of [databasePath, backupPath]) {
        const raw = new DatabaseSync(path, { readOnly: true, readBigInts: true });
        try {
          assert.equal(
            Number((raw.prepare(
              "SELECT MAX(version) AS version FROM schema_migrations",
            ).get() as { version: bigint | number }).version),
            12,
          );
          assert.equal(
            Number((raw.prepare(
              "SELECT COUNT(*) AS count FROM ledger_conflicts WHERE status = 'IGNORED'",
            ).get() as { count: bigint | number }).count),
            1,
          );
          assert.equal(
            raw.prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_conflict_operations'",
            ).get(),
            undefined,
          );
        } finally {
          raw.close();
        }
      }
    });
  });

  it("rejects a conflict operation whose canonical request evidence was changed", async () => {
    await withDirectory("perpay-conflict-operation-tamper-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const database = await AppDatabase.open(databasePath);
      try {
        const store = new LedgerStore(database);
        const now = Date.now();
        store.bindProviderIdentity({
          providerAccountKey: "primary",
          providerKind: "alipay",
          endpoint: "https://openapi.alipay.com",
          externalAccountId: "2026000000000000",
        }, now);
        const conflict = recordInvalidAmountConflict(store, now, "operation-tamper");
        store.resolveConflict({
          conflictOperationId: randomUUID(),
          conflictId: conflict.conflictId,
          action: "ACKNOWLEDGE_ISOLATED",
          actorId: "admin",
          reason: "retain malformed provider evidence without posting it",
          now: now + 2,
        });
      } finally {
        database.close();
      }

      const raw = new DatabaseSync(databasePath);
      try {
        const trigger = raw.prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type = 'trigger' AND name = 'ledger_conflict_operations_no_update'`,
        ).get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        raw.exec("DROP TRIGGER ledger_conflict_operations_no_update");
        try {
          raw.exec("UPDATE ledger_conflict_operations SET request_json = '{}'");
        } finally {
          raw.exec(trigger.sql);
        }
      } finally {
        raw.close();
      }

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /domain_violations=[1-9][0-9]*/,
      );
    });
  });

  it("rejects a missing migration-owned trigger even when migration checksums remain valid", async () => {
    await withDirectory("perpay-schema-catalog-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const database = await AppDatabase.open(databasePath);
      database.close();

      const raw = new DatabaseSync(databasePath);
      raw.exec("DROP TRIGGER webhook_attempts_no_delete");
      raw.close();

      await assert.rejects(() => AppDatabase.open(databasePath), /schema=invalid/);
    });
  });

  it("does not replace a lost checkout token key after orders exist", async () => {
    await withOrderDatabase("perpay-key-loss-", async ({ databasePath, close }) => {
      close();
      const raw = new DatabaseSync(databasePath);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        withTriggerDisabled(raw, "checkout_token_keys_no_delete", () => {
          raw.exec("DELETE FROM checkout_token_keys");
        });
      } finally {
        raw.close();
      }

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
      withTriggerDisabled(raw, "checkout_token_keys_valid_update", () => {
        raw.exec("UPDATE checkout_token_keys SET key_material = zeroblob(32)");
      });
      raw.close();

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /checkout token key history does not match persisted checkout sessions/,
      );
    });
  });

  it("rejects a checkout session rebound to a different valid key version", async () => {
    await withOrderDatabase("perpay-key-version-tamper-", async ({ databasePath, close }) => {
      close();
      const raw = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        const active = raw
          .prepare(
            `SELECT key_version, activated_at
               FROM checkout_token_keys
              WHERE retired_at IS NULL`,
          )
          .get() as { key_version: bigint | number; activated_at: bigint | number };
        const version = Number(active.key_version);
        const rotatedAt = Number(active.activated_at) + 1;
        raw.exec("BEGIN IMMEDIATE");
        try {
          raw.prepare(
            "UPDATE checkout_token_keys SET retired_at = ? WHERE key_version = ?",
          ).run(rotatedAt, version);
          raw.prepare(
            `INSERT INTO checkout_token_keys(
               key_version, key_material, activated_at, retired_at
             ) VALUES (?, ?, ?, NULL)`,
          ).run(version + 1, Buffer.alloc(32, 9), rotatedAt);
          raw.exec("COMMIT");
        } catch (error) {
          if (raw.isTransaction) raw.exec("ROLLBACK");
          throw error;
        }
        withTriggerDisabled(raw, "checkout_sessions_no_update", () => {
          raw.prepare("UPDATE checkout_sessions SET token_key_version = ?")
            .run(version + 1);
        });
      } finally {
        raw.close();
      }

      await assert.rejects(
        () => AppDatabase.open(databasePath),
        /checkout token key history does not match persisted checkout sessions/,
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
           const restoredSettings = runtimeSettings(restored, config);
           restoredSettings.initialize();
           const restoredOrders = new OrderService(restored, () => restoredSettings.snapshot());
           restoredOrders.initialize();
           const restoredOrder = restoredOrders.getByMerchantOrderNumber("recovery-1");
          assert.equal(restoredOrder.orderId, order.orderId);
          assert.equal(restoredOrder.checkoutToken, order.checkoutToken);
        } finally {
          restored.close();
        }
        assert.equal(
          existsSync(
            `${databasePath}.pre-migration-v${DATABASE_COMPATIBILITY.maximum}-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`,
          ),
          false,
        );
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
                 (SELECT COUNT(*) FROM checkout_token_keys) AS checkout_keys`,
            )
            .get() as Record<string, bigint | number>,
        );
        assert.deepEqual(
          Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Number(value)])),
          {
            schema_version: DATABASE_COMPATIBILITY.maximum,
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

      const backupPath = `${databasePath}.pre-migration-v2-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
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
        [`database.sqlite3.pre-migration-v2-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`],
      );
    });
  });

  it("upgrades v4 fractional timestamps, verifies the backup, and preserves them after restart", async () => {
    await withDirectory("perpay-v4-upgrade-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionFourDatabase(databasePath);

      const database = await AppDatabase.open(databasePath);
      try {
        assert.equal(database.integrityCheck().ok, true);
        assert.deepEqual(
          database.read((connection) => (connection.prepare(
            `SELECT raw.occurred_at_text, entry.occurred_at_precision_ms
               FROM ledger_entries AS entry
               JOIN provider_raw_events AS raw ON raw.raw_event_id = entry.raw_event_id
              ORDER BY raw.ordinal`,
          ).all() as Array<{
            occurred_at_text: string;
            occurred_at_precision_ms: bigint | number;
          }>).map((row) => [row.occurred_at_text, Number(row.occurred_at_precision_ms)])),
          [
            ["2026-08-14 00:01:00.1", 100],
            ["2026-08-14 00:01:00.12", 10],
            ["2026-08-14 00:01:00.123", 1],
            ["2026-08-14 00:01:00", 1_000],
          ],
        );
        assert.deepEqual(
          database.read((connection) => ({ ...(connection.prepare(
            `SELECT disposition, observation_sequence, transition_enforced
               FROM ingest_run_page_observations`,
          ).get() as Record<string, unknown>) })),
          { disposition: "PROCESSED", observation_sequence: 1n, transition_enforced: 0n },
        );
      } finally {
        database.close();
      }
      assert.equal(
        existsSync(
          `${databasePath}.pre-migration-v4-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`,
        ),
        true,
      );
      const backup = new DatabaseSync(
        `${databasePath}.pre-migration-v4-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`,
        {
          readOnly: true,
          readBigInts: true,
        },
      );
      try {
        assert.equal(
          Number((backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
            version: bigint;
          }).version),
          4,
        );
        assert.equal(
          (backup.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get() as { count: bigint }).count,
          4n,
        );
        assert.equal(
          (backup.prepare("SELECT 1 FROM pragma_table_info('ledger_entries') WHERE name = 'occurred_at_precision_ms'").get() as unknown),
          undefined,
        );
      } finally {
        backup.close();
      }

      const reopened = await AppDatabase.open(databasePath);
      try {
        assert.equal(reopened.integrityCheck().ok, true);
        assert.deepEqual(
          reopened.read((connection) => (connection.prepare(
            "SELECT occurred_at_precision_ms FROM ledger_entries ORDER BY rowid",
          ).all() as Array<{ occurred_at_precision_ms: bigint | number }>).map((row) => Number(row.occurred_at_precision_ms))),
          [100, 10, 1, 1_000],
        );
      } finally {
        reopened.close();
      }
    });
  });

  it("upgrades ordered v6 page observations and keeps its verified backup on the old schema", async () => {
    await withDirectory("perpay-v6-upgrade-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionSixDatabase(databasePath);

      const upgraded = await AppDatabase.open(databasePath);
      try {
        assert.equal(upgraded.integrityCheck().ok, true);
        assert.deepEqual(
          upgraded.read((connection) => (connection.prepare(
            `SELECT disposition, observation_sequence, transition_enforced
               FROM ingest_run_page_observations
              ORDER BY observation_sequence`,
          ).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }))),
          [
            { disposition: "PROCESSED", observation_sequence: 1n, transition_enforced: 0n },
            { disposition: "PROCESSED", observation_sequence: 2n, transition_enforced: 0n },
          ],
        );
        const legacyDetails = upgraded.read((connection) => connection.prepare(
          `SELECT details_json
             FROM ledger_conflicts
            WHERE conflict_type = 'RAW_PAGE_VARIANT'`,
        ).get() as { details_json: string });
        upgraded.write((connection) => {
          withTriggerDisabled(connection, "ledger_conflicts_evidence_immutable", () => {
            connection.prepare(
              `UPDATE ledger_conflicts
                  SET details_json = json_set(
                        details_json,
                        '$.existing_raw_page_id',
                        json_extract(details_json, '$.incoming_raw_page_id')
                      )
                WHERE conflict_type = 'RAW_PAGE_VARIANT'`,
            ).run();
          });
        });
        assert.equal(upgraded.integrityCheck().ok, false);
        upgraded.write((connection) => {
          withTriggerDisabled(connection, "ledger_conflicts_evidence_immutable", () => {
            connection.prepare(
              `UPDATE ledger_conflicts
                  SET details_json = ?
                WHERE conflict_type = 'RAW_PAGE_VARIANT'`,
            ).run(legacyDetails.details_json);
          });
        });
        assert.equal(upgraded.integrityCheck().ok, true);
        upgraded.write((connection) => {
          withTriggerDisabled(connection, "ledger_conflicts_evidence_immutable", () => {
            connection.prepare(
              `UPDATE ledger_conflicts
                  SET details_json = json_set(?, '$.unexpected', 1)
                WHERE conflict_type = 'RAW_PAGE_VARIANT'`,
            ).run(legacyDetails.details_json);
          });
        });
        assert.equal(upgraded.integrityCheck().ok, false);
      } finally {
        upgraded.close();
      }

      const backupPath = `${databasePath}.pre-migration-v6-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
      assert.equal(existsSync(backupPath), true);
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number((backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
            version: bigint;
          }).version),
          6,
        );
        assert.equal(
          backup.prepare(
            "SELECT 1 FROM pragma_table_info('ingest_run_page_observations') WHERE name = 'disposition'",
          ).get(),
          undefined,
        );
        assert.equal(
          backup.prepare(
            "SELECT 1 FROM pragma_table_info('ingest_run_page_observations') WHERE name = 'transition_enforced'",
          ).get(),
          undefined,
        );
        assert.equal(
          (backup.prepare("SELECT COUNT(*) AS count FROM ingest_run_page_observations").get() as {
            count: bigint;
          }).count,
          2n,
        );
      } finally {
        backup.close();
      }
    });
  });

  it("upgrades schema v7 to the sequenced settlement history and preserves a v7 backup", async () => {
    await withDirectory("perpay-v7-upgrade-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionSevenDatabase(databasePath);

      const upgraded = await AppDatabase.open(databasePath);
      try {
        assert.equal(upgraded.integrityCheck().ok, true);
        upgraded.read((connection) => {
          assert.equal(
            Number((connection.prepare(
              "SELECT MAX(version) AS version FROM schema_migrations",
            ).get() as { version: bigint | number }).version),
            DATABASE_COMPATIBILITY.maximum,
          );
          assert.ok(connection.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'payment_match_events_history_idx'",
          ).get());
          assert.ok(connection.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'payment_match_events'",
          ).get());
          assert.ok(connection.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'payment_matches_event_status_update'",
          ).get());
        });
      } finally {
        upgraded.close();
      }

      const backupPath = `${databasePath}.pre-migration-v7-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
      assert.equal(existsSync(backupPath), true);
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number((backup.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint }).version),
          7,
        );
        assert.equal(
          backup.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'payment_matches_review_queue_idx'",
          ).get(),
          undefined,
        );
      } finally {
        backup.close();
      }
    });
  });

  it("backfills the v9 audit anchor and immutable evidence fingerprints", async () => {
    await withDirectory("perpay-v8-evidence-upgrade-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      const fixture = createVersionEightEvidenceDatabase(databasePath);

      const upgraded = await AppDatabase.open(databasePath);
      try {
        const state = upgraded.read((connection) => ({
          schemaVersion: Number((connection.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          anchor: connection.prepare(
            `SELECT event_count, last_sequence, last_event_hash
               FROM audit_chain_state WHERE singleton_key = 1`,
          ).get() as {
            event_count: bigint | number;
            last_sequence: bigint | number;
            last_event_hash: string;
          },
          orderEvents: connection.prepare(
            "SELECT event_id, details_json, details_fingerprint FROM order_events ORDER BY event_id",
          ).all() as Array<{
            event_id: string;
            details_json: string;
            details_fingerprint: string;
          }>,
          exceptions: connection.prepare(
            `SELECT context_key, details_json, details_fingerprint,
                    resolution_json, resolution_fingerprint
               FROM financial_exceptions
              ORDER BY context_key`,
          ).all() as Array<{
            context_key: string;
            details_json: string;
            details_fingerprint: string;
            resolution_json: string | null;
            resolution_fingerprint: string | null;
          }>,
        }));

        assert.equal(state.schemaVersion, DATABASE_COMPATIBILITY.maximum);
        assert.deepEqual(
          {
            eventCount: Number(state.anchor.event_count),
            lastSequence: Number(state.anchor.last_sequence),
            lastEventHash: state.anchor.last_event_hash,
          },
          { eventCount: 2, lastSequence: 2, lastEventHash: fixture.auditEventHash },
        );
        assert.equal(state.orderEvents.length, 3);
        assert.deepEqual(
          state.orderEvents.map((event) => event.event_id),
          [...fixture.orderEventIds],
        );
        for (const event of state.orderEvents) {
          assert.equal(
            event.details_fingerprint,
            orderEventDetailsFingerprint(event.details_json),
          );
        }
        assert.equal(state.exceptions.length, 2);
        for (const exception of state.exceptions) {
          assert.equal(
            exception.details_fingerprint,
            financialExceptionDetailsFingerprint(exception.details_json),
          );
          assert.equal(
            exception.resolution_fingerprint,
            exception.resolution_json === null
              ? null
              : financialExceptionResolutionFingerprint(exception.resolution_json),
          );
        }
        assert.equal(upgraded.integrityCheck().ok, true);
      } finally {
        upgraded.close();
      }

      const backupPath = `${databasePath}.pre-migration-v8-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
      assert.equal(existsSync(backupPath), true);
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number((backup.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          8,
        );
        assert.equal(
          backup.prepare(
            "SELECT 1 FROM pragma_table_info('order_events') WHERE name = 'details_fingerprint'",
          ).get(),
          undefined,
        );
        assert.equal(inspectDatabaseIntegrity(backup).ok, true);
      } finally {
        backup.close();
      }
    });
  });

  it("repairs a settled v9 ledger state overwritten by a provider conflict and keeps backups restorable", async () => {
    await withOrderDatabase("perpay-v9-financial-state-repair-", async (context) => {
      const { database, databasePath, directory, order, settings, close } = context;
      const ledger = new LedgerStore(database);
      const providerAccountKey = settings.snapshot().activeProviderAccountKey;
      if (!providerAccountKey) throw new Error("recovery provider account is missing");
      const entry = recordRecoveryCredit(
        ledger,
        "v9-settled-provider-conflict",
        order.payableAmountCents,
        Math.ceil((order.createdAt + 1_000) / 1_000) * 1_000,
        order.createdAt + 2_000,
        providerAccountKey,
      );
      const reconciliation = new ReconciliationStore(database);
      const settlement = reconciliation.reconcileEntry(
        entry.ledgerEntryId,
        order.createdAt + 4_000,
      );
      assert.equal(settlement.kind, "auto_settled");
      assert.equal(
        database.read((connection) => (connection.prepare(
          "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
        ).get(entry.ledgerEntryId) as { state: string }).state),
        "ALLOCATED",
      );
      close();

      const legacy = new DatabaseSync(databasePath, {
        enableForeignKeyConstraints: true,
        readBigInts: true,
      });
      try {
        legacy.exec(`
          DROP TRIGGER payment_orders_product_metadata_immutable;
          DROP TRIGGER payment_orders_product_metadata_insert_guard;
          DROP TRIGGER payment_orders_snapshot_immutable;
          ALTER TABLE payment_orders RENAME COLUMN product_name TO description;
          ALTER TABLE payment_orders DROP COLUMN note;
          ALTER TABLE payment_orders DROP COLUMN note_fingerprint;
          ALTER TABLE payment_orders DROP COLUMN note_fingerprint_version;
          ${migrationObjectSql(3, "trigger", "payment_orders_snapshot_immutable")};

          DROP TRIGGER ledger_conflict_operations_no_delete;
          DROP TRIGGER ledger_conflict_operations_no_update;
          DROP TRIGGER ledger_conflict_operations_apply;
          DROP TRIGGER ledger_conflict_operations_valid_insert;
          DROP TRIGGER ledger_conflicts_resolution_transition;
          DROP TRIGGER ledger_conflicts_resolution_valid_insert;
          DROP INDEX ledger_conflicts_resolution_operation_unique;
          DROP TRIGGER ledger_conflicts_no_delete;
          DROP TRIGGER ledger_conflicts_evidence_immutable;
          DROP TRIGGER ledger_conflicts_valid_insert;
          DROP INDEX ledger_conflicts_open_idx;
          DROP TRIGGER payment_matches_valid_insert;
          DROP TRIGGER ingest_run_page_observations_rejected_variant_valid_insert;

          ALTER TABLE ledger_conflicts RENAME TO ledger_conflicts_v13;
          ${LEGACY_LEDGER_CONFLICTS_TABLE_SQL};

          INSERT INTO ledger_conflicts(
            conflict_id, provider_account_key, conflict_type, raw_page_id,
            raw_event_id, existing_ledger_entry_id, external_event_id,
            existing_semantic_fingerprint, incoming_semantic_fingerprint,
            details_json, status, resolution_json, created_at, resolved_at,
            conflict_fingerprint
          )
          SELECT conflict_id, provider_account_key, conflict_type, raw_page_id,
                 raw_event_id, existing_ledger_entry_id, external_event_id,
                 existing_semantic_fingerprint, incoming_semantic_fingerprint,
                 details_json, status, resolution_json, created_at, resolved_at,
                 conflict_fingerprint
            FROM ledger_conflicts_v13;

          DROP TABLE ledger_conflict_operations;
          DROP TABLE ledger_conflicts_v13;

          ${LEGACY_LEDGER_CONFLICTS_OPEN_INDEX_SQL};
          ${LEGACY_LEDGER_CONFLICTS_VALID_INSERT_SQL};
          ${LEGACY_LEDGER_CONFLICTS_EVIDENCE_IMMUTABLE_SQL};
          ${LEGACY_LEDGER_CONFLICTS_RESOLUTION_CONSISTENT_SQL};
          ${LEGACY_LEDGER_CONFLICTS_NO_DELETE_SQL};
          ${LEGACY_PAYMENT_MATCH_VALID_INSERT_SQL};
          ${LEGACY_REJECTED_VARIANT_VALID_INSERT_SQL};

          DROP TRIGGER api_client_config_key_transition;
          DROP TRIGGER api_client_keys_no_delete;
          DROP TRIGGER api_client_keys_valid_update;
          DROP TRIGGER api_client_keys_monotonic_insert;
          DROP INDEX api_client_keys_one_active;
          DROP INDEX api_nonces_expiry_idx;
          ALTER TABLE api_nonces RENAME TO api_nonces_v11;

          ${LEGACY_API_NONCES_TABLE_SQL};

          INSERT INTO api_nonces(
            client_id, nonce, request_timestamp_seconds, expires_at, created_at
          )
          SELECT client_id, nonce, request_timestamp_seconds, expires_at, created_at
            FROM api_nonces_v11;

          DROP TABLE api_nonces_v11;
          ${LEGACY_API_NONCES_INDEX_SQL};
          DROP TABLE api_client_keys;

          DROP TRIGGER checkout_sessions_no_update;
          DROP TRIGGER checkout_sessions_no_delete;
          ALTER TABLE checkout_sessions RENAME TO checkout_sessions_v12;

          ${LEGACY_CHECKOUT_TOKEN_KEY_TABLE_SQL};

          INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
          SELECT 1, key_material, activated_at
            FROM checkout_token_keys
           WHERE key_version = 1;

          ${LEGACY_CHECKOUT_SESSIONS_TABLE_SQL};

          INSERT INTO checkout_sessions(checkout_id, order_id, token_digest)
          SELECT checkout_id, order_id, token_digest
            FROM checkout_sessions_v12;

          DROP TABLE checkout_sessions_v12;
          DROP TRIGGER checkout_token_keys_no_delete;
          DROP TRIGGER checkout_token_keys_valid_update;
          DROP TRIGGER checkout_token_keys_monotonic_insert;
          DROP INDEX checkout_token_keys_one_active;
          DROP TABLE checkout_token_keys;
          ${LEGACY_CHECKOUT_TOKEN_KEY_NO_UPDATE_SQL};
          ${LEGACY_CHECKOUT_TOKEN_KEY_NO_DELETE_SQL};
          ${LEGACY_CHECKOUT_SESSIONS_NO_UPDATE_SQL};
          ${LEGACY_CHECKOUT_SESSIONS_NO_DELETE_SQL};

          DROP TRIGGER api_client_idempotency_namespaces_no_delete;
          DROP TRIGGER api_client_idempotency_namespaces_no_update;
          DROP TABLE api_client_idempotency_namespaces;
          DROP TRIGGER runtime_master_key_guard_no_delete;
          DROP TRIGGER runtime_master_key_guard_no_update;
          DROP TABLE runtime_master_key_guard;
          DROP TRIGGER runtime_secrets_no_delete;
          DROP TRIGGER runtime_secrets_version_guard;
          DROP TABLE runtime_secrets;
          DROP TRIGGER runtime_configuration_no_delete;
          DROP TRIGGER runtime_configuration_revision_guard;
          DROP TABLE runtime_configuration;
          DROP TRIGGER collection_profile_provider_accounts_no_delete;
          DROP TRIGGER collection_profile_provider_accounts_no_update;
          DROP TABLE collection_profile_provider_accounts;
          DROP VIEW active_provider_account;
          DROP TRIGGER provider_account_activations_no_delete;
          DROP TRIGGER provider_account_activations_no_update;
          DROP TRIGGER provider_account_activations_valid_insert;
          DROP TABLE provider_account_activations;
          DROP TRIGGER match_candidates_valid_insert;
          ${LEGACY_MATCH_CANDIDATE_VALID_INSERT_SQL};

          DROP TRIGGER provider_account_bindings_no_delete;
          DROP TRIGGER provider_account_bindings_no_update;
          ALTER TABLE provider_account_bindings RENAME TO provider_account_bindings_v14;
          ${LEGACY_PROVIDER_ACCOUNT_BINDINGS_TABLE_SQL};
          INSERT INTO provider_account_bindings(
            provider_account_key, provider_kind, provider_endpoint,
            external_account_id, identity_fingerprint_version,
            identity_fingerprint, bound_at
          )
          SELECT provider_account_key, provider_kind, provider_endpoint,
                 external_account_id, identity_fingerprint_version,
                 identity_fingerprint, bound_at
            FROM provider_account_bindings_v14
           WHERE provider_account_key = 'primary';
          DROP TABLE provider_account_bindings_v14;
          ${LEGACY_PROVIDER_ACCOUNT_BINDINGS_NO_UPDATE_SQL};
          ${LEGACY_PROVIDER_ACCOUNT_BINDINGS_NO_DELETE_SQL};
        `);
        legacy.prepare("DELETE FROM schema_migrations WHERE version >= 10").run();
        legacy.prepare(
          "UPDATE ledger_entries SET state = 'CONFLICT', updated_at = ? WHERE ledger_entry_id = ?",
        ).run(order.createdAt + 6_000, entry.ledgerEntryId);

        const incomingSemanticFingerprint = "f".repeat(64);
        legacy.prepare(
          `INSERT INTO ledger_conflicts(
             conflict_id, provider_account_key, conflict_type, raw_page_id,
             raw_event_id, existing_ledger_entry_id, external_event_id,
             existing_semantic_fingerprint, incoming_semantic_fingerprint,
             details_json, status, resolution_json, created_at, resolved_at,
             conflict_fingerprint
           ) VALUES (
             '20000000-0000-4000-8000-000000000001', 'primary',
             'DUPLICATE_EXTERNAL_ID', NULL, NULL, ?, ?, ?, ?, ?,
             'OPEN', NULL, ?, NULL, ?
           )`,
        ).run(
          entry.ledgerEntryId,
          entry.externalEventId,
          entry.semanticFingerprint,
          incomingSemanticFingerprint,
          JSON.stringify({
            reason: "legacy provider conflict overwrote the ledger state",
            existing_occurred_at_precision_milliseconds:
              entry.occurredAtPrecisionMilliseconds,
            incoming_occurred_at_precision_milliseconds:
              entry.occurredAtPrecisionMilliseconds,
          }),
          order.createdAt + 6_000,
          conflictFingerprint([
            "DUPLICATE_EXTERNAL_ID",
            entry.externalEventId,
            entry.semanticFingerprint,
            incomingSemanticFingerprint,
            entry.occurredAtPrecisionMilliseconds,
            entry.occurredAtPrecisionMilliseconds,
          ]),
        );

        assert.equal(
          Number((legacy.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          9,
        );
        const legacyIntegrity = inspectDatabaseIntegrity(legacy);
        const legacyNonceSchema = legacy.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'api_nonces'",
        ).get() as { sql: string };
        assert.equal(
          legacyIntegrity.ok,
          true,
          JSON.stringify({ legacyIntegrity, legacyNonceSchema: legacyNonceSchema.sql }),
        );
      } finally {
        legacy.close();
      }

      const upgraded = await AppDatabase.open(databasePath);
      const backupPath = join(directory, "backups", "post-v10-repair.sqlite3");
      try {
        assert.equal(
          upgraded.read((connection) => Number((connection.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version)),
          DATABASE_COMPATIBILITY.maximum,
        );
        assert.equal(
          upgraded.read((connection) => (connection.prepare(
            "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          ).get(entry.ledgerEntryId) as { state: string }).state),
          "ALLOCATED",
        );
        assert.equal(upgraded.integrityCheck().ok, true);
        await upgraded.backupDetailed(backupPath);
      } finally {
        upgraded.close();
      }

      const preMigrationBackupPath =
        `${databasePath}.pre-migration-v9-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
      const preMigrationBackup = new DatabaseSync(preMigrationBackupPath, {
        readOnly: true,
        readBigInts: true,
      });
      try {
        assert.equal(
          Number((preMigrationBackup.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          9,
        );
        assert.equal(
          (preMigrationBackup.prepare(
            "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          ).get(entry.ledgerEntryId) as { state: string }).state,
          "CONFLICT",
        );
        assert.equal(inspectDatabaseIntegrity(preMigrationBackup).ok, true);
      } finally {
        preMigrationBackup.close();
      }

      const migrationRestorePath = join(directory, "restored-v9.sqlite3");
      fs.copyFileSync(preMigrationBackupPath, migrationRestorePath);
      const migratedRestore = await AppDatabase.open(migrationRestorePath);
      try {
        assert.equal(migratedRestore.integrityCheck().ok, true);
        assert.equal(
          migratedRestore.read((connection) => (connection.prepare(
            "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          ).get(entry.ledgerEntryId) as { state: string }).state),
          "ALLOCATED",
        );
      } finally {
        migratedRestore.close();
      }

      const restored = await AppDatabase.open(backupPath);
      try {
        assert.equal(restored.integrityCheck().ok, true);
        assert.equal(
          restored.read((connection) => (connection.prepare(
            "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          ).get(entry.ledgerEntryId) as { state: string }).state),
          "ALLOCATED",
        );
      } finally {
        restored.close();
      }
    });
  });

  it("rolls back every v9 change when evidence backfill fails partway", async () => {
    await withDirectory("perpay-v9-backfill-rollback-", async (directory) => {
      const databasePath = join(directory, "database.sqlite3");
      createVersionEightEvidenceDatabase(databasePath);
      const migration = migrations[8] as { sql: string };
      const originalSql = migration.sql;
      migration.sql = `${originalSql}
        CREATE TRIGGER injected_v9_backfill_failure
        BEFORE UPDATE OF details_fingerprint ON financial_exceptions
        BEGIN
          SELECT RAISE(ABORT, 'injected v9 backfill failure');
        END;
      `;
      try {
        await assert.rejects(
          () => AppDatabase.open(databasePath),
          /database migration 9 \(audit_anchor_and_evidence_fingerprints\) failed/,
        );
      } finally {
        migration.sql = originalSql;
      }

      const unchanged = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number((unchanged.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          8,
        );
        assert.equal(
          unchanged.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'audit_chain_state'",
          ).get(),
          undefined,
        );
        assert.equal(
          unchanged.prepare(
            "SELECT 1 FROM pragma_table_info('order_events') WHERE name = 'details_fingerprint'",
          ).get(),
          undefined,
        );
        assert.equal(
          Number((unchanged.prepare(
            `SELECT COUNT(*) AS count
               FROM sqlite_schema
              WHERE type = 'trigger'
                AND name IN (
                  'order_events_no_update',
                  'financial_exceptions_evidence_immutable',
                  'financial_exceptions_resolution_once'
                )`,
          ).get() as { count: bigint | number }).count),
          3,
        );
        assert.equal(inspectDatabaseIntegrity(unchanged).ok, true);
      } finally {
        unchanged.close();
      }

      const backupPath = `${databasePath}.pre-migration-v8-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`;
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(
          Number((backup.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version),
          8,
        );
        assert.equal(inspectDatabaseIntegrity(backup).ok, true);
      } finally {
        backup.close();
      }

      const recovered = await AppDatabase.open(databasePath);
      try {
        assert.equal(recovered.integrityCheck().ok, true);
        assert.equal(
          recovered.read((connection) => Number((connection.prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          ).get() as { version: bigint | number }).version)),
          DATABASE_COMPATIBILITY.maximum,
        );
      } finally {
        recovered.close();
      }
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
        [`database.sqlite3.pre-migration-v2-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`],
      );
    });
  });

  it("does not migrate when either pre-migration backup publication cannot be synced", async () => {
    for (const failingDirectorySync of [1, 2]) {
      await withDirectory(`perpay-migration-fsync-${failingDirectorySync}-`, async (directory) => {
        const databasePath = join(directory, "database.sqlite3");
        createVersionTwoDatabase(databasePath);

        const originalFsyncSync = fs.fsyncSync;
        let directorySyncs = 0;
        const hookedFsyncSync = ((fileDescriptor: number) => {
          if (fs.fstatSync(fileDescriptor).isDirectory()) {
            directorySyncs += 1;
            if (directorySyncs === failingDirectorySync) {
              throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
            }
          }
          return originalFsyncSync(fileDescriptor);
        }) as typeof fs.fsyncSync;
        assert.equal(Reflect.set(fs, "fsyncSync", hookedFsyncSync), true);
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            () => AppDatabase.open(databasePath),
            /injected directory fsync failure/,
          );
        } finally {
          assert.equal(Reflect.set(fs, "fsyncSync", originalFsyncSync), true);
          syncBuiltinESMExports();
        }
        assert.equal(directorySyncs, failingDirectorySync);

        const unchanged = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true });
        try {
          assert.equal(
            Number((unchanged.prepare(
              "SELECT MAX(version) AS version FROM schema_migrations",
            ).get() as { version: bigint }).version),
            2,
          );
          assert.equal(
            Number((unchanged.prepare(
              "SELECT COUNT(*) AS count FROM app_lease",
            ).get() as { count: bigint }).count),
            0,
          );
        } finally {
          unchanged.close();
        }
        const backupNames = readdirSync(directory)
          .filter((name) => name.includes("pre-migration"));
        assert.deepEqual(
          backupNames,
          failingDirectorySync === 1
            ? []
            : [`database.sqlite3.pre-migration-v2-to-v${DATABASE_COMPATIBILITY.maximum}.sqlite3`],
        );
      });
    }
  });
});

async function withOrderDatabase(
  prefix: string,
  operation: (context: {
    readonly directory: string;
    readonly databasePath: string;
    readonly database: AppDatabase;
    readonly config: AppConfig;
    readonly settings: RuntimeSettingsService;
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
       const settings = configureRuntimeSettings(database, config);
       const orders = new OrderService(database, () => settings.snapshot());
       orders.initialize();
       const created = orders.create(
         createOrderRequestSchema.parse({
          idempotency_key: "recovery-idempotency-1",
          merchant_order_no: "recovery-1",
          amount_cents: 10_000,
          product_name: "recovery boundary",
        }),
      );
      await operation({
        directory,
        databasePath,
        database,
        config,
        settings,
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
    PERPAY_MASTER_KEY: "31".repeat(32),
    PERPAY_DATA_DIR: join(directory, "data"),
    PERPAY_BACKUP_DIR: join(directory, "backup-volume"),
  });
}

function runtimeSettings(
  database: AppDatabase,
  config: AppConfig,
): RuntimeSettingsService {
  return new RuntimeSettingsService({
    store: new RuntimeSettingsStore(database, config.masterKey),
  });
}

function configureRuntimeSettings(
  database: AppDatabase,
  config: AppConfig,
): RuntimeSettingsService {
  const store = new RuntimeSettingsStore(database, config.masterKey);
  store.initialize();
  const audit = {
    actorId: "admin",
    requestId: "database-recovery-settings",
    remoteAddressHash: "a".repeat(64),
  };
  store.saveCollection({
    revision: 0,
    code_payload: COLLECTION_CODE,
    order_ttl_seconds: 300,
    amount_offset_maximum_cents: 99,
  }, audit);
  const provider = parseProviderKeys({
    environment: "PRODUCTION",
    appId: PROVIDER_IDENTITY.externalAccountId,
    privateKey: RECOVERY_APPLICATION_KEYS.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKey: RECOVERY_PLATFORM_KEYS.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    timeoutMilliseconds: 8_000,
    scanIntervalMilliseconds: 10_000,
    safetyLagMilliseconds: 10_000,
    maximumSuccessAgeMilliseconds: 60_000,
  });
  store.saveProvider({
    expectedRevision: 1,
    accountKey: "primary",
    environment: provider.environment,
    appId: provider.appId,
    privateKeyPem: provider.privateKeyPem,
    publicKeyPem: provider.publicKeyPem,
    privateKeyFingerprint: provider.applicationKeyFingerprint,
    publicKeyFingerprint: provider.platformKeyFingerprint,
    timeoutMilliseconds: provider.timeoutMilliseconds,
    scanIntervalMilliseconds: provider.scanIntervalMilliseconds,
    safetyLagMilliseconds: provider.safetyLagMilliseconds,
    maximumSuccessAgeMilliseconds: provider.maximumSuccessAgeMilliseconds,
    providerIdentity: {
      endpoint: provider.endpoint,
      externalAccountId: provider.appId,
    },
    audit,
  });
  store.saveApiSecret(API_SECRET, 2, audit);
  const settings = new RuntimeSettingsService({ store });
  settings.initialize();
  return settings;
}

function recordRecoveryCredit(
  store: LedgerStore,
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
  providerAccountKey = "primary",
) {
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const amount = (amountCents / 100).toFixed(2);
  const detail: AccountLogDetail = {
    raw: {
      account_log_id: externalEventId,
      amount,
      direction: "CREDIT",
      occurred_at: occurredAtText,
    },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction: "CREDIT",
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const run = store.startIngestRun({
    providerAccountKey,
    start: formatProviderTimestamp(occurredAt - 60_000),
    end: formatProviderTimestamp(occurredAt + 60_000),
    pageSize: 1,
    now: startedAt,
  });
  const recorded = store.recordPage({
    ingestRunId: run.ingestRunId,
    page: {
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      hasMore: false,
      details: [detail],
    },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-${externalEventId}` },
      body: JSON.stringify({ external_event_id: externalEventId, amount }),
      traceId: `trace-${externalEventId}`,
      signatureVerified: true,
    },
    now: startedAt + 1,
  });
  assert.notEqual(recorded.kind, "variant");
  const normalized = recorded.normalized[0];
  if (!normalized || normalized.kind !== "created") {
    throw new Error(`expected a created ledger entry, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.entry;
}

function formatProviderTimestamp(milliseconds: number): string {
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

function recordInvalidAmountConflict(
  store: LedgerStore,
  startedAt: number,
  suffix: string,
) {
  const run = store.startIngestRun({
    start: "2026-08-16 00:00:00",
    end: "2026-08-16 01:00:00",
    pageSize: 1,
    now: startedAt,
  });
  const externalEventId = `invalid-amount-${suffix}`;
  const result = store.recordPage({
    ingestRunId: run.ingestRunId,
    page: {
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      hasMore: false,
      details: [{
        raw: {
          account_log_id: externalEventId,
          amount: "1.001",
          direction: "CREDIT",
          occurred_at: "2026-08-16 00:01:00",
        },
        accountLogId: externalEventId,
        occurredAt: "2026-08-16 00:01:00",
        amount: "1.001",
        direction: "CREDIT",
        alipayOrderNo: `platform-${externalEventId}`,
        merchantOrderNo: null,
        transMemo: null,
        otherAccount: null,
      }],
    },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-${suffix}` },
      body: JSON.stringify({ external_event_id: externalEventId, amount: "1.001" }),
      traceId: `trace-${suffix}`,
      signatureVerified: true,
    },
    now: startedAt + 1,
  });
  const normalized = result.normalized[0];
  if (!normalized || normalized.kind !== "isolated") {
    throw new Error(`expected an isolated conflict, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.conflict;
}

function migrationObjectSql(
  version: number,
  type: "index" | "table" | "trigger",
  name: string,
): string {
  const migration = migrations.find((candidate) => candidate.version === version);
  if (!migration) throw new Error(`migration ${version} is missing`);

  const connection = new DatabaseSync(":memory:");
  try {
    for (const candidate of migrations) {
      if (candidate.version > migration.version) break;
      connection.exec(candidate.sql);
    }
    const row = connection.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?",
    ).get(type, name) as { sql: string | null } | undefined;
    if (!row?.sql) throw new Error(`migration ${version} does not create ${type} ${name}`);
    return row.sql;
  } finally {
    connection.close();
  }
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
    const auditEventId = "22222222-2222-4222-8222-222222222222";
    const auditEventHash = calculateAuditEventHash({
      eventId: auditEventId,
      occurredAt: now,
      actorType: "SYSTEM",
      actorId: null,
      action: "fixture.created",
      outcome: "SUCCESS",
      subjectType: null,
      subjectId: null,
      requestId: null,
      remoteAddressHash: null,
      detailsJson: "{}",
      previousHash: null,
    });
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
      .run(auditEventId, now, auditEventHash);
  } finally {
    connection.close();
  }
}

async function createVersionTwelveTerminalConflictDatabase(
  databasePath: string,
  sourcePath: string,
): Promise<void> {
  const source = await AppDatabase.open(sourcePath);
  try {
    const store = new LedgerStore(source);
    const startedAt = Date.now();
    store.bindProviderIdentity({
      providerAccountKey: "primary",
      providerKind: "alipay",
      endpoint: "https://openapi.alipay.com",
      externalAccountId: "2026000000000000",
    }, startedAt);
    const run = store.startIngestRun({
      start: "2026-08-16 00:00:00",
      end: "2026-08-16 01:00:00",
      pageSize: 1,
      now: startedAt,
    });
    const recorded = store.recordPage({
      ingestRunId: run.ingestRunId,
      page: {
        pageNo: 1,
        pageSize: 1,
        totalSize: 1,
        hasMore: false,
        details: [{
          raw: {
            account_log_id: "schema-12-invalid-amount",
            amount: "1.001",
            direction: "CREDIT",
            occurred_at: "2026-08-16 00:01:00",
          },
          accountLogId: "schema-12-invalid-amount",
          occurredAt: "2026-08-16 00:01:00",
          amount: "1.001",
          direction: "CREDIT",
          alipayOrderNo: "platform-schema-12-invalid-amount",
          merchantOrderNo: null,
          transMemo: null,
          otherAccount: null,
        }],
      },
      evidence: {
        httpStatus: 200,
        headers: { "alipay-request-id": "schema-12-terminal-conflict" },
        body: '{"schema":12,"invalid_amount":"1.001"}',
        traceId: "schema-12-terminal-conflict",
        signatureVerified: true,
      },
      now: startedAt + 1,
    });
    assert.equal(recorded.normalized[0]?.kind, "isolated");
  } finally {
    source.close();
  }

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
    for (const migration of migrations.slice(0, 12)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    connection.exec(`ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS source`);
    try {
      connection.exec("PRAGMA defer_foreign_keys = ON; BEGIN IMMEDIATE");
      try {
        for (const table of [
          "system_metadata",
          "checkout_token_keys",
          "provider_account_bindings",
          "ingest_runs",
          "ingest_segments",
          "provider_raw_pages",
          "ingest_run_page_observations",
          "provider_raw_events",
          "ledger_cursors",
          "ledger_conflicts",
        ]) {
          const columns = (connection.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{
            name: string;
          }>).map((column) => `"${column.name}"`).join(", ");
          const insert = table === "system_metadata" || table === "checkout_token_keys"
            ? "INSERT OR IGNORE"
            : "INSERT";
          connection.exec(
            `${insert} INTO main.${table}(${columns}) SELECT ${columns} FROM source.${table}`,
          );
        }
        connection.exec("COMMIT");
      } catch (error) {
        if (connection.isTransaction) connection.exec("ROLLBACK");
        throw error;
      }
    } finally {
      connection.exec("DETACH DATABASE source");
    }
    const conflict = connection.prepare(
      "SELECT conflict_id, created_at FROM ledger_conflicts",
    ).get() as { conflict_id: string; created_at: bigint | number };
    connection.prepare(
      `UPDATE ledger_conflicts
          SET status = 'IGNORED', resolution_json = '{"legacy":true}', resolved_at = ?
        WHERE conflict_id = ?`,
    ).run(Number(conflict.created_at) + 1, conflict.conflict_id);
  } finally {
    connection.close();
  }
}

function createVersionFourDatabase(databasePath: string): void {
  createVersionTwoDatabase(databasePath);
  const connection = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    readBigInts: true,
  });
  try {
    const record = connection.prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')`,
    );
    for (const migration of migrations.slice(2, 4)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    connection.prepare(
      `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
       VALUES (1, zeroblob(32), 1800000000000)`,
    ).run();

    const now = 1_800_000_000_000;
    const runId = "33333333-3333-4333-8333-333333333333";
    const segmentId = "44444444-4444-4444-8444-444444444444";
    const pageId = "55555555-5555-4555-8555-555555555555";
    const windowStart = "2026-08-14 00:00:00";
    const windowEnd = "2026-08-14 01:00:00";
    const pageBody = Buffer.from("{\"legacy\":true}", "utf8");
    connection.prepare(
      `INSERT INTO ingest_runs(
         ingest_run_id, provider_account_key, window_start, window_end,
         page_size, status, started_at, completed_at, pages_received, details_received
       ) VALUES (?, 'primary', ?, ?, 4, 'COMPLETED', ?, ?, 1, 4)`,
    ).run(runId, windowStart, windowEnd, now, now + 1_000);
    connection.prepare(
      `INSERT INTO provider_raw_pages(
         raw_page_id, ingest_run_id, provider_account_key, window_start, window_end,
         page_no, page_size, total_size, has_more, request_fingerprint,
         response_fingerprint, http_status, headers_json, raw_body, trace_id,
         signature_verified, received_at
       ) VALUES (?, ?, 'primary', ?, ?, 1, 4, 4, 0, ?, ?, 200, '{}', ?, 'v4-fixture', 1, ?)`,
    ).run(
      pageId,
      runId,
      windowStart,
      windowEnd,
      requestFingerprint("primary", windowStart, windowEnd, 1, 4),
      responseFingerprint(pageBody),
      pageBody,
      now + 1_000,
    );
    connection.prepare(
      `INSERT INTO ingest_segments(
         ingest_segment_id, ingest_run_id, parent_segment_id, window_start, window_end,
         depth, state, split_at, accepted_raw_page_id, created_at, completed_at
       ) VALUES (?, ?, NULL, ?, ?, 0, 'COMPLETE', NULL, ?, ?, ?)`,
    ).run(segmentId, runId, windowStart, windowEnd, pageId, now, now + 1_000);
    connection.prepare(
      `INSERT INTO ingest_run_page_observations(
         ingest_run_id, ingest_segment_id, raw_page_id, observation_kind,
         http_status, headers_json, trace_id, signature_verified, observed_at
       ) VALUES (?, ?, ?, 'ACCEPTED_LEAF', 200, '{}', 'v4-fixture', 1, ?)`,
    ).run(runId, segmentId, pageId, now + 1_000);

    const occurrences = [
      "2026-08-14 00:01:00.1",
      "2026-08-14 00:01:00.12",
      "2026-08-14 00:01:00.123",
      "2026-08-14 00:01:00",
    ] as const;
    for (const [ordinal, occurredAtText] of occurrences.entries()) {
      const rawEventId = `66666666-6666-4666-8666-${String(ordinal + 1).padStart(12, "0")}`;
      const externalEventId = `v4-precision-${ordinal}`;
      const rawPayload = Buffer.from(JSON.stringify({ externalEventId, occurredAtText }), "utf8");
      const parsed = parseOccurredAtWithPrecision(occurredAtText);
      connection.prepare(
        `INSERT INTO provider_raw_events(
           raw_event_id, raw_page_id, provider_account_key, ordinal,
           external_event_id, occurred_at_text, amount_text, direction_text,
           alipay_order_no, merchant_order_no, trans_memo, other_account,
           payload_fingerprint, raw_payload, observed_at
         ) VALUES (?, ?, 'primary', ?, ?, ?, '1.00', 'CREDIT', ?, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(
        rawEventId,
        pageId,
        ordinal,
        externalEventId,
        occurredAtText,
        `alipay-${ordinal}`,
        payloadFingerprint(rawPayload),
        rawPayload,
        now + 1_000,
      );
      connection.prepare(
        `INSERT INTO ledger_entries(
           ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
           semantic_fingerprint, occurred_at, amount_cents, direction, currency,
           alipay_order_no, merchant_order_no, trans_memo, other_account,
           state, created_at, updated_at
         ) VALUES (?, 'primary', ?, ?, ?, ?, 100, 'CREDIT', 'CNY', ?, NULL, NULL, NULL,
                   'UNALLOCATED', ?, ?)`,
      ).run(
        `77777777-7777-4777-8777-${String(ordinal + 1).padStart(12, "0")}`,
        rawEventId,
        externalEventId,
        legacySemanticFingerprintV1({
          externalEventId,
          occurredAt: parsed.milliseconds,
          amountCents: 100,
          direction: "CREDIT",
          currency: "CNY",
          alipayOrderNo: `alipay-${ordinal}`,
          merchantOrderNo: null,
          transMemo: null,
          otherAccount: null,
        }),
        parsed.milliseconds,
        `alipay-${ordinal}`,
        now + 1_000,
        now + 1_000,
      );
    }
  } finally {
    connection.close();
  }
}

function createVersionSixDatabase(databasePath: string): void {
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
    for (const migration of migrations.slice(0, 6)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    connection.prepare(
      `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
       VALUES (1, zeroblob(32), 1800000000000)`,
    ).run();

    const now = 1_800_000_000_000;
    const runId = "88888888-8888-4888-8888-888888888888";
    const segmentId = "99999999-9999-4999-8999-999999999999";
    const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondSegmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const secondPageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const windowStart = "2026-08-14 00:00:00";
    const windowEnd = "2026-08-14 01:00:00";
    const pageRequestFingerprint = requestFingerprint(
      "primary",
      windowStart,
      windowEnd,
      1,
      1,
    );
    const pageBody = Buffer.from('{"legacy":"v6"}', "utf8");
    const pageResponseFingerprint = responseFingerprint(pageBody);
    connection.prepare(
      `INSERT INTO ingest_runs(
         ingest_run_id, provider_account_key, window_start, window_end,
         page_size, status, started_at, completed_at, pages_received, details_received
       ) VALUES (?, 'primary', ?, ?, 1, 'COMPLETED', ?, ?, 1, 0)`,
    ).run(runId, windowStart, windowEnd, now, now + 1_000);
    connection.prepare(
      `INSERT INTO provider_raw_pages(
         raw_page_id, ingest_run_id, provider_account_key, window_start, window_end,
         page_no, page_size, total_size, has_more, request_fingerprint,
         response_fingerprint, http_status, headers_json, raw_body, trace_id,
         signature_verified, received_at
       ) VALUES (?, ?, 'primary', ?, ?, 1, 1, 0, 0, ?, ?, 200, '{}', ?,
                 'v6-fixture', 1, ?)`,
    ).run(
      pageId,
      runId,
      windowStart,
      windowEnd,
      pageRequestFingerprint,
      pageResponseFingerprint,
      pageBody,
      now + 1_000,
    );
    connection.prepare(
      `INSERT INTO ingest_segments(
         ingest_segment_id, ingest_run_id, parent_segment_id, window_start, window_end,
         depth, state, split_at, accepted_raw_page_id, created_at, completed_at
       ) VALUES (?, ?, NULL, ?, ?, 0, 'COMPLETE', NULL, ?, ?, ?)`,
    ).run(segmentId, runId, windowStart, windowEnd, pageId, now, now + 1_000);
    connection.prepare(
      `INSERT INTO ingest_run_page_observations(
         ingest_run_id, ingest_segment_id, raw_page_id, observation_kind,
         http_status, headers_json, trace_id, signature_verified, observed_at
       ) VALUES (?, ?, ?, 'ACCEPTED_LEAF', 200, '{}', 'v6-fixture', 1, ?)`,
    ).run(runId, segmentId, pageId, now + 1_000);
    const secondPageBody = Buffer.from('{"legacy":"v6-variant"}', "utf8");
    const secondPageResponseFingerprint = responseFingerprint(secondPageBody);
    connection.prepare(
      `INSERT INTO ingest_runs(
         ingest_run_id, provider_account_key, window_start, window_end,
         page_size, status, started_at, completed_at, pages_received, details_received
       ) VALUES (?, 'primary', ?, ?, 1, 'COMPLETED', ?, ?, 1, 0)`,
    ).run(secondRunId, windowStart, windowEnd, now + 2_000, now + 3_000);
    connection.prepare(
      `INSERT INTO provider_raw_pages(
         raw_page_id, ingest_run_id, provider_account_key, window_start, window_end,
         page_no, page_size, total_size, has_more, request_fingerprint,
         response_fingerprint, http_status, headers_json, raw_body, trace_id,
         signature_verified, received_at
       ) VALUES (?, ?, 'primary', ?, ?, 1, 1, 0, 0, ?, ?, 200, '{}', ?,
                 'v6-fixture-variant', 1, ?)`,
    ).run(
      secondPageId,
      secondRunId,
      windowStart,
      windowEnd,
      pageRequestFingerprint,
      secondPageResponseFingerprint,
      secondPageBody,
      now + 3_000,
    );
    connection.prepare(
      `INSERT INTO ingest_segments(
         ingest_segment_id, ingest_run_id, parent_segment_id, window_start, window_end,
         depth, state, split_at, accepted_raw_page_id, created_at, completed_at
       ) VALUES (?, ?, NULL, ?, ?, 0, 'COMPLETE', NULL, ?, ?, ?)`,
    ).run(secondSegmentId, secondRunId, windowStart, windowEnd, secondPageId, now + 2_000, now + 3_000);
    connection.prepare(
      `INSERT INTO ingest_run_page_observations(
         ingest_run_id, ingest_segment_id, raw_page_id, observation_kind,
         http_status, headers_json, trace_id, signature_verified, observed_at
       ) VALUES (?, ?, ?, 'ACCEPTED_LEAF', 200, '{}', 'v6-fixture-variant', 1, ?)`,
    ).run(secondRunId, secondSegmentId, secondPageId, now + 3_000);
    const legacyVariantDetails = JSON.stringify({
      request_fingerprint: pageRequestFingerprint,
      ingest_segment_id: secondSegmentId,
      existing_raw_page_id: pageId,
      incoming_raw_page_id: secondPageId,
    });
    connection.prepare(
      `INSERT INTO ledger_conflicts(
         conflict_id, provider_account_key, conflict_type, raw_page_id,
         raw_event_id, existing_ledger_entry_id, external_event_id,
         existing_semantic_fingerprint, incoming_semantic_fingerprint,
         details_json, status, resolution_json, created_at, resolved_at,
         conflict_fingerprint
       ) VALUES (
         'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'primary', 'RAW_PAGE_VARIANT', ?,
         NULL, NULL, NULL, ?, ?, ?, 'OPEN', NULL, ?, NULL, ?
       )`,
    ).run(
      secondPageId,
      pageResponseFingerprint,
      secondPageResponseFingerprint,
      legacyVariantDetails,
      now + 3_000,
      conflictFingerprint([
        "RAW_PAGE_VARIANT",
        pageRequestFingerprint,
        pageResponseFingerprint,
        secondPageResponseFingerprint,
      ]),
    );
    connection.prepare(
      `INSERT INTO ledger_cursors(
         provider_account_key, window_start, window_end, next_page_no, page_size,
         expected_total_size, overlap_milliseconds, complete, last_event_occurred_at,
         last_completed_at, updated_at, version
       ) VALUES ('primary', ?, ?, NULL, 1, NULL, 300000, 1, NULL, ?, ?, 1)`,
    ).run(windowStart, windowEnd, now + 1_000, now + 1_000);
  } finally {
    connection.close();
  }
}

function createVersionSevenDatabase(databasePath: string): void {
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
    for (const migration of migrations.slice(0, 7)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    connection.prepare(
      `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
       VALUES (1, zeroblob(32), 1800000000000)`,
    ).run();
  } finally {
    connection.close();
  }
}

function createVersionEightEvidenceDatabase(databasePath: string): {
  readonly auditEventHash: string;
  readonly orderEventIds: readonly [string, string, string];
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
    for (const migration of migrations.slice(0, 8)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }

    const profileId = "10000000-0000-4000-8000-000000000001";
    const activationId = "10000000-0000-4000-8000-000000000002";
    const orderId = "10000000-0000-4000-8000-000000000003";
    const checkoutId = "10000000-0000-4000-8000-000000000004";
    const slotId = "10000000-0000-4000-8000-000000000005";
    const orderEventId = "10000000-0000-4000-8000-000000000006";
    const ingestRunId = "10000000-0000-4000-8000-000000000007";
    const segmentId = "10000000-0000-4000-8000-000000000008";
    const rawPageId = "10000000-0000-4000-8000-000000000009";
    const rawEventId = "10000000-0000-4000-8000-000000000010";
    const ledgerEntryId = "10000000-0000-4000-8000-000000000011";
    const operationId = "10000000-0000-4000-8000-000000000012";
    const candidateId = "10000000-0000-4000-8000-000000000013";
    const resolvedExceptionId = "10000000-0000-4000-8000-000000000014";
    const openExceptionId = "10000000-0000-4000-8000-000000000015";
    const auditEventId = "10000000-0000-4000-8000-000000000016";
    const secondOrderId = "10000000-0000-4000-8000-000000000017";
    const secondCheckoutId = "10000000-0000-4000-8000-000000000018";
    const secondSlotId = "10000000-0000-4000-8000-000000000019";
    const secondOrderEventId = "10000000-0000-4000-8000-000000000020";
    const secondAuditEventId = "10000000-0000-4000-8000-000000000021";
    const paymentMatchId = "10000000-0000-4000-8000-000000000022";
    const ledgerTransactionId = "10000000-0000-4000-8000-000000000023";
    const debitPostingId = "10000000-0000-4000-8000-000000000024";
    const creditPostingId = "10000000-0000-4000-8000-000000000025";
    const confirmationOrderEventId = "10000000-0000-4000-8000-000000000026";
    const outboxEventId = "10000000-0000-4000-8000-000000000027";
    const occurrence = parseOccurredAtWithPrecision("2026-08-16 00:01:00");
    const orderCreatedAt = occurrence.milliseconds - 1_000;
    const completedAt = occurrence.milliseconds + 1_000;

    const providerIdentity = normalizeProviderIdentity(PROVIDER_IDENTITY);
    connection.prepare(
      `INSERT INTO provider_account_bindings(
         provider_account_key, provider_kind, provider_endpoint,
         external_account_id, identity_fingerprint_version,
         identity_fingerprint, bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      providerIdentity.providerAccountKey,
      providerIdentity.providerKind,
      providerIdentity.endpoint,
      providerIdentity.externalAccountId,
      providerIdentity.identityFingerprintVersion,
      providerIdentity.identityFingerprint,
      orderCreatedAt,
    );

    connection.prepare(
      `INSERT INTO api_client_config(
         singleton_key, client_id, secret_fingerprint, key_version,
         enabled, created_at, updated_at
       ) VALUES (1, 'default', ?, 1, 1, ?, ?)`,
    ).run("1".repeat(64), orderCreatedAt, orderCreatedAt);

    const codePayload = "https://qr.local.invalid/v8-evidence";
    const profileFingerprint = fingerprintCollectionCodeProfile(codePayload);
    connection.prepare(
      `INSERT INTO collection_profiles(
         profile_id, version, provider_account_key, code_payload,
         payload_fingerprint, profile_fingerprint, evidence_policy, created_at
       ) VALUES (?, 1, 'primary', ?, ?, ?, 'UNIQUE_AMOUNT_AUTO', ?)`,
    ).run(
      profileId,
      codePayload,
      profileFingerprint.payloadFingerprint,
      profileFingerprint.profileFingerprint,
      orderCreatedAt,
    );
    connection.prepare(
      `INSERT INTO active_collection_profile(singleton_key, profile_id, activated_at)
       VALUES (1, ?, ?)`,
    ).run(profileId, orderCreatedAt);
    connection.prepare(
      `INSERT INTO collection_profile_activations(
         activation_id, sequence, profile_id, previous_profile_id, activated_at, reason
       ) VALUES (?, 1, ?, NULL, ?, 'CONFIG_SYNC')`,
    ).run(activationId, profileId, orderCreatedAt);

    const checkoutKey = Buffer.alloc(32, 7);
    connection.prepare(
      `INSERT INTO checkout_token_key(singleton_key, key_material, created_at)
       VALUES (1, ?, ?)`,
    ).run(checkoutKey, orderCreatedAt);
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
         ?, 'default', 'v8-evidence', ?, 1, ?, 1, NULL,
         1000, 1001, 1, NULL, 'CNY', NULL, ?,
         'OPEN', 'UNPAID', 'NONE', 'NONE', ?, ?, ?, NULL, ?, 1
       )`,
    ).run(
      orderId,
      "2".repeat(64),
      "3".repeat(64),
      profileId,
      orderCreatedAt,
      orderCreatedAt,
      occurrence.milliseconds + 60_000,
      orderCreatedAt,
    );
    connection.prepare(
      "INSERT INTO checkout_sessions(checkout_id, order_id, token_digest) VALUES (?, ?, ?)",
    ).run(
      checkoutId,
      orderId,
      digestCheckoutToken(deriveCheckoutToken(checkoutKey, checkoutId)),
    );
    connection.prepare(
      `INSERT INTO amount_slots(
         slot_id, order_id, collection_profile_id, payable_amount_cents,
         generation, occupied_from, released_at, release_reason
       ) VALUES (?, ?, ?, 1001, 1, ?, NULL, NULL)`,
    ).run(slotId, orderId, profileId, orderCreatedAt);
    connection.prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at, details_json
       ) VALUES (?, ?, 1, 'CREATED', ?, ?)`,
    ).run(orderEventId, orderId, orderCreatedAt, '{"amount_offset_cents":1,"slot_generation":1}');
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
         ?, 'default', 'v8-evidence-secondary', ?, 1, ?, 1, NULL,
         2000, 2001, 1, NULL, 'CNY', NULL, ?,
         'OPEN', 'UNPAID', 'NONE', 'NONE', ?, ?, ?, NULL, ?, 1
       )`,
    ).run(
      secondOrderId,
      "4".repeat(64),
      "5".repeat(64),
      profileId,
      orderCreatedAt,
      orderCreatedAt,
      occurrence.milliseconds + 60_000,
      orderCreatedAt,
    );
    connection.prepare(
      "INSERT INTO checkout_sessions(checkout_id, order_id, token_digest) VALUES (?, ?, ?)",
    ).run(
      secondCheckoutId,
      secondOrderId,
      digestCheckoutToken(deriveCheckoutToken(checkoutKey, secondCheckoutId)),
    );
    connection.prepare(
      `INSERT INTO amount_slots(
         slot_id, order_id, collection_profile_id, payable_amount_cents,
         generation, occupied_from, released_at, release_reason
       ) VALUES (?, ?, ?, 2001, 1, ?, NULL, NULL)`,
    ).run(secondSlotId, secondOrderId, profileId, orderCreatedAt);
    connection.prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at, details_json
       ) VALUES (?, ?, 1, 'CREATED', ?, ?)`,
    ).run(
      secondOrderEventId,
      secondOrderId,
      orderCreatedAt,
      '{"amount_offset_cents":1,"slot_generation":1,"fixture":"secondary"}',
    );

    const windowStart = "2026-08-16 00:00:00";
    const windowEnd = "2026-08-16 01:00:00";
    const pageBody = Buffer.from('{"fixture":"v8-evidence"}', "utf8");
    const pageRequestFingerprint = requestFingerprint("primary", windowStart, windowEnd, 1, 1);
    connection.prepare(
      `INSERT INTO ingest_runs(
         ingest_run_id, provider_account_key, window_start, window_end,
         page_size, status, started_at, completed_at, pages_received, details_received
       ) VALUES (?, 'primary', ?, ?, 1, 'COMPLETED', ?, ?, 1, 1)`,
    ).run(ingestRunId, windowStart, windowEnd, orderCreatedAt, completedAt);
    connection.prepare(
      `INSERT INTO provider_raw_pages(
         raw_page_id, ingest_run_id, provider_account_key, window_start, window_end,
         page_no, page_size, total_size, has_more, request_fingerprint,
         response_fingerprint, http_status, headers_json, raw_body, trace_id,
         signature_verified, received_at
       ) VALUES (?, ?, 'primary', ?, ?, 1, 1, 1, 0, ?, ?, 200, '{}', ?,
                 'v8-evidence', 1, ?)`,
    ).run(
      rawPageId,
      ingestRunId,
      windowStart,
      windowEnd,
      pageRequestFingerprint,
      responseFingerprint(pageBody),
      pageBody,
      occurrence.milliseconds,
    );
    connection.prepare(
      `INSERT INTO ingest_segments(
         ingest_segment_id, ingest_run_id, parent_segment_id, window_start, window_end,
         depth, state, split_at, accepted_raw_page_id, created_at, completed_at
       ) VALUES (?, ?, NULL, ?, ?, 0, 'COMPLETE', NULL, ?, ?, ?)`,
    ).run(
      segmentId,
      ingestRunId,
      windowStart,
      windowEnd,
      rawPageId,
      orderCreatedAt,
      completedAt,
    );
    connection.prepare(
      `INSERT INTO ingest_run_page_observations(
         ingest_run_id, ingest_segment_id, raw_page_id, observation_kind,
         http_status, headers_json, trace_id, signature_verified, observed_at,
         disposition, observation_sequence, transition_enforced
       ) VALUES (?, ?, ?, 'ACCEPTED_LEAF', 200, '{}', 'v8-evidence', 1, ?,
                 'PROCESSED', 1, 1)`,
    ).run(ingestRunId, segmentId, rawPageId, occurrence.milliseconds);

    const rawPayload = Buffer.from('{"fixture":"v8-ledger-event"}', "utf8");
    const externalEventId = "v8-evidence-ledger";
    const alipayOrderNo = "v8-evidence-platform-order";
    connection.prepare(
      `INSERT INTO provider_raw_events(
         raw_event_id, raw_page_id, provider_account_key, ordinal,
         external_event_id, occurred_at_text, amount_text, direction_text,
         alipay_order_no, merchant_order_no, trans_memo, other_account,
         payload_fingerprint, raw_payload, observed_at
       ) VALUES (?, ?, 'primary', 0, ?, '2026-08-16 00:01:00', '10.01', 'CREDIT',
                 ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      rawEventId,
      rawPageId,
      externalEventId,
      alipayOrderNo,
      payloadFingerprint(rawPayload),
      rawPayload,
      occurrence.milliseconds,
    );
    const ledgerSemanticFingerprint = semanticFingerprint({
      externalEventId,
      occurredAt: occurrence.milliseconds,
      occurredAtPrecisionMilliseconds: occurrence.precisionMilliseconds,
      amountCents: 1001,
      direction: "CREDIT",
      currency: "CNY",
      alipayOrderNo,
      merchantOrderNo: null,
      transMemo: null,
      otherAccount: null,
    });
    connection.prepare(
      `INSERT INTO ledger_entries(
         ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
         semantic_fingerprint, occurred_at, occurred_at_precision_ms,
         amount_cents, direction, currency, alipay_order_no, merchant_order_no,
         trans_memo, other_account, state, created_at, updated_at
       ) VALUES (?, 'primary', ?, ?, ?, ?, ?, 1001, 'CREDIT', 'CNY', ?, NULL,
                 NULL, NULL, 'UNALLOCATED', ?, ?)`,
    ).run(
      ledgerEntryId,
      rawEventId,
      externalEventId,
      ledgerSemanticFingerprint,
      occurrence.milliseconds,
      occurrence.precisionMilliseconds,
      alipayOrderNo,
      occurrence.milliseconds,
      occurrence.milliseconds,
    );

    const candidateInput = {
      providerAccountKey: "primary",
      ledgerEntryId,
      ledgerSemanticFingerprint,
      occurredAt: occurrence.milliseconds,
      occurredAtPrecisionMilliseconds: occurrence.precisionMilliseconds,
      amountCents: 1001,
      orderId,
      collectionProfileId: profileId,
      slotId,
      slotGeneration: 1,
      slotOccupiedFrom: orderCreatedAt,
      slotReleasedAt: null,
    } as const;
    const candidateEvidenceJson = JSON.stringify(candidateEvidence(candidateInput));
    const candidateEvidenceFingerprint = candidateFingerprint(candidateInput);
    connection.prepare(
      `INSERT INTO match_candidates(
         candidate_id, ledger_entry_id, order_id, slot_id, evidence_type,
         rule_version, evidence_json, candidate_fingerprint, status,
         decided_by_operation_id, created_at, updated_at, decided_at
       ) VALUES (?, ?, ?, ?, 'AMOUNT_INFERRED', 3, ?, ?, 'ELIGIBLE',
                 NULL, ?, ?, NULL)`,
    ).run(
      candidateId,
      ledgerEntryId,
      orderId,
      slotId,
      candidateEvidenceJson,
      candidateEvidenceFingerprint,
      occurrence.milliseconds,
      occurrence.milliseconds,
    );

    const operationInput = {
      operationType: "AUTO_SETTLEMENT" as const,
      actorType: "SYSTEM" as const,
      actorId: null,
      orderId,
      ledgerEntryId,
      candidateId,
      paymentMatchId,
      reversesOperationId: null,
      reason: null,
    };
    connection.prepare(
      `INSERT INTO financial_operations(
         financial_operation_id, operation_key, request_fingerprint, request_json,
         operation_type, actor_type, actor_id, order_id, ledger_entry_id,
         reverses_operation_id, reason, created_at
       ) VALUES (?, ?, ?, ?, 'AUTO_SETTLEMENT',
                 'SYSTEM', NULL, ?, ?, NULL, NULL, ?)`,
    ).run(
      operationId,
      `auto-settlement:${candidateEvidenceFingerprint}`,
      financialOperationFingerprint(operationInput),
      JSON.stringify(financialOperationEvidence(operationInput)),
      orderId,
      ledgerEntryId,
      completedAt,
    );
    connection.prepare(
      `UPDATE match_candidates
          SET status = 'SELECTED', decided_by_operation_id = ?,
              updated_at = ?, decided_at = ?
        WHERE candidate_id = ? AND status = 'ELIGIBLE'`,
    ).run(operationId, completedAt, completedAt, candidateId);
    connection.prepare(
      `INSERT INTO ledger_transactions(
         ledger_transaction_id, financial_operation_id, order_id,
         ledger_entry_id, transaction_type, currency, status,
         created_at, posted_at
       ) VALUES (?, ?, ?, ?, 'SETTLEMENT', 'CNY', 'DRAFT', ?, NULL)`,
    ).run(ledgerTransactionId, operationId, orderId, ledgerEntryId, completedAt);
    const insertPosting = connection.prepare(
      `INSERT INTO ledger_postings(
         posting_id, ledger_transaction_id, account_code, side,
         amount_cents, currency, order_id, ledger_entry_id, created_at
       ) VALUES (?, ?, ?, ?, 1001, 'CNY', ?, ?, ?)`,
    );
    insertPosting.run(
      debitPostingId,
      ledgerTransactionId,
      "PROVIDER_CASH",
      "DEBIT",
      orderId,
      ledgerEntryId,
      completedAt,
    );
    insertPosting.run(
      creditPostingId,
      ledgerTransactionId,
      "ORDER_SETTLEMENT",
      "CREDIT",
      orderId,
      ledgerEntryId,
      completedAt,
    );
    connection.prepare(
      `UPDATE ledger_transactions
          SET status = 'POSTED', posted_at = ?
        WHERE ledger_transaction_id = ? AND status = 'DRAFT'`,
    ).run(completedAt, ledgerTransactionId);
    connection.prepare(
      `INSERT INTO payment_matches(
         payment_match_id, ledger_entry_id, order_id, candidate_id,
         match_role, evidence_type, evidence_json, status,
         created_by_operation_id, resolved_by_operation_id,
         created_at, updated_at, resolved_at
       ) VALUES (?, ?, ?, ?, 'PRIMARY_SETTLEMENT', 'AMOUNT_INFERRED', ?,
                 'SETTLED', ?, ?, ?, ?, ?)`,
    ).run(
      paymentMatchId,
      ledgerEntryId,
      orderId,
      candidateId,
      candidateEvidenceJson,
      operationId,
      operationId,
      completedAt,
      completedAt,
      completedAt,
    );
    connection.prepare(
      `UPDATE ledger_entries
          SET state = 'ALLOCATED', updated_at = ?
        WHERE ledger_entry_id = ? AND state = 'UNALLOCATED'`,
    ).run(completedAt, ledgerEntryId);
    connection.prepare(
      `UPDATE payment_orders
          SET received_amount_cents = 1001, payment_status = 'CONFIRMED',
              payment_basis = 'INFERRED', updated_at = ?, version = 2
        WHERE order_id = ? AND version = 1 AND payment_status = 'UNPAID'`,
    ).run(completedAt, orderId);
    const confirmationDetails = JSON.stringify({
      financial_operation_id: operationId,
      payment_match_id: paymentMatchId,
      candidate_id: candidateId,
      evidence_type: "AMOUNT_INFERRED",
    });
    connection.prepare(
      `INSERT INTO order_events(
         event_id, order_id, sequence, event_type, occurred_at, details_json
       ) VALUES (?, ?, 2, 'PAYMENT_CONFIRMED', ?, ?)`,
    ).run(confirmationOrderEventId, orderId, completedAt, confirmationDetails);
    const outboxPayload = JSON.stringify({
      schema: "perpay:outbox-event:v2",
      event_id: outboxEventId,
      event_type: "PAYMENT_CONFIRMED",
      financial_operation_id: operationId,
      order_id: orderId,
      merchant_order_no: "v8-evidence",
      requested_amount_cents: 1000,
      payable_amount_cents: 1001,
      received_amount_cents: 1001,
      currency: "CNY",
      payment_status: "CONFIRMED",
      payment_basis: "INFERRED",
      refund_status: "NONE",
      event_details: {
        payment_match_id: paymentMatchId,
        candidate_id: candidateId,
        evidence_type: "AMOUNT_INFERRED",
      },
      order_version: 2,
      occurred_at: completedAt,
    });
    connection.prepare(
      `INSERT INTO outbox_events(
         outbox_event_id, financial_operation_id, aggregate_type,
         aggregate_id, aggregate_version, event_type, payload_json,
         payload_fingerprint, created_at
       ) VALUES (?, ?, 'PAYMENT_ORDER', ?, 2, 'PAYMENT_CONFIRMED', ?, ?, ?)`,
    ).run(
      outboxEventId,
      operationId,
      orderId,
      outboxPayload,
      outboxPayloadFingerprint(outboxPayload),
      completedAt,
    );

    const resolvedExceptionInput = {
      providerAccountKey: "primary",
      exceptionType: "RECONCILIATION_CONFLICT" as const,
      ledgerEntryId,
      orderId,
      candidateId,
      contextKey: "migration-resolved",
    };
    connection.prepare(
      `INSERT INTO financial_exceptions(
         exception_id, provider_account_key, exception_type, ledger_entry_id,
         order_id, candidate_id, context_key, details_json,
         exception_fingerprint, status, resolution_operation_id,
         resolution_json, created_at, resolved_at
       ) VALUES (?, 'primary', 'RECONCILIATION_CONFLICT', ?, ?, ?, ?, ?, ?,
                 'RESOLVED', ?, ?, ?, ?)`,
    ).run(
      resolvedExceptionId,
      ledgerEntryId,
      orderId,
      candidateId,
      resolvedExceptionInput.contextKey,
      '{"legacy":"resolved-details"}',
      financialExceptionFingerprint(resolvedExceptionInput),
      operationId,
      '{"legacy":"resolution"}',
      occurrence.milliseconds,
      completedAt,
    );
    const openExceptionInput = {
      providerAccountKey: "primary",
      exceptionType: "UNMATCHED_CREDIT" as const,
      ledgerEntryId: null,
      orderId: null,
      candidateId: null,
      contextKey: "migration-open",
    };
    connection.prepare(
      `INSERT INTO financial_exceptions(
         exception_id, provider_account_key, exception_type, ledger_entry_id,
         order_id, candidate_id, context_key, details_json,
         exception_fingerprint, status, resolution_operation_id,
         resolution_json, created_at, resolved_at
       ) VALUES (?, 'primary', 'UNMATCHED_CREDIT', NULL, NULL, NULL, ?, ?, ?,
                 'OPEN', NULL, NULL, ?, NULL)`,
    ).run(
      openExceptionId,
      openExceptionInput.contextKey,
      '{"legacy":"open-details"}',
      financialExceptionFingerprint(openExceptionInput),
      occurrence.milliseconds,
    );

    const firstAuditEventHash = calculateAuditEventHash({
      eventId: auditEventId,
      occurredAt: completedAt,
      actorType: "SYSTEM",
      actorId: null,
      action: "fixture.v8.created",
      outcome: "SUCCESS",
      subjectType: null,
      subjectId: null,
      requestId: null,
      remoteAddressHash: null,
      detailsJson: '{"schema":8}',
      previousHash: null,
    });
    connection.prepare(
      `INSERT INTO audit_events(
         event_id, occurred_at, actor_type, actor_id, action, outcome,
         subject_type, subject_id, request_id, remote_address_hash,
         details_json, previous_hash, event_hash
       ) VALUES (?, ?, 'SYSTEM', NULL, 'fixture.v8.created', 'SUCCESS',
                 NULL, NULL, NULL, NULL, '{"schema":8}', NULL, ?)`,
    ).run(auditEventId, completedAt, firstAuditEventHash);
    const auditEventHash = calculateAuditEventHash({
      eventId: secondAuditEventId,
      occurredAt: completedAt + 1,
      actorType: "SYSTEM",
      actorId: null,
      action: "fixture.v8.completed",
      outcome: "SUCCESS",
      subjectType: null,
      subjectId: null,
      requestId: null,
      remoteAddressHash: null,
      detailsJson: '{"schema":8,"step":2}',
      previousHash: firstAuditEventHash,
    });
    connection.prepare(
      `INSERT INTO audit_events(
         event_id, occurred_at, actor_type, actor_id, action, outcome,
         subject_type, subject_id, request_id, remote_address_hash,
         details_json, previous_hash, event_hash
       ) VALUES (?, ?, 'SYSTEM', NULL, 'fixture.v8.completed', 'SUCCESS',
                 NULL, NULL, NULL, NULL, '{"schema":8,"step":2}', ?, ?)`,
    ).run(secondAuditEventId, completedAt + 1, firstAuditEventHash, auditEventHash);

    const integrity = inspectDatabaseIntegrity(connection);
    assert.equal(integrity.quickCheck, "ok");
    assert.equal(integrity.foreignKeyViolations, 0);
    assert.equal(integrity.domainViolations, 0);
    return {
      auditEventHash,
      orderEventIds: [orderEventId, secondOrderEventId, confirmationOrderEventId],
    };
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
