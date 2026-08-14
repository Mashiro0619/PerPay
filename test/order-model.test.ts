import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_REQUESTED_AMOUNT_CENTS,
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
  type CreateOrderRequest,
} from "../src/orders/model.ts";

describe("create order request model", () => {
  it("accepts the amount, merchant order number, and description boundaries", () => {
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "minimum",
        merchant_order_no: "A",
        amount_cents: 1,
      }).success,
      true,
    );
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "x".repeat(MAX_IDEMPOTENCY_KEY_BYTES),
        merchant_order_no: `Z${"._-a".repeat(15)}xyz`,
        amount_cents: MAX_REQUESTED_AMOUNT_CENTS,
        description: "付".repeat(200),
      }).success,
      true,
    );
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "😀".repeat(MAX_IDEMPOTENCY_KEY_BYTES / 4),
        merchant_order_no: "emoji-200",
        amount_cents: 1,
        description: "😀".repeat(200),
      }).success,
      true,
    );
  });

  it("rejects invalid merchant order numbers", () => {
    for (const merchantOrderNumber of [
      "",
      "-starts-with-symbol",
      ".starts-with-symbol",
      "contains space",
      "contains/slash",
      "ends-with-newline\n",
      "ends-with-return\r",
      "a".repeat(65),
      "订单-1",
    ]) {
      assert.equal(
        createOrderRequestSchema.safeParse({
          idempotency_key: "merchant-number-test",
          merchant_order_no: merchantOrderNumber,
          amount_cents: 1,
        }).success,
        false,
        merchantOrderNumber,
      );
    }
  });

  it("accepts only integer JSON numbers in the supported amount range", () => {
    for (const amount of [
      0,
      -1,
      1.5,
      MAX_REQUESTED_AMOUNT_CENTS + 1,
      "1",
      null,
    ]) {
      assert.equal(
        createOrderRequestSchema.safeParse({
          idempotency_key: "amount-test",
          merchant_order_no: "amount-boundary",
          amount_cents: amount,
        }).success,
        false,
        String(amount),
      );
    }
  });

  it("requires every non-optional request field", () => {
    const complete = {
      idempotency_key: "required-fields",
      merchant_order_no: "required-fields",
      amount_cents: 1,
    };

    for (const field of ["idempotency_key", "merchant_order_no", "amount_cents"] as const) {
      const missing: Partial<typeof complete> = { ...complete };
      delete missing[field];
      assert.equal(createOrderRequestSchema.safeParse(missing).success, false, field);
    }
  });

  it("bounds idempotency keys by encoding and rejects ambiguous whitespace or controls", () => {
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "checkout retry 1",
        merchant_order_no: "idempotency-valid",
        amount_cents: 1,
      }).success,
      true,
    );

    for (const idempotencyKey of [
      "",
      " leading",
      "trailing ",
      "line\nbreak",
      "control\u0085character",
      "x".repeat(MAX_IDEMPOTENCY_KEY_BYTES + 1),
      "😀".repeat(MAX_IDEMPOTENCY_KEY_BYTES / 4 + 1),
      "\ud800",
    ]) {
      assert.equal(
        createOrderRequestSchema.safeParse({
          idempotency_key: idempotencyKey,
          merchant_order_no: "idempotency-invalid",
          amount_cents: 1,
        }).success,
        false,
      );
    }
  });

  it("rejects extra fields and invalid descriptions", () => {
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "strict-fields",
        merchant_order_no: "strict-request",
        amount_cents: 1,
        callback_url: "https://merchant.invalid/callback",
      }).success,
      false,
    );

    for (const description of ["", "😀".repeat(201), "\ud800"]) {
      assert.equal(
        createOrderRequestSchema.safeParse({
          idempotency_key: "description-test",
          merchant_order_no: "description-boundary",
          amount_cents: 1,
          description,
        }).success,
        false,
      );
    }
  });
});

describe("create order request fingerprint", () => {
  it("is versioned, stable, and independent of object insertion order", () => {
    assert.equal(CREATE_ORDER_REQUEST_FINGERPRINT_VERSION, 1);

    const first = createOrderRequestSchema.parse({
      idempotency_key: "create-2026-08-subscription",
      merchant_order_no: "merchant-2026.08",
      amount_cents: 12_345,
      description: "年度订阅",
    });
    const reordered = createOrderRequestSchema.parse({
      description: "年度订阅",
      amount_cents: 12_345,
      merchant_order_no: "merchant-2026.08",
      idempotency_key: "create-2026-08-subscription",
    });

    const fingerprint = fingerprintCreateOrderRequest(first);
    assert.equal(fingerprint, fingerprintCreateOrderRequest(reordered));
    assert.equal(
      fingerprint,
      "997eefe929654f217a6a7b410d4ccc12591d82ffd3d76c5f251f271d66669efc",
    );
  });

  it("distinguishes every request field and a missing description from an empty value", () => {
    const base: CreateOrderRequest = {
      idempotency_key: "fingerprint-attempt-1",
      merchant_order_no: "fingerprint-1",
      amount_cents: 100,
    };
    const baseFingerprint = fingerprintCreateOrderRequest(base);

    const variants: readonly CreateOrderRequest[] = [
      { ...base, idempotency_key: "fingerprint-attempt-2" },
      { ...base, merchant_order_no: "fingerprint-2" },
      { ...base, amount_cents: 101 },
      { ...base, description: "" },
      { ...base, description: "0" },
    ];

    const fingerprints = new Set([
      baseFingerprint,
      ...variants.map((request) => fingerprintCreateOrderRequest(request)),
    ]);
    assert.equal(fingerprints.size, variants.length + 1);
  });
});
