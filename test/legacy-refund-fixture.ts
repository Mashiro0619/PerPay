import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../src/database/database.ts";
import { orderEventDetailsFingerprint } from "../src/orders/model.ts";
import { financialOperationEvidence, financialOperationFingerprint, outboxPayloadFingerprint, refundRecordEvidence } from "../src/reconciliation/model.ts";

/** Seeds pre-retirement history only in isolated tests. No production refund writer remains. */
export function seedLegacyRefund(database: AppDatabase, input: {
  financialOperationId: string; orderId: string; ledgerEntryId: string; actorId: string; reason: string; now: number;
}) {
  return database.write((connection) => {
    const order = connection.prepare("SELECT * FROM payment_orders WHERE order_id = ?").get(input.orderId) as Record<string, string | number | bigint | null>;
    const debit = connection.prepare("SELECT * FROM ledger_entries WHERE ledger_entry_id = ?").get(input.ledgerEntryId) as Record<string, string | number | bigint | null>;
    assert.ok(order); assert.ok(debit); assert.equal(debit.direction, "DEBIT");
    assert.ok(["CONFIRMED", "DISPUTED"].includes(String(order.payment_status)));
    const amount = Number(debit.amount_cents);
    const previous = connection.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refund_records WHERE order_id = ?").get(input.orderId) as { total: number | bigint };
    const total = Number(previous.total) + amount;
    assert.ok(total <= Number(order.received_amount_cents));
    const refundStatus = total === Number(order.received_amount_cents) ? "FULL" : "PARTIAL";
    const version = Number(order.version) + 1;
    const clock = connection.prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1").get() as { last_now_ms: number | bigint };
    const now = Math.max(input.now, Number(clock.last_now_ms));
    connection.prepare("UPDATE order_clock SET last_now_ms = ? WHERE singleton_key = 1").run(now);
    const facts = { operationType: "RECORD_REFUND" as const, actorType: "ADMIN" as const, actorId: input.actorId,
      orderId: input.orderId, ledgerEntryId: input.ledgerEntryId, candidateId: null, paymentMatchId: null, reversesOperationId: null, reason: input.reason };
    connection.prepare(`INSERT INTO financial_operations(financial_operation_id, operation_key, request_fingerprint, request_json,
      operation_type, actor_type, actor_id, order_id, ledger_entry_id, reverses_operation_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'RECORD_REFUND', 'ADMIN', ?, ?, ?, NULL, ?, ?)`)
      .run(input.financialOperationId, "admin:" + input.financialOperationId, financialOperationFingerprint(facts), JSON.stringify(financialOperationEvidence(facts)), input.actorId, input.orderId, input.ledgerEntryId, input.reason, now);
    const transactionId = randomUUID();
    connection.prepare(`INSERT INTO ledger_transactions(ledger_transaction_id, financial_operation_id, order_id, ledger_entry_id,
      transaction_type, currency, status, created_at, posted_at) VALUES (?, ?, ?, ?, 'REFUND', 'CNY', 'DRAFT', ?, NULL)`)
      .run(transactionId, input.financialOperationId, input.orderId, input.ledgerEntryId, now);
    const posting = connection.prepare(`INSERT INTO ledger_postings(posting_id, ledger_transaction_id, account_code, side,
      amount_cents, currency, order_id, ledger_entry_id, created_at) VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?)`);
    posting.run(randomUUID(), transactionId, "REFUND_CLEARING", "DEBIT", amount, input.orderId, input.ledgerEntryId, now);
    posting.run(randomUUID(), transactionId, "PROVIDER_CASH", "CREDIT", amount, input.orderId, input.ledgerEntryId, now);
    connection.prepare("UPDATE ledger_transactions SET status = 'POSTED', posted_at = ? WHERE ledger_transaction_id = ?").run(now, transactionId);
    const refundRecordId = randomUUID();
    connection.prepare(`INSERT INTO refund_records(refund_record_id, financial_operation_id, ledger_entry_id, order_id, amount_cents, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(refundRecordId, input.financialOperationId, input.ledgerEntryId, input.orderId, amount,
        JSON.stringify(refundRecordEvidence({ financialOperationId: input.financialOperationId, actorId: input.actorId, reason: input.reason })), now);
    connection.prepare("UPDATE ledger_entries SET state = 'ALLOCATED', updated_at = ? WHERE ledger_entry_id = ?").run(now, input.ledgerEntryId);
    connection.prepare("UPDATE payment_orders SET refund_status = ?, updated_at = ?, version = version + 1 WHERE order_id = ?").run(refundStatus, now, input.orderId);
    const details = { refund_record_id: refundRecordId, refund_amount_cents: amount, refunded_amount_cents: total };
    const eventDetails = JSON.stringify({ financial_operation_id: input.financialOperationId, ...details, refund_status: refundStatus });
    connection.prepare(`INSERT INTO order_events(event_id, order_id, sequence, event_type, occurred_at, details_json, details_fingerprint)
      VALUES (?, ?, ?, 'REFUND_UPDATED', ?, ?, ?)`).run(randomUUID(), input.orderId, version, now, eventDetails, orderEventDetailsFingerprint(eventDetails));
    const outboxEventId = randomUUID();
    const payload = JSON.stringify({ schema: "perpay:outbox-event:v2", event_id: outboxEventId, event_type: "REFUND_UPDATED",
      financial_operation_id: input.financialOperationId, order_id: input.orderId, merchant_order_no: order.merchant_order_no,
      product_name: order.product_name, note: order.note, requested_amount_cents: Number(order.requested_amount_cents),
      payable_amount_cents: Number(order.payable_amount_cents), received_amount_cents: Number(order.received_amount_cents), currency: order.currency,
      payment_status: order.payment_status, payment_basis: order.payment_basis, refund_status: refundStatus,
      event_details: details, order_version: version, occurred_at: now });
    connection.prepare(`INSERT INTO outbox_events(outbox_event_id, financial_operation_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, payload_json, payload_fingerprint, created_at) VALUES (?, ?, 'PAYMENT_ORDER', ?, ?, 'REFUND_UPDATED', ?, ?, ?)`)
      .run(outboxEventId, input.financialOperationId, input.orderId, version, payload, outboxPayloadFingerprint(payload), now);
    return { refundRecordId, refundStatus, orderVersion: version, outboxEventId };
  });
}
