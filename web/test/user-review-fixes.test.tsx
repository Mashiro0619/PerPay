import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { queryClient } from "../src/api/client";
import { apiError, json, order, orderId } from "./fixtures";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

beforeEach(() => onlineManager.setOnline(true));
afterEach(() => { vi.restoreAllMocks(); onlineManager.setOnline(true); });

describe("homepage collection health", () => {
  it.each(["ledger", "database", "reconciliation"] as const)("shows a %s outage without sending a configured instance to onboarding", async (kind) => {
    const view = mountOnboarding({ stage: 4, path: "/", status: (settings) => {
      const status = systemStatus(settings); status.status = "not_ready";
      if (kind === "ledger") { status.ledger.collection_ready = false; status.ledger.last_error_code = "remote_authorization_failed"; }
      if (kind === "database") status.database.ok = false;
      if (kind === "reconciliation") status.reconciliation.confirmation_ready = false;
      return status;
    } });
    expect(await screen.findByText("当前暂停新收款")).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/");
    expect(within(screen.getByRole("alert")).getByRole("link", { name: "查看运行状态" })).toHaveAttribute("href", "/system");
  });
  it("keeps non-blocking warnings distinct from stopped payments and invalidates them on a failed read", async () => {
    let fail = false;
    mountOnboarding({ stage: 4, path: "/", status: (settings) => ({ ...systemStatus(settings), status: "degraded" }), handle: (request) => fail && request.url.endsWith("/system/status") ? apiError("internal_error", "unavailable", 503) : undefined });
    expect(await screen.findByText("可以收款，但有运行告警")).toBeVisible();
    expect(screen.queryByText("当前暂停新收款")).not.toBeInTheDocument();
    fail = true; await act(async () => { await queryClient.invalidateQueries({ queryKey: ["dashboard", "status"] }); });
    expect(await screen.findByText("暂时无法确认收款状态")).toBeVisible();
    expect(screen.queryByText("可以收款，但有运行告警")).not.toBeInTheDocument();
  });
  it("invalidates health immediately when offline", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mountOnboarding({ stage: 4, path: "/", status: (settings) => ({ ...systemStatus(settings), status: "degraded" }) });
    await screen.findByText("可以收款，但有运行告警");
    online.mockReturnValue(false); fireEvent(window, new Event("offline"));
    expect(screen.getByText("暂时无法确认收款状态")).toBeVisible();
    expect(screen.queryByText("可以收款，但有运行告警")).not.toBeInTheDocument();
  });
  it("polls while visible, pauses while hidden, and reads afresh on return", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false); vi.useFakeTimers();
    const view = mountOnboarding({ stage: 4, path: "/" });
    const reads = () => view.fetchMock.mock.calls.filter(([request]) => request.url.endsWith("/system/status")).length;
    for (let attempt = 0; attempt < 10 && reads() === 0; attempt += 1) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const first = reads(); expect(first).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_100); }); expect(reads()).toBe(first + 1);
    hidden.mockReturnValue(true); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_100); }); expect(reads()).toBe(first + 1);
    hidden.mockReturnValue(false); fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); expect(reads()).toBe(first + 2);
  });
});

describe("guided configuration field errors", () => {
  it("does not submit arbitrary text as a collection code and focuses the retained input", async () => {
    const view = mountOnboarding({ stage: 2, path: "/settings/onboarding/collection" });
    const field = await screen.findByLabelText("支付宝经营码内容");
    fireEvent.change(field, { target: { value: "not-a-payment-code" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveFocus(); expect(field).toHaveValue("not-a-payment-code"); expect(view.writes()).toHaveLength(0);
    expect(view.router.state.location.pathname).toBe("/settings/onboarding/collection");
  });
  it("associates a server key error with the exact field without clearing the draft", async () => {
    const view = mountOnboarding({ stage: 1, path: "/settings/onboarding/provider", handle: (request) => request.method === "PUT" ? json({ error: { code: "settings_validation_failed", message: "请改填支付宝公钥。", request_id: "field-test", fields: { platform_public_key: "请改填支付宝公钥。" } } }, 422) : undefined });
    fireEvent.change(await screen.findByLabelText("应用 ID（App ID）"), { target: { value: "app-id-test" } });
    const key = screen.getByLabelText("支付宝公钥"); fireEvent.change(key, { target: { value: "invalid-public-key" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect(key).toHaveFocus());
    expect(key).toHaveAttribute("aria-invalid", "true"); expect(key).toHaveValue("invalid-public-key");
    expect(screen.getByLabelText("应用 ID（App ID）")).toHaveValue("app-id-test");
    expect(view.router.state.location.pathname).toBe("/settings/onboarding/provider");
    fireEvent.change(key, { target: { value: "corrected-draft" } }); expect(key).not.toHaveAttribute("aria-invalid");
  });
});

function orderRequests(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/orders")) return json({ data: [{ ...order, product_name: url.searchParams.has("cursor") ? "第二页订单" : "第一页订单" }], page: { next_cursor: url.searchParams.has("cursor") ? null : "opaque-next-cursor" } });
  if (url.pathname.endsWith("/orders/" + orderId)) return json({ data: order });
  if (url.pathname.endsWith("/notifications")) return json({ data: [], page: { next_cursor: null } });
  return undefined;
}
describe("list navigation continuity", () => {
  it("clears both the filter and cursor when clearing filters on a later page", async () => {
    const view = mountOnboarding({ stage: 4, path: "/orders?payment=UNPAID&cursor=opaque-cursor&page=2&source=overview", handle: orderRequests });
    await screen.findByRole("link", { name: "第二页订单" });
    await userEvent.setup().click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByRole("link", { name: "第一页订单" })).toBeVisible();
    expect(view.router.state.location.search).toBe("?source=overview");
  });

  it.each(["page link", "browser back"])("restores page two and filters via %s", async (returnMethod) => {
    const view = mountOnboarding({ stage: 4, path: "/orders?payment=UNPAID&checkout=OPEN", handle: orderRequests });
    const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "下一页" }));
    await user.click(await screen.findByRole("link", { name: "第二页订单" }));
    await screen.findByRole("heading", { name: "订单详情" });
    if (returnMethod === "page link") await user.click(screen.getByRole("link", { name: "订单列表" }));
    else await act(async () => { await view.router.navigate(-1); });
    expect(await screen.findByRole("link", { name: "第二页订单" })).toBeVisible();
    expect(screen.getByText("第 2 页 · 本页 1 条")).toBeVisible();
    expect(screen.getByLabelText("付款状态筛选")).toHaveValue("UNPAID");
    expect(screen.getByLabelText("收银台状态筛选")).toHaveValue("OPEN");
    await user.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("link", { name: "第一页订单" })).toBeVisible();
  });
  it("restores a directly opened cursor and does not invent an unknown previous cursor", async () => {
    mountOnboarding({ stage: 4, path: "/orders?payment=UNPAID&cursor=opaque-cursor&page=4", handle: orderRequests });
    expect(await screen.findByRole("link", { name: "第二页订单" })).toBeVisible();
    expect(screen.getByText("第 4 页 · 本页 1 条")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "返回首页" }));
    expect(await screen.findByRole("link", { name: "第一页订单" })).toBeVisible();
    expect(screen.getByLabelText("付款状态筛选")).toHaveValue("UNPAID");
  });
});
