import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceProvider,
  WorkspaceOutlet,
  useWorkspaceApi,
} from "../src/workspace";
import { useQuery } from "../src/lib/workspace-query";
import {
  workspaceScope,
  workspaceHref,
  legacyWorkspaceUrl,
} from "../src/lib/workspace-scope";
import { workspaceApi } from "../src/api/workspace";
import { queryClient, result } from "../src/api/client";
import { Link, useDetailBack } from "../src/navigation";
import { DraftProvider } from "../src/drafts";
import { TestPaymentButton, TestPaymentProvider } from "../src/components/test-payment-provider";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";
import { json, order, orderId } from "./fixtures";
const site = (id: string) => ({
  client_id: id,
  revision: 0,
  configuration: {
    name: id === "a" ? "网站 A" : "网站 B",
    accepting_orders: true,
    notifications_enabled: false,
  },
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
  deleted_at: null,
});
function Probe() {
  const [draft, setDraft] = useState("");
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["orders", "probe"],
    queryFn: ({ signal }) => result(api.listAdministratorOrders({ signal })),
  });
  const back = useDetailBack("/orders", "订单列表");
  return (
    <>
      <input
        aria-label="待保存草稿"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <output>{query.data?.data.map((o) => o.product_name).join(",")}</output>
      <Link to={"/orders/" + orderId}>订单详情</Link>
      <Link to={back.to}>返回列表</Link>
    </>
  );
}
function mountProbe(path = "/sites/a/orders") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <WorkspaceProvider>
            <WorkspaceOutlet />
          </WorkspaceProvider>
        ),
        children: [
          { path: "/sites/:clientId/orders/:orderId?", element: <Probe /> },
          { path: "/orders", element: <Probe /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
describe("two-level workspace boundaries", () => {
  it("derives scope only from nested routes and converts legacy filters without pagination", () => {
    expect(workspaceScope("/sites/new").clientId).toBeNull();
    expect(workspaceScope("/sites/defaults").clientId).toBeNull();
    expect(
      workspaceHref(workspaceScope("/sites/a/orders"), "/orders/" + orderId),
    ).toBe("/sites/a/orders/" + orderId);
    expect(
      legacyWorkspaceUrl(
        "/orders",
        "?api_client_id=a&q=hello&payment=UNPAID&cursor=old&page=4",
      ),
    ).toBe("/sites/a/orders?q=hello&payment=UNPAID");
    expect(
      legacyWorkspaceUrl("/sites/a/orders", "?api_client_id=b"),
    ).toBeNull();
  });
  it("captures SDK scope immutably, removes duplicate identity, and refuses a conflicting body", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) => {
        requests.push(req.clone());
        return json({ data: [] });
      }),
    );
    const a = workspaceApi("a"),
      b = workspaceApi("b");
    await a.listAdministratorOrders({ query: { api_client_id: "a" } });
    await b.listAdministratorOrders();
    await a.listAdministratorOrders();
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/admin/v1/sites/a/orders",
      "/api/admin/v1/sites/b/orders",
      "/api/admin/v1/sites/a/orders",
    ]);
    expect(
      requests.every((r) => !new URL(r.url).searchParams.has("api_client_id")),
    ).toBe(true);
    expect(() =>
      a.createAdministratorTestPayment({
        body: { api_client_id: "b", test_payment_id: orderId, amount_cents: 1 },
      }),
    ).toThrow("网站范围不一致");
    expect(() =>
      a.getLedgerConflict({ path: { conflictId: orderId } }),
    ).toThrow("请到「对账（全部网站）」执行此操作。");
  });
  it("keeps late A responses out of B caches and preserves scoped detail returns", async () => {
    let release!: (r: Response) => void;
    const late = new Promise<Response>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) => {
        const p = new URL(req.url).pathname;
        const id = p.split("/")[5]!;
        if (p.endsWith("/orders"))
          return id === "a"
            ? late
            : json({
                data: [{ ...order, product_name: "B-only" }],
                page: { next_cursor: null },
              });
        return json({ data: site(id) });
      }),
    );
    const router = mountProbe("/sites/a/orders?q=old");
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([r]) =>
            String((r as Request).url).endsWith("/sites/a/orders"),
          ),
      ).toBe(true),
    );
    await act(async () => {
      await router.navigate("/sites/b/orders?q=new");
    });
    await screen.findByText("B-only");
    await act(async () => {
      release(
        json({
          data: [{ ...order, product_name: "A-late" }],
          page: { next_cursor: null },
        }),
      );
      await late;
    });
    expect(screen.queryByText("A-late")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "订单详情" }));
    expect(router.state.location.pathname).toBe("/sites/b/orders/" + orderId);
    expect(screen.getByRole("link", { name: "返回列表" })).toHaveAttribute(
      "href",
      "/sites/b/orders?q=new",
    );
  });
  it("does not render cached business data or fall back globally when the site read fails", async () => {
    queryClient.setQueryData(["orders", "probe"], {
      data: [{ ...order, product_name: "global-leak" }],
    });
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) => {
        reads.push(new URL(req.url).pathname);
        return json(
          { error: { code: "site_not_found", message: "该网站不存在" } },
          404,
        );
      }),
    );
    mountProbe();
    await screen.findByText("该网站不存在");
    expect(reads).toEqual(["/api/admin/v1/sites/a"]);
    expect(screen.queryByText("global-leak")).not.toBeInTheDocument();
  });
  it("keeps the current business section and shared navigation in the real shell when switching websites", async () => {
    const reads: string[] = [];
    const view = mountOnboarding({
      stage: 4,
      path: "/sites/a/orders",
      handle: (req) => {
        const p = new URL(req.url).pathname;
        reads.push(p);
        if (p === "/api/admin/v1/sites")
          return json({
            data: [site("a"), site("b")],
            page: { next_cursor: null },
          });
        if (/^\/api\/admin\/v1\/sites\/[ab]$/.test(p))
          return json({ data: site(p.at(-1)!) });
        if (p.endsWith("/orders"))
          return json({
            data: [{ ...order, api_client_id: p.includes("/a/") ? "a" : "b" }],
            page: { next_cursor: null },
          });
        if (p.endsWith("/work-items/summary"))
          return json({ data: { total: 0 } });
        if (p.endsWith("/work-items"))
          return json({ data: [], page: { next_cursor: null } });
        if (p.endsWith("/system/analytics"))
          return json({ data: { pending: { orders: 1 }, daily: [] } });
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "本站订单" });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const selector = screen.getByRole("navigation", { name: "网站选择" });
    expect(within(nav).getByRole("link", { name: "通知" })).toHaveAttribute(
      "href",
      "/sites/a/notifications",
    );
    expect(screen.getByRole("link", { name: "对账" })).toHaveAttribute(
      "href",
      "/reconciliation?selected_site=a",
    );
    expect(
      screen.queryByRole("button", { name: "切换后台" }),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "业务网站" })).toHaveAttribute(
      "href",
      "/sites?selected_site=a",
    );
    expect(await within(selector).findByRole("link", { name: "网站 A" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    const user = userEvent.setup();
    await user.click(await within(selector).findByRole("link", { name: "网站 B" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/sites/b/orders"),
    );
    await screen.findByRole("heading", { name: "本站订单" });
    await waitFor(() => expect(document.title).toContain("网站 B"));
    expect(within(selector).getByRole("link", { name: "网站 B" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(reads).toContain("/api/admin/v1/sites/b/orders");
    expect(reads).not.toContain("/api/admin/v1/orders");
  });
});

it("fixes a test-payment request to A while switching to B and retries the original request", async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<Response>((_, r) => {
    reject = r;
  });
  const writes: Request[] = [];
  const view = mountOnboarding({
    stage: 4,
    path: "/sites/a",
    handle: (req) => {
      const p = new URL(req.url).pathname;
      if (/^\/api\/admin\/v1\/sites\/[ab]$/.test(p))
        return json({ data: site(p.at(-1)!) });
      if (p.endsWith("/orders"))
        return json({ data: [], page: { next_cursor: null } });
      if (p.endsWith("/test-payments")) {
        writes.push(req.clone());
        return writes.length === 1
          ? pending
          : json({ error: { code: "site_paused", message: "暂停接单" } }, 503);
      }
      return undefined;
    },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试收款" }));
  expect(await within(await screen.findByRole("dialog", { name: "测试收款" })).findByText("a", { exact: true })).toBeVisible();
  expect(screen.queryByLabelText("搜索业务网站")).not.toBeInTheDocument();
  const create = screen.getByRole("button", { name: "创建测试订单" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await waitFor(() => expect(writes).toHaveLength(1));
  await act(async () => {
    await view.router.navigate("/sites/b");
  });
  await act(async () => {
    reject(new TypeError("response lost"));
    await pending.catch(() => {});
  });
  await user.click(await screen.findByRole("button", { name: "测试收款" }));
  await screen.findByText("创建结果待确认");
  expect(within(screen.getByRole("dialog", { name: "测试收款" })).getByText("a", { exact: true })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((r) => new URL(r.url).pathname)).toEqual([
    "/api/admin/v1/sites/a/test-payments",
    "/api/admin/v1/sites/a/test-payments",
  ]);
  expect(await writes[1]!.json()).toEqual(await writes[0]!.json());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "重试上一次操作" })).toBeEnabled(),
  );
  expect(screen.getByText("创建结果待确认")).toBeVisible();
});

it("keeps a global test-payment dialog and its original request through selection-only navigation", async () => {
  const writes: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/test-payments") && request.method === "POST") {
      writes.push(request.clone());
      throw new TypeError("response lost");
    }
    if (path === "/api/admin/v1/system/status") return json({ data: systemStatus() });
    if (path === "/api/admin/v1/sites")
      return json({ data: [site("a"), site("b")], page: { next_cursor: null } });
    if (/^\/api\/admin\/v1\/sites\/[ab]$/.test(path))
      return json({ data: site(path.at(-1)!) });
    return json({ error: { code: "route_not_found", message: "unexpected test request" } }, 404);
  }));
  function SharedPage() {
    return <><h1>全局页面</h1><TestPaymentButton /></>;
  }
  const router = createMemoryRouter([{
    element: <DraftProvider><WorkspaceProvider><TestPaymentProvider><WorkspaceOutlet /></TestPaymentProvider></WorkspaceProvider></DraftProvider>,
    children: [
      { path: "/reconciliation", element: <SharedPage /> },
      { path: "/system", element: <SharedPage /> },
    ],
  }], { initialEntries: ["/reconciliation?selected_site=a"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "测试收款" }));
  const dialog = await screen.findByRole("dialog", { name: "测试收款" });
  const picker = within(dialog).getByRole("combobox", { name: "业务网站" });
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "网站 A" }));
  const create = within(dialog).getByRole("button", { name: "创建测试订单" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await within(dialog).findByText("创建结果待确认");
  const original = await writes[0]!.clone().json();
  expect(original).toMatchObject({ api_client_id: "a", amount_cents: 1, test_payment_id: expect.any(String) });

  await act(async () => { await router.navigate("/reconciliation?selected_site=b"); });
  expect(screen.getByRole("dialog", { name: "测试收款" })).toBe(dialog);
  expect(picker).toHaveTextContent("网站 A");
  expect(picker).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "重试上一次操作" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(await writes[1]!.clone().json()).toEqual(original);

  await act(async () => { await router.navigate("/system?selected_site=b"); });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "测试收款" })).not.toBeInTheDocument());
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await user.click(screen.getByRole("button", { name: "测试收款" }));
  const reopened = await screen.findByRole("dialog", { name: "测试收款" });
  expect(within(reopened).getByRole("combobox", { name: "业务网站" })).toHaveTextContent("网站 A");
  const retry = within(reopened).getByRole("button", { name: "重试上一次操作" });
  await waitFor(() => expect(retry).toBeEnabled());
  await user.click(retry);
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(await writes[2]!.clone().json()).toEqual(original);
  expect(writes.map((request) => new URL(request.url).pathname)).toEqual([
    "/api/admin/v1/test-payments",
    "/api/admin/v1/test-payments",
    "/api/admin/v1/test-payments",
  ]);
});

it("hides business controls on metadata refresh failure without throwing away an existing draft", async () => {
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith("/orders"))
        return json({ data: [], page: { next_cursor: null } });
      return fail
        ? json(
            { error: { code: "internal_error", message: "网站读取失败" } },
            500,
          )
        : json({ data: site("a") });
    }),
  );
  mountProbe();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("待保存草稿"), "不要丢失");
  fail = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["workspace-site", "a"] });
  });
  await screen.findByText("网站读取失败");
  expect(screen.getByLabelText("待保存草稿")).not.toBeVisible();
  fail = false;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["workspace-site", "a"] });
  });
  await waitFor(() =>
    expect(screen.getByLabelText("待保存草稿")).toBeVisible(),
  );
  expect(screen.getByLabelText("待保存草稿")).toHaveValue("不要丢失");
});

it.each([
  ["CONFIRMED", "OPEN", "收款已确认"],
  ["UNPAID", "EXPIRED", "收银台已过期"],
  ["UNPAID", "CLOSED", "收银台已关闭"],
  ["DISPUTED", "CLOSED", "收款需要核查"],
  ["UNPAID", "ERROR", "最新状态暂不可用"],
] as const)(
  "opens the original site's recovered test order after switching workspaces (%s / %s)",
  async (paymentStatus, checkoutStatus, notice) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<Response>((_, fail) => { reject = fail; });
    const writes: Request[] = [];
    const reads: string[] = [];
    const created = {
      ...order,
      api_client_id: "a",
      checkout: { ...order.checkout, checkout_url: "/checkout/test-original-site" },
    };
    const view = mountOnboarding({
      stage: 4,
      path: "/sites/a",
      handle: (req) => {
        const path = new URL(req.url).pathname;
        if (/^\/api\/admin\/v1\/sites\/[ab]$/.test(path))
          return json({ data: site(path.at(-1)!) });
        if (path.endsWith("/orders"))
          return json({ data: [], page: { next_cursor: null } });
        if (path.endsWith("/test-payments")) {
          writes.push(req.clone());
          return writes.length === 1 ? pending : json({ data: created });
        }
        if (path.endsWith("/orders/" + orderId)) {
          reads.push(path);
          return checkoutStatus === "ERROR"
            ? json({ error: { code: "internal_error", message: "订单查询暂时失败" } }, 503)
            : json({ data: {
                ...created,
                checkout: { ...created.checkout, status: checkoutStatus },
                payment: { ...created.payment, status: paymentStatus },
              } });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "测试收款" }));
    const create = screen.getByRole("button", { name: "创建测试订单" });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(writes).toHaveLength(1));
    await act(async () => { await view.router.navigate("/sites/b"); });
    await act(async () => {
      reject(new TypeError("response lost"));
      await pending.catch(() => {});
    });
    await user.click(await screen.findByRole("button", { name: "测试收款" }));
    await user.click(await screen.findByRole("button", { name: "重试上一次操作" }));
    await screen.findByText(notice);
    expect(writes.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/admin/v1/sites/a/test-payments",
      "/api/admin/v1/sites/a/test-payments",
    ]);
    expect(await writes[1]!.json()).toEqual(await writes[0]!.json());
    expect(reads).toContain("/api/admin/v1/sites/a/orders/" + orderId);
    expect(reads).not.toContain("/api/admin/v1/sites/b/orders/" + orderId);
    const link = screen.getByRole("link", { name: "查看订单" });
    expect(link).toHaveAttribute("href", "/sites/a/orders/" + orderId);
    await user.click(link);
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/a/orders/" + orderId));
  },
);
