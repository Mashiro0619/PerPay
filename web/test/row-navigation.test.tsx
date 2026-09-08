import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { LinkedTableRow } from "../src/components/LinkedTableRow";
import Notifications from "../src/pages/Notifications";
import Orders from "../src/pages/Orders";
import Reconciliation from "../src/pages/Reconciliation";
import { json, order, orderId } from "./fixtures";

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}</output>;
}

function renderRow(onCopy = vi.fn()) {
  render(<MemoryRouter><Routes><Route path="/" element={<table><tbody><LinkedTableRow>
    <td><Link data-row-link to="/record">记录标题</Link></td>
    <td>可选择的编号</td>
    <td><Link to="/related">关联订单</Link><button onClick={onCopy}>复制编号</button><input aria-label="备注" /></td>
  </LinkedTableRow></tbody></table>} /><Route path="*" element={<p>已打开记录</p>} /></Routes><CurrentLocation /></MemoryRouter>);
  return onCopy;
}

describe("linked table row behavior", () => {
  it("opens the native primary link when clicking a non-link cell", async () => {
    renderRow();
    await userEvent.setup().click(screen.getByRole("cell", { name: "可选择的编号" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/record");
  });

  it("keeps keyboard navigation on the real link instead of duplicating row tab stops", async () => {
    renderRow();
    const user = userEvent.setup();
    expect(screen.getByRole("row")).not.toHaveAttribute("tabindex");
    await user.tab();
    expect(screen.getByRole("link", { name: "记录标题" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/record");
  });

  it("does not override the associated order link", async () => {
    renderRow();
    await userEvent.setup().click(screen.getByRole("link", { name: "关联订单" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/related");
  });

  it("does not turn nested buttons or inputs into navigation", async () => {
    const onCopy = renderRow();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "复制编号" }));
    await user.type(screen.getByRole("textbox", { name: "备注" }), "保留备注");
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "备注" })).toHaveValue("保留备注");
    expect(screen.getByLabelText("当前地址").textContent).toBe("/");
  });

  it("leaves selected text available for copying", () => {
    renderRow();
    const cell = screen.getByRole("cell", { name: "可选择的编号" });
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(cell);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      fireEvent.click(cell);
      expect(selection.toString()).toBe("可选择的编号");
      expect(screen.getByLabelText("当前地址").textContent).toBe("/");
    } finally { selection.removeAllRanges(); }
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)("forwards %s to the native link", (modifier) => {
    renderRow();
    const forwarded = vi.fn((event: Event) => event.preventDefault());
    screen.getByRole("link", { name: "记录标题" }).addEventListener("click", forwarded);
    fireEvent.click(screen.getByRole("cell", { name: "可选择的编号" }), { [modifier]: true });
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded.mock.calls[0]![0]).toMatchObject({ [modifier]: true, button: 0 });
    expect(screen.getByLabelText("当前地址").textContent).toBe("/");
  });

  it("forwards middle clicks but leaves right clicks alone", () => {
    renderRow();
    const forwarded = vi.fn((event: Event) => event.preventDefault());
    screen.getByRole("link", { name: "记录标题" }).addEventListener("auxclick", forwarded);
    const cell = screen.getByRole("cell", { name: "可选择的编号" });
    fireEvent(cell, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded.mock.calls[0]![0]).toMatchObject({ button: 1 });
    fireEvent(cell, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(forwarded).toHaveBeenCalledOnce();
  });
});

const recordId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-09-07T12:00:00.000Z";
const listCases = [
  { name: "orders", path: "/orders", element: <Orders />, target: `/orders/${orderId}`, record: order, columns: 6 },
  { name: "notifications", path: "/notifications", element: <Notifications />, target: `/notifications/${recordId}`, record: { delivery_id: recordId, status: "ACKNOWLEDGED", attempt_count: 1, next_attempt_at: null, event: { event_type: "PAYMENT_CONFIRMED", order_id: orderId } }, columns: 5 },
  { name: "payment matches", path: "/reconciliation", element: <Reconciliation />, target: `/reconciliation/matches/${recordId}`, record: { payment_match_id: recordId, evidence_type: "MANUAL", order_id: orderId, status: "SETTLED", created_at: timestamp }, columns: 4 },
  { name: "ledger conflicts", path: "/reconciliation?tab=conflicts", element: <Reconciliation />, target: `/reconciliation/conflicts/${recordId}`, record: { conflict_id: recordId, conflict_type: "RAW_PAGE_VARIANT", status: "OPEN", created_at: timestamp }, columns: 4 },
  { name: "financial exceptions", path: "/reconciliation?tab=exceptions", element: <Reconciliation />, target: `/reconciliation/exceptions/${recordId}`, record: { exception_id: recordId, exception_type: "UNMATCHED_CREDIT", order_id: null, status: "OPEN", created_at: timestamp }, columns: 4 },
];

describe("detail navigation from actual list pages", () => {
  it.each(listCases)("opens $name from the row without a separate action column", async ({ path, element, target, record, columns }) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [record], page: { next_cursor: null } })));
    const { container } = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}>
      <Routes><Route path={path.split("?")[0]} element={element} /><Route path="*" element={<p>已打开详情</p>} /></Routes><CurrentLocation />
    </MemoryRouter></QueryClientProvider>);
    const table = await screen.findByRole("table");
    expect(container.querySelector(".page-heading p, .page-note")).toBeNull();
    expect(screen.queryByText("自动投递与人工重发均保留独立记录")).not.toBeInTheDocument();
    expect(screen.queryByText("按创建时间分页")).not.toBeInTheDocument();
    const row = within(table).getAllByRole("row")[1]!;
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(columns);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(columns);
    expect(within(table).queryByRole("columnheader", { name: "操作" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "详情" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "查看证据" })).not.toBeInTheDocument();
    await userEvent.setup().click(cells.at(-1)!);
    expect(screen.getByLabelText("当前地址").textContent).toBe(target);
  });
});
