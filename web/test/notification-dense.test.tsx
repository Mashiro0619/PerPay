import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { NotificationDetail } from "../src/pages/Notifications";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
import { WorkspaceProvider } from "../src/workspace";
import { delivery, deliveryId, paidOrder } from "./detail-fixtures";
import { apiError, json } from "./fixtures";
import { recordAction } from "./menu-helper";

function mockDetail(attemptsUnavailable = false, orderUnavailable = false) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sites/site_dense"))
      return json({ data: { client_id: "site_dense", name: "紧凑布局网站" } });
    if (path.endsWith("/attempts"))
      return attemptsUnavailable
        ? apiError("webhook_unavailable", "尝试记录读取失败", 503)
        : json({ data: delivery.attempts });
    if (path.includes("/orders/"))
      return orderUnavailable
        ? apiError("order_unavailable", "关联订单读取失败", 503)
        : json({ data: paidOrder });
    return json({ data: delivery });
  }));
  return requests;
}

function mountDetail(site = false) {
  const base = site ? "/sites/site_dense" : "";
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[base + "/notifications/" + deliveryId]}>
        <WorkspaceProvider>
          <Routes>
            <Route path={base + "/notifications/:deliveryId"} element={<NotificationDetail />} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("compact standalone notification detail", () => {
  it.each([false, true])("keeps the linked order inside the notification and reads it once (site=%s)", async (site) => {
    const requests = mockDetail();
    mountDetail(site);
    expect(await screen.findByRole("heading", { name: "通知详情", level: 1 })).toBeVisible();
    const card = await screen.findByRole("group", { name: "通知记录" });
    const orderLink = await within(card).findByRole("link", { name: paidOrder.product_name });
    expect(orderLink).toHaveAttribute("href", (site ? "/sites/site_dense" : "") + "/orders/" + paidOrder.order_id);
    expect(within(card).getByText("等待重试")).toBeVisible();
    expect(within(card).getByText("已尝试 1 次")).toBeVisible();
    expect(within(card).getByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "投递尝试（1）" })).not.toBeInTheDocument();
    expect(screen.getByText(deliveryId)).toBeVisible();
    expect(within(card).queryByText(deliveryId)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "通知记录操作" })).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url).pathname.includes("/orders/"))).toHaveLength(1);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    if (site) expect(requests.every((request) => new URL(request.url).pathname.startsWith("/api/admin/v1/sites/site_dense"))).toBe(true);
  });

  it("keeps an unavailable attempt read distinct from an empty history and retries it", async () => {
    const requests = mockDetail(true);
    mountDetail();
    expect(await screen.findByText(/不能据此判断未曾投递/)).toBeVisible();
    expect(screen.queryByText("暂无尝试明细")).not.toBeInTheDocument();
    const card = screen.getByRole("group", { name: "通知记录" });
    expect(await within(card).findByRole("link", { name: paidOrder.product_name })).toBeVisible();
    expect(within(card).getByText(delivery.target.target_url)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/attempts"))).toHaveLength(2));
  });

  it("retains the linked order error and retry inside the compact card", async () => {
    const requests = mockDetail(false, true);
    mountDetail();
    const card = await screen.findByRole("group", { name: "通知记录" });
    const error = await within(card).findByRole("alert");
    expect(within(card).getByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(within(card).getByText(delivery.target.target_url)).toBeVisible();
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(requests.filter((request) => new URL(request.url).pathname.includes("/orders/"))).toHaveLength(2));
  });

  it("copies the complete long notification address and keeps the resend reason visible", async () => {
    const user = userEvent.setup();
    const targetUrl = "https://business.example.invalid/notify?context=" + "x".repeat(240);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeliveryCard density="dense" detail={{
            ...delivery,
            target: { ...delivery.target, target_url: targetUrl },
            delivery: { ...delivery.delivery, requested_by_type: "ADMIN", reason: "第一行理由\n第二行理由" },
          }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(targetUrl)).toBeVisible();
    expect(screen.getByText("第一行理由 第二行理由")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "复制通知地址" }));
    expect(await navigator.clipboard.readText()).toBe(targetUrl);
  });

  it.each(["DEAD_LETTER", "ACKNOWLEDGED"] as const)("restores focus after cancelling resend from the compact %s action", async (status) => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeliveryCard density="dense" detail={{ ...delivery, delivery: { ...delivery.delivery, status } }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const trigger = status === "DEAD_LETTER"
      ? screen.getByRole("button", { name: "重新发送" })
      : screen.getByRole("button", { name: "通知记录操作" });
    await user.click(status === "DEAD_LETTER" ? trigger : await recordAction("重新发送", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "重新发送通知" });
    expect(within(dialog).getByText(delivery.target.target_url)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认重新发送" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
