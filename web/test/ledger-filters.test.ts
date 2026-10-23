import { describe, expect, it } from "vitest";
import { LEDGER_DATE_FIELDS, LEDGER_SORT_FIELDS, ledgerAmountInput, migrateMatchListSearch, parseLedgerAmount, readLedgerFilters } from "../src/lib/ledger-filters";
import { readListQuery } from "../src/lib/list-query";

describe("administrator ledger filters", () => {
  it.each([["", undefined], ["0", 0], ["0.01", 1], ["0.29", 29], ["12.1", 1210], [" 001.20 ", 120], ["9999999999.99", 999999999999]] as const)("converts decimal text %s exactly to cents", (text, cents) => {
    expect(parseLedgerAmount(text)).toBe(cents);
  });
  it.each(["-1", "+1", ".01", "1.", "1.001", "1e3", "Infinity", "NaN", "1,000", "10000000000", "9".repeat(500)])("rejects invalid or excessive amounts %s", value => {
    expect(() => parseLedgerAmount(value)).toThrow();
  });
  it("queries income across all transaction dates in descending order by default", () => {
    expect(readLedgerFilters(new URLSearchParams())).toEqual({ direction: "CREDIT", sort_by: "occurred_at", sort_order: "desc" });
  });
  it("forwards only ledger filters and keeps zero boundaries", () => {
    const selected = "q= 付款 &direction=DEBIT&state=IGNORED&occurred_from=2026-10-01&occurred_to=2026-10-21&min_amount_cents=0&max_amount_cents=999999999999&sort_order=asc&selected_site=site-a&created_from=bad&api_client_id=ignored";
    expect(readLedgerFilters(new URLSearchParams(selected))).toEqual({ q: "付款", direction: "DEBIT", state: "IGNORED", occurred_from: "2026-10-01", occurred_to: "2026-10-21", min_amount_cents: 0, max_amount_cents: 999999999999, sort_by: "occurred_at", sort_order: "asc" });
  });
  it("keeps current association, reversal history, and both date ranges independent", () => {
    expect(readLedgerFilters(new URLSearchParams("association_status=MATCHED&has_reversals=true&occurred_from=2026-10-01&occurred_to=2026-10-02&associated_from=2026-10-03&associated_to=2026-10-04&sort_by=handled_at"))).toEqual({
      direction: "CREDIT", association_status: "MATCHED", has_reversals: true, occurred_from: "2026-10-01", occurred_to: "2026-10-02", associated_from: "2026-10-03", associated_to: "2026-10-04", sort_by: "handled_at", sort_order: "desc",
    });
    expect(readLedgerFilters(new URLSearchParams("has_reversals=false"))).toHaveProperty("has_reversals", false);
  });
  it.each(LEDGER_SORT_FIELDS)("supports the grouped transaction sort %s", sort => {
    expect(readLedgerFilters(new URLSearchParams("sort_by=" + sort))).toHaveProperty("sort_by", sort);
  });
  it.each(["min_amount_cents=-1", "max_amount_cents=1.5", "min_amount_cents=1e2", "max_amount_cents=1000000000000", "min_amount_cents=2&max_amount_cents=1", "direction=unknown", "state=unknown", "association_status=REVERSED", "has_reversals=1", "has_reversals=", "occurred_from=2026-02-30", "occurred_from=2026-10-21&occurred_to=2026-10-20", "associated_from=2026-02-30", "associated_from=2026-10-21&associated_to=2026-10-20"])("blocks invalid URL filters %s", text => {
    expect(() => readLedgerFilters(new URLSearchParams(text))).toThrow();
  });
  it.each(["SETTLED", "REVERSED"])("migrates %s match bookmarks without reusing the old match cursor", status => {
    const migrated = migrateMatchListSearch(new URLSearchParams("tab=matches&status=" + status + "&q=商品%26订单&selected_site=remembered&cursor=old&page=3&sort_by=created_at&sort_order=asc&created_from=2026-10-01&created_to=2026-10-03"))!;
    expect(migrated.get("tab")).toBe("transactions");
    expect(migrated.get("q")).toBe("商品&订单");
    expect(migrated.get("selected_site")).toBe("remembered");
    expect(migrated.get("sort_by")).toBe("associated_at");
    expect(migrated.get("sort_order")).toBe("asc");
    expect(migrated.get("associated_from")).toBe("2026-10-01");
    expect(migrated.get("associated_to")).toBe("2026-10-03");
    expect(migrated.has("cursor") || migrated.has("page") || migrated.has("status") || migrated.has("created_from")).toBe(false);
    expect(migrated.get(status === "SETTLED" ? "association_status" : "has_reversals")).toBe(status === "SETTLED" ? "MATCHED" : "true");
  });
  it("does not reinterpret unified or issue filters as match bookmarks", () => {
    for (const value of ["", "q=新查询&sort_by=amount_cents&cursor=opaque-new", "tab=transactions&association_status=UNMATCHED", "tab=transactions&created_from=2026-10-01", "tab=conflicts&sort_by=created_at", "tab=exceptions&created_from=2026-10-01"]) expect(migrateMatchListSearch(new URLSearchParams(value))).toBeNull();
    expect(migrateMatchListSearch(new URLSearchParams("tab=matches&sort_by=event_sequence"))!.get("sort_by")).toBe("event_sequence");
  });
  it.each([
    "sort_by=created_at",
    "created_from=2026-10-01&created_to=2026-10-03",
    "sort_by=created_at&created_from=2026-10-01&created_to=2026-10-03",
  ])("migrates the old default match list without a tab: %s", oldFilters => {
    const migrated = migrateMatchListSearch(new URLSearchParams(oldFilters + "&q=商品%26订单&sort_order=asc&selected_site=remembered&cursor=old&page=2"))!;
    expect(migrated.get("tab")).toBe("transactions");
    expect(migrated.get("association_status")).toBe("MATCHED");
    expect(migrated.get("q")).toBe("商品&订单");
    expect(migrated.get("sort_by")).toBe("associated_at");
    expect(migrated.get("sort_order")).toBe("asc");
    expect(migrated.get("selected_site")).toBe("remembered");
    expect(migrated.get("associated_from")).toBe(oldFilters.includes("created_from") ? "2026-10-01" : null);
    expect(migrated.get("associated_to")).toBe(oldFilters.includes("created_to") ? "2026-10-03" : null);
    expect(["cursor", "page", "status", "created_from", "created_to"].some(key => migrated.has(key))).toBe(false);
  });
  it.each([[null, ""], ["0", "0.00"], ["29", "0.29"], ["999999999999", "9999999999.99"], ["invalid", ""]] as const)("formats integer cent boundary %s for editing", (value, text) => {
    expect(ledgerAmountInput(value)).toBe(text);
  });
  it("keeps custom transaction date keys separate from the existing order export keys", () => {
    const search = new URLSearchParams("occurred_from=2026-10-01&occurred_to=2026-10-21&created_from=2026-09-01&created_to=2026-09-30");
    expect(readListQuery(search, LEDGER_SORT_FIELDS, "occurred_at", "desc", LEDGER_DATE_FIELDS).apiQuery).toEqual({ occurred_from: "2026-10-01", occurred_to: "2026-10-21", sort_by: "occurred_at", sort_order: "desc" });
    expect(readListQuery(search, ["created_at"], "created_at", "desc", true).apiQuery).toEqual({ created_from: "2026-09-01", created_to: "2026-09-30", sort_by: "created_at", sort_order: "desc" });
  });
});
