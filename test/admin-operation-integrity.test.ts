import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { countAdminOperationViolations } from "../src/database/admin-operation-integrity.ts";
import { adminFingerprint, recordAdminOperation } from "../src/database/admin-operation-store.ts";
import { type AdminWorkItemType, type IgnoreAllResult } from "../src/http/admin-work-items.ts";
import { login, postFinancial, responseData, withHttpFixture, type ReconciliationHttpFixture } from "./reconciliation-http-fixture.ts";

interface IgnoreFilter { type: AdminWorkItemType; api_client_id?: string; q?: string; }

async function ignoreThroughHttp(fixture: ReconciliationHttpFixture, filters: IgnoreFilter) {
  const { order } = fixture.createSettlement("integrity-order", 999);
  const duplicate = fixture.recordCredit("integrity-target", order.payableAmountCents, 5);
  const selected = fixture.reconciliation.reconcileEntry(duplicate.ledgerEntryId);
  assert.equal(selected.kind, "unmatched");
  const unrelated = fixture.recordCredit("integrity-other", 121, 6);
  assert.equal(fixture.reconciliation.reconcileEntry(unrelated.ledgerEntryId).kind, "unmatched");
  assert.equal(fixture.database.integrityCheck().ok, true);

  const auth = await login(fixture.app);
  const input = { operation_id: randomUUID(), ...filters };
  const response = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, input);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await responseData<IgnoreAllResult>(response);
  assert.equal(result.ignored_count, filters.api_client_id || filters.q?.trim() ? 1 : 2);
  const replay = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, input);
  assert.equal(replay.status, 200);
  assert.deepEqual(await responseData(replay), result);
  return result;
}

function operationEvidence(database: AppDatabase, operationId: string) {
  return database.read(connection => ({
    operation: connection.prepare("SELECT * FROM admin_operation_log WHERE operation_id = ?").get(operationId),
    members: connection.prepare("SELECT * FROM admin_work_item_operations WHERE operation_id = ? ORDER BY kind,item_id").all(operationId),
    audit: connection.prepare("SELECT * FROM audit_events WHERE subject_type = 'admin_operation' AND subject_id = ?").all(operationId),
  }));
}

describe("filtered administrator operation integrity", () => {
  const scenarios: Array<{ name: string; filter: IgnoreFilter }> = [
    { name: "keyword", filter: { type: "ALL", q: "  integrity-target  " } },
    { name: "site", filter: { type: "ALL", api_client_id: "default" } },
    { name: "keyword and site", filter: { type: "FINANCIAL_EXCEPTION", api_client_id: "default", q: "integrity-target" } },
    { name: "legacy type-only", filter: { type: "FINANCIAL_EXCEPTION" } },
    { name: "legacy unfiltered", filter: { type: "ALL" } },
    { name: "empty normalized keyword", filter: { type: "ALL", q: " \t " } },
  ];
  for (const scenario of scenarios) {
    it(`accepts ${scenario.name} ignores and their unchanged replay`, async () => {
      await withHttpFixture(async fixture => {
        const result = await ignoreThroughHttp(fixture, scenario.filter);
        if (scenario.filter.q?.trim()) assert.equal(result.q, scenario.filter.q.trim());
        else assert.equal(Object.hasOwn(result, "q"), false, "legacy result shape must not gain an empty keyword");
        assert.equal(Object.hasOwn(result, "api_client_id"), scenario.filter.api_client_id !== undefined);
        assert.deepEqual(fixture.database.integrityCheck(), {
          ok: true, quickCheck: "ok", foreignKeyViolations: 0, domainViolations: 0, schema: "ok",
        });
      });
    });
  }

  it("creates and opens a verified backup without rewriting filtered operation or audit evidence", async () => {
    await withHttpFixture(async fixture => {
      const result = await ignoreThroughHttp(fixture, { type: "ALL", api_client_id: "default", q: "integrity-target" });
      const before = operationEvidence(fixture.database, result.operation_id);
      const target = join(fixture.directory, "filtered-operations-backup.sqlite3");
      assert.ok(await fixture.database.backup(target) > 0);
      const backup = await AppDatabase.open(target, { masterKey: fixture.services.config.masterKey });
      try {
        assert.equal(backup.integrityCheck().ok, true);
        assert.deepEqual(operationEvidence(backup, result.operation_id), before);
      } finally { backup.close(); }
    });
  });

  it("reopens an existing database containing filtered ignores without a migration or data rewrite", async () => {
    await withHttpFixture(async fixture => {
      const result = await ignoreThroughHttp(fixture, { type: "ALL", q: "integrity-target" });
      const before = operationEvidence(fixture.database, result.operation_id);
      fixture.database.close();
      const reopened = await AppDatabase.open(fixture.services.config.databasePath, { masterKey: fixture.services.config.masterKey });
      try {
        assert.equal(reopened.integrityCheck().ok, true);
        assert.deepEqual(operationEvidence(reopened, result.operation_id), before);
      } finally { reopened.close(); }
    });
  });

  it("rejects invalid or noncanonical filters even when operation and audit fingerprints agree", async () => {
    await withHttpFixture(async fixture => {
      const invalid = [
        { api_client_id: "" }, { api_client_id: "../site" }, { api_client_id: 42 }, { api_client_id: null },
        { q: "" }, { q: " padded " }, { q: 42 }, { q: null }, { q: "x".repeat(101) }, { q: "\0" }, { q: "\ud800" },
      ];
      for (const filters of invalid) {
        const before = fixture.database.read(countAdminOperationViolations);
        fixture.database.write(connection => {
          const operationId = randomUUID();
          recordAdminOperation(connection, { operationId, action: "work_items.ignore_all", now: Date.now(), context: { actorId: "admin" },
            requestFingerprint: adminFingerprint({ type: "ALL", ...filters }),
            result: { operation_id: operationId, type: "ALL", ignored_count: 0, ...filters },
            membershipFingerprint: adminFingerprint([]) });
        });
        assert.ok(fixture.database.read(countAdminOperationViolations) > before, JSON.stringify(filters));
      }
    });
  });
});
