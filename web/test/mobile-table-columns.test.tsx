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
function expectOrderStatus() {
  const status = within(orderSummary()).getByText("待付款", { exact: true });
  expect(status).toBeVisible();
  expect(status.closest("[data-summary-status]")).not.toBeNull();
}
describe("mobile column controls", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia();
  });
  it.each([null, 0, 99, 101, 102, Number.MAX_SAFE_INTEGER])("distinguishes missing, zero, equal and differing receipts without duplicating the amount: %s", received => {
    render(<MemoryRouter><DataTable data={[{ ...order, received_amount_cents: received }]} control={control} /></MemoryRouter>);
    const summary = within(orderSummary());
    if (received === null) {
      expect(summary.getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
      expect(summary.queryByRole("group", { name: /^实收金额/ })).not.toBeInTheDocument();
      expect(summary.queryByText("—")).not.toBeInTheDocument();
    } else {
      expect(summary.getByRole("group", { name: "实收金额 " + money(received) })).toBeVisible();
      expect(summary.getByText("实收", { selector: "dt" })).toBeVisible();
    }
    if (received != null && received !== order.payable_amount_cents) {
      expect(summary.getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
      expect(summary.getByText(received < order.payable_amount_cents ? "少收" : "多收")).toHaveAttribute("data-variant", "warning");
      expect(summary.getByRole("group", { name: "差额 " + money(Math.abs(received - order.payable_amount_cents)) })).toBeVisible();
    } else {
      expect(summary.queryByText(/少收|多收/)).not.toBeInTheDocument();
      if (received !== null) {
        expect(summary.queryByRole("group", { name: /^应付金额/ })).not.toBeInTheDocument();
        expect(summary.getAllByText(money(received))).toHaveLength(1);
      }
    }
  });
  it("calls out a missing receipt on a confirmed payment without presenting it as zero", () => {
    render(<MemoryRouter><DataTable data={[{ ...order, payment: { ...order.payment, status: "CONFIRMED" } }]} control={control} /></MemoryRouter>);
    const summary = within(orderSummary());
    expect(summary.getByText("收款已确认", { exact: true })).toBeVisible();
    expect(summary.getByText("金额暂缺")).toBeVisible();
    expect(summary.getByText("实收", { selector: "dt" })).toBeVisible();
    expect(summary.getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
    expect(summary.queryByText("¥0.00")).not.toBeInTheDocument();
  });
  it("retains the refund mark alongside confirmation when the two amount fields collapse", () => {
    render(<MemoryRouter><DataTable data={[{
      ...order, received_amount_cents: order.payable_amount_cents,
      payment: { ...order.payment, status: "CONFIRMED", received_amount_cents: order.payable_amount_cents },
      refund_mark: { ...order.refund_mark, marked: true },
    }]} control={control} /></MemoryRouter>);
    const summary = within(orderSummary());
    expect(summary.getByText("收款已确认", { exact: true })).toBeVisible();
    expect(summary.getByText("已标记退款", { exact: true })).toBeVisible();
    expect(summary.getAllByText(money(order.payable_amount_cents))).toHaveLength(1);
  });
  it("keeps one fixed mobile summary and no column or row-expansion controls after migrating legacy defaults", () => {
    localStorage.setItem(
      "perpay.table-columns.orders",
      JSON.stringify({
        received_amount_cents: true,
        status: true,
        created_at: true,
      }),
    );
    mountOrders();
    expect(screen.queryByRole("button", { name: "显示列" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    expect(orderSummary()).toHaveAttribute("role", "listitem");
    expectOrderStatus();
    expect(orderSummary().querySelector("time[datetime]")).toHaveAttribute("datetime", order.created_at);
    expect(within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({});
    expect(
      within(orderSummary()).getAllByText(money(order.payable_amount_cents)),
    ).toHaveLength(1);
  });
  it("restores responsive defaults and compact summaries after explicit show/hide", async () => {
    const media = mobileMedia(1440);
    mountOrders();
    const user = userEvent.setup();
    await menu(user);
    const amount = screen.getByRole("menuitemcheckbox", { name: "实收金额" });
    await user.click(amount);
    expect(
      screen.queryByRole("columnheader", { name: "实收金额" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemcheckbox", { name: "创建时间" }));
    expect(screen.queryByRole("columnheader", { name: "创建时间" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "恢复默认列" }));
    await user.keyboard("{Escape}");
    media.resize(390);
    expect(
      orderSummary().querySelector("time[datetime]"),
    ).toBeVisible();
    expect(
      within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) }),
    ).toBeVisible();
    expect(
      JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders")!),
    ).toEqual({});
  });
  it("preserves desktop column preferences while mobile keeps its fixed key fields", async () => {
    const media = mobileMedia(1280);
    const view = mountOrders();
    const user = userEvent.setup();
    await menu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "实收金额" }));
    await user.keyboard("{Escape}");
    media.resize(1280);
    expect(screen.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "创建时间" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "确认时间" })).toBeVisible();
    await menu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "状态" }));
    await user.keyboard("{Escape}");
    media.resize(390);
    expect(
      within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) }),
    ).toBeVisible();
    expectOrderStatus();
    expect(
      orderSummary().querySelector("time[datetime]"),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    view.unmount();
    mountOrders();
    expect(
      within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) }),
    ).toBeVisible();
    expectOrderStatus();
    media.resize(1280);
    expect(screen.queryByRole("columnheader", { name: "状态" })).not.toBeInTheDocument();
  });
  it("keeps table preferences separate when the mounted table id changes", async () => {
    mobileMedia(1440);
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
              defaultVisible: false,
              cell: () => "内容",
            },
          ]}
        />
      </MemoryRouter>
    );
    const view = render(table("first"));
    expect(screen.getByRole("columnheader", { name: "附加" })).toBeVisible();
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
    const media = mobileMedia(1440);
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
      await user.keyboard("{Escape}");
      media.resize(390);
      expect(
        within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) }),
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
      localStorage.setItem("perpay.table-columns.v2.orders", '{"received_amount_cents":true}');
      mountOrders();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "显示列" })).not.toBeInTheDocument();
      expect(within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
      width = 640;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getByRole("table")).toBeVisible();
      expect(screen.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
      width = 639;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(within(orderSummary()).getByRole("group", { name: "应付金额 " + money(order.payable_amount_cents) })).toBeVisible();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
    } finally {
      rect.mockRestore();
    }
  });
});
