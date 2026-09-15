import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { login, postFinancial, withHttpFixture } from "./reconciliation-http-fixture.ts";

describe("administrator detail context", () => {
  it("returns creation and reversal decisions consistently without changing financial records", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const order = fixture.createOrder("detail-manual", 999);
      const entry = fixture.recordCredit("detail-manual-entry", order.payableAmountCents, 0);
      const creation = fixture.reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: order.orderId, ledgerEntryId: entry.ledgerEntryId, actorId: "admin", reason: "已核实平台交易号" });
      const matchId = creation.paymentMatch.paymentMatchId;
      async function get(path: string) {
        const response = await fixture.app.request(path, { headers: { cookie: auth.cookie } });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json() as Promise<{ data: any }>;
      }
      const readMatch = () => get("/api/admin/v1/reconciliation/matches/" + matchId);
      const before = (await readMatch()).data;
      assert.equal(before.creation_operation.operation_type, "MANUAL_SETTLEMENT");
      assert.equal(before.creation_operation.actor_id, "admin");
      assert.equal(before.creation_operation.reason, "已核实平台交易号");
      assert.equal(before.status, "SETTLED");
      assert.equal(before.resolution_operation.operation_type, "MANUAL_SETTLEMENT");
      const reversal = fixture.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: matchId, actorId: "admin", reason: "核对后确认关联错误" });
      const snapshot = fixture.database.read(connection => connection.prepare("SELECT * FROM financial_operations ORDER BY rowid").all());
      const detail = (await readMatch()).data;
      assert.deepEqual(detail.creation_operation, before.creation_operation);
      assert.equal(detail.status, "REVERSED");
      assert.equal(detail.resolution_operation.financial_operation_id, reversal.operation.financialOperationId);
      assert.equal(detail.resolution_operation.operation_type, "REVERSE_SETTLEMENT");
      assert.equal(detail.resolution_operation.reason, "核对后确认关联错误");
      const embedded = (await get("/api/admin/v1/orders/" + order.orderId)).data.reconciliation;
      assert.deepEqual(embedded.matches[0], detail);
      assert.equal(embedded.exceptions[0].reminder_ignored, false);
      const history = (await get("/api/admin/v1/reconciliation/matches?status=REVERSED")).data;
      assert.deepEqual(history[0], detail);
      const ignore = await postFinancial(fixture.app, "/api/admin/v1/work-items/actions/ignore-all", auth, { operation_id: randomUUID(), type: "FINANCIAL_EXCEPTION" });
      assert.equal(ignore.status, 200);
      const ignored = (await get("/api/admin/v1/orders/" + order.orderId)).data.reconciliation.exceptions[0];
      assert.equal(ignored.reminder_ignored, true);
      assert.equal(ignored.status, "OPEN");
      assert.equal((await get("/api/admin/v1/reconciliation/exceptions/" + ignored.exception_id)).data.reminder_ignored, true);
      assert.deepEqual(fixture.database.read(connection => connection.prepare("SELECT * FROM financial_operations ORDER BY rowid").all()), snapshot);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("keeps inferred confirmation facts and administrator context on admin-only reads", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const settled = fixture.createSettlement("detail-automatic", 501);
      const path = "/api/admin/v1/orders/" + settled.order.orderId;
      assert.equal((await fixture.app.request(path)).status, 401);
      const response = await fixture.app.request(path, { headers: { cookie: auth.cookie } });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: any };
      const match = body.data.reconciliation.matches[0];
      assert.equal(match.creation_operation.actor_type, "SYSTEM");
      assert.equal(match.creation_operation.operation_type, "AUTO_SETTLEMENT");
      assert.equal(match.ledger_entry.ledger_entry_id, settled.entry.ledgerEntryId);
      assert.equal(match.candidate.evidence.amount_cents, settled.order.payableAmountCents);
      const checkout = await fixture.app.request("/api/public/v1/checkouts/" + settled.order.checkoutToken);
      const text = await checkout.text();
      for (const field of ["creation_operation", "resolution_operation", "reminder_ignored"]) assert.equal(text.includes(field), false);
    });
  });
});
