import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LedgerNormalizationError,
  parseAmountCents,
  parseDirection,
  parseOccurredAt,
  parseOccurredAtWithPrecision,
  rewindProviderWindowStart,
  requestFingerprint,
  semanticFingerprint,
  validateWindow,
} from "../src/ledger/model.ts";

describe("ledger normalization model", () => {
  it("parses provider CNY values to integer cents without floating point rounding", () => {
    assert.equal(parseAmountCents("0.01"), 1);
    assert.equal(parseAmountCents("12"), 1_200);
    assert.equal(parseAmountCents("12.3"), 1_230);
    assert.equal(parseAmountCents("-12.30"), 1_230);
    assert.equal(parseAmountCents("9999999999.99"), 999_999_999_999);

    for (const invalid of [null, "", "0", "1.001", "01.00", "NaN", "10000000000.00"]) {
      assert.throws(
        () => parseAmountCents(invalid),
        (error: unknown) =>
          error instanceof LedgerNormalizationError && error.code === "INVALID_AMOUNT",
      );
    }
  });

  it("accepts only real provider-formatted scan windows", () => {
    assert.doesNotThrow(() => validateWindow({
      start: "2026-08-14 00:00:00",
      end: "2026-08-14 00:00:01",
    }));
    for (const window of [
      { start: "2026-02-30 00:00:00", end: "2026-03-01 00:00:00" },
      { start: "2026-08-14T00:00:00+08:00", end: "2026-08-14T01:00:00+08:00" },
      { start: "2026-08-14 01:00:00", end: "2026-08-14 00:00:00" },
    ]) {
      assert.throws(() => validateWindow(window), /ledger window/);
    }
  });

  it("normalizes provider directions and timestamps deterministically", () => {
    assert.equal(parseDirection("收入"), "CREDIT");
    assert.equal(parseDirection("credit"), "CREDIT");
    assert.equal(parseDirection("支出"), "DEBIT");
    assert.equal(parseDirection("OUT"), "DEBIT");
    assert.equal(
      parseOccurredAt("2026-08-14 12:34:56"),
      Date.parse("2026-08-14T12:34:56+08:00"),
    );
    assert.equal(parseOccurredAt("2026-08-14T12:34:56+08:00"), Date.parse("2026-08-14T12:34:56+08:00"));
    assert.deepEqual(parseOccurredAtWithPrecision("2026-08-14 12:34:56"), {
      milliseconds: Date.parse("2026-08-14T12:34:56+08:00"),
      precisionMilliseconds: 1_000,
    });
    assert.deepEqual(parseOccurredAtWithPrecision("2026-08-14T12:34:56.12+08:00"), {
      milliseconds: Date.parse("2026-08-14T12:34:56.12+08:00"),
      precisionMilliseconds: 10,
    });
    assert.throws(
      () => parseOccurredAtWithPrecision("2026-08-14T12:34:56.1234+08:00"),
      (error: unknown) =>
        error instanceof LedgerNormalizationError && error.code === "INVALID_TIMESTAMP",
    );
    assert.throws(
      () => parseOccurredAt("2026-02-30 12:34:56"),
      (error: unknown) =>
        error instanceof LedgerNormalizationError && error.code === "INVALID_TIMESTAMP",
    );
    assert.throws(
      () => parseDirection("unknown"),
      (error: unknown) =>
        error instanceof LedgerNormalizationError && error.code === "INVALID_DIRECTION",
    );
  });

  it("rejects invalid calendar fields, times and offsets in zoned timestamps", () => {
    for (const value of [
      "2030-02-30T12:34:56+08:00",
      "2025-02-29T12:34:56Z",
      "2026-04-31T12:34:56-05:00",
      "2026-00-14T12:34:56Z",
      "2026-13-14T12:34:56Z",
      "2026-08-00T12:34:56Z",
      "2026-08-14T24:00:00+08:00",
      "2026-08-14T12:60:00Z",
      "2026-08-14T12:34:60Z",
      "2026-08-14T12:34:56+24:00",
      "2026-08-14T12:34:56+08:60",
      "2026-08-14T12:34+08:00",
      "2026-08-14T12:34:56.1234Z",
    ]) {
      assert.throws(
        () => parseOccurredAtWithPrecision(value),
        (error: unknown) =>
          error instanceof LedgerNormalizationError && error.code === "INVALID_TIMESTAMP",
        value,
      );
    }
  });

  it("preserves valid leap dates, timezone boundaries and declared millisecond precision", () => {
    for (const [value, expectedUtc, precisionMilliseconds] of [
      ["2024-02-29T23:59:59.123Z", "2024-02-29T23:59:59.123Z", 1],
      ["2024-03-01T00:30:00.1+01:00", "2024-02-29T23:30:00.100Z", 100],
      ["2024-02-29T23:30:00.12-02:30", "2024-03-01T02:00:00.120Z", 10],
      ["1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z", 1_000],
      ["2026-08-14 12:34:56.001", "2026-08-14T04:34:56.001Z", 1],
      ["2026-08-14T12:34:56", "2026-08-14T04:34:56.000Z", 1_000],
    ] as const) {
      assert.deepEqual(parseOccurredAtWithPrecision(value), {
        milliseconds: Date.parse(expectedUtc),
        precisionMilliseconds,
      }, value);
    }
  });

  it("scopes request identity to the account and semantic identity to normalized facts", () => {
    const first = requestFingerprint("primary", "2026-08-14 00:00:00", "2026-08-14 01:00:00", 1, 2000);
    assert.equal(first, requestFingerprint("primary", "2026-08-14 00:00:00", "2026-08-14 01:00:00", 1, 2000));
    assert.notEqual(first, requestFingerprint("other", "2026-08-14 00:00:00", "2026-08-14 01:00:00", 1, 2000));

    const facts = {
      externalEventId: "event-1",
      occurredAt: 1_797_033_600_000,
      occurredAtPrecisionMilliseconds: 1_000 as const,
      amountCents: 1_001,
      direction: "CREDIT" as const,
      alipayOrderNo: "alipay-1",
      merchantOrderNo: null,
      transMemo: "memo",
      otherAccount: null,
    };
    const semantic = semanticFingerprint(facts);
    assert.equal(semantic, semanticFingerprint(facts));
    assert.notEqual(semantic, semanticFingerprint({ ...facts, amountCents: 1_002 }));
    assert.notEqual(
      semantic,
      semanticFingerprint({ ...facts, occurredAtPrecisionMilliseconds: 1 }),
    );
  });

  it("computes a deterministic China-time overlap lower bound", () => {
    assert.equal(
      rewindProviderWindowStart("2026-08-14 00:00:00", 300_000, Date.parse("2026-08-14T00:10:00+08:00")),
      "2026-08-14 00:05:00",
    );
    assert.equal(
      rewindProviderWindowStart("2026-08-14 00:00:00", 300_000),
      "2026-08-13 23:55:00",
    );
  });
});
