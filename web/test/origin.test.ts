import { describe, expect, it } from "vitest";
import { isSameOriginUrl } from "../src/lib/origin";

describe("isSameOriginUrl", () => {
  it("accepts same-origin relative and absolute URLs", () => {
    expect(isSameOriginUrl("/admin/orders", "https://pay.example.com/admin/")).toBe(true);
    expect(isSameOriginUrl("https://pay.example.com:443/api/v1", "https://pay.example.com/admin/")).toBe(true);
  });

  it("rejects cross-origin and opaque null origins", () => {
    expect(isSameOriginUrl("https://evil.example.com/admin", "https://pay.example.com/admin/")).toBe(false);
    expect(isSameOriginUrl("http://pay.example.com/admin", "https://pay.example.com/admin/")).toBe(false);
    expect(isSameOriginUrl("data:text/html,hi", "data:text/html,base")).toBe(false);
    expect(isSameOriginUrl("javascript:alert(1)", "https://pay.example.com/admin/")).toBe(false);
  });
});
