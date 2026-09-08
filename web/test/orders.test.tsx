import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { OrderTable } from "../src/components/OrderTable";
import { Pagination } from "../src/components/ui";
import { dateTime, money } from "../src/lib/format";
import Orders from "../src/pages/Orders";
import { apiError, json, order, orderId } from "./fixtures";

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}{location.search}</output>;
}

function renderOrders(initialPath = "/orders") {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[initialPath]}>
    <Routes><Route path="/orders" element={<Orders />} /><Route path="/orders/:orderId" element={<h1>测试订单详情</h1>} /></Routes>
    <CurrentLocation />
  </MemoryRouter></QueryClientProvider>);
}

describe("order browsing", () => {
  it("clears active filters without dropping unrelated URL parameters", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const filtered = new URL(request.url).searchParams.has("payment_status");
      return json({ data: filtered ? [] : [order], page: { next_cursor: null } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders("/orders?payment=UNPAID&checkout=OPEN&source=overview");
    expect(await screen.findByRole("heading", { name: "没有符合条件的订单" })).toBeVisible();
    expect(screen.getByText("已筛选 2 项")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByRole("link", { name: order.product_name })).toBeVisible();
    expect(screen.getByLabelText("付款状态筛选")).toHaveValue("");
    expect(screen.getByLabelText("收银台状态筛选")).toHaveValue("");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders?source=overview");
    expect(screen.queryByRole("button", { name: "清除筛选" })).not.toBeInTheDocument();
    expect(new URL(fetchMock.mock.calls.at(-1)![0].url).searchParams.has("payment_status")).toBe(false);
  });

  it("offers a direct way out of an empty filtered result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => json({
      data: new URL(request.url).searchParams.has("checkout_status") ? [] : [order], page: { next_cursor: null },
    })));
    const user = userEvent.setup();
    renderOrders("/orders?checkout=CLOSED");
    await user.click(await screen.findByRole("button", { name: "查看全部订单" }));
    expect(await screen.findByRole("link", { name: order.product_name })).toBeVisible();
    expect(screen.getByLabelText("当前地址").textContent).toBe("/orders");
  });

  it("does not describe an empty later page as an instance with no orders", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const laterPage = new URL(request.url).searchParams.has("cursor");
      return json({ data: laterPage ? [] : [order], page: { next_cursor: laterPage ? null : "next-page" } });
    }));
    const user = userEvent.setup();
    renderOrders();
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("heading", { name: "这一页暂无订单" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "还没有订单" })).not.toBeInTheDocument();
    expect(screen.getByText("第 2 页 · 本页 0 条")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(await screen.findByRole("link", { name: order.product_name })).toBeVisible();
    expect(screen.getByText("第 1 页 · 本页 1 条")).toBeVisible();
  });

  it("starts at the first page after changing a filter", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const search = new URL(request.url).searchParams;
      const laterPage = search.has("cursor");
      return json({ data: [{ ...order, product_name: laterPage ? "后一页订单" : order.product_name }], page: { next_cursor: laterPage ? null : "next-page" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders();
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("link", { name: "后一页订单" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("付款状态筛选"), "UNPAID");
    expect(await screen.findByRole("link", { name: order.product_name })).toBeVisible();
    expect(screen.getByText("第 1 页 · 本页 1 条")).toBeVisible();
    const lastSearch = new URL(fetchMock.mock.calls.at(-1)![0].url).searchParams;
    expect(lastSearch.get("payment_status")).toBe("UNPAID");
    expect(lastSearch.has("cursor")).toBe(false);
  });

  it("clears a stale lookup error while editing and opens the corrected order", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/orders")) return json({ data: [order], page: { next_cursor: null } });
      return pathname.endsWith(order.merchant_order_no) ? json({ data: order }) : apiError("order_not_found", "没有找到这笔订单", 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders();
    const search = screen.getByRole("searchbox", { name: "订单号" });
    await user.type(search, "missing-order");
    await user.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByText("没有找到这笔订单")).toBeVisible();
    const requestCount = fetchMock.mock.calls.length;
    await user.clear(search);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查找" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    await user.type(search, `  ${order.merchant_order_no}  `);
    await user.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByRole("heading", { name: "测试订单详情" })).toBeVisible();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(`/orders/${orderId}`);
  });

  it("keeps the setup action for a genuinely empty first page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], page: { next_cursor: null } })));
    renderOrders();
    expect(await screen.findByRole("heading", { name: "还没有订单" })).toBeVisible();
    expect(screen.getByRole("link", { name: "创建测试订单" })).toHaveAttribute("href", "/test-payment");
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });
});

describe("responsive order semantics", () => {
  it.each([false, true])("retains table semantics, full identities and business timestamps (compact: %s)", (compact) => {
    const productName = "很长的商品名称与多语言订单说明 / " + "A".repeat(100);
    const merchantNumber = "MERCHANT-" + "9".repeat(100);
    render(<MemoryRouter><OrderTable orders={[{ ...order, product_name: productName, merchant_order_no: merchantNumber }]} compact={compact} /></MemoryRouter>);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getAllByRole("cell")).toHaveLength(compact ? 4 : 6);
    expect(within(table).getByRole("columnheader", { name: "付款状态" })).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: productName })).toHaveAttribute("title", productName);
    expect(within(table).getByText(merchantNumber)).toHaveAttribute("title", merchantNumber);
    expect(within(table).getByText(money(order.payable_amount_cents))).toBeInTheDocument();
    expect(within(table).getByText("未付款")).toBeInTheDocument();
    expect(within(table).getByText(dateTime(order.created_at))).toHaveAttribute("datetime", order.created_at);
    expect(within(table).getByRole("link", { name: productName })).toHaveAttribute("href", `/orders/${orderId}`);
    expect(within(table).getByRole("link", { name: productName })).toHaveAttribute("data-row-link");
    expect(within(table).queryByRole("columnheader", { name: "操作" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "收银台状态" }) !== null).toBe(!compact);
  });

  it("announces pagination progress and disables navigation while loading", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(<Pagination page={2} count={20} hasNext pending onPrevious={onPrevious} onNext={onNext} />);
    const pagination = screen.getByRole("navigation", { name: "列表分页" });
    expect(within(pagination).getByRole("status")).toHaveTextContent("正在读取第 2 页…");
    expect(within(pagination).getByRole("status")).toHaveAttribute("aria-atomic", "true");
    expect(within(pagination).getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(within(pagination).getByRole("button", { name: "下一页" })).toBeDisabled();
    rerender(<Pagination page={2} count={3} hasNext={false} onPrevious={onPrevious} onNext={onNext} />);
    expect(within(pagination).getByRole("status")).toHaveTextContent("第 2 页 · 本页 3 条");
    await userEvent.setup().click(within(pagination).getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(onPrevious).toHaveBeenCalledOnce());
    expect(onNext).not.toHaveBeenCalled();
  });
});
