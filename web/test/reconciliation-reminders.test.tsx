import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import Reconciliation from "../src/pages/Reconciliation";
import WorkItems from "../src/pages/WorkItems";
import { json, ledgerId } from "./fixtures";

const cases = [
  { tab: "exceptions", type: "FINANCIAL_EXCEPTION", endpoint: "/api/admin/v1/reconciliation/exceptions", idKey: "exception_id", title: "收入尚未匹配订单" },
  { tab: "conflicts", type: "LEDGER_CONFLICT", endpoint: "/api/admin/v1/ledger/conflicts", idKey: "conflict_id", title: "流水金额无法解析" },
] as const;

describe("reconciliation reminder navigation", () => {
  it.each(cases)("refreshes the $tab list after ignoring and restoring its reminder", async (scenario) => {
    const user = userEvent.setup();
    let ignored = false;
    const requests: Request[] = [];
    const entry = { [scenario.idKey]: ledgerId, exception_type: "UNMATCHED_CREDIT", conflict_type: "INVALID_AMOUNT", order_id: null, status: "OPEN", created_at: "2026-09-06T12:00:00Z" };
    const reminder = {
      type: scenario.type, resource_id: ledgerId, provider_account_key: "primary", status: "OPEN", order_id: null, ledger_entry_id: null,
      exception_type: "UNMATCHED_CREDIT", conflict_type: "INVALID_AMOUNT", candidate_id: null, external_event_id: null,
      created_at: entry.created_at, actionable_at: entry.created_at, ignored_at: null, ignored_by: null, ended: false,
      detail_url: scenario.endpoint + "/" + ledgerId,
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/ignore-all")) {
        ignored = true;
        return json({ data: { ...await request.json(), ignored_count: 1 } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/actions/restore")) {
        ignored = false;
        return json({ data: { ...await request.json(), type: scenario.type, resource_id: ledgerId, restored: true } });
      }
      if (url.pathname === scenario.endpoint) return json({ data: !ignored || url.searchParams.get("status") === "ALL" ? [entry] : [], page: { next_cursor: null } });
      if (url.pathname === "/api/admin/v1/work-items") {
        const selected = (url.searchParams.get("visibility") === "IGNORED") === ignored;
        return json({ data: selected ? [{ ...reminder, ...(ignored ? { ignored_at: "2026-09-07T12:00:00Z", ignored_by: "admin" } : {}) }] : [], page: { next_cursor: null } });
      }
      throw new Error("unexpected request: " + request.method + " " + url.pathname);
    }));
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/reconciliation?tab=" + scenario.tab]}>
      <nav><Link to={"/reconciliation?tab=" + scenario.tab}>账本记录</Link><Link to={"/work-items?type=" + scenario.type}>管理提醒</Link></nav>
      <Routes><Route path="/reconciliation" element={<Reconciliation />} /><Route path="/work-items" element={<WorkItems />} /></Routes>
    </MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("link", { name: scenario.title })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "管理提醒" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "全部忽略" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "全部忽略" }));
    await user.click(screen.getByRole("button", { name: "确认全部忽略" }));
    await screen.findByText(/已忽略“.+”中的 1 条提醒/);
    await user.click(screen.getByRole("link", { name: "账本记录" }));
    expect(await screen.findByText("暂无符合条件的记录")).toBeVisible();
    expect(screen.queryByRole("link", { name: scenario.title })).not.toBeInTheDocument();
    if (scenario.tab === "conflicts") {
      expect(screen.getByRole("option", { name: "待处理（未忽略）" })).toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText("对账状态筛选"), "ALL");
      expect(await screen.findByRole("link", { name: scenario.title })).toBeVisible();
      expect(screen.getByRole("option", { name: "全部记录（含已忽略）" })).toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText("对账状态筛选"), "OPEN");
      await screen.findByText("暂无符合条件的记录");
    }
    const historyLink = screen.getByRole("link", { name: "查看已忽略" });
    expect(historyLink).toHaveAttribute("href", "/work-items?type=" + scenario.type + "&visibility=IGNORED");
    await user.click(historyLink);
    expect(await screen.findByRole("heading", { name: scenario.title })).toBeVisible();
    expect(screen.getByText("已忽略提醒")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "恢复提醒" }));
    await screen.findByText("暂时没有已忽略提醒");
    await user.click(screen.getByRole("link", { name: "账本记录" }));
    expect(await screen.findByRole("link", { name: scenario.title })).toBeVisible();
    expect(requests.filter(request => new URL(request.url).pathname === scenario.endpoint).length).toBeGreaterThanOrEqual(3);
  });
});
