import { describe, expect, it } from "vitest";
import {
  actualPageAddress,
  isGlobalNavigationPage,
  navigationSection,
  navigationSelection,
  sidebarHref,
  switchWorkspaceHref,
  withNavigationSelection,
  type NavigationSection,
} from "../src/lib/navigation-selection";

const all = { clientId: null, base: "" };
const siteA = { clientId: "site_a", base: "/sites/site_a" };
const selectedA = { pathname: "/system", search: "?selected_site=site_a" };

describe("navigation selection stays separate from the actual workspace", () => {
  it.each([
    "/reconciliation", "/reconciliation/conflicts/conflict-id", "/system",
    "/sites", "/sites/new", "/sites/defaults", "/system/",
  ])("permits navigation memory on the global page %s", (pathname) => {
    expect(isGlobalNavigationPage(pathname)).toBe(true);
    expect(navigationSelection({ pathname, search: "?selected_site=site_a" })).toEqual(siteA);
    expect(navigationSelection({ pathname })).toEqual(all);
  });

  it.each([
    "/", "/orders", "/orders/order-id", "/notifications", "/work-items",
    "/settings", "/settings/display", "/sites/site_a/orders", "/sites/newish",
    "/system-old", "/system/details", "/reconciliation-old", "/sites/new/details",
  ])("does not treat %s as a global page with navigation memory", (pathname) => {
    expect(isGlobalNavigationPage(pathname)).toBe(false);
  });

  it("trusts real site paths over a conflicting selection query", () => {
    expect(navigationSelection({ pathname: "/sites/site_a/orders", search: "?selected_site=site_b" })).toEqual(siteA);
    expect(navigationSelection({ pathname: "/sites/site_a/settings/basic", search: "?selected_site=" })).toEqual(siteA);
  });

  it("does not turn global business or instance settings pages into site pages", () => {
    for (const pathname of ["/", "/orders/order-id", "/notifications", "/work-items", "/settings/display"]) {
      expect(navigationSelection({ pathname, search: "?selected_site=site_a&api_client_id=site_b" })).toEqual(all);
    }
  });

  it("reads encoded identities without using browser storage or the legacy API filter", () => {
    expect(navigationSelection({ pathname: "/system", search: "?selected_site=site%2Ba" })).toEqual({
      clientId: "site+a", base: "/sites/site%2Ba",
    });
    expect(navigationSelection({ pathname: "/system", search: "?api_client_id=site_a" })).toEqual(all);
    expect(navigationSelection({ pathname: "/system", search: "?selected_site=" })).toEqual(all);
    expect(navigationSelection({ pathname: "/system", search: "?selected_site=new" })).toEqual(all);
  });
});

describe("fixed navigation sections and destinations", () => {
  it.each([
    ["/", "overview"], ["/sites/site_a", "overview"],
    ["/sites/site%2Ea/orders/order-id", "orders"], ["/orders/order-id", "orders"],
    ["/sites/site_a/notifications/delivery-id", "notifications"],
    ["/sites/site_a/reconciliation/exceptions/exception-id", "work-items"],
    ["/reconciliation/exceptions/exception-id", "reconciliation"],
    ["/reconciliation/transactions/entry-id", "reconciliation"], ["/ledger/entry-id", "reconciliation"],
    ["/settings/security", "settings"], ["/sites/site_a/settings/integration", "settings"],
    ["/sites/new", "sites"], ["/sites/defaults", "sites"], ["/system/", "system"],
    ["/orders-old", null], ["/test-payment", null], ["/sites/site_a/unknown", null],
  ] as const)("classifies %s as %s", (pathname, section) => {
    expect(navigationSection(pathname)).toBe(section);
  });

  it.each([
    ["overview", "/", "/sites/site_a"],
    ["orders", "/orders", "/sites/site_a/orders"],
    ["work-items", "/work-items", "/sites/site_a/work-items"],
    ["notifications", "/notifications", "/sites/site_a/notifications"],
    ["settings", "/settings", "/sites/site_a/settings/basic"],
    ["reconciliation", "/reconciliation", "/reconciliation?selected_site=site_a"],
    ["system", "/system", "/system?selected_site=site_a"],
    ["sites", "/sites", "/sites?selected_site=site_a"],
  ] satisfies Array<[NavigationSection, string, string]>)("resolves the fixed %s item in both selections", (section, globalHref, siteHref) => {
    expect(sidebarHref(section, all)).toBe(globalHref);
    expect(sidebarHref(section, siteA)).toBe(siteHref);
  });
});

describe("switching a navigation selection", () => {
  it("does nothing for an already selected option, including detail pages", () => {
    expect(switchWorkspaceHref({ pathname: "/sites/site_a/orders/order-id" }, "site_a")).toBeNull();
    expect(switchWorkspaceHref(selectedA, "site_a")).toBeNull();
    expect(switchWorkspaceHref({ pathname: "/settings" }, null)).toBeNull();
  });

  it("keeps order filters but drops pagination and identities when entering a site", () => {
    const href = switchWorkspaceHref({
      pathname: "/orders",
      search: "?payment=UNPAID&checkout=OPEN&q=hello&sort_by=created_at&sort_order=asc&created_from=2026-10-01&created_to=2026-10-09&cursor=old&page=4&order_id=old&api_client_id=site_old&selected_site=site_old",
      hash: "#old-record",
    }, "site_a");
    expect(href).toBe("/sites/site_a/orders?payment=UNPAID&checkout=OPEN&q=hello&sort_by=created_at&sort_order=asc&created_from=2026-10-01&created_to=2026-10-09");
  });

  it.each([
    ["/sites/site_a/orders/order-id", "?payment=DISPUTED&cursor=old&page=3&order_id=old", "/sites/site_b/orders?payment=DISPUTED"],
    ["/sites/site_a/notifications/delivery-id", "?status=FAILED&q=hello&attempts_cursor=old&delivery_id=old", "/sites/site_b/notifications?status=FAILED&q=hello"],
    ["/sites/site_a/reconciliation/exceptions/exception-id", "?order_id=old&ledger_id=old", "/sites/site_b/work-items"],
    ["/sites/site_a/work-items", "?type=NOTIFICATION_FAILURE&visibility=IGNORED&sort_by=ignored_at&sort_order=desc&cursor=old&page=8", "/sites/site_b/work-items?type=NOTIFICATION_FAILURE&visibility=IGNORED&sort_by=ignored_at&sort_order=desc"],
  ])("takes %s to its corresponding target list", (pathname, search, target) => {
    expect(switchWorkspaceHref({ pathname, search, hash: "#old" }, "site_b")).toBe(target);
  });

  it("returns to the same global business list when selecting all sites", () => {
    expect(switchWorkspaceHref({ pathname: "/sites/site_a/orders/order-id", search: "?payment=CONFIRMED&cursor=old" }, null)).toBe("/orders?payment=CONFIRMED");
    expect(switchWorkspaceHref({ pathname: "/sites/site_a/reconciliation/matches/match-id" }, null)).toBe("/work-items");
  });

  it("keeps only a supported overview range and drops the shared-only work-item type", () => {
    expect(switchWorkspaceHref({ pathname: "/", search: "?range=90&q=unrelated&cursor=old" }, "site_a")).toBe("/sites/site_a?range=90");
    expect(switchWorkspaceHref({ pathname: "/sites/site_a", search: "?range=365" }, null)).toBe("/");
    expect(switchWorkspaceHref({ pathname: "/work-items", search: "?type=LEDGER_CONFLICT&visibility=IGNORED" }, "site_a")).toBe("/sites/site_a/work-items?visibility=IGNORED");
  });

  it("preserves site settings groups only when switching between actual sites", () => {
    for (const section of ["basic", "orders", "integration", "display"]) {
      expect(switchWorkspaceHref({ pathname: "/sites/site_a/settings/" + section }, "site_b")).toBe("/sites/site_b/settings/" + section);
    }
    expect(switchWorkspaceHref({ pathname: "/settings/display" }, "site_b")).toBe("/sites/site_b/settings/basic");
    expect(switchWorkspaceHref({ pathname: "/sites/site_a/settings/display" }, null)).toBe("/settings");
    expect(switchWorkspaceHref({ pathname: "/sites/site_a/settings/unknown" }, "site_b")).toBe("/sites/site_b/settings/basic");
  });

  it.each(["/reconciliation", "/system", "/sites", "/sites/new", "/sites/defaults"])(
    "preserves the actual global page, query bytes and hash at %s", (pathname) => {
      const location = { pathname, search: "?q=hello%20world&selected_site=site_a&cursor=old&page=3&sort_by=created_at", hash: "#position" };
      const href = switchWorkspaceHref(location, "site_b");
      expect(href).toBe(pathname + "?q=hello%20world&cursor=old&page=3&sort_by=created_at&selected_site=site_b#position");
      expect(switchWorkspaceHref(location, null)).toBe(pathname + "?q=hello%20world&cursor=old&page=3&sort_by=created_at#position");
      expect(actualPageAddress({ pathname, search: "?q=hello%20world&cursor=old&page=3&sort_by=created_at&selected_site=site_b" })).toBe(actualPageAddress(location));
    },
  );

  it.each(["matches", "exceptions", "conflicts"])("returns a global %s detail to its matching list", (kind) => {
    expect(switchWorkspaceHref({
      pathname: "/reconciliation/" + kind + "/resource-id",
      search: "?selected_site=site_a&cursor=old&page=8&order_id=old&ledger_id=old",
      hash: "#resource",
    }, "site_b")).toBe("/reconciliation?tab=" + kind + "&selected_site=site_b");
  });

  it("does not carry an evidence ID out of a global ledger detail", () => {
    expect(switchWorkspaceHref({ pathname: "/reconciliation/ledger/ledger-id", search: "?selected_site=site_a&order_id=order-id" }, null)).toBe("/reconciliation");
  });

  it("keeps a unified transaction and its source anchor when changing navigation memory", () => {
    expect(switchWorkspaceHref({ pathname: "/reconciliation/transactions/entry-id", search: "?association_status=MATCHED&has_reversals=true&selected_site=site_a", hash: "#source-entry-id" }, "site_b"))
      .toBe("/reconciliation/transactions/entry-id?association_status=MATCHED&has_reversals=true&selected_site=site_b#source-entry-id");
  });

  it("falls back to the new overview from an unrelated page", () => {
    expect(switchWorkspaceHref({ pathname: "/test-payment", search: "?order_id=old" }, "site_a")).toBe("/sites/site_a");
  });
});

describe("actual page identity for drafts and in-flight operations", () => {
  it("ignores only selected_site on eligible global pages", () => {
    expect(actualPageAddress({ pathname: "/system", search: "?selected_site=site_a" })).toBe("/system");
    expect(actualPageAddress({ pathname: "/system", search: "?selected_site=site_b" })).toBe("/system");
    expect(actualPageAddress({ pathname: "/sites/defaults", search: "?q=a%20b&selected_site=site_a&sort_order=asc" })).toBe("/sites/defaults?q=a%20b&sort_order=asc");
    expect(actualPageAddress({ pathname: "/reconciliation", search: "?selected_site=a&tab=matches&%73elected_site=b" })).toBe("/reconciliation?tab=matches");
  });

  it("preserves other raw encodings, order, duplicate fields and malformed query keys", () => {
    const pathname = "/reconciliation";
    const search = "?q=a%20b&x=%2f&x=%2F&%bad=value&selected_site=site_a&tab=matches";
    expect(actualPageAddress({ pathname, search })).toBe("/reconciliation?q=a%20b&x=%2f&x=%2F&%bad=value&tab=matches");
    expect(actualPageAddress({ pathname, search: "?q=a+b" })).not.toBe(actualPageAddress({ pathname, search: "?q=a%20b" }));
    expect(actualPageAddress({ pathname, search: "?tab=matches&q=a" })).not.toBe(actualPageAddress({ pathname, search: "?q=a&tab=matches" }));
  });

  it("still detects real page and business-filter changes", () => {
    expect(actualPageAddress({ pathname: "/reconciliation", search: "?tab=matches&selected_site=site_a" })).not.toBe(actualPageAddress({ pathname: "/reconciliation", search: "?tab=conflicts&selected_site=site_b" }));
    expect(actualPageAddress({ pathname: "/reconciliation/matches/one", search: "?selected_site=site_a" })).not.toBe(actualPageAddress({ pathname: "/reconciliation", search: "?selected_site=site_b" }));
    for (const pathname of ["/orders", "/settings", "/sites/site_a/settings/basic", "/unknown"]) {
      expect(actualPageAddress({ pathname, search: "?selected_site=site_a" })).toBe(pathname + "?selected_site=site_a");
    }
  });
});

describe("carrying navigation memory without changing resource targets", () => {
  it("carries the actual site into a global destination without normalizing its query or hash", () => {
    expect(withNavigationSelection("/reconciliation?tab=matches&q=a%20b#items", { pathname: "/sites/site_a/orders" })).toBe("/reconciliation?tab=matches&q=a%20b&selected_site=site_a#items");
    expect(withNavigationSelection("/sites/new", selectedA)).toBe("/sites/new?selected_site=site_a");
    expect(withNavigationSelection("/reconciliation/matches/match-id", selectedA)).toBe("/reconciliation/matches/match-id?selected_site=site_a");
  });

  it("preserves To objects and supports query-only destinations on the same global page", () => {
    expect(withNavigationSelection({ pathname: "/sites/defaults", search: "?q=a%20b", hash: "#config" }, selectedA)).toEqual({ pathname: "/sites/defaults", search: "?q=a%20b&selected_site=site_a", hash: "#config" });
    expect(withNavigationSelection("?tab=conflicts", { pathname: "/reconciliation", search: "?selected_site=site_a" })).toBe("?tab=conflicts&selected_site=site_a");
    expect(withNavigationSelection({ search: "?tab=matches" }, { pathname: "/reconciliation", search: "?selected_site=site_a" })).toEqual({ search: "?tab=matches&selected_site=site_a" });
  });

  it("honors explicit target selections and explicit clearing", () => {
    expect(withNavigationSelection("/system?selected_site=site_b", selectedA)).toBe("/system?selected_site=site_b");
    expect(withNavigationSelection("/system?selected_site=", selectedA)).toBe("/system?selected_site=");
    expect(withNavigationSelection("/system", selectedA, false)).toBe("/system");
    const target = { pathname: "/system", search: "?q=raw%20text" };
    expect(withNavigationSelection(target, selectedA, false)).toBe(target);
  });

  it.each(["/", "/orders/another-site-order", "/notifications/delivery-id", "/work-items", "/settings/provider", "/sites/site_b/orders", "/system-old", "../system", "https://example.com/system"])(
    "does not retarget or attach navigation scope to %s", (to) => {
      expect(withNavigationSelection(to, selectedA)).toBe(to);
    },
  );

  it("does not invent a selection on a global business route", () => {
    expect(withNavigationSelection("/system", { pathname: "/orders", search: "?selected_site=site_a" })).toBe("/system");
  });
});
