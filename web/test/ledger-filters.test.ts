import { describe, expect, it } from "vitest";
import { LEDGER_DATE_FIELDS, LEDGER_SORT_FIELDS, ledgerAmountInput, parseLedgerAmount, readLedgerFilters } from "../src/lib/ledger-filters";
import { readListQuery } from "../src/lib/list-query";

describe("administrator ledger filters", () => {
  it.each([["", undefined], ["0", 0], ["0.01", 1], ["0.29", 29], ["12.1", 1210], [" 001.20 ", 120], ["9999999999.99", 999999999999]] as const)("converts decimal text %s exactly to cents", (text, cents) => {
    expect(parseLedgerAmount(text)).toBe(cents);
  });
  it.each(["-1", "+1", ".01", "1.", "1.001", "1e3", "Infinity", "NaN", "1,000", "10000000000", "9".repeat(500)])("rejects invalid or excessive amounts %s", value => {
    expect(() => parseLedgerAmount(value)).toThrow();
  });
  it("queries all transaction dates in descending order by default", () => {
    expect(readLedgerFilters(new URLSearchParams())).toEqual({ sort_by: "occurred_at", sort_order: "desc" });
  });
  it("forwards only ledger filters and keeps zero boundaries", () => {
    const selected = "q= 付款 &direction=DEBIT&state=IGNORED&occurred_from=2026-10-01&occurred_to=2026-10-21&min_amount_cents=0&max_amount_cents=999999999999&sort_order=asc&selected_site=site-a&created_from=bad&api_client_id=ignored";
    expect(readLedgerFilters(new URLSearchParams(selected))).toEqual({ q: "付款", direction: "DEBIT", state: "IGNORED", occurred_from: "2026-10-01", occurred_to: "2026-10-21", min_amount_cents: 0, max_amount_cents: 999999999999, sort_by: "occurred_at", sort_order: "asc" });
  });
  it.each(["min_amount_cents=-1", "max_amount_cents=1.5", "min_amount_cents=1e2", "max_amount_cents=1000000000000", "min_amount_cents=2&max_amount_cents=1", "direction=unknown", "state=unknown", "occurred_from=2026-02-30", "occurred_from=2026-10-21&occurred_to=2026-10-20"])("blocks invalid URL filters %s", text => {
    expect(() => readLedgerFilters(new URLSearchParams(text))).toThrow();
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
