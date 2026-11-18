import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type OrderWebhookDeliveryDetail, type WebhookAttempt } from "../src/api/client";
import NotificationDetail from "../src/pages/NotificationDetail";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
import { DeliveryAttempts } from "../src/components/detail/DeliveryAttempts";
import { WorkspaceProvider } from "../src/workspace";
import { delivery, deliveryId, failedAttempt, paidOrder } from "./detail-fixtures";
import { apiError, json } from "./fixtures";
import { recordAction } from "./menu-helper";
import { mobileMedia } from "./mobile-media";

function mockDetail(attemptsUnavailable = false, orderUnavailable = false, detail: OrderWebhookDeliveryDetail = delivery) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sites/site_dense"))
      return json({ data: { client_id: "site_dense", name: "紧凑布局网站" } });
    if (path.endsWith("/attempts"))
      return attemptsUnavailable
        ? apiError("webhook_unavailable", "尝试记录读取失败", 503)
        : json({ data: detail.attempts });
    if (path.includes("/orders/"))
      return orderUnavailable
        ? apiError("order_unavailable", "关联订单读取失败", 503)
        : json({ data: paidOrder });
    return json({ data: detail });
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
const attemptReads = (requests: Request[]) => requests.filter(request => new URL(request.url).pathname.endsWith("/attempts"));
const orderReads = (requests: Request[]) => requests.filter(request => new URL(request.url).pathname.includes("/orders/"));

describe("readable standalone notification detail", () => {
  it("follows a resent delivery to its result and links both generations", async () => {
    const nextId = "33333333-3333-4333-8333-333333333333";
    let resent = false;
    const newDelivery = { ...delivery.delivery, delivery_id: nextId, predecessor_delivery_id: deliveryId, status: "ACKNOWLEDGED" as const };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        resent = true;
        return json({ data: { delivery: newDelivery, replayed: false } });
      }
      if (path.endsWith("/attempts")) return json({ data: [] });
      if (path.includes("/orders/")) return json({ data: paidOrder });
      return json({ data: { ...delivery, latest_delivery_id: resent ? nextId : deliveryId,
        is_latest: !resent || path.endsWith(nextId),
        delivery: path.endsWith(nextId) ? newDelivery : { ...delivery.delivery, status: "DEAD_LETTER" },
      } });
    }));
    mountDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "重新发送" }));
    const dialog = await screen.findByRole("dialog", { name: "重新发送通知" });
    await user.type(within(dialog).getByRole("textbox", { name: "操作理由" }), "已修复业务接口并核对日志");
    await user.click(within(dialog).getByRole("button", { name: "确认重新发送" }));
    expect(await screen.findByText("通知已确认", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "查看原投递" }));
    const latest = await screen.findByRole("link", { name: "已重新发送，查看最新结果" });
    expect(latest).toHaveAttribute("href", "/notifications/" + nextId);
    // A delivery replaced by a resend is history: it offers no resend of its own.
    expect(within(screen.getByRole("group", { name: "通知状态" })).getByText("历史投递")).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
  });
  it.each([false, true])("shows the delivery, its attempts and the order together without duplicate reads (site=%s)", async (site) => {
    const requests = mockDetail();
    mountDetail(site);
    // The notification is titled by the event it reports.
    expect(await screen.findByRole("heading", { name: "收款已确认", level: 1 })).toBeVisible();
    const summary = screen.getByRole("group", { name: "通知状态" });
    expect(within(summary).getByText("等待自动重试")).toBeVisible();
    expect(within(summary).getByText("等待重试")).toBeVisible();
    expect(summary).toHaveTextContent("已尝试 1 次 · 下次重试 2026/09/06 08:02:00");
    expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.firstChild?.textContent)).toEqual(["投递信息", "投递尝试", "关联订单"]);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const information = screen.getByRole("region", { name: "投递信息" });
    const attempts = screen.getByRole("region", { name: /^投递尝试/ });
    const orderSection = screen.getByRole("region", { name: "关联订单" });
    expect(within(information).getByText(delivery.target.target_url)).toBeVisible();
    // The summary states the attempt count and the next attempt, so the fields do not repeat them.
    expect(within(information).queryByText("尝试次数", { selector: "dt" })).not.toBeInTheDocument();
    expect(within(information).queryByText("下次重试", { selector: "dt" })).not.toBeInTheDocument();
    // A site workspace has only one website, so it is not named again.
    if (site) expect(within(information).queryByText("业务网站", { selector: "dt" })).not.toBeInTheDocument();
    else expect(within(information).getByText("业务网站", { selector: "dt" })).toBeVisible();
    expect(screen.queryByText(deliveryId)).not.toBeInTheDocument();
    expect(document.querySelector('[data-record-notice="warning"]')).toHaveTextContent("请核对通知接收程序返回的确认回执");
    expect(screen.getAllByRole("button", { name: "更多操作，通知记录操作" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    const list = await within(attempts).findByRole("list", { name: "投递尝试" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).toHaveTextContent("第 1 次 · HTTP 200 · 对方的确认回执无效");
    expect(attempts.compareDocumentPosition(orderSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(orderSection).findByRole("heading", { name: paidOrder.product_name, level: 3 })).toBeVisible();
    expect(within(orderSection).getByRole("link", { name: "查看订单" })).toHaveAttribute("href", (site ? "/sites/site_dense" : "") + "/orders/" + paidOrder.order_id);
    expect(within(orderSection).getByText(paidOrder.merchant_order_no)).toBeVisible();
    expect(within(information).queryByRole("link", { name: "查看订单" })).not.toBeInTheDocument();
    expect(attemptReads(requests)).toHaveLength(1);
    expect(orderReads(requests)).toHaveLength(1);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    if (site) expect(requests.every((request) => new URL(request.url).pathname.startsWith("/api/admin/v1/sites/site_dense"))).toBe(true);
  });

  it.each([403, 404])("does not read attempts or an order when the delivery cannot be read (%s)", async status => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      return apiError(status === 403 ? "forbidden" : "not_found", "通知详情不可读取", status);
    }));
    mountDetail();
    expect(await screen.findByText("通知详情不可读取")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/admin/v1/webhooks/deliveries/" + deliveryId);
    expect(requests.some(request => /\/attempts$|\/orders\//.test(new URL(request.url).pathname))).toBe(false);
    expect(screen.queryByRole("region", { name: /^投递尝试/ })).not.toBeInTheDocument();
    // Until the delivery is read, the page keeps its general title.
    expect(screen.getByRole("heading", { name: "通知详情", level: 1 })).toBeVisible();
  });

  it("keeps an unavailable attempt read distinct from a delivery without attempts and retries it", async () => {
    const requests = mockDetail(true);
    mountDetail();
    const orderSection = await screen.findByRole("region", { name: "关联订单" });
    expect(await within(orderSection).findByRole("link", { name: "查看订单" })).toBeVisible();
    expect(within(screen.getByRole("region", { name: "投递信息" })).getByText(delivery.target.target_url)).toBeVisible();
    const attempts = screen.getByRole("region", { name: /^投递尝试/ });
    expect(await within(attempts).findByRole("alert")).toHaveTextContent("尝试记录读取失败");
    expect(within(attempts).queryByText("尚未开始投递")).not.toBeInTheDocument();
    expect(within(attempts).queryByRole("list")).not.toBeInTheDocument();
    expect(attempts).not.toHaveAttribute("data-section-empty");
    await userEvent.setup().click(within(attempts).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(attemptReads(requests)).toHaveLength(2));
  });

  it("retains the linked order error in its own section while delivery facts and attempts stay usable", async () => {
    const requests = mockDetail(false, true);
    mountDetail();
    const orderSection = await screen.findByRole("region", { name: "关联订单" });
    const error = await within(orderSection).findByRole("alert");
    expect(within(screen.getByRole("region", { name: "投递信息" })).getByText(delivery.target.target_url)).toBeVisible();
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(orderReads(requests)).toHaveLength(2));
    expect(await within(screen.getByRole("region", { name: /^投递尝试/ })).findByRole("list", { name: "投递尝试" })).toBeVisible();
  });

  it("copies the complete long notification address and keeps the resend reason visible", async () => {
    const user = userEvent.setup();
    const targetUrl = "https://business.example.invalid/notify?context=" + "x".repeat(240);
    mockDetail(false, false, {
      ...delivery,
      target: { ...delivery.target, target_url: targetUrl },
      delivery: { ...delivery.delivery, requested_by_type: "ADMIN", reason: "第一行理由\n第二行理由" },
    });
    mountDetail();
    const information = await screen.findByRole("region", { name: "投递信息" });
    const address = within(information).getByText(targetUrl);
    const reason = within(information).getByText("第一行理由 第二行理由");
    expect(address).toBeVisible();
    expect(reason).toBeVisible();
    // The reason keeps the line breaks it was written with.
    expect(reason.textContent).toBe("第一行理由\n第二行理由");
    expect(reason).toHaveClass("whitespace-pre-wrap");
    await user.click(within(information).getByRole("button", { name: "复制通知地址" }));
    expect(await navigator.clipboard.readText()).toBe(targetUrl);
  });

  it.each(["DEAD_LETTER", "ACKNOWLEDGED"] as const)("restores focus after cancelling resend from the %s action", async (status) => {
    mockDetail(false, false, { ...delivery, delivery: { ...delivery.delivery, status } });
    mountDetail();
    const user = userEvent.setup();
    // A stopped delivery offers the resend as its primary action; a confirmed one keeps it in the menu.
    const trigger = await screen.findByRole("button", { name: status === "DEAD_LETTER" ? "重新发送" : "更多操作，通知记录操作" });
    if (status === "ACKNOWLEDGED") expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    await user.click(status === "DEAD_LETTER" ? trigger : await recordAction("重新发送", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "重新发送通知" });
    expect(within(dialog).getByText(delivery.target.target_url)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认重新发送" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"] as const)("does not offer a resend on a superseded %s delivery", async (status) => {
    mockDetail(false, false, { ...delivery, is_latest: false, delivery: { ...delivery.delivery, status } });
    mountDetail();
    await screen.findByRole("region", { name: "投递信息" });
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    await recordAction("通知技术信息", "通知记录操作");
    expect(screen.queryByRole("menuitem", { name: "重新发送" })).not.toBeInTheDocument();
  });

  it("states when a delivery not yet attempted is scheduled, without advice on a failure that has not happened", async () => {
    mockDetail(false, false, { ...delivery, attempts: [], delivery: { ...delivery.delivery, status: "PENDING", attempt_count: 0, last_error_code: null } });
    mountDetail();
    const summary = await screen.findByRole("group", { name: "通知状态" });
    expect(within(summary).getByText("等待投递结果")).toBeVisible();
    expect(within(summary).getByText("等待投递")).toBeVisible();
    expect(summary).toHaveTextContent("已尝试 0 次 · 计划投递 2026/09/06 08:02:00");
    expect(document.querySelector("[data-record-notice]")).toBeNull();
  });

  it("marks the advice on a stopped delivery as the problem to handle", async () => {
    mockDetail(false, false, { ...delivery, delivery: { ...delivery.delivery, status: "DEAD_LETTER", next_attempt_at: null } });
    mountDetail();
    const summary = await screen.findByRole("group", { name: "通知状态" });
    expect(within(summary).getByText("已停止重试，需要处理")).toBeVisible();
    // Nothing further is scheduled, so the summary names no next attempt.
    expect(summary.querySelector("[data-record-summary-meta]")).toHaveTextContent(/^已尝试 1 次$/);
    const notice = document.querySelector<HTMLElement>('[data-record-notice="danger"]')!;
    expect(notice).toHaveTextContent("请核对通知接收程序返回的确认回执");
    expect(within(notice).getByRole("link", { name: "通知接入说明" })).toHaveAttribute("target", "_blank");
  });

  it("points a delivery ended by a revoked payment confirmation at its order instead of offering a resend", async () => {
    mockDetail(false, false, { ...delivery, redelivery_blocked_reason: "payment_confirmation_revoked", delivery: { ...delivery.delivery, status: "DEAD_LETTER", next_attempt_at: null } });
    mountDetail();
    const summary = await screen.findByRole("group", { name: "通知状态" });
    expect(within(summary).getByText("原付款确认已撤销，成功通知已终止")).toBeVisible();
    expect(within(summary).getByText("已终止")).toBeVisible();
    const notice = document.querySelector<HTMLElement>('[data-record-notice="warning"]')!;
    expect(notice).toHaveTextContent("重新确认收款后，系统会为新的确认事件生成通知");
    expect(within(notice).getByRole("link", { name: "查看订单当前状态" })).toHaveAttribute("href", "/orders/" + delivery.event.order_id);
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    await recordAction("通知技术信息", "通知记录操作");
    expect(screen.queryByRole("menuitem", { name: "重新发送" })).not.toBeInTheDocument();
  });

  it("keeps complete identifiers in copyable technical details", async () => {
    mockDetail();
    mountDetail();
    await screen.findByRole("region", { name: "投递信息" });
    expect(screen.queryByText(deliveryId)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await recordAction("通知技术信息", "通知记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "通知技术信息" });
    for (const [name, value] of [["网站编号", delivery.target.api_client_id], ["投递编号", deliveryId], ["事件编号", delivery.event.event_id], ["内部订单编号", delivery.event.order_id], ["通知目标编号", delivery.target.target_id]]) {
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

describe("readable delivery attempts", () => {
  it("recovers only the attempts after an unavailable read", async () => {
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
    const information = await screen.findByRole("region", { name: "投递信息" });
    const orderSection = screen.getByRole("region", { name: "关联订单" });
    expect(within(information).getByText(delivery.target.target_url)).toBeVisible();
    expect(await within(orderSection).findByRole("link", { name: "查看订单" })).toBeVisible();
    const attempts = screen.getByRole("region", { name: /^投递尝试/ });
    await within(attempts).findByRole("alert");
    unavailable = false;
    await userEvent.setup().click(within(attempts).getByRole("button", { name: "重试" }));
    expect(await within(attempts).findByRole("list", { name: "投递尝试" })).toBeVisible();
    expect(within(attempts).queryByRole("alert")).not.toBeInTheDocument();
    expect(orderReads(requests)).toHaveLength(1);
    expect(attemptReads(requests)).toHaveLength(2);
  });

  it.each([0, 1, 21])("lists %s attempts newest first, folding those beyond the latest ten, without mutating what was read", async (count) => {
    const attempts: WebhookAttempt[] = Array.from({ length: count }, (_, index) => ({
      ...failedAttempt, attempt_id: String(index + 1), attempt_number: index + 1,
      started_at: new Date(Date.parse(failedAttempt.started_at) + index * 1000).toISOString(),
    }));
    const original = structuredClone(attempts);
    mockDetail(false, false, { ...delivery, attempts, delivery: { ...delivery.delivery, attempt_count: count } });
    mountDetail();
    const section = await screen.findByRole("region", { name: /^投递尝试/ });
    const numbers = (list: HTMLElement) => within(list).getAllByRole("listitem").map(item => Number(/第 (\d+) 次/.exec(item.textContent!)![1]));
    if (count === 0) {
      // A delivery not yet attempted keeps the section to its title and one line.
      expect(await within(section).findByText("尚未开始投递")).toBeVisible();
      expect(section).toHaveAttribute("data-section-empty", "true");
      expect(within(section).queryByRole("list")).not.toBeInTheDocument();
    } else {
      const latest = await within(section).findByRole("list", { name: "投递尝试" });
      expect(numbers(latest)).toEqual(Array.from({ length: Math.min(count, 10) }, (_, index) => count - index));
      expect(section).toHaveAccessibleName(new RegExp("^投递尝试，共 ?" + count + " ?项$"));
      const earlier = within(section).queryByRole("button", { name: /^更早的尝试/ });
      if (count === 21) {
        expect(earlier).toHaveTextContent("更早的尝试11");
        await userEvent.setup().click(earlier!);
        expect(numbers(await within(section).findByRole("list", { name: "更早的尝试" }))).toEqual(Array.from({ length: 11 }, (_, index) => 11 - index));
      } else expect(earlier).not.toBeInTheDocument();
    }
    expect(attempts).toEqual(original);
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
