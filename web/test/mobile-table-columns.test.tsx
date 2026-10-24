import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessTable } from "../src/components/business-table";
import { DataTable } from "../src/components/data-table";
import { money } from "../src/lib/format";
import type { ListQueryControl } from "../src/lib/list-query";
import { order } from "./fixtures";
import { mobileMedia } from "./mobile-media";
const control: ListQueryControl = {
  query: { q: "", sortBy: "created_at", sortOrder: "desc" },
  setSort: vi.fn(),
  setKeyword: vi.fn(),
  clear: vi.fn(),
  update: vi.fn(),
};
function mountOrders() {
  return render(
    <MemoryRouter>
      <DataTable data={[order]} control={control} />
    </MemoryRouter>,
  );
}
async function menu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "显示列" }));
  return screen.findByRole("menu");
}
function orderSummary() {
  return screen.getByRole("link", { name: order.product_name }).closest<HTMLElement>("[data-business-row]")!;
}
describe("mobile column controls", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia();
  });
  it.each([null, 0, 99, 101, 102, 9007199254740991])("shows one labelled receipt and distinguishes missing, zero and differing amounts: %s", received => {
    render(<MemoryRouter><DataTable data={[{ ...order, received_amount_cents: received }]} control={control} /></MemoryRouter>);
    const aside = orderSummary().querySelector(".list-summary-aside")!;
    expect(within(aside as HTMLElement).getByText("应付金额")).toBeVisible();
    expect(within(aside as HTMLElement).getByText("实收金额")).toBeVisible();
    expect(within(orderSummary()).getAllByLabelText("实收金额 " + money(received))).toHaveLength(1);
    if (received != null && received !== order.payable_amount_cents) {
      expect(within(aside as HTMLElement).getByText(received < order.payable_amount_cents ? "少收" : "多收")).toHaveAttribute("data-variant", "warning");
    } else expect(within(aside as HTMLElement).queryByText(/少收|多收/)).not.toBeInTheDocument();
  });
  it("uses a single summary row and checks only information that is actually shown after migrating legacy defaults", async () => {
    localStorage.setItem(
      "perpay.table-columns.orders",
      JSON.stringify({
        received_amount_cents: true,
        status: true,
        created_at: true,
      }),
    );
    mountOrders();
    const user = userEvent.setup();
    expect(
      screen.getByRole("button", { name: "显示列" }).closest("th"),
    ).toBeNull();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    expect(orderSummary()).toHaveAttribute("role", "listitem");
    expect(within(orderSummary()).getByText("状态")).toBeVisible();
    expect(within(orderSummary()).getByText("创建时间")).toBeVisible();
    const popup = await menu(user);
    expect(
      within(popup).getByRole("menuitemcheckbox", { name: "订单 / 商品" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(popup).getByRole("menuitemcheckbox", { name: "实收金额" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(orderSummary()).getByText("实收金额")).toBeVisible();
    await user.click(within(popup).getByRole("menuitemcheckbox", { name: "实收金额" }));
    expect(within(orderSummary()).queryByText("实收金额")).not.toBeInTheDocument();
    await user.click(
      within(popup).getByRole("menuitemcheckbox", { name: "实收金额" }),
    );
    expect(
      within(orderSummary()).getByText("实收金额"),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "实收金额" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({ received_amount_cents: true });
    expect(
      within(orderSummary()).getAllByText(money(order.received_amount_cents)),
    ).toHaveLength(1);
  });
  it("restores responsive defaults and compact summaries after explicit show/hide", async () => {
    mountOrders();
    const user = userEvent.setup();
    await menu(user);
    const amount = screen.getByRole("menuitemcheckbox", { name: "实收金额" });
    await user.click(amount);
    expect(
      within(orderSummary()).queryByText("实收金额"),
    ).not.toBeInTheDocument();
    expect(
      within(orderSummary()).queryByText(money(order.received_amount_cents)),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "创建时间" }));
    expect(within(orderSummary()).queryByText("创建时间")).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "恢复默认列" }));
    expect(
      within(orderSummary()).getByText("创建时间"),
    ).toBeVisible();
    expect(
      within(orderSummary()).getByText("实收金额"),
    ).toBeVisible();
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({});
  });
  it("adapts untouched columns on resize but preserves explicit choices and reloads them", async () => {
    const media = mobileMedia();
    const view = mountOrders();
    const user = userEvent.setup();
    await menu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
    await user.keyboard("{Escape}");
    media.resize(1280);
    expect(screen.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "创建时间" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "PerPay 确认时间" })).toBeVisible();
    await menu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "状态" }));
    await user.keyboard("{Escape}");
    media.resize(390);
    expect(
      within(orderSummary()).getByText("实收金额"),
    ).toBeVisible();
    expect(
      within(orderSummary()).queryByText("状态"),
    ).not.toBeInTheDocument();
    expect(
      within(orderSummary()).getByText("创建时间"),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    view.unmount();
    mountOrders();
    expect(
      within(orderSummary()).getByText("实收金额"),
    ).toBeVisible();
    expect(
      within(orderSummary()).queryByText("状态"),
    ).not.toBeInTheDocument();
  });
  it("keeps table preferences separate when the mounted table id changes", async () => {
    localStorage.setItem("perpay.table-columns.v2.first", '{"extra":true}');
    const table = (id: string) => (
      <MemoryRouter>
        <BusinessTable
          id={id}
          items={[{ id: "one" }]}
          rowId={(item) => item.id}
          columns={[
            {
              id: "identity",
              label: "编号",
              hideable: false,
              cell: (item) => item.id,
            },
            {
              id: "extra",
              label: "附加",
              responsive: { minWidthRem: 40 },
              cell: () => "内容",
            },
          ]}
        />
      </MemoryRouter>
    );
    const view = render(table("first"));
    await userEvent.setup().click(screen.getByRole("button", { name: "展开信息" }));
    expect(
      within(screen.getByRole("listitem")).getByText("附加"),
    ).toBeVisible();
    view.rerender(table("second"));
    await waitFor(() =>
      expect(
        within(screen.getByRole("listitem")).queryByText("附加"),
      ).not.toBeInTheDocument(),
    );
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.second")!),
    ).toEqual({});
  });
  it("falls back safely when browser storage is unavailable", async () => {
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      mountOrders();
      const user = userEvent.setup();
      await menu(user);
      await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
      await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
      expect(
        within(orderSummary()).getByText("实收金额"),
      ).toBeVisible();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
  it("switches at the 639/640px container boundary and keeps one copy of every record and explicit field", async () => {
    mobileMedia(1440);
    let width = 639;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-business-table")
          ? DOMRect.fromRect({ width, height: 200 })
          : original.call(this);
      });
    try {
      mountOrders();
      const user = userEvent.setup();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      await menu(user);
      await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
      await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
      await user.keyboard("{Escape}");
      expect(within(orderSummary()).getByText("实收金额")).toBeVisible();
      width = 640;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getByRole("table")).toBeVisible();
      expect(screen.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
      width = 639;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(within(orderSummary()).getByText("实收金额")).toBeVisible();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    } finally {
      rect.mockRestore();
    }
  });
});
