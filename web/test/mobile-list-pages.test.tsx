import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "../src/api/client";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import Orders from "../src/pages/Orders";
import Reconciliation from "../src/pages/Reconciliation";
import Notifications from "../src/pages/Notifications";
import WorkItems from "../src/pages/WorkItems";
import { apiError, json, order, orderId, ledgerId, settings } from "./fixtures";
import { systemStatus } from "./onboarding-fixture";
import { mobileMedia } from "./mobile-media";
function Location() {
  const location = useLocation();
  return (
    <output aria-label="当前地址">{location.pathname + location.search}</output>
  );
}
function mount(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TestPaymentProvider>
          <Routes>
            <Route path={path.split("?")[0]} element={element} />
            <Route path="/orders/:id" element={<h1>订单详情</h1>} />
            <Route
              path="/reconciliation/ledger/:id"
              element={<h1>流水详情</h1>}
            />
          </Routes>
          <Location />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const item: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "primary",
  order_id: null,
  ledger_entry_id: null,
  created_at: "2026-09-06T12:00:00Z",
  actionable_at: "2026-09-06T12:00:00Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url:
    "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};

describe("mobile business list integration", () => {
  beforeEach(() => {
    mobileMedia();
  });
  it.each([
    ["/orders", <Orders />, "更多订单操作"],
    ["/reconciliation", <Reconciliation />, "更多对账操作"],
    ["/notifications", <Notifications />, "更多通知操作"],
    ["/work-items", <WorkItems />, "更多提醒操作"],
  ] as const)(
    "uses one query area and deferred settings on %s",
    async (path, element, menu) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ data: [], page: { next_cursor: null } })),
      );
      mount(path, element);
      expect(await screen.findByRole("search")).toBeVisible();
      expect(screen.getAllByRole("search")).toHaveLength(1);
      expect(
        screen.queryByLabelText("排序字段", { exact: true }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "筛选与排序" })).toBeVisible();
      expect(screen.getByRole("button", { name: menu })).toBeVisible();
    },
  );

  it.each([
    ["商户订单号", order.merchant_order_no],
    ["内部订单编号", orderId],
  ])("preserves direct order lookup for %s", async (mode, value) => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return new URL(request.url).pathname.endsWith("/orders")
          ? json({ data: [order], page: { next_cursor: null } })
          : json({ data: order });
      }),
    );
    mount("/orders", <Orders />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "查询方式：关键词" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: mode }));
    const count = calls.length;
    await user.type(
      screen.getByRole("searchbox", { name: "订单号" }),
      "  " + value + "  ",
    );
    expect(calls).toHaveLength(count);
    await user.click(screen.getByRole("button", { name: "查找" }));
    await screen.findByRole("heading", { name: "订单详情" });
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/orders/" + orderId,
    );
    expect(decodeURIComponent(new URL(calls.at(-1)!.url).pathname)).toContain(
      value,
    );
    expect(calls.every((request) => request.method === "GET")).toBe(true);
  });

  it("clears a failed exact lookup on editing and keeps the keyword query intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        new URL(request.url).pathname.endsWith("/orders")
          ? json({ data: [order], page: { next_cursor: null } })
          : apiError("order_not_found", "没有找到这笔订单", 404),
      ),
    );
    mount("/orders?q=kept", <Orders />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "商户订单号" }),
    );
    const input = screen.getByRole("searchbox", { name: "订单号" });
    await user.type(input, "missing{Enter}");
    expect(await screen.findByText("没有找到这笔订单")).toBeVisible();
    await user.clear(input);
    expect(screen.queryByText("没有找到这笔订单")).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("q=kept");
  });

  it("keeps ledger UUID validation and the dedicated detail route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: [], page: { next_cursor: null } })),
    );
    mount("/reconciliation", <Reconciliation />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "流水编号" }),
    );
    const input = screen.getByRole("searchbox", { name: "账本流水编号" });
    await user.type(input, "invalid");
    await user.click(screen.getByRole("button", { name: "查找" }));
    expect(
      screen.queryByRole("heading", { name: "流水详情" }),
    ).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, ledgerId + "{Enter}");
    expect(
      await screen.findByRole("heading", { name: "流水详情" }),
    ).toBeVisible();
  });

  it("opens test payment from More without creating an order and returns focus to More", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return new URL(request.url).pathname.endsWith("/system/status")
          ? json({ data: systemStatus(settings) })
          : json({ data: [], page: { next_cursor: null } });
      }),
    );
    mount("/orders", <Orders />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "更多订单操作" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "测试收款" }));
    const dialog = await screen.findByRole("dialog", { name: "测试收款" });
    await within(dialog).findByLabelText("测试金额（元）");
    await user.click(
      within(dialog).getByRole("button", { name: "取消" }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(calls.every((request) => request.method === "GET")).toBe(true);
  });

  it("preserves the scoped bulk-ignore confirmation and restores focus after cancelling", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return json({ data: [item], page: { next_cursor: null } });
      }),
    );
    mount("/work-items?q=kept", <WorkItems />);
    const user = userEvent.setup();
    await screen.findByRole("link", { name: /未匹配/ });
    const trigger = screen.getByRole("button", { name: "更多提醒操作" });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "忽略当前筛选结果" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("kept");
    expect(dialog).toHaveTextContent("跨分页");
    expect(dialog).toHaveTextContent("不删除记录");
    await user.click(
      within(dialog).getByRole("button", { name: "取消" }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(calls.every((request) => request.method === "GET")).toBe(true);
  });
});
