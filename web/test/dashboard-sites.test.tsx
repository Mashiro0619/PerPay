import { WorkspaceProvider, WorkspaceOutlet } from "../src/workspace";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Dashboard from "../src/pages/Dashboard";
import { json, order, settings } from "./fixtures";

vi.mock("../src/features/system-status", () => ({
  SystemStatusBoundary: ({ children }: { children: ReactNode }) => children,
  useSystemStatus: () => ({ checking: false, unavailable: false, status: { data: { data: {
    instance_id: "test", status: "ready", configured: true, database: { ok: true },
    ledger: { collection_ready: true }, reconciliation: { confirmation_ready: true }, work_items: { total: 77 },
  } } } }),
}));
vi.mock("../src/components/chart-area-interactive", () => ({ ChartAreaInteractive: () => null }));

function mount(
  summary?: (clientId: string) => Promise<Response>,
  lists?: (kind: "orders" | "work-items", clientId: string, url: URL) => Promise<Response>,
) {
  const summaryReads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url), clientId = /\/sites\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    if (url.pathname === "/api/admin/v1/sites/overview")
      return json({ data: [], period: { from: "2026-09-11", to: "2026-10-10" }, max_confirmed_amount_cents: 0, page: { next_cursor: null } });
    if (url.pathname.endsWith("/settings")) return json({ data: { ...settings, site_mode: true, completion: { ...settings.completion, complete: true, sites: true } } });
    if (url.pathname.endsWith("/analytics")) return json({ data: { pending: { orders: clientId === "site_b" ? 4 : 3 }, daily: [] } });
    if (url.pathname.endsWith("/work-items/summary")) {
      summaryReads.push(clientId);
      return summary ? summary(clientId) : json({ data: { total: clientId === "site_a" ? 6 : 0 } });
    }
    if (lists && url.pathname.endsWith("/work-items")) return lists("work-items", clientId, url);
    if (lists && url.pathname.endsWith("/orders")) return lists("orders", clientId, url);
    if (/\/sites\/site_[ab]$/.test(url.pathname)) return json({ data: { client_id: clientId, configuration: { name: clientId, accepting_orders: true, notifications_enabled: false } } });
    // Deliberately shorter than the total: dashboard cards must not count this page.
    return json({ data: [], page: { next_cursor: null } });
  }));
  const router = createMemoryRouter([{ element: <WorkspaceProvider><WorkspaceOutlet /></WorkspaceProvider>, children: [{ path: "/", element: <Dashboard /> }, { path: "/sites/:clientId", element: <Dashboard /> }] }], { initialEntries: ["/sites/site_a"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, summaryReads };
}
function card(title: string) { return within(screen.getByText(title).closest('[data-slot="card"]') as HTMLElement); }
function href(title: string) { return new URL(card(title).getByRole("link").getAttribute("href")!, "http://localhost"); }

describe("website-scoped dashboard cards", () => {
  it("uses full website counts and preserves website scope in both drilldowns", async () => {
    const view = mount();
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("6"));
    expect(screen.getByLabelText("共 6 项待办")).toHaveTextContent("6");
    expect(card("当前待付款").getByRole("link")).toHaveTextContent("3");
    expect(href("当前待付款").pathname).toContain("/sites/site_a/");
    expect(href("当前待付款").searchParams.get("payment")).toBe("UNPAID");
    expect(href("当前待付款").searchParams.get("checkout")).toBe("OPEN");
    expect(href("需处理事项").pathname).toContain("/sites/site_a/");
    await act(async () => { await view.router.navigate("/sites/site_b"); });
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("0"));
    expect(screen.getByLabelText("共 0 项待办")).toHaveTextContent("0");
    expect(href("需处理事项").pathname).toContain("/sites/site_b/");
    await act(async () => { await view.router.navigate("/"); });
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("77"));
    expect(href("需处理事项").search).toBe("");
    expect(href("当前待付款").searchParams.has("api_client_id")).toBe(false);
    expect(view.summaryReads).toEqual(["site_a", "site_b"]);
  });

  it("never replaces the selected website count with a late response from the previous website", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mount(clientId => clientId === "site_a" ? pending : Promise.resolve(json({ data: { total: 2 } })));
    await waitFor(() => expect(view.summaryReads).toEqual(["site_a"]));
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("—"));
    await act(async () => { await view.router.navigate("/sites/site_b"); });
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("2"));
    await act(async () => { release(json({ data: { total: 9 } })); await pending; });
    expect(card("需处理事项").getByRole("link")).toHaveTextContent("2");
    expect(href("需处理事项").pathname).toContain("/sites/site_b/");
  });

  it("reports a failed site summary instead of showing global totals or zero", async () => {
    mount(async () => json({ error: { code: "internal_error", message: "汇总读取失败" } }, 500));
    await screen.findByText("汇总读取失败");
    expect(card("需处理事项").getByRole("link")).toHaveTextContent("—");
    expect(screen.getByLabelText("待办总数未知")).toHaveTextContent("—");
    expect(card("当前待付款").getByRole("link")).toHaveTextContent("3");
    expect(href("需处理事项").pathname).toContain("/sites/site_a/");
  });

  it("does not keep a cached successful count after a failed refresh", async () => {
    let fail = false;
    mount(async () => fail ? json({ error: { code: "internal_error", message: "刷新失败" } }, 500) : json({ data: { total: 6 } }));
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("6"));
    fail = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["work-items", "summary", "site_a"] }); });
    await screen.findByText("刷新失败");
    expect(card("需处理事项").getByRole("link")).toHaveTextContent("—");
    expect(screen.getByLabelText("待办总数未知")).toHaveTextContent("—");
  });

  it("requests prioritized reminders and keeps order and notification progress visible after a failed refresh", async () => {
    let fail = false;
    const reads: URL[] = [];
    mount(undefined, async (kind, clientId, url) => {
      reads.push(url);
      if (kind === "work-items") return json({ data: [], page: { next_cursor: null } });
      if (fail) return json({ error: { code: "internal_error", message: "订单刷新失败" } }, 500);
      return json({ data: [{
        ...order,
        api_client_id: clientId,
        product_name: "首页完整业务摘要",
        merchant_order_no: "overview-readable-order",
        payment: { ...order.payment, status: "CONFIRMED" },
        notification_summary: { status: "RETRY_WAIT", total_events: 2, acknowledged_events: 1 },
      }], page: { next_cursor: null } });
    });
    await screen.findByText("首页完整业务摘要");
    const recent = within(screen.getByRole("region", { name: "最近订单" }));
    expect(recent.getByText("收款已确认")).toBeVisible();
    expect(recent.getByText("等待重试")).toBeVisible();
    expect(recent.getByRole("link", { name: "首页完整业务摘要" })).toHaveAttribute("href", `/sites/site_a/orders/${order.order_id}`);
    const workRequest = reads.find(url => url.pathname.endsWith("/work-items"))!;
    expect(workRequest.searchParams.get("sort_by")).toBe("priority");
    expect(workRequest.searchParams.get("sort_order")).toBe("desc");
    expect(workRequest.searchParams.get("limit")).toBe("4");
    expect(reads.find(url => url.pathname.endsWith("/orders"))!.searchParams.get("limit")).toBe("5");
    fail = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["orders", "recent", "site_a"] }); });
    expect(await recent.findByText("订单刷新失败")).toBeVisible();
    expect(recent.getByText("首页完整业务摘要")).toBeVisible();
    expect(recent.getByText("等待重试")).toBeVisible();
    expect(recent.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("does not show a late order page from the previous website", async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const pages = (clientId: string) => json({ data: [{ ...order, api_client_id: clientId, product_name: `订单来自${clientId}` }], page: { next_cursor: null } });
    const view = mount(undefined, async (kind, clientId) => kind === "work-items"
      ? json({ data: [], page: { next_cursor: null } })
      : clientId === "site_a" ? pending : pages(clientId));
    await waitFor(() => expect(view.summaryReads).toEqual(["site_a"]));
    await act(async () => { await view.router.navigate("/sites/site_b"); });
    expect(await screen.findByText("订单来自site_b")).toBeVisible();
    await act(async () => { release(pages("site_a")); await pending; });
    expect(screen.queryByText("订单来自site_a")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "订单来自site_b" })).toHaveAttribute("href", `/sites/site_b/orders/${order.order_id}`);
  });
});
