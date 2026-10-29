import { Profiler } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "../src/api/client";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { WorkspaceProvider } from "../src/workspace";
import Orders from "../src/pages/Orders";
import Notifications from "../src/pages/Notifications";
import Reconciliation from "../src/pages/Reconciliation";
import WorkItems from "../src/pages/WorkItems";
import { delivery } from "./detail-fixtures";
import { groupedLedger } from "./ledger-fixtures";
import { alipayAccount, json, order } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const resourceId = (number: number) => "10000000-0000-4000-8000-" + String(number).padStart(12, "0");
const orders = [1, 2].map((number) => ({
  ...order,
  order_id: resourceId(number),
  merchant_order_no: "sorting-order-" + number,
  product_name: "排序商品 " + number,
  payable_amount_cents: number * 1_001,
  created_at: `2026-10-11T0${number}:00:00.000Z`,
}));
const reminders: AdminWorkItem[] = orders.map((item) => ({
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: item.order_id,
  provider_account_key: "primary",
  order_id: null,
  ledger_entry_id: null,
  created_at: item.created_at,
  actionable_at: item.created_at,
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/" + item.order_id,
}));
const lists = [
  { name: "orders", path: "/orders", endpoint: "/orders", field: "payable_amount_cents", heading: "应付金额", data: orders },
  {
    name: "notifications", path: "/notifications", endpoint: "/webhooks/deliveries", field: "attempt_count", heading: "尝试次数",
    data: orders.map((item, index) => ({
      ...delivery.delivery, delivery_id: item.order_id, attempt_count: index + 1,
      event: { ...delivery.event, order_id: item.order_id }, target: delivery.target, order_summary: item,
    })),
  },
  {
    name: "reconciliation", path: "/reconciliation", endpoint: "/ledger/entries", field: "amount_cents", heading: "交易金额",
    data: orders.map((item) => ({
      ...groupedLedger, ledger_entry_id: item.order_id, external_event_id: "alipay-" + item.order_id, amount_cents: item.payable_amount_cents,
      active_match: { ...groupedLedger.active_match!, order_id: item.order_id, product_name: item.product_name },
    })),
  },
  { name: "work-items", path: "/work-items", endpoint: "/work-items", field: "created_at", heading: "创建时间", data: reminders },
];

function page(data: readonly unknown[], nextCursor: string | null = null) {
  return json({ data, page: { next_cursor: nextCursor } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function respond(handler: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn((request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/v1/alipay-accounts") return json({ data: [alipayAccount] });
    requests.push(url);
    return handler(url);
  }));
  return requests;
}

function mount(path: string, onCommit?: () => void) {
  const router = createMemoryRouter([{
    // Keep the same Orders instance on a site parameter change: retaining a sort
    // result must not depend on a parent remount to isolate website data.
    element: <WorkspaceProvider><TestPaymentProvider><Outlet /></TestPaymentProvider></WorkspaceProvider>,
    children: [
      { path: "/orders", element: <Orders /> },
      { path: "/notifications", element: <Notifications /> },
      { path: "/reconciliation", element: <Reconciliation /> },
      { path: "/work-items", element: <WorkItems /> },
      { path: "/sites/:clientId/orders", element: <Orders /> },
    ],
  }], { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Profiler id="list-continuity" onRender={() => onCommit?.()}>
        <RouterProvider router={router} />
      </Profiler>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
const orderPath = "/orders?sort_by=payable_amount_cents&sort_order=asc";

beforeEach(() => {
  localStorage.clear();
  mobileMedia(1600);
  onlineManager.setOnline(true);
});

afterEach(() => { onlineManager.setOnline(true); });

describe("business list sorting continuity", () => {
  it.each(lists.flatMap((list) => (["asc", "desc"] as const).map((direction) => ({ ...list, direction }))))(
    "keeps $name rows and its column-menu portal mounted while changing $direction sorting",
    async ({ name, path, endpoint, field, heading, data, direction }) => {
      const pending = deferredResponse();
      const initial = direction === "asc" ? data : [...data].reverse();
      const sorted = [...initial].reverse();
      const nextDirection = direction === "asc" ? "desc" : "asc";
      const requests = respond((url) => {
        expect(url.pathname).toBe("/api/admin/v1" + endpoint);
        return url.searchParams.get("sort_order") === direction ? page(initial) : pending.promise;
      });
      let recordCommit: (() => void) | undefined;
      mount(path + `?sort_by=${field}&sort_order=${direction}`, () => recordCommit?.());
      const table = await screen.findByRole("table");
      const rows = bodyRows(table);
      expect(rows).toHaveLength(2);
      const columns = screen.getByRole("button", { name: "显示列" });
      const portalHost = columns.closest("[data-list-columns-slot]");
      expect(portalHost).not.toBeNull();
      const sort = within(table).getByRole("button", { name: heading });
      const commits: boolean[] = [];
      recordCommit = () => commits.push(table.isConnected && columns.isConnected && rows.every((row) => row.isConnected));

      try {
        await userEvent.setup().click(sort);
        await waitFor(() => expect(requests.some((url) => url.searchParams.get("sort_order") === nextDirection)).toBe(true));
        expect(requests.at(-1)!.searchParams.get("sort_by")).toBe(field);
        expect(screen.getByRole("table")).toBe(table);
        expect(table).toBeVisible();
        bodyRows(table).forEach((row, index) => expect(row).toBe(rows[index]));
        expect(screen.getByRole("button", { name: "显示列" })).toBe(columns);
        expect(columns.parentElement).toBe(portalHost);
        expect(table.closest('[aria-busy="true"]')).not.toBeNull();
        if (name === "orders") expect(sort).toHaveFocus();

        await act(async () => { pending.resolve(page(sorted)); });
        await waitFor(() => expect(bodyRows(table)[0]).toBe(rows[1]));
        expect(bodyRows(table)[1]).toBe(rows[0]);
        expect(screen.getByRole("table")).toBe(table);
        expect(screen.getByRole("button", { name: "显示列" })).toBe(columns);
        expect(table.closest('[aria-busy="true"]')).toBeNull();
        if (name === "orders") expect(sort).toHaveFocus();
        expect(commits.length).toBeGreaterThan(0);
        expect(commits.every(Boolean)).toBe(true);
      } finally {
        pending.resolve(page(sorted));
      }
    },
  );

  it.each(["keyword", "payment status"] as const)("hides the previous orders while a changed %s is loading", async (change) => {
    const pending = deferredResponse();
    const replacement = {
      ...orders[0]!, order_id: resourceId(3), product_name: "符合新条件的订单",
      received_amount_cents: orders[0]!.payable_amount_cents,
      payment: { status: "CONFIRMED", basis: "INFERRED", received_amount_cents: orders[0]!.payable_amount_cents },
    };
    const isChanged = (url: URL) => change === "keyword" ? url.searchParams.has("q") : url.searchParams.has("payment_status");
    const requests = respond((url) => isChanged(url) ? pending.promise : page(orders));
    mount(orderPath);
    const old = await screen.findByRole("link", { name: orders[0]!.product_name });
    const user = userEvent.setup();
    try {
      if (change === "keyword") {
        await user.type(screen.getByRole("searchbox", { name: "订单关键词搜索" }), "新条件{Enter}");
      } else {
        await user.click(screen.getByRole("combobox", { name: "付款状态筛选" }));
        await user.click(await screen.findByRole("option", { name: "已确认" }));
      }
      await waitFor(() => expect(requests.some(isChanged)).toBe(true));
      expect(old).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: orders[1]!.product_name })).not.toBeInTheDocument();
      await act(async () => { pending.resolve(page([replacement])); });
      expect(await screen.findByRole("link", { name: replacement.product_name })).toBeVisible();
    } finally { pending.resolve(page([replacement])); }
  });

  it("drops loaded A rows when switching to B and ignores A's late sorting response", async () => {
    const sortedA = deferredResponse();
    const pendingB = deferredResponse();
    const a = { ...orders[0]!, api_client_id: "site_a", product_name: "网站 A 已加载订单" };
    const lateA = { ...a, product_name: "网站 A 迟到排序结果" };
    const b = { ...orders[1]!, api_client_id: "site_b", product_name: "网站 B 订单" };
    const requests = respond((url) => {
      const siteId = url.pathname.split("/")[5];
      if (/\/sites\/site_[ab]$/.test(url.pathname)) {
        return json({ data: { client_id: siteId, configuration: { name: siteId }, deleted_at: null } });
      }
      if (url.pathname === "/api/admin/v1/sites/site_a/orders") {
        return url.searchParams.get("sort_order") === "asc" ? page([a]) : sortedA.promise;
      }
      if (url.pathname === "/api/admin/v1/sites/site_b/orders") return pendingB.promise;
      throw new Error("Unexpected request: " + url.pathname);
    });
    const view = mount("/sites/site_a" + orderPath);
    await screen.findByRole("link", { name: a.product_name });
    try {
      await userEvent.setup().click(screen.getByRole("button", { name: "应付金额" }));
      await waitFor(() => expect(requests.some((url) => url.pathname.endsWith("/site_a/orders") && url.searchParams.get("sort_order") === "desc")).toBe(true));
      expect(screen.getByRole("link", { name: a.product_name })).toBeVisible();
      await act(async () => { await view.router.navigate("/sites/site_b/orders?sort_by=payable_amount_cents&sort_order=desc"); });
      await waitFor(() => expect(requests.some((url) => url.pathname.endsWith("/site_b/orders"))).toBe(true));
      expect(screen.queryByRole("link", { name: a.product_name })).not.toBeInTheDocument();
      await act(async () => { pendingB.resolve(page([b])); });
      const current = await screen.findByRole("link", { name: b.product_name });
      expect(current).toHaveAttribute("href", "/sites/site_b/orders/" + b.order_id);
      await act(async () => { sortedA.resolve(page([lateA])); });
      expect(screen.queryByRole("link", { name: lateA.product_name })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: b.product_name })).toBe(current);
      expect(requests.every((url) => url.pathname.startsWith("/api/admin/v1/sites/"))).toBe(true);
    } finally {
      sortedA.resolve(page([lateA]));
      pendingB.resolve(page([b]));
    }
  });

  it("keeps the previous cursor disabled while an offline sort is paused, then uses the new cursor", async () => {
    const pending = deferredResponse();
    const requests = respond((url) => {
      if (url.searchParams.get("cursor") === "sorted-next") return page([orders[0]!]);
      return url.searchParams.get("sort_order") === "asc" ? page(orders, "old-next") : pending.promise;
    });
    mount(orderPath);
    const table = await screen.findByRole("table");
    const next = screen.getByRole("button", { name: "下一页" });
    expect(next).toBeEnabled();
    const user = userEvent.setup();
    try {
      act(() => onlineManager.setOnline(false));
      await user.click(within(table).getByRole("button", { name: "应付金额" }));
      await waitFor(() => expect(next).toBeDisabled());
      expect(screen.getByRole("table")).toBe(table);
      expect(table.closest('[aria-busy="true"]')).not.toBeNull();
      expect(screen.getByRole("navigation", { name: "列表分页" })).toHaveTextContent("正在读取第 1 页");
      await user.click(next);
      expect(requests).toHaveLength(1);
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(requests.some((url) => url.searchParams.get("sort_order") === "desc")).toBe(true));
      expect(next).toBeDisabled();
      await act(async () => { pending.resolve(page([...orders].reverse(), "sorted-next")); });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);
      await waitFor(() => expect(requests.some((url) => url.searchParams.get("cursor") === "sorted-next")).toBe(true));
      expect(requests.some((url) => url.searchParams.get("cursor") === "old-next")).toBe(false);
    } finally {
      pending.resolve(page([...orders].reverse(), "sorted-next"));
      act(() => onlineManager.setOnline(true));
    }
  });

  it("retains the mobile order summary while applying a new sort from the filter sheet", async () => {
    mobileMedia(390);
    const pending = deferredResponse();
    const requests = respond((url) => url.searchParams.get("sort_order") === "asc" ? page(orders) : pending.promise);
    let recordCommit: (() => void) | undefined;
    mount(orderPath, () => recordCommit?.());
    const summary = await screen.findByRole("list");
    const rows = within(summary).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const commits: boolean[] = [];
    recordCommit = () => commits.push(summary.isConnected && rows.every((row) => row.isConnected));
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("button", { name: "筛选与排序" }));
      const sheet = screen.getByRole("dialog", { name: "筛选与排序" });
      await user.click(within(sheet).getByRole("button", { name: "降序" }));
      expect(requests).toHaveLength(1);
      await user.click(within(sheet).getByRole("button", { name: "应用" }));
      await waitFor(() => expect(requests.some((url) => url.searchParams.get("sort_order") === "desc")).toBe(true));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "筛选与排序" })).not.toBeInTheDocument());
      expect(screen.getByRole("list")).toBe(summary);
      expect(summary).toBeVisible();
      within(summary).getAllByRole("listitem").forEach((row, index) => expect(row).toBe(rows[index]));
      expect(summary.closest('[aria-busy="true"]')).not.toBeNull();
      await act(async () => { pending.resolve(page([...orders].reverse())); });
      await waitFor(() => expect(within(summary).getAllByRole("listitem")[0]).toBe(rows[1]));
      expect(within(summary).getAllByRole("listitem")[1]).toBe(rows[0]);
      expect(screen.getByRole("list")).toBe(summary);
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every(Boolean)).toBe(true);
    } finally { pending.resolve(page([...orders].reverse())); }
  });
});
