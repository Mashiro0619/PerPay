import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LedgerFreshness } from "../src/components/ledger-freshness";

describe("ledger scan freshness", () => {
  it.each([
    [undefined, "暂不可用"],
    [null, "暂无记录"],
    [0, "08:00"],
    [Date.UTC(2026, 9, 18, 15, 42), "23:42"],
    [Infinity, "暂不可用"],
  ] as const)("distinguishes unavailable, never successful, and successful scans for %s", (value, expected) => {
    render(<LedgerFreshness value={value} />);
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(/数据截至/)).not.toBeInTheDocument();
    if (typeof value === "number" && Number.isFinite(value)) {
      expect(screen.getByText(expected)).toHaveAttribute("datetime", new Date(value).toISOString());
    }
  });
});
