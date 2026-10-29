import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type LedgerManualScanRequest } from "../src/api/client";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";
import { apiError, json } from "./fixtures";
import System from "../src/pages/System";

const scanPath = "/api/admin/v1/system/ledger/scan";
const isScan = (request: Request) => new URL(request.url).pathname === scanPath;
const requestedAt = "2026-10-28T08:00:00Z";
const scheduledAt = "2026-10-28T08:00:30Z";
function request(state: LedgerManualScanRequest["state"] = "WAITING", overrides: Partial<LedgerManualScanRequest> = {}): LedgerManualScanRequest {
  return { id: "00000000-0000-4000-8000-000000000001", state, requested_at: requestedAt, started_at: state === "WAITING" ? null : scheduledAt,
    finished_at: state === "COMPLETED" || state === "FAILED" ? "2026-10-28T08:00:40Z" : null,
    next_attempt_at: state === "WAITING" ? scheduledAt : null,
    outcome: state === "COMPLETED" ? "COMPLETED" : state === "FAILED" ? "FAILED" : null,
    error_code: state === "FAILED" ? "transport_timeout" : null, ingest_run_id: null, ...overrides };
}
function ready() {
  const data = systemStatus();
  data.ledger.manual_scan = { available: true, unavailable_reason: null, request: null };
  return data;
}
function ledgerRow() {
  return within(screen.getByRole("rowheader", { name: "查账" }).closest("tr")!);
}
afterEach(() => { delete document.documentElement.dataset.perpayDemo; });

describe("manual ledger scan", () => {
  it("offers a manual scan on the failing ledger row without treating readiness failure as a configuration failure", async () => {
    const data = ready();
    data.status = "not_ready";
    data.ledger.collection_ready = false;
    data.ledger.state = "degraded";
    data.ledger.last_error_code = "transport_timeout";
    data.ledger.consecutive_failures = 1;
    mountOnboarding({ stage: 4, path: "/system", status: () => data });
    const table = await screen.findByRole("table", { name: "运行环节" });
    const ledger = within(within(table).getByRole("rowheader", { name: "查账" }).closest("tr")!);
    expect(ledger.getByRole("button", { name: "手动查账" })).toBeEnabled();
    expect(ledger.getByRole("link", { name: "支付宝账号" })).toBeVisible();
    expect(ledger.getByRole("button", { name: "查账运行诊断" })).toBeVisible();
  });

  it("submits one empty JSON request, reports the scheduled time and refreshes operational data without claiming completion", async () => {
    const data = ready();
    let finish!: (response: Response) => void;
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data, handle: req => isScan(req)
      ? new Promise<Response>(resolve => { finish = resolve; }) : undefined });
    await screen.findByRole("table", { name: "运行环节" });
    queryClient.setQueryData(["ledger", "manual-test"], { data: [] });
    queryClient.setQueryData(["summary", "manual-test"], { data: {} });
    queryClient.setQueryData(["official-update", "manual-test"], { data: {} });
    document.cookie = "perpay_csrf=manual-scan-test; Path=/";
    const button = ledgerRow().getByRole("button", { name: "手动查账" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(view.writes().filter(isScan)).toHaveLength(1));
    expect(button).toBeDisabled();
    expect(await screen.findByText("正在提交查账请求…")).toBeVisible();
    const submitted = view.writes().find(isScan)!;
    expect(submitted.method).toBe("POST");
    expect(await submitted.clone().json()).toEqual({});
    expect(submitted.headers.get("X-CSRF-Token")).toBe("manual-scan-test");
    data.ledger.manual_scan!.request = request();
    await act(async () => { finish(json({ data: request() }, 202)); });
    const feedback = await screen.findByRole("status", { name: "手动查账状态" });
    expect(feedback).toHaveTextContent("手动查账已排队");
    expect(feedback.querySelector("time")).toHaveAttribute("datetime", scheduledAt);
    expect(screen.queryByText(/手动查账已完成|已查账成功/)).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.getQueryState(["ledger", "manual-test"])?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(["summary", "manual-test"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["official-update", "manual-test"])?.isInvalidated).toBe(false);
  });

  it.each([
    ["not_configured", "请先完成支付宝账号配置。"],
    ["transitioning", "运行配置正在切换，请稍后再试。"],
    ["stopped", "查账任务已停用，请先启用查账服务。"],
    ["storage_unavailable", "查账进度暂不可用，请检查运行诊断。"],
    ["database_unavailable", "数据库暂不可用，请检查服务器。"],
  ] as const)("explains why %s disables the action", async (reason, message) => {
    const data = ready();
    data.ledger.manual_scan = { available: false, unavailable_reason: reason, request: null };
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data });
    await screen.findByRole("table", { name: "运行环节" });
    const button = ledgerRow().getByRole("button", { name: "手动查账" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(message);
    expect(screen.getByText(message)).toBeVisible();
    fireEvent.click(button);
    expect(view.writes().filter(isScan)).toHaveLength(0);
  });

  it.each(["bootstrap", "server"] as const)("keeps the %s demo restriction without displaying its identity", async source => {
    const data = ready();
    if (source === "bootstrap") document.documentElement.dataset.perpayDemo = "readonly";
    else data.ledger.manual_scan = { available: false, unavailable_reason: "demo_read_only", request: null };
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data });
    await screen.findByRole("table", { name: "运行环节" });
    const button = ledgerRow().getByRole("button", { name: "手动查账" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/演示模式|只读演示/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(view.writes().filter(isScan)).toHaveLength(0);
  });

  it.each([
    [request("RUNNING"), "正在执行手动查账", true],
    [request("COMPLETED"), "手动查账已完成", false],
    [request("COMPLETED", { outcome: "PARTIAL" }), "本轮查账部分完成", false],
    [request("COMPLETED", { outcome: "SKIPPED" }), "本轮未执行查账", false],
    [request("FAILED"), "手动查账未完成", false],
  ] as const)("restores server state %s without resubmitting after opening the page", async (scan, message, disabled) => {
    const data = ready();
    data.ledger.manual_scan!.request = scan;
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data });
    await screen.findByRole("table", { name: "运行环节" });
    expect(screen.getByRole("status", { name: "手动查账状态" })).toHaveTextContent(message);
    const button = ledgerRow().getByRole("button", { name: "手动查账" });
    if (disabled) expect(button).toBeDisabled(); else expect(button).toBeEnabled();
    expect(view.writes().filter(isScan)).toHaveLength(0);
  });

  it("allows retry after the server Retry-After deadline and never resubmits automatically", async () => {
    const data = ready();
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data, handle: req => isScan(req)
      ? json({ error: { code: "rate_limited", message: "请求过于频繁" } }, 429, { "Retry-After": "2" }) : undefined });
    await screen.findByRole("table", { name: "运行环节" });
    await userEvent.setup().click(ledgerRow().getByRole("button", { name: "手动查账" }));
    expect(await screen.findByRole("alert", { name: "手动查账状态" })).toHaveTextContent("请等待 2 秒后重试");
    expect(ledgerRow().getByRole("button", { name: "手动查账" })).toBeDisabled();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3000);
    act(() => fireEvent(window, new Event("focus")));
    // Focusing rechecks the elapsed server deadline without resubmitting.
    expect(ledgerRow().getByRole("button", { name: "手动查账" })).toBeEnabled();
    expect(view.writes().filter(isScan)).toHaveLength(1);
  });

  it("keeps transient failures retryable and rejects incomplete accepted responses", async () => {
    let malformed = false;
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => ready(), handle: req => isScan(req)
      ? malformed ? json({ data: { state: "COMPLETED" } }, 202) : apiError("ledger_scan_unavailable", "查账请求暂未受理", 503) : undefined });
    await screen.findByRole("table", { name: "运行环节" });
    const user = userEvent.setup();
    await user.click(ledgerRow().getByRole("button", { name: "手动查账" }));
    expect(await screen.findByRole("alert", { name: "手动查账状态" })).toHaveTextContent("查账请求暂未受理");
    expect(ledgerRow().getByRole("button", { name: "手动查账" })).toBeEnabled();
    malformed = true;
    await user.click(ledgerRow().getByRole("button", { name: "手动查账" }));
    expect(await screen.findByRole("alert", { name: "手动查账状态" })).toHaveTextContent("查账请求响应不完整");
    expect(view.writes().filter(isScan)).toHaveLength(2);
    expect(screen.queryByText(/手动查账已完成/)).not.toBeInTheDocument();
  });

  it("replaces an ambiguous submission error when a fresh snapshot confirms the new server task", async () => {
    const data = ready();
    mountOnboarding({ stage: 4, path: "/system", status: () => data, handle: req => isScan(req)
      ? Promise.reject(new TypeError("connection closed after the server accepted")) : undefined });
    await screen.findByRole("table", { name: "运行环节" });
    await userEvent.setup().click(ledgerRow().getByRole("button", { name: "手动查账" }));
    expect(await screen.findByRole("alert", { name: "手动查账状态" })).toBeVisible();
    data.ledger.manual_scan!.request = request("RUNNING");
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["status"] }); });
    expect(await screen.findByRole("status", { name: "手动查账状态" })).toHaveTextContent("正在执行手动查账");
    expect(screen.queryByRole("alert", { name: "手动查账状态" })).not.toBeInTheDocument();
  });

  it.each(["source", "session", "unmount"] as const)("ignores a late accepted response after %s changes", async kind => {
    const data = ready();
    let finish!: (response: Response) => void;
    let pendingRequest: Request | undefined;
    const view = mountOnboarding({ stage: 4, path: "/system", status: () => data, handle: req => {
      if (!isScan(req)) return undefined;
      pendingRequest = req;
      return new Promise<Response>(resolve => { finish = resolve; });
    } });
    await screen.findByRole("table", { name: "运行环节" });
    await userEvent.setup().click(ledgerRow().getByRole("button", { name: "手动查账" }));
    await waitFor(() => expect(pendingRequest).toBeDefined());
    if (kind === "source") {
      data.provider_account_key = "new-payment-source";
      data.payment_revision += 1;
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["status"] }); });
    } else if (kind === "session") {
      fireEvent(window, new Event("perpay:session-expired"));
      await screen.findByRole("heading", { name: "登录管理后台" });
    } else view.unmount();
    await waitFor(() => expect(pendingRequest?.signal.aborted).toBe(true));
    await act(async () => { finish(json({ data: request() }, 202)); });
    expect(screen.queryByRole("status", { name: "手动查账状态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "手动查账状态" })).not.toBeInTheDocument();
    if (kind === "source") expect(ledgerRow().getByRole("button", { name: "手动查账" })).toBeEnabled();
  });

  it.each(["visibility", "network"] as const)("polls the shared owner every two seconds only for active scans and pauses during %s loss", async kind => {
    vi.useFakeTimers();
    const available = kind === "visibility"
      ? vi.spyOn(document, "hidden", "get").mockReturnValue(false)
      : vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    let data = ready();
    data.ledger.manual_scan!.request = request();
    const fetchMock = vi.fn(async () => json({ data }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<QueryClientProvider client={queryClient}><MemoryRouter><System /></MemoryRouter></QueryClientProvider>);
    const advance = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
    const change = (value: boolean) => {
      available.mockReturnValue(kind === "visibility" ? !value : value);
      fireEvent(kind === "visibility" ? document : window, new Event(kind === "visibility" ? "visibilitychange" : value ? "online" : "offline"));
    };
    try {
      await advance(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await advance(2100);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      act(() => change(false));
      await advance(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      data = { ...data, ledger: { ...data.ledger, manual_scan: { ...data.ledger.manual_scan!, request: request("RUNNING") } } };
      act(() => change(true));
      await advance(10);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("status", { name: "手动查账状态" })).toHaveTextContent("正在执行手动查账");
      queryClient.setQueryData(["ledger", "completed-manual"], { data: [] });
      data = { ...data, ledger: { ...data.ledger, manual_scan: { ...data.ledger.manual_scan!, request: request("COMPLETED") } } };
      await advance(2100);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(screen.getByRole("status", { name: "手动查账状态" })).toHaveTextContent("手动查账已完成");
      expect(queryClient.getQueryState(["ledger", "completed-manual"])?.isInvalidated).toBe(true);
      await advance(5000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      view.unmount();
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      available.mockRestore();
      onlineManager.setOnline(true);
    }
  });
});
