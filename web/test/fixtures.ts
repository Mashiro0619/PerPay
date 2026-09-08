import type { AdminOrderDetail, ReconciliationLedgerEntry, RuntimeSettings } from "../src/api/client";

export const orderId = "11111111-1111-4111-8111-111111111111";
export const ledgerId = "22222222-2222-4222-8222-222222222222";
const emptySecret = { configured: false, version: null, fingerprint: null, masked: null, updatedAt: null };

export const settings: RuntimeSettings = {
  revision: 3, payment_revision: 1, updated_at: "2026-09-06T00:00:00.000Z",
  completion: { complete: false, application_key: false, collection: true, provider: false, api: false, notifications: false, next_step: "GENERATE_APPLICATION_KEY" },
  collection: { code_payload: "https://qr.alipay.com/test-fixture", order_ttl_seconds: 300, amount_offset_maximum_cents: 99 },
  provider: null, application_public_key: null, application_key_fingerprint: null, provider_generations: [],
  notifications: { enabled: false, allowed_origin: null, timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600 },
  advanced: { checkout_key_rotation_days: 90, checkout_terminal_observation_seconds: 86400 },
  backup: { interval_seconds: 86400, keep_count: 7 },
  secrets: { api_secret: emptySecret, provider_private_key: emptySecret, provider_public_key: emptySecret, webhook_secret: emptySecret },
};

export const order: AdminOrderDetail = {
  order_id: orderId, api_client_id: "default", merchant_order_no: "test-merchant-order", requested_amount_cents: 100,
  payable_amount_cents: 101, received_amount_cents: null, currency: "CNY", product_name: "测试商品", note: null,
  checkout: { status: "OPEN", expires_at: "2026-09-06T01:00:00.000Z", closed_at: null },
  payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null }, refund: { status: "NONE" },
  eligible_from: "2026-09-06T00:00:00.000Z", notification: { notify_url: null },
  events: [], reconciliation: { matches: [], exceptions: [] },
  created_at: "2026-09-06T00:00:00.000Z", updated_at: "2026-09-06T00:00:00.000Z", version: 1,
};

export const ledger: ReconciliationLedgerEntry = {
  ledger_entry_id: ledgerId, external_event_id: "test-event", semantic_fingerprint: "a".repeat(64),
  occurred_at: "2026-09-06T00:01:00.000Z", occurred_at_precision_milliseconds: 1000, occurred_at_interval_end_exclusive: "2026-09-06T00:01:01.000Z",
  amount_cents: 101, direction: "CREDIT", currency: "CNY", provider_order_no: "test-provider-order", merchant_order_no: null,
  memo: null, other_account: null, state: "UNALLOCATED", created_at: "2026-09-06T00:01:00.000Z", updated_at: "2026-09-06T00:01:00.000Z",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

export function apiError(code: string, message: string, status = 409): Response {
  return json({ error: { code, message, request_id: "test-request-id" } }, status);
}
