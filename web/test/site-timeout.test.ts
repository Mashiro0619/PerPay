import { describe, expect, it } from "vitest";
import { integerUnits, siteTimeoutError, siteTimeoutSeconds } from "../src/lib/site-timeout";

describe("website timeout seconds", () => {
  it.each([1000, 5123, 5500, 30000])("round trips %i integer milliseconds", milliseconds => {
    const raw = siteTimeoutSeconds(milliseconds);
    expect(siteTimeoutError(raw)).toBeNull();
    expect(integerUnits(raw, 1000)).toBe(milliseconds);
  });
  it.each(["5.1234", "5.0004"])("rejects unrepresentable seconds %s", raw => {
    expect(siteTimeoutError(raw)).toBe("通知超时最多 3 位小数。");
  });
  it.each(["0.5", "30.001"])("retains the backend timeout range for %s", raw => {
    expect(siteTimeoutError(raw)).toBe("通知超时应为 1 至 30 秒。");
  });
  it("keeps an empty draft invalid and accepts exact trailing zeroes", () => {
    expect(siteTimeoutError("")).toBe("请输入通知超时。");
    expect(siteTimeoutError("5.1230")).toBeNull();
  });
});
