import type { AdminOrderDetail, FinancialException, FinancialOperation, MatchCandidate, OrderWebhookDeliveryDetail, PaymentMatchDetail, WebhookAttempt } from "../src/api/client";
import { ledger, ledgerId, order, orderId } from "./fixtures";

export const matchId = "33333333-3333-4333-8333-333333333333";
export const candidateId = "44444444-4444-4444-8444-444444444444";
export const operationId = "55555555-5555-4555-8555-555555555555";
export const deliveryId = "66666666-6666-4666-8666-666666666666";
export const exceptionId = "77777777-7777-4777-8777-777777777777";
export const detailLedger = { ...ledger, state: "ALLOCATED" as const, provider_order_no: "ALI-20260906-001", other_account: "测试买家", memo: "测试交易备注" };
export const operation: FinancialOperation = { financial_operation_id: operationId, operation_type: "AUTO_SETTLEMENT", actor_type: "SYSTEM", actor_id: null, order_id: orderId, ledger_entry_id: ledgerId, reverses_operation_id: null, reason: null, request_fingerprint: "a".repeat(64), created_at: "2026-09-06T00:01:02.000Z" };
export const candidate: MatchCandidate = {
  candidate_id: candidateId, ledger_entry_id: ledgerId, order_id: orderId, slot_id: "88888888-8888-4888-8888-888888888888",
  evidence_type: "AMOUNT_INFERRED", rule_version: 3, status: "SELECTED", candidate_fingerprint: "b".repeat(64), decided_by_operation_id: operationId,
  created_at: "2026-09-06T00:01:01.000Z", updated_at: operation.created_at, decided_at: operation.created_at,
  evidence: { schema: "perpay:match-candidate:v3", amount_cents: 101, occurred_at: Date.parse(detailLedger.occurred_at), slot_occupied_from: Date.parse(order.created_at), slot_released_at: null },
};
export const paymentMatch: PaymentMatchDetail = {
  payment_match_id: matchId, ledger_entry_id: ledgerId, order_id: orderId, candidate_id: candidateId, evidence_type: "AMOUNT_INFERRED", evidence: candidate.evidence,
  status: "SETTLED", created_by_operation_id: operationId, resolved_by_operation_id: operationId,
  creation_operation: operation, resolution_operation: operation,
  created_at: operation.created_at, updated_at: operation.created_at, resolved_at: operation.created_at,
  candidate, ledger_entry: detailLedger,
  order: { order_id: orderId, merchant_order_no: order.merchant_order_no, requested_amount_cents: 100, payable_amount_cents: 101, received_amount_cents: 101,
    currency: "CNY", product_name: order.product_name, note: null, checkout_status: "EXPIRED", payment_status: "CONFIRMED", payment_basis: "INFERRED", refund_status: "NONE",
    eligible_from: order.eligible_from, created_at: order.created_at, expires_at: order.checkout.expires_at, closed_at: null, updated_at: operation.created_at, version: 3 },
};
export const paidOrder: AdminOrderDetail = { ...order, received_amount_cents: 101, checkout: { ...order.checkout, status: "EXPIRED" },
  payment: { status: "CONFIRMED", basis: "INFERRED", received_amount_cents: 101 },
  reconciliation: { matches: [paymentMatch], exceptions: [] }, notification: { notify_url: "https://business.example.invalid/notify" },
  events: [{ event_id: orderId, sequence: 1, event_type: "CREATED", occurred_at: order.created_at, details: {} },
    { event_id: matchId, sequence: 2, event_type: "PAYMENT_CONFIRMED", occurred_at: operation.created_at, details: { evidence_type: "AMOUNT_INFERRED" } }],
};
export const financialException: FinancialException = {
  exception_id: exceptionId, provider_account_key: "primary", exception_type: "AMOUNT_MISMATCH", ledger_entry_id: ledgerId, order_id: orderId, candidate_id: candidateId,
  context_key: "test", details: { reason: "possible_overpayment", actual_amount_cents: 102, expected_amount_cents: 101 }, exception_fingerprint: "c".repeat(64), status: "OPEN", reminder_ignored: false,
  resolution_operation_id: null, resolution: null, created_at: operation.created_at, resolved_at: null,
};
export const failedAttempt: WebhookAttempt = {
  attempt_id: exceptionId, delivery_id: deliveryId, attempt_number: 1, key_version: 1, key_id: operationId, request_timestamp: 1, request_body_fingerprint: "d".repeat(64),
  outcome: "RETRYABLE_FAILURE", resolved_addresses_fingerprint: null, connected_address: null, http_status: 200, response_bytes: 2, response_fingerprint: null,
  ack_code: null, error_code: "INVALID_ACKNOWLEDGEMENT", started_at: operation.created_at, finished_at: operation.created_at,
};
export const delivery: OrderWebhookDeliveryDetail = {
  is_latest: true,
  delivery: { delivery_id: deliveryId, event_id: matchId, target_id: operationId, generation: 1, predecessor_delivery_id: null, request_key: operationId,
    requested_by_type: "SYSTEM", requested_by_actor_id: null, reason: null, status: "RETRY_WAIT", attempt_count: 1, next_attempt_at: "2026-09-06T00:02:00.000Z", lease_expires_at: null,
    acknowledged_at: null, dead_lettered_at: null, last_error_code: "INVALID_ACKNOWLEDGEMENT", created_at: operation.created_at, updated_at: operation.created_at },
  event: { event_id: matchId, event_type: "PAYMENT_CONFIRMED", order_id: orderId, order_version: 2, payload: { schema: "perpay:webhook:v1", event_id: matchId, event_type: "PAYMENT_CONFIRMED", order_id: orderId, merchant_order_no: order.merchant_order_no, product_name: order.product_name, note: null, order_version: 2 }, payload_fingerprint: "e".repeat(64), created_at: operation.created_at },
  target: { target_id: operationId, order_id: orderId, api_client_id: "default", format: "NATIVE_JSON_V1", target_url: "https://business.example.invalid/notify", allowed_origin: "https://business.example.invalid", url_fingerprint: "f".repeat(64), created_at: order.created_at },
  attempts: [failedAttempt],
};
