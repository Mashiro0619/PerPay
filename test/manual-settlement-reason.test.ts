import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import {
  ReconciliationStore,
  financialDecisionRequestSchema,
  linkedFinancialDecisionRequestSchema,
  manualSettlementRequestSchema,
} from "../src/reconciliation/index.ts";
import { withHttpFixture, login, postFinancial, responseData, responseErrorCode, readCount } from "./reconciliation-http-fixture.ts";

const manualPath = "/api/admin/v1/reconciliation/settlements/manual";

describe("optional manual settlement reasons", () => {
  it("normalizes omitted, null and blank reasons without relaxing other financial decisions", () => {
    const input = { financial_operation_id: randomUUID(), order_id: randomUUID(), ledger_entry_id: randomUUID() };
    for (const reason of [undefined, null, "", "   "]) {
      const body = reason === undefined ? input : { ...input, reason };
      assert.equal(manualSettlementRequestSchema.parse(body).reason, null);
      assert.equal(linkedFinancialDecisionRequestSchema.safeParse(body).success, false);
      assert.equal(financialDecisionRequestSchema.safeParse({ financial_operation_id: input.financial_operation_id, reason }).success, false);
    }
    assert.equal(manualSettlementRequestSchema.parse({ ...input, reason: "核对后关联" }).reason, "核对后关联");
    for (const reason of [" leading", "trailing ", "line\nbreak", "nul\0byte", "x".repeat(513), " ".repeat(513), 123, {}, []]) {
      assert.equal(manualSettlementRequestSchema.safeParse({ ...input, reason }).success, false);
    }
    assert.equal(manualSettlementRequestSchema.safeParse({ ...input, operation_type: "AUTO_SETTLEMENT" }).success, false);
  });

  for (const variant of ["omitted", "null", "empty", "blank"] as const) {
    it("accepts a " + variant + " reason for a mismatched amount and replays one immutable operation", async () => {
      await withHttpFixture(async (fixture) => {
        const auth = await login(fixture.app);
        const order = fixture.createOrder("optional-" + variant, 9);
        const entry = fixture.recordCredit("optional-" + variant, 19_901, 1);
        const input = { financial_operation_id: randomUUID(), order_id: order.orderId, ledger_entry_id: entry.ledgerEntryId };
        const reason = variant === "null" ? null : variant === "empty" ? "" : "   ";
        const body = variant === "omitted" ? input : { ...input, reason };
        const response = await postFinancial(fixture.app, manualPath, auth, body);
        assert.equal(response.status, 200);
        const saved = await responseData<Record<string, any>>(response);
        assert.equal(saved.operation.reason, null);
        assert.equal(saved.operation.actor_id, "admin");
        assert.equal(saved.payment_match.evidence.reason, null);
        assert.equal(saved.payment_match.evidence.schema, "perpay:manual-settlement:v2");
        const orderResponse = await fixture.app.request("/api/admin/v1/orders/" + order.orderId, { headers: { cookie: auth.cookie } });
        const updatedOrder = await responseData<Record<string, any>>(orderResponse);
        assert.equal(updatedOrder.payment.received_amount_cents, 19_901);
        assert.equal(updatedOrder.payment.basis, "MANUAL");
        for (const equivalent of [input, { ...input, reason: null }, { ...input, reason: "" }, { ...input, reason: "   " }]) {
          const replay = await postFinancial(fixture.app, manualPath, auth, equivalent);
          assert.equal(replay.status, 200);
          const replayed = await responseData<Record<string, any>>(replay);
          assert.equal(replayed.operation.financial_operation_id, input.financial_operation_id);
          assert.equal(replayed.replayed, true);
        }
        const changed = await postFinancial(fixture.app, manualPath, auth, { ...input, reason: "补充理由不得篡改原操作" });
        assert.equal(changed.status, 409);
        assert.equal(await responseErrorCode(changed), "operation_conflict");
        fixture.database.read((connection) => {
          const row = connection.prepare("SELECT reason, request_json FROM financial_operations WHERE financial_operation_id = ?").get(input.financial_operation_id)!;
          assert.equal(row.reason, null);
          assert.equal(JSON.parse(String(row.request_json)).reason, null);
          assert.equal(readCount(connection, "financial_operations"), 1);
          assert.equal(readCount(connection, "ledger_transactions"), 1);
          assert.equal(readCount(connection, "outbox_events"), 1);
        });
        assert.equal(fixture.database.integrityCheck().ok, true);
      });
    });
  }

  it("keeps authentication, ledger eligibility and reversal reasons mandatory", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("reason-boundary", 999);
      const debit = fixture.recordDebit("reason-boundary-debit", 900, 1);
      const input = { financial_operation_id: randomUUID(), order_id: order.orderId, ledger_entry_id: debit.ledgerEntryId };
      const anonymous = await fixture.app.request(manualPath, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
      assert.equal(anonymous.status, 401);
      const noCsrf = await fixture.app.request(manualPath, { method: "POST", body: JSON.stringify(input), headers: { cookie: auth.cookie, origin: "http://localhost:6190", "content-type": "application/json" } });
      assert.equal(noCsrf.status, 403);
      assert.equal((await postFinancial(fixture.app, manualPath, auth, input)).status, 409);
      const credit = fixture.recordCredit("reason-boundary-credit", order.payableAmountCents, 2);
      const settled = fixture.reconciliation.settleManually({ financialOperationId: input.financial_operation_id, orderId: order.orderId, ledgerEntryId: credit.ledgerEntryId, actorId: "admin" });
      assert.equal(settled.operation.reason, null);
      const reverse = await postFinancial(fixture.app, "/api/admin/v1/reconciliation/matches/" + settled.paymentMatch.paymentMatchId + "/actions/reverse", auth, { financial_operation_id: randomUUID() });
      assert.equal(reverse.status, 422);
      const secondOrder = fixture.createOrder("already-allocated", 899);
      const allocated = await postFinancial(fixture.app, manualPath, auth, { ...input, financial_operation_id: randomUUID(), order_id: secondOrder.orderId, ledger_entry_id: credit.ledgerEntryId });
      assert.equal(allocated.status, 409);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("preserves old reasons and fingerprints during migration and supports backup/restore of missing reasons", async () => {
    await withHttpFixture(async (fixture) => {
      const order = fixture.createOrder("legacy-reason", 999);
      const entry = fixture.recordCredit("legacy-reason-entry", 900, 1);
      const legacy = fixture.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: order.orderId, ledgerEntryId: entry.ledgerEntryId, actorId: "admin", reason: "历史核对理由" });
      assert.equal(legacy.paymentMatch.evidence.schema, "perpay:manual-settlement:v1");
      const newOrder = fixture.createOrder("new-no-reason", 799);
      const newEntry = fixture.recordCredit("new-no-reason-entry", 800, 2);
      const snapshot = fixture.database.read(connection => ({
        operation: connection.prepare("SELECT * FROM financial_operations").all(),
        match: connection.prepare("SELECT * FROM payment_matches").all(),
      }));
      const databasePath = fixture.services.config.databasePath;
      fixture.database.close();
      const previous = new DatabaseSync(databasePath);
      try {
        previous.exec("DROP TABLE provider_application_key_changes; DELETE FROM schema_migrations WHERE version = 28; DROP TRIGGER financial_operations_reason_required; DELETE FROM schema_migrations WHERE version = 27;");
      } finally { previous.close(); }
      const upgraded = await AppDatabase.open(databasePath);
      const backupPath = join(fixture.directory, "manual-optional-backup.sqlite3");
      const input = { financialOperationId: randomUUID(), orderId: newOrder.orderId, ledgerEntryId: newEntry.ledgerEntryId, actorId: "admin", reason: null };
      try {
        assert.deepEqual(upgraded.read(connection => ({ operation: connection.prepare("SELECT * FROM financial_operations").all(), match: connection.prepare("SELECT * FROM payment_matches").all() })), snapshot);
        const history = upgraded.read(connection => connection.prepare("SELECT version, checksum FROM schema_migrations WHERE version <= 26 ORDER BY version").all());
        assert.deepEqual(history.map(row => ({ version: Number(row.version), checksum: row.checksum })), migrations.filter(m => m.version <= 26).map(m => ({ version: m.version, checksum: migrationChecksum(m) })));
        const result = new ReconciliationStore(upgraded).settleManually(input);
        assert.equal(result.operation.reason, null);
        assert.equal(upgraded.integrityCheck().ok, true);
        await upgraded.backupDetailed(backupPath);
      } finally { upgraded.close(); }
      const restored = await AppDatabase.open(backupPath);
      try {
        const replay = new ReconciliationStore(restored).settleManually(input);
        assert.equal(replay.replayed, true);
        assert.equal(replay.paymentMatch.evidence.reason, null);
        assert.equal(restored.integrityCheck().ok, true);
        assert.throws(() => restored.write(connection => connection.prepare(
          "INSERT INTO financial_operations(financial_operation_id, operation_key, request_fingerprint, request_json, operation_type, actor_type, actor_id, order_id, ledger_entry_id, reverses_operation_id, reason, created_at) SELECT ?, ?, request_fingerprint, request_json, 'REVERSE_SETTLEMENT', actor_type, actor_id, order_id, ledger_entry_id, financial_operation_id, NULL, created_at FROM financial_operations WHERE financial_operation_id = ?",
        ).run(randomUUID(), "invalid-reverse-" + randomUUID(), input.financialOperationId)), /financial operation reason is required/);
      } finally { restored.close(); }
      // A missing reason must not be accepted as old v26 evidence by backup verification.
      const damaged = new DatabaseSync(backupPath);
      try {
        damaged.exec("DROP TABLE provider_application_key_changes; DELETE FROM schema_migrations WHERE version = 28; DROP TRIGGER financial_operations_reason_required; DELETE FROM schema_migrations WHERE version = 27;");
        assert.equal(inspectDatabaseIntegrity(damaged).ok, false);
      } finally { damaged.close(); }
    });
  });
});
