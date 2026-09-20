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
import { OrderDetail } from "../src/pages/OrderDetail";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
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
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/orders/:orderId" element={<OrderDetail />} />
          <Route
            path="/reconciliation/:kind/:resourceId"
            element={<EvidenceDetail />}
          />
        </Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
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
async function confirmReason(
  user: ReturnType<typeof userEvent.setup>,
  reason: string,
  action: string,
) {
  const dialog = screen.getByRole("dialog");
  await user.type(within(dialog).getByLabelText("操作理由"), reason);
  expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: action }));
}

describe("order detail work surface", () => {
  it("does not create an empty attempt disclosure or repeat generic event descriptions", async () => {
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
    expect(await screen.findByText(/尚未开始投递/)).toBeVisible();
    expect(screen.queryByText("投递尝试（0）")).not.toBeInTheDocument();
    const timeline = screen
      .getByRole("heading", { name: "订单动态" })
      .closest<HTMLElement>("[data-slot=card]")!;
    expect(within(timeline).getByText("订单已创建")).toBeVisible();
    expect(within(timeline).getByText("按金额与付款时间推断")).toBeVisible();
    expect(
      within(timeline).queryByText("已生成订单及付款窗口。"),
    ).not.toBeInTheDocument();
  });
  it("shows payment evidence and notification outcomes in place without refetching embedded resources", async () => {
    const { requests } = mockData();
    mount();
    expect(
      await screen.findByRole("heading", {
        name: order.product_name,
        level: 2,
      }),
    ).toBeVisible();
    expect(
      await screen.findByText(/HTTP 200 · 业务确认响应无效/),
    ).toBeVisible();
    expect(screen.getByText(detailLedger.provider_order_no!)).toBeVisible();
    expect(screen.getByText("测试买家")).toBeVisible();
    expect(screen.getByText("测试交易备注")).toBeVisible();
    expect(screen.queryByText("金额占用窗口")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText("匹配依据"));
    expect(
      screen.queryByText(/按金额和付款时间推断，不是平台按订单号确认/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("金额占用窗口")).toBeVisible();
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
    await user.click(screen.getByText("投递尝试（1）"));
    expect(
      screen.getByRole("columnheader", { name: "HTTP / ACK" }),
    ).toBeVisible();
    await user.click(await recordAction("技术详情", "通知记录操作"));
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
      expect(await screen.findByText("未配置业务通知")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "订单操作" }));
      expect(
        screen.queryByRole("menuitem", { name: "标记已退款" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "管理员退款标记" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("navigation", { name: "列表分页" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "人工关联收款" }),
      ).toBeVisible();
    },
  );

  it("keeps ignored exceptions in expandable history and uses the embedded candidate and ledger", async () => {
    const { requests } = mockData({
      ...paidOrder,
      reconciliation: {
        matches: [paymentMatch],
        exceptions: [{ ...financialException, reminder_ignored: true }],
      },
    });
    mount();
    await screen.findByText(/HTTP 200/);
    expect(
      screen.queryByRole("heading", { name: "实收金额不符" }),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText("异常历史（1）"));
    expect(
      await screen.findByRole("heading", { name: "实收金额不符" }),
    ).toBeVisible();
    expect(screen.getByText("未处理 · 已忽略")).toBeVisible();
    expect(screen.queryByText(/异常尚未解决/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "账务异常 · 1" }),
    ).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
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
    const heading = await screen.findByRole("heading", {
      name: "实收金额不符",
    });
    expect(
      heading.compareDocumentPosition(
        screen.getByRole("heading", { name: "收款依据" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText(/流水金额 ¥1.02 与可能关联订单的应付 ¥1.01 不一致/),
    ).toBeVisible();
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
    expect(await screen.findByText("撤销时间")).toBeVisible();
    expect(screen.getByText("平台记录归属不符")).toBeVisible();
    expect(screen.getByText("对照交易号确认")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "收款记录操作" }));
    expect(
      screen.queryByRole("menuitem", { name: "撤销错误关联" }),
    ).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "收款记录操作" });
    await user.click(await recordAction("撤销错误关联", "收款记录操作"));
    await confirmReason(user, "测试撤销原因", "确认撤销关联");
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

  it("reuses a redelivery operation UUID on retry and never leaves the order", async () => {
    const bodies: unknown[] = [];
    const terminal = {
      ...delivery,
      delivery: { ...delivery.delivery, status: "DEAD_LETTER" as const },
    };
    mockData(paidOrder, [terminal], async (request) => {
      bodies.push(await request.json());
      return bodies.length === 1
        ? apiError("internal_error", "lost response", 500)
        : json({ data: { delivery: { delivery_id: "new-delivery" } } });
    });
    mount();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "通知记录操作" });
    await user.click(await recordAction("重新投递", "通知记录操作"));
    await confirmReason(user, "业务已修复", "确认重新投递");
    await screen.findByText("操作结果待确认");
    await user.click(screen.getByRole("button", { name: "响应详情" }));
    await screen.findByText(/服务处理失败/);
    await user.click(screen.getByRole("button", { name: "重试原操作" }));
    expect(await screen.findByText(/已创建新投递，等待发送/)).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(screen.getByLabelText("当前页面")).toHaveTextContent(
      "/orders/" + orderId,
    );
  });

  it.each([
    "PENDING",
    "LEASED",
    "RETRY_WAIT",
    "ACKNOWLEDGED",
    "DEAD_LETTER",
  ] as const)(
    "does not offer redelivery on a superseded %s record",
    (status) => {
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <DeliveryCard
              detail={{
                ...delivery,
                is_latest: false,
                delivery: { ...delivery.delivery, status },
              }}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "通知记录操作" }));
      expect(
        screen.queryByRole("menuitem", { name: "重新投递" }),
      ).not.toBeInTheDocument();
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
    expect(
      await screen.findByText(detailLedger.provider_order_no!),
    ).toBeVisible();
    await screen.findByRole("button", { name: "重试" });
    const before = attempts;
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(attempts).toBeGreaterThan(before));
    expect(screen.queryByText("未配置业务通知")).not.toBeInTheDocument();
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
    expect(await within(dialog).findByText(/应付.*实收/)).toBeVisible();
    expect(
      within(dialog).queryByText("请核对这笔关联"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "确认关联收款" }),
    ).toBeDisabled();
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
    const user = userEvent.setup();
    await screen.findByText(/HTTP 200/);
    expect(requests).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText(/历史投递/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "通知记录操作" }));
    expect(
      screen.queryByRole("menuitem", { name: "重新投递" }),
    ).not.toBeInTheDocument();
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
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "订单操作" });
    await user.click(await recordAction("标记已退款"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(
      /PerPay 不执行转账，也未验证退款/,
    );
    await user.type(
      within(dialog).getByLabelText("备注（可选）"),
      "外部退款已完成",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "确认标记已退款" }),
    );
    await screen.findByText("已标记退款");
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
