import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { DataTable } from "../src/components/data-table";
import { CursorPagination as Pagination } from "../src/components/cursor-pagination";
import { dateTime, money } from "../src/lib/format";
import Orders from "../src/pages/Orders";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { apiError, json, order, orderId } from "./fixtures";
import { mobileMedia } from "./mobile-media";

function CurrentLocation() {
  const location = useLocation();
  return (
    <output aria-label="当前地址">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderOrders(initialPath = "/orders") {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TestPaymentProvider>
          <Link to="/system">离开订单列表</Link>
          <Link to="/orders">返回订单列表</Link>
          <Routes>
            <Route path="/system" element={<h1>测试运行状态</h1>} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:orderId" element={<h1>测试订单详情</h1>} />
          </Routes>
          <CurrentLocation />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("order browsing", () => {
  it("ignores a result after browser history commits while the old route is still mounted", async () => {
    let finish!: (response: Response) => void;
    let lookupRequest: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        if (new URL(request.url).pathname.endsWith("/orders"))
          return Promise.resolve(
            json({ data: [order], page: { next_cursor: null } }),
          );
        lookupRequest = request;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const user = userEvent.setup();
    renderOrders();
    await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "商户订单号" }),
    );
    await user.type(
      screen.getByRole("searchbox", { name: "订单号" }),
      order.merchant_order_no,
    );
    await user.click(screen.getByRole("button", { name: "查找" }));
    await waitFor(() => expect(lookupRequest).toBeDefined());
    const originalUrl = window.location.href;
    try {
      // A view transition updates browser history before React unmounts Orders.
      window.history.replaceState(null, "", "/admin/system");
      expect(lookupRequest!.signal.aborted).toBe(false);
      await act(async () => {
        finish(json({ data: order }));
      });
      expect(
        screen.getByRole("searchbox", { name: "订单号" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "测试订单详情" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", originalUrl);
    }
  });

  it.each(["商户订单号", "内部订单编号"])(
    "aborts a %s lookup when leaving and ignores a late response",
    async (mode) => {
      let finish!: (response: Response) => void;
      let lookupRequest: Request | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((request: Request) => {
          if (new URL(request.url).pathname.endsWith("/orders"))
            return Promise.resolve(
              json({ data: [order], page: { next_cursor: null } }),
            );
          lookupRequest = request;
          // Deliberately ignore abort: the UI must also reject a late success.
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }),
      );
      const user = userEvent.setup();
      renderOrders();
      await user.click(
        screen.getByRole("button", { name: "查询方式：关键词" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: mode }),
      );
      await user.type(
        screen.getByRole("searchbox", { name: "订单号" }),
        mode === "商户订单号" ? order.merchant_order_no : orderId,
      );
      await user.click(screen.getByRole("button", { name: "查找" }));
      await waitFor(() => expect(lookupRequest).toBeDefined());
      await user.click(screen.getByRole("link", { name: "离开订单列表" }));
      await screen.findByRole("heading", { name: "测试运行状态" });
      expect(lookupRequest!.signal.aborted).toBe(true);
      await act(async () => {
        finish(json({ data: order }));
      });
      expect(screen.getByLabelText("当前地址")).toHaveTextContent("/system");
      expect(
        screen.queryByRole("heading", { name: "测试订单详情" }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not let an old lookup take over a new lookup after returning to the list", async () => {
    const requests: Array<{
      request: Request;
      finish: (response: Response) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        if (new URL(request.url).pathname.endsWith("/orders"))
          return Promise.resolve(
            json({ data: [order], page: { next_cursor: null } }),
          );
        return new Promise<Response>((finish) => {
          requests.push({ request, finish });
        });
      }),
    );
    const user = userEvent.setup();
    renderOrders();
    async function lookup(value: string) {
      await user.click(
        screen.getByRole("button", { name: "查询方式：关键词" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "商户订单号" }),
      );
      await user.type(screen.getByRole("searchbox", { name: "订单号" }), value);
      await user.click(screen.getByRole("button", { name: "查找" }));
    }
    await lookup("old-merchant-order");
    await waitFor(() => expect(requests).toHaveLength(1));
    await user.click(screen.getByRole("link", { name: "离开订单列表" }));
    await screen.findByRole("heading", { name: "测试运行状态" });
    await user.click(screen.getByRole("link", { name: "返回订单列表" }));
    await lookup("new-merchant-order");
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      requests[0]!.finish(json({ data: order }));
    });
    expect(screen.getByLabelText("当前地址").textContent).toBe("/orders");
    expect(requests[0]!.request.signal.aborted).toBe(true);
    expect(requests[1]!.request.signal.aborted).toBe(false);
    const newId = "22222222-2222-4222-8222-222222222222";
    await act(async () => {
      requests[1]!.finish(json({ data: { ...order, order_id: newId } }));
    });
    expect(
      await screen.findByRole("heading", { name: "测试订单详情" }),
    ).toBeVisible();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/orders/" + newId,
    );
  });

  it("clears active filters without dropping unrelated URL parameters", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const filtered = new URL(request.url).searchParams.has("payment_status");
      return json({
        data: filtered ? [] : [order],
        page: { next_cursor: null },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders("/orders?payment=UNPAID&checkout=OPEN&source=overview");
    expect(
      await screen.findByRole("heading", { name: "没有符合条件的订单" }),
    ).toBeVisible();
    expect(screen.getByLabelText("付款状态筛选")).toHaveTextContent("未付款");
    expect(screen.getByLabelText("收银台状态筛选")).toHaveTextContent("开放中");
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(
      await screen.findByRole("link", { name: order.product_name }),
    ).toBeVisible();
    expect(screen.getByLabelText("付款状态筛选")).toHaveTextContent(
      "全部付款状态",
    );
    expect(screen.getByLabelText("收银台状态筛选")).toHaveTextContent(
      "全部收银台状态",
    );
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/orders?source=overview",
    );
    expect(
      screen.queryByRole("button", { name: "清除筛选" }),
    ).not.toBeInTheDocument();
    expect(
      new URL(fetchMock.mock.calls.at(-1)![0].url).searchParams.has(
        "payment_status",
      ),
    ).toBe(false);
  });

  it("offers a direct way out of an empty filtered result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        json({
          data: new URL(request.url).searchParams.has("checkout_status")
            ? []
            : [order],
          page: { next_cursor: null },
        }),
      ),
    );
    const user = userEvent.setup();
    renderOrders("/orders?checkout=CLOSED");
    await user.click(
      await screen.findByRole("button", { name: "查看全部订单" }),
    );
    expect(
      await screen.findByRole("link", { name: order.product_name }),
    ).toBeVisible();
    expect(screen.getByLabelText("当前地址").textContent).toBe("/orders");
  });

  it("does not describe an empty later page as an instance with no orders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const laterPage = new URL(request.url).searchParams.has("cursor");
        return json({
          data: laterPage ? [] : [order],
          page: { next_cursor: laterPage ? null : "next-page" },
        });
      }),
    );
    const user = userEvent.setup();
    renderOrders();
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    expect(
      await screen.findByRole("heading", { name: "这一页暂无订单" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "暂无订单" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("第 2 页 · 本页 0 条")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(
      await screen.findByRole("link", { name: order.product_name }),
    ).toBeVisible();
    expect(screen.getByText("第 1 页 · 本页 1 条")).toBeVisible();
  });

  it("starts at the first page after changing a filter", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const search = new URL(request.url).searchParams;
      const laterPage = search.has("cursor");
      return json({
        data: [
          {
            ...order,
            product_name: laterPage ? "后一页订单" : order.product_name,
          },
        ],
        page: { next_cursor: laterPage ? null : "next-page" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders();
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    expect(
      await screen.findByRole("link", { name: "后一页订单" }),
    ).toBeVisible();
    await user.click(screen.getByLabelText("付款状态筛选"));
    await user.click(await screen.findByRole("option", { name: "未付款" }));
    expect(
      await screen.findByRole("link", { name: order.product_name }),
    ).toBeVisible();
    expect(screen.getByText("第 1 页 · 本页 1 条")).toBeVisible();
    const lastSearch = new URL(fetchMock.mock.calls.at(-1)![0].url)
      .searchParams;
    expect(lastSearch.get("payment_status")).toBe("UNPAID");
    expect(lastSearch.has("cursor")).toBe(false);
  });

  it("clears a stale lookup error while editing and opens the corrected order", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/orders"))
        return json({ data: [order], page: { next_cursor: null } });
      return pathname.endsWith(order.merchant_order_no)
        ? json({ data: order })
        : apiError("order_not_found", "没有找到这笔订单", 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderOrders();
    await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "商户订单号" }),
    );
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
    expect(
      await screen.findByRole("heading", { name: "测试订单详情" }),
    ).toBeVisible();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      `/orders/${orderId}`,
    );
  });

  it("keeps the setup action for a genuinely empty first page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: [], page: { next_cursor: null } })),
    );
    renderOrders();
    expect(
      await screen.findByRole("heading", { name: "暂无订单" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "测试收款" })).toHaveAttribute(
      "aria-haspopup",
      "dialog",
    );
    expect(
      screen.queryByRole("navigation", { name: "列表分页" }),
    ).not.toBeInTheDocument();
  });
});

describe("responsive order semantics", () => {
  it("keeps payment, refund and checkout states in the mobile order summary", () => {
    mobileMedia();
    render(
      <MemoryRouter>
        <DataTable
          data={[
            {
              ...order,
              payment: { ...order.payment, status: "CONFIRMED" },
              refund_mark: { ...order.refund_mark, marked: true },
            },
          ]}
        />
      </MemoryRouter>,
    );
    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    const mobileSummary = within(cells[0]!);
    expect(mobileSummary.getByText("已确认")).toBeInTheDocument();
    expect(mobileSummary.getByText("已标记退款")).toBeInTheDocument();
    expect(mobileSummary.getByText("收银台开放中")).toBeInTheDocument();
    expect(cells).toHaveLength(2);
    expect(
      screen.queryByRole("columnheader", { name: "状态" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass(
      "table-fixed",
      "@lg/orders:table-auto",
    );
    expect(mobileSummary.getByText(dateTime(order.created_at))).toHaveAttribute(
      "datetime",
      order.created_at,
    );
  });
  it("retains table semantics, full identities and business timestamps", () => {
    const media = mobileMedia(1280);
    const productName = "很长的商品名称与多语言订单说明 / " + "A".repeat(100);
    const merchantNumber = "MERCHANT-" + "9".repeat(100);
    render(
      <MemoryRouter>
        <DataTable
          data={[
            {
              ...order,
              product_name: productName,
              merchant_order_no: merchantNumber,
            },
          ]}
        />
      </MemoryRouter>,
    );
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getAllByRole("cell")).toHaveLength(5);
    expect(
      within(table).getByRole("columnheader", { name: "状态" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("link", { name: productName }),
    ).toHaveAttribute("title", productName);
    expect(within(table).getByText(merchantNumber)).toHaveAttribute(
      "title",
      merchantNumber,
    );
    expect(
      within(table).getByText(money(order.payable_amount_cents)),
    ).toBeInTheDocument();
    const cells = within(rows[1]!).getAllByRole("cell");
    expect(within(cells[0]!).queryByText("未付款")).not.toBeInTheDocument();
    expect(within(cells[3]!).getByText("未付款")).toBeInTheDocument();
    for (const time of within(table).getAllByText(dateTime(order.created_at)))
      expect(time).toHaveAttribute("datetime", order.created_at);
    expect(
      within(table).getByRole("link", { name: productName }),
    ).toHaveAttribute("href", `/orders/${orderId}`);
    expect(
      within(table).getByRole("link", { name: productName }),
    ).toHaveAttribute("data-row-link");
    expect(
      within(table).queryByRole("columnheader", { name: "操作" }),
    ).not.toBeInTheDocument();
    expect(
      within(cells[0]!).queryByText("收银台开放中"),
    ).not.toBeInTheDocument();
    expect(within(cells[3]!).getByText("收银台开放中")).toBeInTheDocument();
    media.resize(390);
    const mobileCells = within(screen.getAllByRole("row")[1]!).getAllByRole(
      "cell",
    );
    expect(mobileCells).toHaveLength(2);
    expect(within(mobileCells[0]!).getByText("未付款")).toBeInTheDocument();
    expect(
      within(mobileCells[0]!).getByText("收银台开放中"),
    ).toBeInTheDocument();
    expect(
      within(mobileCells[0]!).getByText(dateTime(order.created_at)),
    ).toHaveAttribute("datetime", order.created_at);
  });

  it("announces pagination progress and disables navigation while loading", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <Pagination
        page={2}
        count={20}
        hasNext
        pending
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    const pagination = screen.getByRole("navigation", { name: "列表分页" });
    expect(within(pagination).getByRole("status")).toHaveTextContent(
      "正在读取第 2 页…",
    );
    expect(within(pagination).getByRole("status")).toHaveAttribute(
      "aria-atomic",
      "true",
    );
    expect(
      within(pagination).getByRole("button", { name: "上一页" }),
    ).toBeDisabled();
    expect(
      within(pagination).getByRole("button", { name: "下一页" }),
    ).toBeDisabled();
    rerender(
      <Pagination
        page={2}
        count={3}
        hasNext={false}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );
    expect(within(pagination).getByRole("status")).toHaveTextContent(
      "第 2 页 · 本页 3 条",
    );
    await userEvent
      .setup()
      .click(within(pagination).getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(onPrevious).toHaveBeenCalledOnce());
    expect(onNext).not.toHaveBeenCalled();
  });
});
