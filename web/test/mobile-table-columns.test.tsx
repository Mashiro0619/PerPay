import { render, screen, waitFor, within } from "@testing-library/react";
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
describe("mobile column controls", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia();
  });
  it("places the control inside the header and checks the columns that are actually visible", async () => {
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
    ).not.toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    const popup = await menu(user);
    expect(
      within(popup).getByRole("menuitemcheckbox", { name: "订单 / 商品" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(popup).getByRole("menuitemcheckbox", { name: "实收金额" }),
    ).toHaveAttribute("aria-checked", "false");
    await user.click(
      within(popup).getByRole("menuitemcheckbox", { name: "实收金额" }),
    );
    expect(
      screen.getByRole("columnheader", { name: "实收金额" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "实收金额" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({ received_amount_cents: true });
    expect(
      screen.queryByText("实收 " + money(order.received_amount_cents)),
    ).not.toBeInTheDocument();
  });
  it("restores responsive defaults and compact summaries after explicit show/hide", async () => {
    mountOrders();
    const user = userEvent.setup();
    await menu(user);
    const amount = screen.getByRole("menuitemcheckbox", { name: "实收金额" });
    await user.click(amount);
    await user.click(amount);
    expect(
      screen.queryByRole("columnheader", { name: "实收金额" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("实收 " + money(order.received_amount_cents)),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "恢复默认列" }));
    expect(
      await screen.findByText("实收 " + money(order.received_amount_cents)),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "实收金额" }),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({});
  });
  it("adapts untouched columns on resize but preserves explicit choices and reloads them", async () => {
    const media = mobileMedia();
    const view = mountOrders();
    const user = userEvent.setup();
    await menu(user);
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "实收金额" }),
    );
    await user.keyboard("{Escape}");
    media.resize(1280);
    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    await menu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "状态" }));
    await user.keyboard("{Escape}");
    media.resize(390);
    expect(
      screen.getByRole("columnheader", { name: "实收金额" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "状态" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "创建时间" }),
    ).not.toBeInTheDocument();
    view.unmount();
    mountOrders();
    expect(
      screen.getByRole("columnheader", { name: "实收金额" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "状态" }),
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
    expect(
      screen.getByRole("columnheader", { name: "附加" }),
    ).toBeInTheDocument();
    view.rerender(table("second"));
    await waitFor(() =>
      expect(
        screen.queryByRole("columnheader", { name: "附加" }),
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
      await user.click(
        screen.getByRole("menuitemcheckbox", { name: "实收金额" }),
      );
      expect(
        screen.getByRole("columnheader", { name: "实收金额" }),
      ).toBeInTheDocument();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
