import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MAX_REQUESTED_AMOUNT_CENTS,
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
  fingerprintOrderNote,
  orderEventDetailsFingerprint,
  type CreateOrderRequest,
} from "../src/orders/model.ts";

describe("create order request model", () => {
  it("accepts the amount, merchant order number, and description boundaries", () => {
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "minimum",
        merchant_order_no: "A",
        amount_cents: 1,
        product_name: "商品",
      }).success,
      true,
    );
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "x".repeat(MAX_IDEMPOTENCY_KEY_BYTES),
        merchant_order_no: `Z${"._-a".repeat(15)}xyz`,
        amount_cents: MAX_REQUESTED_AMOUNT_CENTS,
        product_name: "付".repeat(200),
      }).success,
      true,
    );
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "😀".repeat(MAX_IDEMPOTENCY_KEY_BYTES / 4),
        merchant_order_no: "emoji-200",
        amount_cents: 1,
        product_name: "😀".repeat(200),
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
      product_name: "商品",
    };

    for (const field of ["idempotency_key", "merchant_order_no", "amount_cents", "product_name"] as const) {
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
        product_name: "商品",
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
          product_name: description,
        }).success,
        false,
      );
    }
  });

  it("requires a product name and normalizes optional notes", () => {
    const missingProduct = createOrderRequestSchema.safeParse({
      idempotency_key: "missing-product",
      merchant_order_no: "missing-product",
      amount_cents: 1,
    });
    assert.equal(missingProduct.success, false);

    const emptyNote = createOrderRequestSchema.parse({
      idempotency_key: "empty-note",
      merchant_order_no: "empty-note",
      amount_cents: 1,
      product_name: "商品",
      note: "  ",
    });
    assert.equal(emptyNote.note, null);

    const trimmed = createOrderRequestSchema.parse({
      idempotency_key: "trimmed-metadata",
      merchant_order_no: "trimmed-metadata",
      amount_cents: 1,
      product_name: "  商品名称  ",
      note: "  商户备注  ",
    });
    assert.equal(trimmed.product_name, "商品名称");
    assert.equal(trimmed.note, "商户备注");

    const whitespaceOnly = createOrderRequestSchema.parse({
      idempotency_key: "long-whitespace-note",
      merchant_order_no: "long-whitespace-note",
      amount_cents: 1,
      product_name: "商品",
      note: " ".repeat(501),
    });
    assert.equal(whitespaceOnly.note, null);

    const explicitNull = createOrderRequestSchema.parse({
      idempotency_key: "null-note",
      merchant_order_no: "null-note",
      amount_cents: 1,
      product_name: "商品",
      note: null,
    });
    assert.equal(explicitNull.note, null);
    assert.equal(
      createOrderRequestSchema.safeParse({
        idempotency_key: "note-control",
        merchant_order_no: "note-control",
        amount_cents: 1,
        product_name: "商品",
        note: "备注\n控制",
      }).success,
      false,
    );
  });
});

describe("create order request fingerprint", () => {
  it("is versioned, stable, and independent of object insertion order", () => {
    assert.equal(CREATE_ORDER_REQUEST_FINGERPRINT_VERSION, 1);

    const first = createOrderRequestSchema.parse({
      idempotency_key: "create-2026-08-subscription",
      merchant_order_no: "merchant-2026.08",
      amount_cents: 12_345,
      product_name: "年度订阅",
    });
    const reordered = createOrderRequestSchema.parse({
      product_name: "年度订阅",
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
      product_name: "商品",
    };
    const baseFingerprint = fingerprintCreateOrderRequest(base);

    const variants: readonly CreateOrderRequest[] = [
      { ...base, idempotency_key: "fingerprint-attempt-2" },
      { ...base, merchant_order_no: "fingerprint-2" },
      { ...base, amount_cents: 101 },
      { ...base, product_name: "不同商品" },
    ];

    const fingerprints = new Set([
      baseFingerprint,
      ...variants.map((request) => fingerprintCreateOrderRequest(request)),
    ]);
    assert.equal(fingerprints.size, variants.length + 1);
    assert.notEqual(fingerprintOrderNote(null), fingerprintOrderNote("备注"));
  });
});

describe("order event evidence fingerprint", () => {
  it("binds the exact persisted JSON bytes to a versioned domain", () => {
    const details = '{"amount_offset_cents":1,"slot_generation":1}';
    assert.equal(
      orderEventDetailsFingerprint(details),
      "6c56b74e0e2a8d8714d943b7ba5c2b400e080641b5b0ea79faa42b7ac410a17a",
    );
    assert.notEqual(
      orderEventDetailsFingerprint(details),
      orderEventDetailsFingerprint('{"slot_generation":1,"amount_offset_cents":1}'),
    );
  });
});
