import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type SystemStatus } from "../src/api/client";
import { ReadinessCheck } from "../src/pages/Onboarding";
import { apiError, json } from "./fixtures";
import { configuredThrough, instanceId, systemStatus } from "./onboarding-fixture";

function mount(read: () => Response | Promise<Response> = () => json({ data: systemStatus() })) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const fetchMock = vi.fn(read); vi.stubGlobal("fetch", fetchMock);
  const onReload = vi.fn();
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter><ReadinessCheck settings={configuredThrough(4)} instanceId={instanceId} onReload={onReload} /></MemoryRouter></QueryClientProvider>);
  return { ...view, fetchMock, onReload };
}

describe("onboarding payment readiness", () => {
  it.each(["configured", "database", "collection", "confirmation", "not_ready"])("does not report success when %s is not ready", async (missing) => {
    const status = systemStatus();
    if (missing === "configured") status.configured = false;
    if (missing === "database") status.database.ok = false;
    if (missing === "collection") status.ledger.collection_ready = false;
    if (missing === "confirmation") status.reconciliation.confirmation_ready = false;
    if (missing === "not_ready") status.status = "not_ready";
    const { fetchMock } = mount(() => json({ data: status }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
    expect(screen.queryByText("收款已就绪。")).not.toBeInTheDocument();
  });
  it("accepts degraded payment readiness but keeps the operational warning", async () => {
    const status = { ...systemStatus(), status: "degraded" as const };
    const { fetchMock } = mount(() => json({ data: status }));
    expect(await screen.findByText("可以收款，仍有事项待处理。")).toBeVisible();
    expect(screen.getByRole("link", { name: "进入控制台" })).toBeVisible();
    expect(screen.getByRole("link", { name: "小额真实测试" })).toHaveAttribute("href", "/test-payment");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(["settings_revision", "payment_revision"] as const)("rejects an outdated %s and offers explicit configuration reload", async (version) => {
    const status = systemStatus(); status[version] = 0;
    const { onReload } = mount(() => json({ data: status }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "重新读取配置" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
  });
  it("requires a fresh response instead of trusting a cached green state", async () => {
    let finish: (response: Response) => void = () => {};
    const configured = configuredThrough(4);
    queryClient.setQueryData(["onboarding", "readiness", instanceId, configured.revision, configured.payment_revision, 0], { data: systemStatus() });
    const { fetchMock } = mount(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
    await act(async () => { finish(json({ data: systemStatus() })); });
    expect(await screen.findByRole("link", { name: "进入控制台" })).toBeVisible();
  });
  it("removes previous success on a failed refresh and allows recovery", async () => {
    let fail = false;
    mount(() => fail ? apiError("internal_error", "temporary outage", 503) : json({ data: systemStatus() }));
    await screen.findByRole("link", { name: "进入控制台" });
    fail = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "重新检查" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByRole("link", { name: "进入控制台" })).toBeVisible();
  });
  it("polls every five seconds, pauses while hidden and refreshes on return", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.useFakeTimers();
    const { fetchMock, unmount } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole("link", { name: "进入控制台" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5010); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(true); fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("invalidates old success immediately when offline", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mount(); await screen.findByRole("link", { name: "进入控制台" });
    online.mockReturnValue(false); fireEvent(window, new Event("offline"));
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    online.mockReturnValue(true); fireEvent(window, new Event("online"));
    expect(await screen.findByRole("link", { name: "进入控制台" })).toBeVisible();
  });
  it("does not show a late success while hidden", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finish: (response: Response) => void = () => {};
    const { fetchMock } = mount(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    hidden.mockReturnValue(true); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { finish(json({ data: systemStatus() })); });
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
  });
  it("exposes actual collection failure details rather than claiming platform access was verified", async () => {
    const status: SystemStatus = systemStatus(); status.ledger.collection_ready = false; status.ledger.last_error_code = "provider_authentication_failed"; status.status = "not_ready";
    mount(() => json({ data: status }));
    expect(await screen.findByText("最近错误：provider_authentication_failed")).toBeVisible();
    expect(screen.getByRole("link", { name: "检查支付宝接入" })).toHaveAttribute("href", "/settings/onboarding/provider");
    expect(screen.queryByRole("link", { name: "小额真实测试" })).not.toBeInTheDocument();
  });
});
