import { describe, expect, it } from "vitest";
import { siteChoiceLabel } from "../src/lib/site-choice-label";

const uuid = "12345678-abcd-4abc-8abc-123456789012";
const site = (client_id: string, name = "同名网站") => ({ client_id, configuration: { name } });

describe("website choice labels", () => {
  it("shows only the name when the website is unique", () => {
    const sites = [site("shop", "商店"), site("site_shop", "会员中心")];
    expect(sites.map(value => siteChoiceLabel(value, sites))).toEqual(["商店", "会员中心"]);
  });

  it("retains compact identifiers for generated IDs with distinct prefixes", () => {
    const sites = [site("site_" + uuid), site("site_abcdef12-abcd-4abc-8abc-123456789012")];
    expect(sites.map(value => siteChoiceLabel(value, sites))).toEqual(["同名网站 · 12345678", "同名网站 · abcdef12"]);
  });

  it("deduplicates repeated rows and includes the current site before its list page arrives", () => {
    const current = site("shop");
    expect(siteChoiceLabel(current, [current, current])).toBe("同名网站");
    expect(siteChoiceLabel(current, [site("site_shop")])).toBe("同名网站 · shop");
  });

  it.each([
    ["custom and prefixed IDs", ["shop", "site_shop"]],
    ["generated and bare UUIDs", ["site_" + uuid, uuid]],
    ["successive prefixes", ["shop", "site_shop", "site_site_shop", "site_site_site_shop"]],
    ["prefix-only IDs", ["site_", "site_site_", "site_site_site_"]],
    ["shared prefixes", ["shop-main", "shop-main-v2", "shop-main-v2-preview"]],
    ["short IDs", ["abc", "abcd", "abc_", "abc."]],
    ["64-character IDs", ["a".repeat(63) + "x", "a".repeat(63) + "y"]],
    ["64-character prefixed IDs", ["site_" + "a".repeat(58) + "x", "a".repeat(58) + "x"]],
    ["case-sensitive IDs", ["Shop", "shop", "site_Shop", "site_shop"]],
    ["multiple collision groups", ["shop", "site_shop", "other", "site_other", "site_site_other"]],
  ] as const)("distinguishes %s regardless of candidate ordering", (_description, ids) => {
    const sites = ids.map(id => site(id));
    const labels = sites.map(value => siteChoiceLabel(value, sites));
    expect(new Set(labels).size).toBe(ids.length);
    expect(labels.every(label => label.length > "同名网站 · ".length)).toBe(true);
    expect(sites.map(value => siteChoiceLabel(value, [...sites].reverse()))).toEqual(labels);
  });

  it("uses the original identities when removing a prefix makes them equal", () => {
    const sites = [site("shop"), site("site_shop")];
    expect(sites.map(value => siteChoiceLabel(value, sites))).toEqual(["同名网站 · shop", "同名网站 · site_sho"]);
  });

  it("keeps unrelated long IDs compact when a collision requires original prefixes", () => {
    const sites = ["shop", "site_shop", "a".repeat(64), "b".repeat(64)].map(id => site(id));
    expect(sites.map(value => siteChoiceLabel(value, sites))).toEqual([
      "同名网站 · shop", "同名网站 · site_sho", "同名网站 · aaaaaaaa", "同名网站 · bbbbbbbb",
    ]);
  });
});
