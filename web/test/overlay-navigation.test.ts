import { describe, expect, it } from "vitest";
import { createPath } from "react-router";
import { legacyOverlayLocation, overlayBackground, overlayOwner, parseOverlayTarget, readOverlayTarget, withOverlayTarget, withoutOverlaySearch } from "../src/lib/overlay-navigation";

describe("overlay addresses", () => {
  it("keeps parent filters and cursor separate from detail search and anchors", () => {
    const parent = { pathname: "/orders", search: "?payment=PAID&cursor=list-cursor&page=3", hash: "" };
    const target = parseOverlayTarget("/orders/order-1?cursor=detail-cursor&page=2&section=notifications#delivery-1")!;
    const location = withOverlayTarget(parent, target);
    expect(new URLSearchParams(location.search).get("cursor")).toBe("list-cursor");
    expect(readOverlayTarget(location.search)).toEqual(target);
    expect(overlayBackground(location)).toEqual(parent);
    const nextTab = { ...target, search: "?section=events" };
    expect(overlayOwner(target)).toBe(overlayOwner(nextTab));
  });

  it.each(["https://example.com/orders/id", "//example.com/orders/id", "/checkout/token", "/orders/..", "/orders/%2F", "/orders/id?overlay=%2Forders%2Fother", "/audit/invalid/id", "/sites/a", "/sites/a/settings/basic"])("does not promote %s to a detail", target => {
    expect(parseOverlayTarget(target)).toBeNull();
  });

  it("rejects duplicate presentation parameters and removes only that parameter", () => {
    expect(readOverlayTarget("?overlay=%2Forders%2Fa&overlay=%2Forders%2Fb")).toBeNull();
    expect(withoutOverlaySearch("?q=a%20b&overlay=%2Forders%2Fa&selected_site=s&cursor=x%2By")).toBe("?q=a%20b&selected_site=s&cursor=x%2By");
    const parent = { pathname: "/orders", search: "?q=a%20b&cursor=x%2By", hash: "#list" };
    expect(overlayBackground(withOverlayTarget(parent, parseOverlayTarget("/orders/order-1")!))).toEqual(parent);
  });

  it("opens old detail links above a deterministic parent and preserves their target hash", () => {
    const result = legacyOverlayLocation({ pathname: "/ledger/entry-1", search: "?selected_site=shop", hash: "#match-1", key: "direct", state: null })!;
    expect(result.to.pathname).toBe("/reconciliation");
    expect(new URLSearchParams(result.to.search).get("tab")).toBe("transactions");
    expect(createPath(readOverlayTarget(result.to.search)!)).toBe("/ledger/entry-1?selected_site=shop#match-1");
  });
});
