import { Toaster } from "../src/components/ui/toast";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type AdminOrderDetail,
  type OrderWebhookDeliveryDetail,
} from "../src/api/client";
import { RequestNoticeBanner } from "../src/components/request-notice-banner";
import { RequestNoticeProvider } from "../src/lib/request-notices";
import { OrderDetail } from "../src/pages/OrderDetail";
import NotificationDetail from "../src/pages/NotificationDetail";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { recordAction } from "./menu-helper";
import { apiError, json, ledgerId, order, orderId } from "./fixtures";
import {
  candidate,
  candidateId,
  delivery,
  detailLedger,
  financialException,
  matchId,
  operation,
  paidOrder,
  paymentMatch,
} from "./detail-fixtures";

function Location() {
  return <output aria-label="当前页面">{useLocation().pathname}</output>;
}
function mount(path = "/orders/" + orderId) {
  return render(
    <QueryClientProvider client={queryClient}><Toaster>
      <MemoryRouter initialEntries={[path]}>
        {/* As in a record drawer: one notice reports the reads the service could not answer. */}
        <RequestNoticeProvider>
          <RequestNoticeBanner showRuntimeLink={false} />
          <Routes>
            <Route path="/orders/:orderId" element={<OrderDetail />} />
            <Route path="/notifications/:deliveryId" element={<NotificationDetail />} />
            <Route
              path="/reconciliation/:kind/:resourceId"
              element={<EvidenceDetail />}
            />
          </Routes>
        </RequestNoticeProvider>
        <Location />
      </MemoryRouter>
    </Toaster></QueryClientProvider>,
  );
}
function mockData(
  initialOrder = paidOrder,
  initialDeliveries: OrderWebhookDeliveryDetail[] = [delivery],
  write?: (request: Request) => Promise<Response>,
) {
  const state = { order: initialOrder, deliveries: initialDeliveries };
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (request.method !== "GET") {
        if (write) return write(request);
        throw new Error("unexpected write");
      }
      if (url.pathname === "/api/admin/v1/orders/" + orderId)
        return json({ data: state.order });
      if (url.pathname.endsWith("/notifications/deliveries"))
        return json({ data: state.deliveries, page: { next_cursor: null } });
      const notification = state.deliveries.find(item => url.pathname === "/api/admin/v1/webhooks/deliveries/" + item.delivery.delivery_id ||
        url.pathname === "/api/admin/v1/webhooks/deliveries/" + item.delivery.delivery_id + "/attempts");
      if (notification) return url.pathname.endsWith("/attempts")
        ? json({ data: notification.attempts }) : json({ data: notification });
      if (url.pathname.endsWith("/matches/" + matchId))
        return json({
          data: state.order.reconciliation.matches[0] ?? paymentMatch,
        });
      if (url.pathname.endsWith("/candidates/" + candidateId))
        return json({ data: candidate });
      if (url.pathname.endsWith("/ledger-entries/" + ledgerId))
        return json({ data: detailLedger });
      throw new Error("unexpected GET " + url.pathname);
    }),
  );
  return { state, requests };
}
const section = (id: string) => document.querySelector<HTMLElement>('[data-detail-section="' + id + '"]')!;
const shown = (element: Element) => element.closest("[hidden]") === null;
async function confirmReason(
  user: ReturnType<typeof userEvent.setup>,
  reason: string,
  action: string,
) {
  const dialog = screen.getByRole("dialog");
  await user.type(within(dialog).getByLabelText(/^操作理由(?:（可选）)?$/), reason);
  expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: action }));
}

describe("order detail work surface", () => {
  it("says that delivery has not started instead of listing attempts, and does not repeat event descriptions", async () => {
    mockData(paidOrder, [
      {
        ...delivery,
        attempts: [],
        delivery: {
          ...delivery.delivery,
          status: "PENDING",
          attempt_count: 0,
          last_error_code: null,
        },
      },
    ]);
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    expect(await screen.findByText(/尚未开始发送/)).toBeVisible();
    expect(within(section("notifications")).queryByRole("list")).not.toBeInTheDocument();
    expect(within(section("notifications")).getAllByText("待发送")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: /发送记录/ }),
    ).not.toBeInTheDocument();
    const timeline = within(section("history")).getByRole("list", { name: "订单动态" });
    expect(within(timeline).getByText("订单已创建")).toBeVisible();
    expect(within(timeline).getByText("PerPay 按金额和付款时间推断")).toBeVisible();
    expect(
      within(timeline).queryByText("已生成订单及付款窗口。"),
    ).not.toBeInTheDocument();
  });
  it("shows every order section on first load and reads notifications once without refetching embedded evidence", async () => {
    const { requests } = mockData();
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    expect(
      await screen.findByRole("heading", {
        name: order.product_name,
        level: 1,
      }),
    ).toBeVisible();
    expect(await screen.findByText(/HTTP 200 · 对方的确认回执无效/)).toBeVisible();
    const content = screen.getByRole("group", { name: "订单详情内容" });
    expect(Array.from(content.children).map(child => child.getAttribute("data-detail-section"))).toEqual(["overview", "payments", "notifications", "history"]);
    expect(within(content).getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["订单信息", "收款关联，共 1 项", "通知，共 1 项", "动态"]);
    expect(within(screen.getByRole("navigation", { name: "分区导航" })).getAllByRole("button").map(link => link.textContent)).toEqual(["订单信息", "收款关联，共 1 项", "通知，共 1 项", "动态"]);
    expect(section("payments")).toHaveAttribute("data-anchor-prefixes", "match- candidate- exception-");
    expect(screen.getAllByRole("heading", { name: "收款关联记录" })).toHaveLength(1);
    expect(document.getElementById("match-" + matchId)).toBe(screen.getByRole("heading", { name: "收款关联记录" }).closest("article"));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "概况" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "金额明细" })).not.toBeInTheDocument();
    const facts = within(screen.getByRole("region", { name: "订单信息" }));
    expect(facts.getByText("下单金额").parentElement).toHaveTextContent("¥1.00");
    expect(facts.getByText("加价金额").parentElement).toHaveTextContent("¥0.01");
    expect(requests).toHaveLength(2);
    expect(screen.getByText(detailLedger.provider_order_no!)).toBeVisible();
    expect(screen.getByText("测试买家")).toBeVisible();
    expect(screen.getByText("测试交易备注")).toBeVisible();
    // The facts used to check the payment are in view; the remaining evidence is one step away.
    const fields = (root: Element) => Array.from(root.querySelectorAll("[data-detail-fields] > dl > div")).filter(shown).map(row => row.querySelector("dt")!.textContent);
    expect(fields(document.getElementById("match-" + matchId)!)).toEqual(["支付宝交易金额", "支付宝交易时间", "交易对方", "支付宝订单号", "支付宝备注"]);
    expect(screen.getByText("金额占用时间")).not.toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /^更多流水与匹配信息/ }));
    expect(screen.getByText("金额占用时间")).toBeVisible();
    expect(screen.getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "匹配依据" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/按金额和付款时间推断，不是平台按订单号确认/),
    ).not.toBeInTheDocument();
    expect(await recordAction("标记已退款")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByText("历史退款（只读）")).not.toBeInTheDocument();
    expect(screen.queryByText("无备注")).not.toBeInTheDocument();
    expect(screen.queryByText("撤销时间")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "列表分页" }),
    ).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(
      requests.some((request) =>
        /\/reconciliation\/|\/webhooks\/deliveries/.test(
          new URL(request.url).pathname,
        ),
      ),
    ).toBe(false);
    const user = userEvent.setup();
    expect(await screen.findByText(/HTTP 200 · 对方的确认回执无效/)).toBeVisible();
    expect(within(screen.getByRole("list", { name: "发送记录（1）" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // The delivery states its result once, in its badge.
    expect(within(section("notifications")).getAllByText("等待重试")).toHaveLength(1);
    // One menu holds every record's technical data; the content has no tool rows of its own.
    expect(content.querySelector("[data-record-tools], [data-technical-information]")).toBeNull();
    expect(screen.queryByRole("button", { name: /技术信息|技术详情/ })).not.toBeInTheDocument();
    await recordAction("订单技术信息");
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["标记已退款", "订单技术信息", "收款关联技术信息", "通知技术信息"]);
    await user.click(await recordAction("通知技术信息"));
    expect(await screen.findByRole("dialog", { name: "通知技术信息" })).toHaveTextContent(delivery.delivery.delivery_id);
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/orders/" + orderId,
    );
    expect(requests).toHaveLength(2);
  });

  it.each(["OPEN", "EXPIRED", "CLOSED"] as const)(
    "keeps an unpaid %s checkout free of refund and empty history panels",
    async (status) => {
      mockData({ ...order, checkout: { ...order.checkout, status } }, []);
      mount();
      await screen.findByRole("heading", { name: "订单信息" });
      expect(await screen.findByText("此订单未设置通知地址")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "更多操作，订单操作" }));
      expect(
        screen.queryByRole("menuitem", { name: "标记已退款" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "管理员退款标记" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("navigation", { name: "列表分页" }),
      ).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(await screen.findByRole("region", { name: "收款关联" })).toHaveAttribute("data-section-empty", "true");
      expect(section("payments")).toHaveTextContent("尚未关联收款。");
      // The one filled action sits in the footer, after the outlined checkout link.
      expect(screen.getAllByRole("button", { name: "人工关联收款" })).toHaveLength(1);
      expect(Array.from(document.querySelectorAll("[data-record-primary-actions] > *")).map(action => action.textContent))
        .toEqual([status === "OPEN" ? "打开收银台" : "查看收银台结果", "人工关联收款"]);
    },
  );

  it("retains complete order text and every event while older activity stays expandable", async () => {
    const product = "跨平台桌面软件与移动设备长期授权，包含完整版本升级与离线使用支持";
    const note = "适用于两台个人设备。\n请在下载页获取完整安装包并保留此订单号。";
    const reason = "已核对完整交易凭据。\n记录本次人工确认的依据。";
    const merchant = "2026110316010000000001";
    const events: AdminOrderDetail["events"] = Array.from({ length: 8 }, (_, index) => ({
      event_id: "timeline-event-" + index,
      sequence: index + 1,
      event_type: index === 0 ? "CREATED" : "PAYMENT_CONFIRMED",
      occurred_at: new Date(Date.UTC(2026, 10, 3, 8, index)).toISOString(),
      details: index === 0 ? {} : { evidence_type: "MANUAL", financial_operation_id: operation.financial_operation_id },
    }));
    mockData({ ...paidOrder, product_name: product, merchant_order_no: merchant, note, events,
      reconciliation: { matches: [{ ...paymentMatch, evidence_type: "MANUAL", candidate: null,
        creation_operation: { ...operation, operation_type: "MANUAL_SETTLEMENT", actor_type: "ADMIN", actor_id: "管理员甲", reason },
        resolution_operation: null,
      }], exceptions: [] },
    }, []);
    mount();
    const facts = within(await screen.findByRole("region", { name: "订单信息" }));
    expect(facts.getByText(product)).toBeVisible();
    expect(facts.getByText(note, { normalizer: value => value })).toBeVisible();
    const user = userEvent.setup();
    await user.click(facts.getByRole("button", { name: "复制商户订单号" }));
    expect(await navigator.clipboard.readText()).toBe(merchant);
    const timeline = within(section("history"));
    const visibleTimes = () => timeline.getAllByRole("listitem").map(item => item.querySelector("time")?.getAttribute("datetime"));
    expect(visibleTimes()).toEqual(events.slice(2).reverse().map(event => event.occurred_at));
    // Older events stay in the document, collapsed, so each of the seven confirmations keeps its reason.
    const reasons = () => timeline.getAllByText("管理员甲：" + reason, { normalizer: value => value });
    expect(reasons()).toHaveLength(7);
    expect(reasons().filter(shown)).toHaveLength(6);
    expect(timeline.getByText("订单已创建")).not.toBeVisible();
    await user.click(timeline.getByRole("button", { name: /^更早动态，共 ?2 ?项$/ }));
    expect(visibleTimes()).toEqual([...events].reverse().map(event => event.occurred_at));
    expect(timeline.getByText("订单已创建")).toBeVisible();
    await user.click(timeline.getByRole("button", { name: /^更早动态，共 ?2 ?项$/ }));
    await waitFor(() => expect(visibleTimes()).toHaveLength(6));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("keeps ignored exceptions in expandable history and uses the embedded candidate and ledger", async () => {
    const { requests } = mockData({
      ...paidOrder,
      reconciliation: {
        matches: [paymentMatch],
        exceptions: [{ ...financialException, reminder_ignored: true }],
      },
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    expect(
      screen.queryByRole("heading", { name: "实收金额不符" }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    const historyTrigger = screen.getByRole("button", { name: /^异常历史，共 ?1 ?项$/ });
    expect(section("history")).toContainElement(historyTrigger);
    expect(historyTrigger).toHaveAttribute("aria-expanded", "false");
    await user.click(historyTrigger);
    expect(historyTrigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("heading", { name: "实收金额不符" }),
    ).toBeVisible();
    expect(screen.getByText("未处理 · 提醒已忽略")).toBeVisible();
    expect(screen.queryByText(/异常尚未解决/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "账务异常 · 1" }),
    ).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
    historyTrigger.focus();
    await user.keyboard("{Enter}");
    expect(historyTrigger).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(historyTrigger).toHaveAttribute("aria-expanded", "true");
  });

  it("shows live exceptions before collection evidence and separates financial state from reminder state", async () => {
    mockData({
      ...paidOrder,
      reconciliation: {
        matches: [paymentMatch],
        exceptions: [financialException],
      },
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const heading = await screen.findByRole("heading", {
      name: "实收金额不符",
    });
    expect(
      heading.compareDocumentPosition(
        screen.getByRole("heading", { name: "收款关联记录" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText(/支付宝交易金额 ¥1.02 与可能关联订单的应付 ¥1.01 不一致/),
    ).toBeVisible();
    expect(heading.closest("article")).toHaveAttribute("id", "exception-" + financialException.exception_id);
    // The notice names what needs checking and leads to it; it holds no action of its own.
    const notice = document.querySelector<HTMLElement>('[data-record-notice="warning"]')!;
    expect(notice).toHaveTextContent("实收金额不符");
    expect(notice.compareDocumentPosition(section("overview")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(notice).getAllByRole("button").map(button => button.textContent)).toEqual(["1 项待核对 ›"]);
    expect(within(screen.getByRole("navigation", { name: "分区导航" })).getAllByRole("button")[1]).toHaveTextContent("收款关联，共 2 项");
    await userEvent.setup().click(within(notice).getByRole("button"));
    expect(section("payments")).toHaveFocus();
  });

  it("shows manual actors and reversal reasons and never calls a settled timestamp a reversal", async () => {
    const creation = {
      ...operation,
      operation_type: "MANUAL_SETTLEMENT" as const,
      actor_type: "ADMIN" as const,
      actor_id: "管理员甲",
      reason: "对照交易号确认",
    };
    const reversal = {
      ...operation,
      operation_type: "REVERSE_SETTLEMENT" as const,
      actor_type: "ADMIN" as const,
      actor_id: "管理员乙",
      reason: "平台记录归属不符",
    };
    const reversed = {
      ...paymentMatch,
      evidence_type: "MANUAL" as const,
      status: "REVERSED" as const,
      candidate: null,
      creation_operation: creation,
      resolution_operation: reversal,
    };
    mockData({
      ...paidOrder,
      payment: { ...paidOrder.payment, status: "DISPUTED" },
      reconciliation: { matches: [reversed], exceptions: [] },
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    await userEvent.setup().click(screen.getByRole("button", { name: /^已撤销的收款关联，共 ?1 ?项$/ }));
    expect(await screen.findByText("撤销时间")).toBeVisible();
    expect(screen.getByText("平台记录归属不符")).toBeVisible();
    expect(screen.getByText("对照交易号确认")).toBeVisible();
    expect(screen.queryByRole("button", { name: "撤销收款关联" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作，收款关联记录操作" })).not.toBeInTheDocument();
  });

  it("reverses an association without navigation and refreshes the current order", async () => {
    const { state, requests } = mockData(paidOrder, [], async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/api/admin/v1/reconciliation/matches/" + matchId + "/actions/reverse",
      );
      state.order = {
        ...paidOrder,
        payment: { ...paidOrder.payment, status: "DISPUTED" },
        reconciliation: {
          matches: [
            {
              ...paymentMatch,
              status: "REVERSED",
              resolution_operation: {
                ...operation,
                operation_type: "REVERSE_SETTLEMENT",
                reason: "测试撤销原因",
              },
            },
          ],
          exceptions: [],
        },
      };
      return json({ data: {} });
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const user = userEvent.setup();
    // The association's only action is shown directly on its record.
    await user.click(within(document.getElementById("match-" + matchId)!).getByRole("button", { name: "撤销收款关联" }));
    await confirmReason(user, "测试撤销原因", "确认撤销关联");
    await user.click(await screen.findByRole("button", { name: /^已撤销的收款关联，共 ?1 ?项$/ }));
    expect(await screen.findByText("测试撤销原因")).toBeVisible();
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/orders/" + orderId,
    );
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          new URL(request.url).pathname === "/api/admin/v1/orders/" + orderId,
      ).length,
    ).toBeGreaterThan(1);
  });

  it("reuses a redelivery operation UUID on retry and opens the resulting delivery", async () => {
    const bodies: unknown[] = [];
    const newDeliveryId = "99999999-9999-4999-8999-999999999999";
    const terminal = {
      ...delivery,
      delivery: { ...delivery.delivery, status: "DEAD_LETTER" as const },
    };
    const { state } = mockData(paidOrder, [terminal], async (request) => {
      bodies.push(await request.json());
      if (bodies.length === 1) return apiError("internal_error", "lost response", 500);
      const successor: OrderWebhookDeliveryDetail = {
        ...delivery, attempts: [],
        delivery: { ...delivery.delivery, delivery_id: newDeliveryId, predecessor_delivery_id: terminal.delivery.delivery_id,
          generation: 2, status: "PENDING", attempt_count: 0, last_error_code: null },
      };
      state.deliveries = [successor, { ...terminal, is_latest: false }];
      return json({ data: successor });
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const user = userEvent.setup();
    await user.click(await within(section("notifications")).findByRole("button", { name: "重新发送" }));
    await confirmReason(user, "业务已修复", "确认重新发送");
    await screen.findByText("操作结果待确认");
    await user.click(screen.getByRole("button", { name: "响应详情" }));
    await screen.findByText(/服务处理失败/);
    await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
    expect(await screen.findByText(/已创建新通知，等待发送/)).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    // The new delivery opens in its own detail, titled by the event it reports.
    expect(await screen.findByRole("group", { name: "通知状态" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "收款已确认", level: 1 })).toBeVisible();
    expect(screen.getByLabelText("当前页面")).toHaveTextContent("/notifications/" + newDeliveryId);
    expect(await screen.findByText("待发送", { exact: true })).toBeVisible();
    expect(screen.getByRole("link", { name: "查看原通知" })).toHaveAttribute("href", "/notifications/" + terminal.delivery.delivery_id);
  });

  it("retries a waiting order delivery immediately without leaving the order", async () => {
    let retried = false;
    const { state } = mockData(paidOrder, [delivery], async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/webhooks/deliveries/" + delivery.delivery.delivery_id + "/actions/retry");
      expect(await request.json()).toEqual({});
      retried = true;
      state.deliveries = [{ ...delivery, delivery: { ...delivery.delivery, status: "LEASED", attempt_count: 2 } }];
      return json({ data: { delivery: state.deliveries[0]!.delivery } }, 202);
    });
    mount();
    const notifications = await screen.findByRole("region", { name: /^通知/ });
    const retry = await within(notifications).findByRole("button", { name: "立即重试" });
    await userEvent.setup().click(retry);
    expect(await screen.findByText("已发起立即重试")).toBeVisible();
    expect(retried).toBe(true);
    await waitFor(() => {
      expect(within(section("notifications")).queryByRole("button", { name: "立即重试" })).not.toBeInTheDocument();
    });
    expect(within(section("notifications")).getByText("发送中")).toBeVisible();
    expect(screen.getByLabelText("当前页面")).toHaveTextContent("/orders/" + orderId);
  });

  it.each([
    "PENDING",
    "LEASED",
    "RETRY_WAIT",
    "ACKNOWLEDGED",
    "DEAD_LETTER",
  ] as const)(
    "does not offer redelivery or retry on a superseded %s record",
    async (status) => {
      mockData(paidOrder, [{ ...delivery, is_latest: false, delivery: { ...delivery.delivery, status } }]);
      mount();
      await screen.findByRole("heading", { name: "订单信息" });
      // A delivery replaced by a resend is folded into the section's history.
      await userEvent.setup().click(await within(section("notifications")).findByRole("button", { name: /^历史通知/ }));
      expect(await within(section("notifications")).findByRole("link", { name: "查看详情" })).toBeVisible();
      expect(within(section("notifications")).queryByRole("button", { name: "立即重试" })).not.toBeInTheDocument();
      expect(within(section("notifications")).queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
      expect(within(section("notifications")).queryByRole("button", { name: "更多操作，通知记录操作" })).not.toBeInTheDocument();
    },
  );

  it("keeps order evidence usable when notification reads fail and refresh retries secondary data", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.url.endsWith("/" + orderId))
          return json({ data: paidOrder });
        attempts += 1;
        return apiError("webhook_unavailable", "temporary", 503);
      }),
    );
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    expect(
      await screen.findByText(detailLedger.provider_order_no!),
    ).toBeVisible();
    // The page's notice reports the failure; the section says which part is missing, so it never ends blank.
    const notice = await screen.findByRole("alert", { name: "服务连接提示" });
    expect(within(section("notifications")).getByText("通知结果读取失败，请刷新重试。")).toBeVisible();
    expect(within(section("notifications")).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("此订单未设置通知地址")).not.toBeInTheDocument();
    const user = userEvent.setup();
    let before = attempts;
    await user.click(within(notice).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(attempts).toBeGreaterThan(before));
    before = attempts;
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(attempts).toBeGreaterThan(before));
    expect(within(section("notifications")).getByText("通知结果读取失败，请刷新重试。")).toBeVisible();
  });

  it("opens a candidate in place with readable order and ledger facts and locks known association IDs", async () => {
    const openOrder: AdminOrderDetail = {
      ...order,
      reconciliation: { matches: [], exceptions: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/candidates/" + candidateId))
          return json({ data: { ...candidate, status: "ELIGIBLE" } });
        if (path.endsWith("/orders/" + orderId))
          return json({ data: openOrder });
        if (path.endsWith("/ledger-entries/" + ledgerId))
          return json({ data: { ...detailLedger, state: "UNALLOCATED" } });
        throw new Error("unexpected request");
      }),
    );
    mount("/reconciliation/candidates/" + candidateId);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "人工关联收款" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).queryByLabelText("内部订单编号"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("收入流水编号"),
    ).not.toBeInTheDocument();
    expect(await within(dialog).findByText("应付金额", { selector: "dt" })).toBeVisible();
    expect(within(dialog).getByText("交易金额", { selector: "dt" })).toBeVisible();
    expect(
      within(dialog).queryByText("请核对这笔关联"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "确认关联收款" }),
    ).toBeEnabled();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/reconciliation/candidates/" + candidateId,
    );
  });
  it("loads only the selected notification page and keeps historical redelivery disabled", async () => {
    const requests: Request[] = [];
    const old = {
      ...delivery,
      is_latest: false,
      delivery: {
        ...delivery.delivery,
        status: "ACKNOWLEDGED",
        delivery_id: "old-delivery",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request.clone());
        const url = new URL(request.url);
        if (url.pathname.endsWith("/" + orderId))
          return json({ data: paidOrder });
        return json({
          data: url.searchParams.has("cursor") ? [old] : [delivery],
          page: {
            next_cursor: url.searchParams.has("cursor")
              ? null
              : "next-delivery-page",
          },
        });
      }),
    );
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const user = userEvent.setup();
    await screen.findByText(/HTTP 200/);
    expect(requests).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    // A delivery replaced by a resend is history: collapsed, and never offered for another resend.
    const superseded = await screen.findByRole("button", { name: /^历史通知/ });
    expect(superseded).toHaveAttribute("aria-expanded", "false");
    await user.click(superseded);
    expect(await within(section("notifications")).findByRole("link", { name: "查看详情" })).toHaveAttribute("href", "/notifications/old-delivery");
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作，通知记录操作" })).not.toBeInTheDocument();
    expect(requests).toHaveLength(3);
    expect(new URL(requests[2]!.url).searchParams.get("cursor")).toBe(
      "next-delivery-page",
    );
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/orders/" + orderId,
    );
  });

  it("saves a refund declaration from the order without financial changes or navigation", async () => {
    const { state, requests } = mockData(paidOrder, [], async (request) => {
      const body = await request.json();
      expect(request.method).toBe("PUT");
      expect(body).toEqual({
        operation_id: expect.any(String),
        version: 0,
        marked: true,
        note: "外部退款已完成",
      });
      const mark = {
        marked: true,
        version: 1,
        note: body.note,
        updated_at: operation.created_at,
        updated_by: "admin",
      };
      state.order = {
        ...paidOrder,
        refund_mark: mark,
        refund_mark_history: [{ ...mark, operation_id: body.operation_id }],
      };
      return json({
        data: { operation_id: body.operation_id, refund_mark: mark },
      });
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "更多操作，订单操作" });
    await user.click(await recordAction("标记已退款"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(
      /PerPay 不会发起或验证实际退款/,
    );
    await user.type(
      within(dialog).getByLabelText("备注（可选）"),
      "外部退款已完成",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "确认标记已退款" }),
    );
    const refund = await screen.findByRole("region", { name: "管理员退款标记" });
    expect(within(refund).getByText("已标记退款")).toBeVisible();
    expect(within(screen.getByRole("group", { name: "收款状态" })).getByText("已标记退款")).toBeVisible();
    expect(await recordAction("撤销退款标记")).toBeVisible();
    expect(state.order.payment).toEqual(paidOrder.payment);
    expect(state.order.received_amount_cents).toBe(
      paidOrder.received_amount_cents,
    );
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(
      1,
    );
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/orders/" + orderId,
    );
  });

  it("rechecks known association facts and blocks confirmation if the order has since been paid", async () => {
    let orderReads = 0;
    const writes: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method !== "GET") writes.push(request);
        if (request.url.endsWith("/candidates/" + candidateId))
          return json({ data: { ...candidate, status: "ELIGIBLE" } });
        if (request.url.endsWith("/ledger-entries/" + ledgerId))
          return json({ data: { ...detailLedger, state: "UNALLOCATED" } });
        orderReads += 1;
        return json({ data: orderReads === 1 ? order : paidOrder });
      }),
    );
    mount("/reconciliation/candidates/" + candidateId);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "人工关联收款" }));
    expect(await screen.findByText(/订单或流水状态已变化/)).toBeVisible();
    expect(screen.getByRole("button", { name: "确认关联收款" })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  it("refreshes both the order and notification result with the page refresh action", async () => {
    const { requests } = mockData();
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const user = userEvent.setup();
    await screen.findByText(/HTTP 200/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(
      requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/" + orderId),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.url.includes("/notifications/deliveries"),
      ),
    ).toHaveLength(2);
  });
});


describe("order record layout", () => {
  const footerActions = () => Array.from(document.querySelectorAll("[data-record-primary-actions] > *")).map(action => action.textContent);
  const reversedMatch = { ...paymentMatch, status: "REVERSED" as const,
    resolution_operation: { ...operation, operation_type: "REVERSE_SETTLEMENT" as const, reason: "平台记录归属不符" } };

  it.each([
    { name: "a confirmed order", data: paidOrder, value: "¥1.01", difference: null, actions: ["查看收银台结果"] },
    { name: "an overpaid order", data: { ...paidOrder, received_amount_cents: 103 }, value: "¥1.03", difference: "多收 ¥0.02", actions: ["查看收银台结果"] },
    { name: "an underpaid order", data: { ...paidOrder, received_amount_cents: 99 }, value: "¥0.99", difference: "少收 ¥0.02", actions: ["查看收银台结果"] },
    { name: "an unpaid order", data: order, value: "¥1.01", difference: null, actions: ["打开收银台", "人工关联收款"] },
  ])("leads the summary of $name with $value and keeps at most one filled action", async ({ data, value, difference, actions }) => {
    mockData(data, []);
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const summary = screen.getByRole("group", { name: "收款状态" });
    expect(summary.querySelector("[data-record-summary-value]")).toHaveTextContent(value);
    if (difference) {
      expect(within(summary).getByText("实收金额")).toBeVisible();
      expect(within(summary).getByText(/应付/).parentElement).toHaveTextContent("应付 ¥1.01（" + difference + "）");
    } else if (data.received_amount_cents) {
      expect(within(summary).queryByText("应付")).not.toBeInTheDocument();
      expect(within(summary).queryByText("实收")).not.toBeInTheDocument();
    } else {
      expect(within(summary).getByText("应付金额")).toBeVisible();
      expect(within(summary).queryByText("实收")).not.toBeInTheDocument();
    }
    expect(summary.querySelector("[data-amount-difference]")?.textContent ?? null).toBe(difference && "（" + difference + "）");
    expect(summary).toHaveTextContent("创建于 ");
    expect(summary.querySelector("time")).toHaveAttribute("datetime", data.created_at);
    // The summary is not repeated in the scrolling content.
    expect(screen.getByRole("group", { name: "订单详情内容" })).not.toContainElement(summary);
    expect(footerActions()).toEqual(actions);
    expect(document.querySelector("[data-record-notice]")).toBeNull();
  });

  it("gives a disputed order its two decisions in the footer and explains them without buttons", async () => {
    const released = { ...reversedMatch, ledger_entry: { ...detailLedger, state: "UNALLOCATED" as const } };
    const disputed: AdminOrderDetail = { ...paidOrder, payment: { ...paidOrder.payment, status: "DISPUTED" },
      reconciliation: { matches: [released], exceptions: [] } };
    const { state } = mockData(disputed, [], async request => {
      const body = await request.json();
      const mark = { marked: true, version: 1, note: null, updated_at: operation.created_at, updated_by: "admin" };
      state.order = { ...disputed, refund_mark: mark, refund_mark_history: [{ ...mark, operation_id: body.operation_id }] };
      return json({ data: { operation_id: body.operation_id, refund_mark: mark } });
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    const notice = document.querySelector<HTMLElement>('[data-record-notice="danger"]')!;
    expect(notice).toHaveTextContent("原收款关联已撤销，请核对付款人、交易凭证和金额；确认属于本订单后重新关联收款。");
    expect(notice).toHaveTextContent(/确认属于本订单后重新关联收款/);
    expect(within(notice).queryByRole("button")).not.toBeInTheDocument();
    expect(footerActions()).toEqual(["标记已退款", "重新核对并确认收款"]);
    expect(screen.getAllByRole("button", { name: "重新核对并确认收款" })).toHaveLength(1);
    // The checkout link gives way to the refund decision and moves into the menu.
    expect(screen.queryByRole("link", { name: "查看收银台结果" })).not.toBeInTheDocument();
    expect(await recordAction("查看收银台结果")).toHaveAttribute("target", "_blank");
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["查看收银台结果", "订单技术信息", "收款关联技术信息"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // A reversed association whose entry is free again is in view, with the way to move it.
    const association = document.getElementById("match-" + matchId)!;
    expect(association).toBeVisible();
    expect(within(association).getByRole("button", { name: "将原流水关联到正确订单" })).toBeVisible();
    expect(screen.getByText("原流水属于其他订单时，选择正确订单继续处理：")).toBeVisible();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "标记已退款" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认标记已退款" }));
    expect(await screen.findByText("本次退款标记已保存")).toBeVisible();
    // With the refund on record nothing is left to decide: no filled action, and the mark can be withdrawn from the menu.
    await waitFor(() => expect(footerActions()).toEqual(["查看收银台结果"]));
    expect(document.querySelector('[data-record-notice="danger"]')).toHaveTextContent(/已标记退款/);
    expect(screen.queryByRole("button", { name: "将原流水关联到正确订单" })).not.toBeInTheDocument();
    expect(await recordAction("撤销退款标记")).toBeVisible();
  });

  it("keeps the footer reconfirmation unique while labeling an exception's specific ledger shortcut", async () => {
    const released = { ...reversedMatch, ledger_entry: { ...detailLedger, state: "UNALLOCATED" as const } };
    const withEntry = { ...financialException, exception_id: "exc-with-entry", ledger_entry_id: released.ledger_entry_id, candidate_id: null };
    const withoutEntry = { ...financialException, exception_id: "exc-no-entry", ledger_entry_id: null, candidate_id: null };
    mockData({
      ...paidOrder,
      payment: { ...paidOrder.payment, status: "DISPUTED" },
      reconciliation: { matches: [released], exceptions: [withEntry, withoutEntry] },
    }, []);
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    expect(screen.getAllByRole("button", { name: "重新核对并确认收款" })).toHaveLength(1);
    expect(within(document.getElementById("exception-exc-with-entry")!).getByRole("button", { name: "用此流水重新确认" })).toBeVisible();
    expect(within(document.getElementById("exception-exc-no-entry")!).queryByRole("button", { name: /重新确认|人工关联/ })).not.toBeInTheDocument();
  });

  it.each([
    { name: "a reversed association inside collapsed history", hash: "#match-" + matchId, target: () => document.getElementById("match-" + matchId), exact: true },
    { name: "an ignored exception inside collapsed history", hash: "#exception-" + financialException.exception_id, target: () => document.getElementById("exception-" + financialException.exception_id), exact: true },
    { name: "the match candidate inside collapsed evidence", hash: "#candidate-" + candidateId, target: () => document.getElementById("candidate-" + candidateId), exact: true },
    { name: "an unknown candidate, by its section", hash: "#candidate-unknown", target: () => section("payments"), exact: false },
    { name: "a requested section", hash: "?section=history", target: () => section("history"), exact: false },
  ])("opens a deep link to $name", async ({ hash, target, exact }) => {
    mockData({ ...paidOrder, payment: { ...paidOrder.payment, status: "DISPUTED" },
      reconciliation: { matches: [reversedMatch], exceptions: [{ ...financialException, reminder_ignored: true }] } });
    mount("/orders/" + orderId + hash);
    await screen.findByRole("heading", { name: "订单信息" });
    await waitFor(() => expect(target()).toHaveFocus());
    expect(target()).toBeVisible();
    expect(document.querySelectorAll("[data-anchor-hit]")).toHaveLength(exact ? 1 : 0);
    if (exact) expect(target()).toHaveAttribute("data-anchor-hit");
    // Only the history that holds the destination is opened.
    const collapsed = screen.getAllByRole("button", { expanded: false }).map(button => button.textContent);
    expect(collapsed.some(name => name!.startsWith("已撤销的收款关联"))).toBe(!hash.startsWith("#match-") && hash !== "#candidate-" + candidateId);
    expect(collapsed.some(name => name!.startsWith("异常历史"))).toBe(!hash.startsWith("#exception-"));
  });

  it("tells records of the same kind apart in the single technical menu", async () => {
    const second = { ...reversedMatch, payment_match_id: "33333333-3333-4333-8333-333333333334", created_at: "2026-09-06T00:05:00.000Z" };
    mockData({ ...paidOrder, reconciliation: { matches: [paymentMatch, second], exceptions: [] } }, []);
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    await recordAction("订单技术信息");
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual([
      "标记已退款", "订单技术信息", "收款关联技术信息 · 2026/09/06 08:01:02", "收款关联技术信息 · 2026/09/06 08:05:00",
    ]);
    await userEvent.setup().click(screen.getByRole("menuitem", { name: /^收款关联技术信息 · 2026\/09\/06 08:05:00$/ }));
    const technical = await screen.findByRole("dialog", { name: "收款关联技术信息" });
    expect(technical).toHaveTextContent(second.payment_match_id);
    expect(technical).not.toHaveTextContent(matchId);
  });
});

describe("payment provenance", () => {
  it.each(["INFERRED", "MANUAL", "NONE"] as const)("explains %s without attributing administrator decisions to Alipay", async (basis) => {
    const match = { ...paymentMatch, evidence_type: basis === "MANUAL" ? "MANUAL" as const : "AMOUNT_INFERRED" as const,
      candidate: basis === "MANUAL" ? null : paymentMatch.candidate };
    mockData({ ...paidOrder, note: "业务网站传入的备注",
      payment: { ...paidOrder.payment, status: basis === "NONE" ? "UNPAID" : "CONFIRMED", basis },
      reconciliation: { ...paidOrder.reconciliation, matches: basis === "NONE" ? [] : [match] },
    });
    mount();
    await screen.findByRole("heading", { name: "订单信息" });
    await screen.findByRole("button", { name: "更多操作，订单操作" });
    const currentPayment = within(screen.getByRole("group", { name: "收款状态" }));
    const inferred = currentPayment.queryAllByText(/PerPay 按金额和付款时间推断/);
    const manual = currentPayment.queryAllByText(/管理员人工关联/);
    expect(inferred.length > 0).toBe(basis === "INFERRED");
    expect(manual.length > 0).toBe(basis === "MANUAL");
    expect(within(screen.getByRole("region", { name: "订单信息" })).getByText("加价金额").parentElement).toHaveTextContent("¥0.01");
    expect(within(screen.getByRole("region", { name: "订单信息" })).getByText("业务网站传入的备注")).toBeVisible();
    expect(screen.queryByText(/数据截至/)).not.toBeInTheDocument();
  });

  it("surfaces a top notice and primary footer action on paid orders with an actionable failed notification", async () => {
    let retried = false;
    const { state } = mockData(paidOrder, [delivery], async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/webhooks/deliveries/" + delivery.delivery.delivery_id + "/actions/retry");
      retried = true;
      state.deliveries = [{ ...delivery, delivery: { ...delivery.delivery, status: "LEASED", attempt_count: 2 } }];
      return json({ data: { delivery: state.deliveries[0]!.delivery } }, 202);
    });
    mount();
    expect(await screen.findByText(/该订单付款通知暂未确认，当前等待自动重试/)).toBeVisible();
    const footerAction = await screen.findByRole("button", { name: "立即重试通知" });
    await userEvent.setup().click(footerAction);
    expect(await screen.findByText("已发起立即重试")).toBeVisible();
    expect(retried).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "立即重试通知" })).not.toBeInTheDocument();
    });
  });

  it("surfaces a danger notice and primary redelivery action on paid orders with a DEAD_LETTER notification", async () => {
    const deadDelivery: OrderWebhookDeliveryDetail = {
      ...delivery,
      delivery: { ...delivery.delivery, status: "DEAD_LETTER", next_attempt_at: null },
    };
    mockData(paidOrder, [deadDelivery]);
    mount();
    expect(await screen.findByText(/该订单付款通知已停止重试/)).toBeVisible();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "重新发送通知" }));
    const dialog = await screen.findByRole("dialog", { name: "重新发送通知" });
    expect(within(dialog).getByRole("button", { name: "回调修复后手动重发" })).toBeVisible();
  });
});
