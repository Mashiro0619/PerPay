import { act, cleanup, render, screen } from "@testing-library/react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminOrderSummary, type AdminWorkItem } from "../src/api/client";
import { useOverview } from "../src/features/overview/use-overview";
import { WorkspaceProvider } from "../src/workspace";
import { json, order, settings } from "./fixtures";

vi.mock("../src/features/system-status", () => ({
  useSystemStatus: () => ({ checking: false, unavailable: false, status: { data: { data: { status: "ready" } } } }),
}));

const pending: AdminWorkItem = {
  type: "NOTIFICATION_FAILURE",
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "synthetic-account",
  order_id: order.order_id,
  ledger_entry_id: null,
  created_at: "2026-10-11T02:30:00.000Z",
  actionable_at: "2026-10-11T03:00:00.000Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "/api/admin/v1/webhooks/deliveries/00000000-0000-4000-8000-000000000001",
  status: "RETRY_WAIT",
  event_type: "PAYMENT_CONFIRMED",
  attempt_count: 2,
  next_attempt_at: "2026-10-11T04:01:00.000Z",
  last_error_code: "TIMEOUT",
  dead_lettered_at: null,
  updated_at: "2026-10-11T03:00:00.000Z",
};

function OverviewProbe() {
  const { clientId, orders, work } = useOverview();
  return (
    <>
      <output aria-label="网站范围">{clientId}</output>
      <output aria-label="通知汇总">{orders.data?.data[0]?.notification_summary?.status ?? "读取中"}</output>
      <output aria-label="当前待办">{work.data?.data.length ?? "读取中"}</output>
    </>
  );
}

function mount() {
  let acknowledged = false;
  const requests = { orders: [] as Request[], work: [] as Request[] };
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/v1/sites/site_a") {
      return json({ data: { client_id: "site_a", configuration: { name: "订阅网站" } } });
    }
    if (url.pathname.endsWith("/settings")) return json({ data: settings });
    if (url.pathname.endsWith("/analytics")) return json({ data: { pending: { orders: 0 }, daily: [] } });
    if (url.pathname === "/api/admin/v1/sites/site_a/work-items/summary") {
      const total = acknowledged ? 0 : 2;
      return json({ data: { total, financial_exceptions: 0, ledger_conflicts: 0, notification_failures: total } });
    }
    if (url.pathname === "/api/admin/v1/sites/site_a/orders") {
      requests.orders.push(request);
      const summary: AdminOrderSummary = {
        ...order,
        api_client_id: "site_a",
        payment: { ...order.payment, status: "CONFIRMED" },
        received_amount_cents: order.payable_amount_cents,
        notification_summary: {
          status: acknowledged ? "ACKNOWLEDGED" : "RETRY_WAIT",
          total_events: 2,
          acknowledged_events: acknowledged ? 2 : 0,
        },
      };
      return json({ data: [summary], page: { next_cursor: null } });
    }
    if (url.pathname === "/api/admin/v1/sites/site_a/work-items") {
      requests.work.push(request);
      return json({
        data: acknowledged ? [] : [pending, { ...pending, resource_id: "00000000-0000-4000-8000-000000000002" }],
        page: { next_cursor: null },
      });
    }
    throw new Error("Unexpected overview request: " + url.pathname);
  }));
  const router = createMemoryRouter([{
    element: <WorkspaceProvider><Outlet /></WorkspaceProvider>,
    children: [
      { path: "/sites/:clientId", element: <OverviewProbe /> },
      { path: "/sites/:clientId/orders", element: <p>订单页面</p> },
    ],
  }], { initialEntries: ["/sites/site_a"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, router, requests, acknowledge: () => { acknowledged = true; } };
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

function expectPending() {
  expect(screen.getByLabelText("网站范围")).toHaveTextContent("site_a");
  expect(screen.getByLabelText("通知汇总")).toHaveTextContent("RETRY_WAIT");
  expect(screen.getByLabelText("当前待办")).toHaveTextContent(/^2$/);
}

function expectAcknowledged() {
  expect(screen.getByLabelText("通知汇总")).toHaveTextContent("ACKNOWLEDGED");
  expect(screen.getByLabelText("当前待办")).toHaveTextContent(/^0$/);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T04:00:00.000Z"));
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("overview list observation", () => {
  it("refreshes both scoped lists after one visible minute and updates delivery and work results without user action", async () => {
    const view = mount();
    await advance(1);
    expectPending();
    expect(view.requests.orders).toHaveLength(1);
    expect(view.requests.work).toHaveLength(1);
    view.acknowledge();

    await advance(59_000);
    expect(view.requests.orders).toHaveLength(1);
    expect(view.requests.work).toHaveLength(1);
    expectPending();

    await advance(1_000);
    expect(view.requests.orders).toHaveLength(2);
    expect(view.requests.work).toHaveLength(2);
    expectAcknowledged();
    for (const request of [...view.requests.orders, ...view.requests.work]) {
      const url = new URL(request.url);
      expect(url.pathname).toMatch(/^\/api\/admin\/v1\/sites\/site_a\/(?:orders|work-items)$/);
      expect(url.searchParams.has("api_client_id")).toBe(false);
    }
  });

  it("does not poll either list in the background and resumes observation when visible", async () => {
    const view = mount();
    await advance(1);
    expectPending();
    view.acknowledge();
    act(() => focusManager.setFocused(false));

    await advance(180_000);
    expect(view.requests.orders).toHaveLength(1);
    expect(view.requests.work).toHaveLength(1);
    expectPending();

    act(() => focusManager.setFocused(true));
    await advance(60_000);
    expect(view.requests.orders).toHaveLength(2);
    expect(view.requests.work).toHaveLength(2);
    expectAcknowledged();
  });

  it("reads both lists immediately on returning to the overview even while cached results are fresh", async () => {
    const view = mount();
    await advance(1);
    expectPending();
    await act(async () => { await view.router.navigate("/sites/site_a/orders"); });
    expect(screen.getByText("订单页面")).toBeVisible();
    view.acknowledge();
    await advance(5_000);
    expect(view.requests.orders).toHaveLength(1);
    expect(view.requests.work).toHaveLength(1);

    await act(async () => { await view.router.navigate("/sites/site_a"); });
    await advance(1);
    expect(view.requests.orders).toHaveLength(2);
    expect(view.requests.work).toHaveLength(2);
    expectAcknowledged();
  });
});
