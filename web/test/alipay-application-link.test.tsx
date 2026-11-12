import { describe, expect, it } from "vitest";
import { alipayApplicationUrl } from "../src/lib/application-key";
const managementUrl = "https://open.alipay.com/develop/manage";
const detailsUrl = "https://open.alipay.com/develop/pm/sub/appinfo";

describe("Alipay application shortcuts", () => {
  it.each([undefined, null, "", " \n "])(
    "uses application management before an App ID exists (%j)",
    (appId) => {
      expect(alipayApplicationUrl(appId)).toBe(managementUrl);
    },
  );
  it("opens the supplied App ID using the official application details URL", () => {
    expect(alipayApplicationUrl(" 2026000000000001 ")).toBe(
      detailsUrl + "?appId=2026000000000001",
    );
  });
  it("encodes the App ID without permitting injected query parameters or a different host", () => {
    const id = "app&redirect=https://other.invalid/#fragment?x=1";
    const url = new URL(alipayApplicationUrl(id));
    expect(url.origin + url.pathname).toBe(detailsUrl);
    expect([...url.searchParams.entries()]).toEqual([["appId", id]]);
    expect(url.hash).toBe("");
  });
});
