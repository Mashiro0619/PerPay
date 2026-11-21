import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerFreshness } from "../src/components/ledger-freshness";

afterEach(() => { vi.useRealTimers(); });

describe("ledger scan freshness", () => {
  it.each([
    [undefined, "暂不可用"],
    [null, "暂无记录"],
    [0, "1970/01/01 08:00"],
    [Date.UTC(2026, 9, 18, 15, 42), "23:42"],
    [Date.UTC(2026, 9, 17, 15, 42), "10/17 23:42"],
    [Infinity, "暂不可用"],
  ] as const)("distinguishes unavailable, never successful, and successful scans for %s", (value, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 18, 15, 50));
    render(<LedgerFreshness value={value} scope="all" />);
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(/数据截至/)).not.toBeInTheDocument();
    if (typeof value === "number" && Number.isFinite(value)) {
      expect(screen.getByText(expected)).toHaveAttribute("datetime", new Date(value).toISOString());
      expect(screen.getByText("（多账号取最新）")).toBeVisible();
    } else {
      expect(screen.queryByText("（多账号取最新）")).not.toBeInTheDocument();
    }
  });
});
