import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type WebhookAttempt } from "../src/api/client";
import { NotificationDetail } from "../src/pages/Notifications";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
import { DeliveryAttempts } from "../src/components/detail/DeliveryAttempts";
import { WorkspaceProvider } from "../src/workspace";
import { delivery, deliveryId, failedAttempt, paidOrder } from "./detail-fixtures";
import { apiError, json } from "./fixtures";
import { recordAction } from "./menu-helper";
import { mobileMedia } from "./mobile-media";

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

describe("readable standalone notification detail", () => {
  it.each([false, true])("separates the order, delivery information and history without duplicate reads (site=%s)", async (site) => {
    const requests = mockDetail();
    mountDetail(site);
    expect(await screen.findByRole("heading", { name: "通知详情", level: 1 })).toBeVisible();
    const orderCard = await screen.findByRole("group", { name: "关联订单" });
    const information = screen.getByRole("group", { name: "通知信息" });
    const history = screen.getByRole("group", { name: "投递历史" });
    const orderLink = await within(orderCard).findByRole("link", { name: paidOrder.product_name });
    expect(orderLink).toHaveAttribute("href", (site ? "/sites/site_dense" : "") + "/orders/" + paidOrder.order_id);
    expect(within(information).getByText("等待重试")).toBeVisible();
    expect(within(information).getByText("已尝试 1 次")).toBeVisible();
    expect(within(history).getByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "投递尝试（1）" })).not.toBeInTheDocument();
    expect(screen.queryByText(deliveryId)).not.toBeInTheDocument();
    expect(within(information).queryByRole("link", { name: paidOrder.product_name })).not.toBeInTheDocument();
    expect(within(information).getByRole("alert")).toHaveTextContent("通知投递建议");
    expect([...document.querySelectorAll("[data-detail-page] > [data-slot=card]")].map(card => card.getAttribute("aria-label"))).toEqual(["关联订单", "通知信息", "投递历史"]);
    expect([orderCard, information, history].every(card => card.getAttribute("data-size") === "default")).toBe(true);
    expect(information.querySelector(".record-list-meta,.record-list-title")).toBeNull();
    expect(information.querySelectorAll('[data-detail-fields][data-layout="flow"]')).toHaveLength(1);
    expect(history.querySelector('[data-detail-fields][data-layout="flow"]')).toBeNull();
    expect(screen.getAllByRole("button", { name: "更多操作，通知记录操作" })).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url).pathname.includes("/orders/"))).toHaveLength(1);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    if (site) expect(requests.every((request) => new URL(request.url).pathname.startsWith("/api/admin/v1/sites/site_dense"))).toBe(true);
  });

  it("keeps an unavailable attempt read distinct from an empty history and retries it", async () => {
    const requests = mockDetail(true);
    mountDetail();
    expect(await screen.findByText("发送记录读取失败，请重试；这不代表没有发送过。")).toBeVisible();
    expect(screen.queryByText("暂无尝试明细")).not.toBeInTheDocument();
    const orderCard = screen.getByRole("group", { name: "关联订单" });
    const information = screen.getByRole("group", { name: "通知信息" });
    const history = screen.getByRole("group", { name: "投递历史" });
    expect(await within(orderCard).findByRole("link", { name: paidOrder.product_name })).toBeVisible();
    expect(within(information).getByText(delivery.target.target_url)).toBeVisible();
    expect(within(history).getByRole("alert")).toHaveTextContent("尝试记录读取失败");
    await userEvent.setup().click(within(history).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/attempts"))).toHaveLength(2));
  });

  it("retains the linked order error in its own card while delivery facts and history stay usable", async () => {
    const requests = mockDetail(false, true);
    mountDetail();
    const card = await screen.findByRole("group", { name: "关联订单" });
    const error = await within(card).findByRole("alert");
    expect(within(screen.getByRole("group", { name: "投递历史" })).getByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(within(screen.getByRole("group", { name: "通知信息" })).getByText(delivery.target.target_url)).toBeVisible();
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(requests.filter((request) => new URL(request.url).pathname.includes("/orders/"))).toHaveLength(2));
  });

  it("copies the complete long notification address and keeps the resend reason visible", async () => {
    const user = userEvent.setup();
    const targetUrl = "https://business.example.invalid/notify?context=" + "x".repeat(240);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeliveryCard density="comfortable" detail={{
            ...delivery,
            target: { ...delivery.target, target_url: targetUrl },
            delivery: { ...delivery.delivery, requested_by_type: "ADMIN", reason: "第一行理由\n第二行理由" },
          }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const information = screen.getByRole("group", { name: "通知信息" });
    const address = within(information).getByText(targetUrl);
    const reason = within(information).getByText("第一行理由 第二行理由");
    expect(address).toBeVisible();
    expect(reason).toBeVisible();
    expect(address.closest("dd")?.parentElement).toHaveAttribute("data-field-wide", "true");
    expect(reason.closest("dd")?.parentElement).toHaveAttribute("data-field-wide", "true");
    expect(reason.textContent).toBe("第一行理由\n第二行理由");
    await user.click(screen.getByRole("button", { name: "复制通知地址" }));
    expect(await navigator.clipboard.readText()).toBe(targetUrl);
  });

  it.each(["DEAD_LETTER", "ACKNOWLEDGED"] as const)("restores focus after cancelling resend from the readable %s action", async (status) => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeliveryCard density="comfortable" detail={{ ...delivery, delivery: { ...delivery.delivery, status } }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const trigger = status === "DEAD_LETTER"
      ? screen.getByRole("button", { name: "重新发送" })
      : screen.getByRole("button", { name: "更多操作，通知记录操作" });
    await user.click(status === "DEAD_LETTER" ? trigger : await recordAction("重新发送", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "重新发送通知" });
    expect(within(dialog).getByText(delivery.target.target_url)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认重新发送" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps complete identifiers in copyable technical details", async () => {
    mockDetail();
    mountDetail();
    await screen.findByRole("group", { name: "通知信息" });
    expect(screen.queryByText(deliveryId)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await recordAction("技术详情", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    for (const [name, value] of [["客户端 ID", delivery.target.api_client_id], ["投递编号", deliveryId], ["事件编号", delivery.event.event_id], ["内部订单编号", delivery.event.order_id], ["通知目标编号", delivery.target.target_id]]) {
      expect(within(dialog).getByText(value!, { exact: true })).toBeVisible();
      await user.click(within(dialog).getByRole("button", { name: "复制" + name }));
      expect(await navigator.clipboard.readText()).toBe(value);
    }
  });

  it.each([
    { embedded: false, density: undefined },
    { embedded: true, density: undefined },
    { embedded: true, density: "comfortable" },
  ] as const)("keeps the existing evidence surface when flow is not opted in (embedded=$embedded, density=$density)", async ({ embedded, density }) => {
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DeliveryCard detail={delivery} embedded={embedded} {...(density ? { density } : {})} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const card = screen.getByRole("group", { name: "通知记录" });
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(container.querySelector('[data-detail-fields][data-layout="flow"]')).toBeNull();
    expect(within(card).getByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(within(card).getByText(delivery.target.target_url)).toBeVisible();
    expect(within(card).getByRole("button", { name: "更多操作，通知记录操作" }).closest('[data-slot="card-content"]')).not.toBeNull();
    await userEvent.setup().click(await recordAction("技术详情", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(dialog).getByText(delivery.delivery.delivery_id, { exact: true })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "复制内部订单编号" })).not.toBeInTheDocument();
  });
});

describe("readable delivery history", () => {
  it("recovers only the history card after an unavailable attempts read", async () => {
    let unavailable = true;
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/attempts")) return unavailable ? apiError("webhook_unavailable", "尝试记录读取失败", 503) : json({ data: delivery.attempts });
      if (path.includes("/orders/")) return json({ data: paidOrder });
      return json({ data: delivery });
    }));
    mountDetail();
    const information = await screen.findByRole("group", { name: "通知信息" });
    const orderCard = screen.getByRole("group", { name: "关联订单" });
    const history = screen.getByRole("group", { name: "投递历史" });
    await within(history).findByText("发送记录读取失败，请重试；这不代表没有发送过。");
    unavailable = false;
    await userEvent.setup().click(within(history).getByRole("button", { name: "重试" }));
    expect(await within(history).findByRole("table", { name: "投递尝试（1）" })).toBeVisible();
    expect(within(history).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(history).queryByText("发送记录读取失败，请重试；这不代表没有发送过。")).not.toBeInTheDocument();
    expect(within(information).getByText(delivery.target.target_url)).toBeVisible();
    expect(await within(orderCard).findByRole("link", { name: paidOrder.product_name })).toBeVisible();
    expect(requests.filter(request => new URL(request.url).pathname.includes("/orders/"))).toHaveLength(1);
    expect(requests.filter(request => new URL(request.url).pathname.endsWith("/attempts"))).toHaveLength(2);
  });

  it.each([0, 1, 21])("keeps %s attempts expanded, newest-first and paginated without mutating evidence", async (count) => {
    const attempts: WebhookAttempt[] = Array.from({ length: count }, (_, index) => ({
      ...failedAttempt, attempt_id: String(index + 1), attempt_number: index + 1,
      started_at: new Date(Date.parse(failedAttempt.started_at) + index * 1000).toISOString(),
    }));
    const original = structuredClone(attempts);
    render(<DeliveryAttempts attempts={attempts} available density="comfortable" />);
    const table = screen.getByRole("table", { name: `投递尝试（${count}）` });
    expect(table).not.toHaveClass("business-table");
    expect(screen.queryByRole("button", { name: `投递尝试（${count}）` })).not.toBeInTheDocument();
    if (count === 0) expect(within(table).getByText("暂无尝试明细")).toBeVisible();
    else expect(within(table).getAllByRole("row")[1]).toHaveTextContent("第 " + count + " 次");
    if (count === 21) {
      const user = userEvent.setup();
      const seen: number[] = [];
      for (let page = 1; page <= 3; page++) {
        seen.push(...within(table).getAllByRole("row").slice(1).map(row => Number(/第 (\d+) 次/.exec(row.textContent!)![1])));
        if (page < 3) await user.click(screen.getByRole("button", { name: "投递尝试下一页" }));
      }
      expect(seen).toEqual(Array.from({ length: 21 }, (_, index) => 21 - index));
      expect(screen.getByRole("button", { name: "投递尝试下一页" })).toBeDisabled();
    }
    expect(attempts).toEqual(original);
  });

  it("uses normal Item fields on mobile without hiding the HTTP result", () => {
    mobileMedia(390);
    const { rerender } = render(<DeliveryAttempts attempts={[failedAttempt]} available density="comfortable" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const item = screen.getByRole("listitem");
    expect(item).toHaveAttribute("data-size", "default");
    expect(within(item).getByText("开始时间", { exact: true })).toBeVisible();
    expect(within(item).getByText("HTTP / ACK", { exact: true })).toBeVisible();
    expect(item.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "flow");
    expect(within(item).getByText("HTTP / ACK", { exact: true }).closest("[data-field-wide]")).toHaveAttribute("data-field-wide", "true");
    expect(within(item).getByText(/HTTP 200 · 对方的确认回执无效/)).toBeVisible();
    expect(item.querySelector(".record-list-meta,.record-list-title,.business-summary-fields")).toBeNull();
    rerender(<DeliveryAttempts attempts={[failedAttempt]} available />);
    const existingSummary = screen.getByRole("listitem");
    expect(existingSummary).toHaveAttribute("data-size", "xs");
    expect(existingSummary.querySelector('[data-layout="flow"]')).toBeNull();
    expect(within(existingSummary).getByText(/HTTP 200 · 对方的确认回执无效/)).toBeVisible();
  });
});
