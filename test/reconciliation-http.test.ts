import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { seedLegacyRefund } from "./legacy-refund-fixture.ts";
import { API_SECRET, withHttpFixture, login, postFinancial, responseData, responseErrorCode, readCount, readCountWhere, readText } from "./reconciliation-http-fixture.ts";

describe("reconciliation HTTP contract", () => {
  it("automatically confirms a unique payment and exposes only settlement history", async () => {
    await withHttpFixture(async (fixture) => {
      const settlement = fixture.createSettlement("auto-http", 999);
      const checkout = await fixture.app.request(
        `/api/public/v1/checkouts/${settlement.order.checkoutToken}`,
      );
      assert.equal(checkout.status, 200);
      const checkoutData = await responseData<Record<string, any>>(checkout);
      assert.equal(checkoutData.payment.status, "CONFIRMED");
      assert.equal(checkoutData.payment.basis, "INFERRED");
      assert.equal(checkoutData.payment_instructions, null);

      const anonymous = await fixture.app.request("/api/admin/v1/reconciliation/matches");
      assert.equal(anonymous.status, 401);
      assert.equal(await responseErrorCode(anonymous), "session_invalid");
      const auth = await login(fixture.app);

      const detailResponse = await fixture.app.request(
        `/api/admin/v1/reconciliation/matches/${settlement.result.paymentMatchId}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(detailResponse.status, 200);
      const detail = await responseData<Record<string, any>>(detailResponse);
      assert.equal(detail.status, "SETTLED");
      assert.equal(detail.payment_match_id, settlement.result.paymentMatchId);
      assert.equal(detail.candidate.status, "SELECTED");
      assert.equal(detail.order.payment_status, "CONFIRMED");

      const history = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=SETTLED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(history.status, 200);
      const historyData = await responseData<Array<Record<string, any>>>(history);
      assert.equal(historyData.length, 1);
      assert.equal(historyData[0]?.payment_match_id, settlement.result.paymentMatchId);

      for (const action of ["confirm", "reject"]) {
        const removed = await fixture.app.request(
          `/api/admin/v1/reconciliation/matches/${settlement.result.paymentMatchId}/actions/${action}`,
          { method: "POST", headers: { cookie: auth.cookie } },
        );
        assert.equal(removed.status, 404);
        assert.equal(await responseErrorCode(removed), "route_not_found");
      }

      const debit = fixture.recordDebit("http-unmatched-debit", 100, 1);
      const unmatched = fixture.reconciliation.reconcileEntry(debit.ledgerEntryId);
      assert.equal(unmatched.kind, "ignored");
      const exceptions = await fixture.app.request(
        "/api/admin/v1/reconciliation/exceptions?limit=10",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(exceptions.status, 200);
      const exceptionData = await responseData<Array<Record<string, any>>>(exceptions);
      assert.deepEqual(exceptionData, []);
      assert.equal(fixture.reconciliation.ledgerEntry(debit.ledgerEntryId)?.state, "UNALLOCATED");
    });
  });

  it("paginates settlement history with a status-bound cursor", async () => {
    await withHttpFixture(async (fixture) => {
      const settlements = [1_001, 2_001, 3_001].map((amount, index) =>
        fixture.createSettlement(`history-${index}`, amount),
      );
      const auth = await login(fixture.app);
      let cursor: string | null = null;
      const discovered: string[] = [];
      do {
        const query = new URLSearchParams({ status: "SETTLED", limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await fixture.app.request(
          `/api/admin/v1/reconciliation/matches?${query.toString()}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          data: Array<Record<string, any>>;
          page: { next_cursor: string | null };
        };
        assert.equal(page.data.length, 1);
        discovered.push(String(page.data[0]?.payment_match_id));
        cursor = page.page.next_cursor;
      } while (cursor !== null);
      assert.deepEqual(
        new Set(discovered),
        new Set(settlements.map((item) => item.result.paymentMatchId)),
      );

      const invalid = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=PROPOSED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(invalid.status, 422);
      assert.equal(await responseErrorCode(invalid), "validation_failed");
      const malformed = await fixture.app.request(
        "/api/admin/v1/reconciliation/matches?status=SETTLED&cursor=not-a-canonical-cursor",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(malformed.status, 422);
      assert.equal(await responseErrorCode(malformed), "validation_failed");
    });
  });

  it("lists and inspects administrator orders without exposing checkout credentials", async () => {
    await withHttpFixture(async (fixture) => {
      const open = fixture.createOrder("admin-open", 1_499);
      const closed = fixture.createOrder("admin-closed", 2_499);
      fixture.closeOrder(closed.orderId);
      const confirmed = fixture.createSettlement("admin-confirmed", 3_499).order;

      const anonymous = await fixture.app.request("/api/admin/v1/orders");
      assert.equal(anonymous.status, 401);
      assert.equal(await responseErrorCode(anonymous), "session_invalid");
      const auth = await login(fixture.app);

      const unpaidIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ payment_status: "UNPAID", limit: "1" });
        if (cursor) query.set("cursor", cursor);
        const response = await fixture.app.request(
          `/api/admin/v1/orders?${query.toString()}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          data: Array<Record<string, any>>;
          page: { next_cursor: string | null };
        };
        assert.equal(page.data.length, 1);
        assert.equal(page.data[0]?.payment.status, "UNPAID");
        unpaidIds.push(String(page.data[0]?.order_id));
        cursor = page.page.next_cursor;
      } while (cursor !== null);
      assert.deepEqual(new Set(unpaidIds), new Set([open.orderId, closed.orderId]));

      const firstPage = await fixture.app.request(
        "/api/admin/v1/orders?payment_status=UNPAID&limit=1",
        { headers: { cookie: auth.cookie } },
      );
      const firstPageBody = (await firstPage.json()) as {
        page: { next_cursor: string | null };
      };
      assert.ok(firstPageBody.page.next_cursor);
      for (const reboundQuery of [
        `payment_status=CONFIRMED&limit=1&cursor=${firstPageBody.page.next_cursor}`,
        `payment_status=UNPAID&checkout_status=OPEN&limit=1&cursor=${firstPageBody.page.next_cursor}`,
      ]) {
        const rebound = await fixture.app.request(
          `/api/admin/v1/orders?${reboundQuery}`,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(rebound.status, 422);
        assert.equal(await responseErrorCode(rebound), "validation_failed");
      }

      const closedPage = await fixture.app.request(
        "/api/admin/v1/orders?checkout_status=CLOSED",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(closedPage.status, 200);
      const closedData = await responseData<Array<Record<string, any>>>(closedPage);
      assert.deepEqual(closedData.map((order) => order.order_id), [closed.orderId]);

      const byMerchant = await fixture.app.request(
        `/api/admin/v1/orders/by-merchant-no/${confirmed.merchantOrderNo}`,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(byMerchant.status, 200);
      const byMerchantText = await byMerchant.text();
      assert.equal(byMerchantText.includes(confirmed.checkoutToken), false);
      assert.equal(byMerchantText.includes(API_SECRET), false);
      assert.equal(byMerchantText.includes("idempotency_key_digest"), false);
      const byMerchantData = (JSON.parse(byMerchantText) as { data: Record<string, any> }).data;
      assert.equal(byMerchantData.order_id, confirmed.orderId);
      assert.equal(byMerchantData.api_client_id, "default");
      assert.equal(byMerchantData.payment.status, "CONFIRMED");
      assert.ok(Array.isArray(byMerchantData.reconciliation?.matches));
      assert.ok(Array.isArray(byMerchantData.reconciliation?.exceptions));
      assert.equal(byMerchantData.reconciliation.matches.length, 1);
      assert.equal(byMerchantData.reconciliation.matches[0].ledger_entry.amount_cents, confirmed.payableAmountCents);
      assert.equal(byMerchantData.reconciliation.matches[0].order.product_name, byMerchantData.product_name);
      assert.deepEqual(
        byMerchantData.events.map((event: Record<string, unknown>) => event.event_type),
        ["CREATED", "PAYMENT_CONFIRMED"],
      );
      assert.equal(byMerchantData.checkout.token, undefined);

      const byId = await fixture.app.request(`/api/admin/v1/orders/${closed.orderId}`, {
        headers: { cookie: auth.cookie },
      });
      assert.equal(byId.status, 200);
      const byIdData = await responseData<Record<string, any>>(byId);
      assert.equal(byIdData.checkout.status, "CLOSED");
      assert.deepEqual(
        byIdData.events.map((event: Record<string, unknown>) => event.event_type),
        ["CREATED", "CHECKOUT_CLOSED"],
      );

      for (const invalidQuery of [
        "checkout_status=UNKNOWN",
        "payment_status=UNKNOWN",
        "limit=0",
        "limit=201",
        "payment_status=UNPAID&payment_status=UNPAID",
        "cursor=not-a-canonical-cursor",
        "unknown=value",
      ]) {
        const invalid = await fixture.app.request(`/api/admin/v1/orders?${invalidQuery}`, {
          headers: { cookie: auth.cookie },
        });
        assert.equal(invalid.status, 422, invalidQuery);
        assert.equal(await responseErrorCode(invalid), "validation_failed");
      }

      const missing = await fixture.app.request(
        "/api/admin/v1/orders/00000000-0000-4000-8000-000000000000",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(missing.status, 404);
      assert.equal(await responseErrorCode(missing), "order_not_found");
      const invalidMerchant = await fixture.app.request(
        "/api/admin/v1/orders/by-merchant-no/invalid%20merchant",
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(invalidMerchant.status, 404);
      assert.equal(await responseErrorCode(invalidMerchant), "order_not_found");
    });
  });

  it("allows manual claim and reversal but retires the refund recording endpoint", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);

      const manualOrder = fixture.createOrder("manual", 2_999);
      const manualEntry = fixture.recordCredit("http-manual-entry", 2_900, 1);
      const manual = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/settlements/manual",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: manualOrder.orderId,
          ledger_entry_id: manualEntry.ledgerEntryId,
          reason: "link an exception after reviewing evidence",
        },
      );
      assert.equal(manual.status, 200);
      const manualData = await responseData<Record<string, any>>(manual);
      assert.equal(manualData.operation.operation_type, "MANUAL_SETTLEMENT");
      assert.equal(manualData.payment_match.status, "SETTLED");

      const auto = fixture.createSettlement("reverse", 3_999);
      const reversed = await postFinancial(
        fixture.app,
        `/api/admin/v1/reconciliation/matches/${auto.result.paymentMatchId}/actions/reverse`,
        auth,
        {
          financial_operation_id: randomUUID(),
          reason: "reverse an incorrect settlement",
        },
      );
      assert.equal(reversed.status, 200);
      const reversedData = await responseData<Record<string, any>>(reversed);
      assert.equal(reversedData.operation.operation_type, "REVERSE_SETTLEMENT");
      assert.equal(reversedData.payment_match.status, "REVERSED");

      const debit = fixture.recordDebit("http-refund-entry", 500, 2);
      const refund = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/refunds",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: manualOrder.orderId,
          ledger_entry_id: debit.ledgerEntryId,
          reason: "record a provider debit as a refund",
        },
      );
      assert.equal(refund.status, 410);
      assert.equal(await responseErrorCode(refund), "refund_recording_retired");
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("retains legacy refunds but rejects all new recording without financial side effects", async () => {
    await withHttpFixture(async (fixture) => {
      const auth = await login(fixture.app);
      const settlement = fixture.createSettlement("refund-cap", 4_999);
      const firstDebit = fixture.recordDebit("http-refund-cap-first", 3_000, 1);
      seedLegacyRefund(fixture.database, { financialOperationId: randomUUID(), orderId: settlement.order.orderId,
        ledgerEntryId: firstDebit.ledgerEntryId, actorId: "admin", reason: "historical refund", now: Date.now() });
      const before = fixture.database.read((connection) => ({
        operations: readCountWhere(connection, "financial_operations", "operation_type = 'RECORD_REFUND'"),
        refunds: readCount(connection, "refund_records"),
        transactions: readCount(connection, "ledger_transactions"),
        postings: readCount(connection, "ledger_postings"),
      }));
      const secondDebit = fixture.recordDebit("http-refund-cap-second", 3_000, 2);
      const second = await postFinancial(
        fixture.app,
        "/api/admin/v1/reconciliation/refunds",
        auth,
        {
          financial_operation_id: randomUUID(),
          order_id: settlement.order.orderId,
          ledger_entry_id: secondDebit.ledgerEntryId,
          reason: "this refund exceeds the confirmed receipt",
        },
      );
      assert.equal(second.status, 410);
      assert.equal(await responseErrorCode(second), "refund_recording_retired");
      fixture.database.read((connection) => {
        assert.deepEqual({
          operations: readCountWhere(connection, "financial_operations", "operation_type = 'RECORD_REFUND'"),
          refunds: readCount(connection, "refund_records"),
          transactions: readCount(connection, "ledger_transactions"),
          postings: readCount(connection, "ledger_postings"),
        }, before);
        assert.equal(readText(
          connection,
          "SELECT state FROM ledger_entries WHERE ledger_entry_id = ?",
          secondDebit.ledgerEntryId,
        ), "UNALLOCATED");
      });
    });
  });
});
