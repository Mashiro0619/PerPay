import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import { SectionCards } from "../src/components/section-cards";
import { mobileMedia } from "./mobile-media";

const analytics: SystemAnalytics = {
  range_days: 7,
  from: "2026-10-13T00:00:00+08:00",
  to: "2026-10-20T00:00:00+08:00",
  orders: { created: 0, unpaid: 0, confirmed: 0, disputed: 0, closed: 0, expired: 0 },
  confirmations: { count: 123456789, amount_cents: 987654321012 },
  notifications: { acknowledged: 0, failed: 0, pending: 0 },
  pending: { orders: 3, exceptions: 0, conflicts: 0, notifications: 0 },
  daily: [{
    date: "2026-10-19",
    confirmed_amount_cents: 987654321012,
    confirmations: 123456789,
    orders_created: 0,
    notifications_acknowledged: 0,
    notifications_failed: 0,
  }],
};

function mount(pending = false, data: SystemAnalytics | undefined = analytics) {
  return render(
    <MemoryRouter>
      <SectionCards analytics={data} workItems={7} clientId="site_a" pending={pending} />
      <button>卡片后续操作</button>
    </MemoryRouter>,
  );
}

describe("overview metric keyboard access", () => {
  it.each([320, 390])("makes complete static values keyboard reachable at %i pixels", async (width) => {
    mobileMedia(width);
    mount();
    const user = userEvent.setup();
    const amount = screen.getByText("¥9,876,543,210.12");
    const confirmations = screen.getByText("123,456,789");

    await user.tab();
    expect(amount).toHaveFocus();
    expect(amount).toHaveAccessibleName("今日确认金额：¥9,876,543,210.12");
    await user.tab();
    expect(confirmations).toHaveFocus();
    expect(confirmations).toHaveAccessibleName("今日收款确认笔数：123,456,789");
    await user.tab();
    expect(screen.getByRole("link", { name: "3" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "3" })).toHaveAttribute("href", "/sites/site_a/orders?payment=UNPAID&checkout=OPEN");
    await user.tab();
    expect(screen.getByRole("link", { name: "7" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "7" })).toHaveAttribute("href", "/sites/site_a/work-items");
    await user.tab();
    expect(screen.getByRole("button", { name: "卡片后续操作" })).toHaveFocus();
  });

  it("keeps loading placeholders out of keyboard navigation and does not name stale values", async () => {
    mount(true);
    const user = userEvent.setup();
    expect(screen.queryByText("¥9,876,543,210.12")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/今日确认金额：/)).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("button", { name: "卡片后续操作" })).toHaveFocus();
  });

  it("does not add static placeholder tab stops when analytics are unavailable", async () => {
    render(<MemoryRouter><SectionCards analytics={undefined} workItems={7} /></MemoryRouter>);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("link", { name: "—" })).toHaveFocus();
  });
});
