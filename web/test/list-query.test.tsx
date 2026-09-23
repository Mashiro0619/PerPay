import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { Link, useDetailBack } from "../src/navigation";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { BusinessTable } from "../src/components/business-table";
import Orders from "../src/pages/Orders";
import Notifications from "../src/pages/Notifications";
import Reconciliation from "../src/pages/Reconciliation";
import WorkItems from "../src/pages/WorkItems";
import { json, order } from "./fixtures";
function Location() {
  const l = useLocation();
  return <output aria-label="查询地址">{l.pathname + l.search}</output>;
}
function Back() {
  const back = useDetailBack("/orders", "订单");
  return (
    <Link to={back.to} state={back.state}>
      返回列表
    </Link>
  );
}
function mount(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TestPaymentProvider>
          <Routes>
            <Route path={path.split("?")[0]} element={element} />
            <Route path="/orders/:orderId" element={<Back />} />
          </Routes>
          <Location />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const cases = [
  {
    path: "/orders",
    element: <Orders />,
    label: "订单关键词搜索",
    endpoint: "/orders",
    sort: "应付金额",
    field: "payable_amount_cents",
  },
  {
    path: "/notifications",
    element: <Notifications />,
    label: "通知关键词搜索",
    endpoint: "/webhooks/deliveries",
    sort: "尝试次数",
    field: "attempt_count",
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    label: "对账关键词搜索",
    endpoint: "/reconciliation/matches",
    sort: "流水金额",
    field: "amount_cents",
  },
  {
    path: "/reconciliation?tab=conflicts",
    element: <Reconciliation />,
    label: "对账关键词搜索",
    endpoint: "/ledger/conflicts",
    sort: "外部流水号",
    field: "external_event_id",
  },
  {
    path: "/reconciliation?tab=exceptions",
    element: <Reconciliation />,
    label: "对账关键词搜索",
    endpoint: "/reconciliation/exceptions",
    sort: "发现时间",
    field: "created_at",
  },
  {
    path: "/work-items",
    element: <WorkItems />,
    label: "提醒关键词搜索",
    endpoint: "/work-items",
    sort: "创建时间",
    field: "created_at",
  },
];
describe("server-driven business queries", () => {
  it.each(cases)(
    "submits $endpoint keywords only on Enter and resets cursors on sorting",
    async ({ path, element, label, endpoint, sort, field }) => {
      const fetch = vi.fn(async () =>
        json({ data: [], page: { next_cursor: null } }),
      );
      vi.stubGlobal("fetch", fetch);
      mount(
        path +
          (path.includes("?") ? "&" : "?") +
          "cursor=old-page&page=3&source=overview",
        element,
      );
      const user = userEvent.setup();
      const input = await screen.findByRole("searchbox", { name: label });
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const before = fetch.mock.calls.length;
      await user.type(input, "  中文%_  ");
      expect(fetch.mock.calls.length).toBe(before);
      await user.keyboard("{Enter}");
      await waitFor(() => {
        const request = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
        const url = new URL(request.url);
        expect(url.pathname).toBe("/api/admin/v1" + endpoint);
        expect(url.searchParams.get("q")).toBe("中文%_");
        expect(url.searchParams.has("cursor")).toBe(false);
      });
      expect(screen.getByLabelText("查询地址")).toHaveTextContent(
        "source=overview",
      );
      await user.click(screen.getByRole("combobox", { name: "排序字段" }));
      await user.click(
        await screen.findByRole("option", { name: sort }),
      );
      await user.click(screen.getByRole("button", { name: /当前.*序，切换/ }));
      await waitFor(() => {
        const request = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
        expect(new URL(request.url).searchParams.get("sort_by")).toBe(field);
        expect(new URL(request.url).searchParams.get("q")).toBe("中文%_");
      });
      expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("cursor");
      expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("page=");
    },
  );
  it("does not apply TanStack client sorting or hide the required identifier", async () => {
    const setSort = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <BusinessTable
          id="unit-manual-sort"
          items={[
            { id: "b", amount: 30 },
            { id: "a", amount: 10 },
          ]}
          rowId={(r) => r.id}
          control={{
            query: { q: "", sortBy: "amount", sortOrder: "asc" },
            setSort,
            setKeyword: vi.fn(),
            clear: vi.fn(),
          }}
          columns={[
            { id: "id", label: "编号", hideable: false, cell: (r) => r.id },
            {
              id: "amount",
              sortBy: "amount",
              label: "金额",
              cell: (r) => r.amount,
            },
          ]}
        />
      </MemoryRouter>,
    );
    const values = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    expect(values()).toEqual(["b", "a"]);
    await user.click(screen.getByRole("button", { name: "金额" }));
    expect(setSort).toHaveBeenCalledWith("amount", "desc");
    expect(values()).toEqual(["b", "a"]);
    await user.click(screen.getByRole("button", { name: "显示列" }));
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "编号" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "金额" }),
    );
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("columnheader", { name: "金额" }),
    ).not.toBeInTheDocument();
    expect(values()).toEqual(["b", "a"]);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("returns from a detail to the exact searched and sorted page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        json({
          data: [
            {
              ...order,
              product_name: new URL(request.url).searchParams.has("cursor")
                ? "第二页结果"
                : "第一页结果",
            },
          ],
          page: { next_cursor: "next-page" },
        }),
      ),
    );
    const user = userEvent.setup();
    mount(
      "/orders?q=结果&sort_by=payable_amount_cents&sort_order=desc",
      <Orders />,
    );
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    await user.click(await screen.findByRole("link", { name: "第二页结果" }));
    await user.click(screen.getByRole("link", { name: "返回列表" }));
    expect(
      await screen.findByRole("link", { name: "第二页结果" }),
    ).toBeVisible();
    expect(screen.getByLabelText("查询地址")).toHaveTextContent(
      "cursor=next-page",
    );
    expect(screen.getByLabelText("查询地址")).toHaveTextContent(
      "sort_by=payable_amount_cents",
    );
    expect(
      screen.getByRole("searchbox", { name: "订单关键词搜索" }),
    ).toHaveValue("结果");
  });
  it("keeps the latest keyword result when asynchronous responses finish out of order", async () => {
    const finishes = new Map<string, (value: Response) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        const q = new URL(request.url).searchParams.get("q");
        return q
          ? new Promise<Response>((resolve) => finishes.set(q, resolve))
          : Promise.resolve(
              json({ data: [order], page: { next_cursor: null } }),
            );
      }),
    );
    const user = userEvent.setup();
    mount("/orders", <Orders />);
    await screen.findByRole("link", { name: order.product_name });
    const input = screen.getByRole("searchbox", { name: "订单关键词搜索" });
    await user.type(input, "旧{Enter}");
    await user.clear(input);
    await user.type(input, "新{Enter}");
    await waitFor(() => expect(finishes.has("新")).toBe(true));
    await act(async () => {
      finishes.get("新")!(
        json({
          data: [{ ...order, product_name: "新结果" }],
          page: { next_cursor: null },
        }),
      );
    });
    expect(await screen.findByRole("link", { name: "新结果" })).toBeVisible();
    await act(async () => {
      finishes.get("旧")!(
        json({
          data: [{ ...order, product_name: "旧结果" }],
          page: { next_cursor: null },
        }),
      );
    });
    expect(
      screen.queryByRole("link", { name: "旧结果" }),
    ).not.toBeInTheDocument();
  });
  it("validates the 100 Unicode character limit without submitting the draft", async () => {
    const fetch = vi.fn(async () =>
      json({ data: [], page: { next_cursor: null } }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount("/orders", <Orders />);
    const input = screen.getByRole("searchbox", { name: "订单关键词搜索" });
    await user.click(input);
    await user.paste("😀".repeat(101));
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("关键词最多100个Unicode字符。"),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("q=");
  });
});
