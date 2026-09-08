import { describe, expect, it } from "vitest";

import { dateTime, money, parseAmount, safeCheckoutUrl, validatePassword } from "../src/lib/format";
import { createOperationKey } from "../src/lib/idempotency";

describe("financial input and operation identity", () => {
  it("parses decimal currency without floating point rounding", () => {
    expect(parseAmount("0.29")).toBe(29);
    expect(parseAmount("1.1")).toBe(110);
    expect(parseAmount("100.00")).toBe(10000);
    for (const invalid of ["0", "-1", "1.001", "1e2", "100.01", "Infinity", "", "999999999999999999999999"]) {
      expect(() => parseAmount(invalid)).toThrow();
    }
  });

  it("does not display missing money as an actual zero payment", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(0)).toMatch(/0\.00/);
    expect(money(101)).toMatch(/1\.01/);
    expect(dateTime("bad-date")).toBe("—");
  });

  it("displays absolute timestamps in Beijing time across midnight and year boundaries", () => {
    expect(dateTime("2025-12-31T15:59:59.999Z")).toBe("2025/12/31 23:59");
    expect(dateTime("2025-12-31T16:00:00.000Z")).toBe("2026/01/01 00:00");
    expect(dateTime("2026-01-01T00:00:00+08:00")).toBe("2026/01/01 00:00");
  });

  it.each(["a", "密", "🔐"])("requires six Unicode characters for passwords containing %s", (character) => {
    expect(validatePassword(character.repeat(5))).toBe("密码至少需要 6 个字符。");
    expect(validatePassword(character.repeat(6))).toBeNull();
  });

  it("retains the UTF-8 byte limit and well-formed Unicode checks", () => {
    expect(validatePassword("a".repeat(1024))).toBeNull();
    expect(validatePassword("a".repeat(1025))).not.toBeNull();
    expect(validatePassword("文".repeat(400))).not.toBeNull();
    expect(validatePassword("a".repeat(6) + "\ud800")).not.toBeNull();
  });

  it("reuses an operation ID only for an identical retried payload", () => {
    const key = createOperationKey();
    const first = key({ amount_cents: 29 });
    expect(key({ amount_cents: 29 })).toBe(first);
    expect(key({ amount_cents: 30 })).not.toBe(first);
    expect(createOperationKey()({ amount_cents: 29 })).not.toBe(first);
  });

  it("rejects unsafe or non-checkout navigation targets", () => {
    expect(safeCheckoutUrl("javascript:alert(1)")).toBeNull();
    expect(safeCheckoutUrl("https://example.test/not-a-checkout")).toBeNull();
    expect(safeCheckoutUrl(`https://user:password@example.test/checkout/pct1_${"a".repeat(43)}`)).toBeNull();
    expect(safeCheckoutUrl(`/checkout/pct1_${"a".repeat(43)}`)).toContain("/checkout/pct1_");
  });
});
