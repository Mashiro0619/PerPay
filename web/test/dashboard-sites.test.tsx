import { WorkspaceProvider, WorkspaceOutlet } from "../src/workspace";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Dashboard from "../src/pages/Dashboard";
import { json, settings } from "./fixtures";

vi.mock("../src/features/system-status", () => ({
  SystemStatusBoundary: ({ children }: { children: ReactNode }) => children,
  useSystemStatus: () => ({ checking: false, unavailable: false, status: { data: { data: {
    instance_id: "test", status: "ready", configured: true, database: { ok: true },
    ledger: { collection_ready: true }, reconciliation: { confirmation_ready: true }, work_items: { total: 77 },
  } } } }),
}));
vi.mock("../src/components/chart-area-interactive", () => ({ ChartAreaInteractive: () => null }));

function mount(summary?: (clientId: string) => Promise<Response>) {
  const summaryReads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url), clientId = /\/sites\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    if (url.pathname.endsWith("/settings")) return json({ data: { ...settings, site_mode: true, completion: { ...settings.completion, complete: true, sites: true } } });
    if (url.pathname.endsWith("/analytics")) return json({ data: { pending: { orders: clientId === "site_b" ? 4 : 3 }, daily: [] } });
    if (url.pathname.endsWith("/work-items/summary")) {
      summaryReads.push(clientId);
      return summary ? summary(clientId) : json({ data: { total: clientId === "site_a" ? 6 : 0 } });
    }
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
    expect(card("当前待付款").getByRole("link")).toHaveTextContent("3");
    expect(href("当前待付款").pathname).toContain("/sites/site_a/");
    expect(href("当前待付款").searchParams.get("payment")).toBe("UNPAID");
    expect(href("当前待付款").searchParams.get("checkout")).toBe("OPEN");
    expect(href("需处理事项").pathname).toContain("/sites/site_a/");
    await act(async () => { await view.router.navigate("/sites/site_b"); });
    await waitFor(() => expect(card("需处理事项").getByRole("link")).toHaveTextContent("0"));
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
  });
});
