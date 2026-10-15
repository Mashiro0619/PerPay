import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListDateTime, ListMoney } from "../src/components/list-primitives";

describe("business record formatting", () => {
  it("keeps cents, zero and unknown amounts distinct", () => {
    render(<><ListMoney value={0} /><ListMoney value={12901} /><ListMoney value={null} /></>);
    expect(screen.getByText("¥0.00")).toBeVisible();
    expect(screen.getByText("¥129.01")).toBeVisible();
    expect(screen.getByText("—")).toBeVisible();
  });

  it("uses Beijing calendar dates at midnight and preserves the machine-readable instant", () => {
    render(<ListDateTime value="2026-10-09T16:01:00Z" />);
    const time = screen.getByTitle("2026/10/10 00:01（北京时间）");
    expect(time).toHaveAttribute("datetime", "2026-10-09T16:01:00.000Z");
    expect(time).toHaveTextContent("2026/10/10 00:01");
    expect(screen.getByText("00:01")).toBeVisible();
  });

  it.each([null, undefined, "invalid"])("keeps an unavailable timestamp %s empty", (value) => {
    const view = render(<ListDateTime value={value} />);
    expect(screen.getByText("—")).toBeVisible();
    expect(view.container.querySelector("time")).toBeNull();
  });
});
