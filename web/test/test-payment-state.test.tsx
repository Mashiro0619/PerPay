import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminOrderDetail } from "../src/api/client";
import { apiError, json, order, orderId } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const target = "/api/admin/v1/test-payments";
const detail = "/api/admin/v1/orders/" + orderId;
const checkoutUrl = window.location.origin + "/checkout/pct1_" + "a".repeat(43);
const unpaid: AdminOrderDetail = {
  ...order,
  requested_amount_cents: 1,
  payable_amount_cents: 2,
};
const created = {
  ...unpaid,
  checkout: { ...unpaid.checkout, checkout_url: checkoutUrl },
};
const confirmed: AdminOrderDetail = {
  ...unpaid,
  version: 2,
  received_amount_cents: 2,
  payment: { status: "CONFIRMED", basis: "INFERRED", received_amount_cents: 2 },
};
function mount(
  handle: (request: Request) => Response | Promise<Response> = () =>
    json({ data: unpaid }),
  standalone = false,
) {
  const view = mountOnboarding({
    stage: 4,
    path: standalone ? "/test-payment" : "/orders",
    handle: (request) => {
      const url = new URL(request.url);
      if (url.pathname === target && request.method === "POST")
        return json({ data: created }, 201);
      if (url.pathname === detail) return handle(request);
      return undefined;
    },
  });
  return {
    ...view,
    reads: () =>
      view.fetchMock.mock.calls
        .map(([request]) => request)
        .filter((request) => new URL(request.url).pathname === detail),
  };
}
async function create(
  user: ReturnType<typeof userEvent.setup>,
  standalone = false,
) {
  const trigger = standalone
    ? null
    : await screen.findByRole("button", { name: "测试收款" });
  if (trigger) await user.click(trigger);
  const create = await screen.findByRole("button", { name: "创建测试订单" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await screen.findByRole("heading", { name: "测试订单已创建" });
  return trigger;
}
afterEach(() => focusManager.setFocused(undefined));

describe("current test-payment state", () => {
  it("refreshes a reopened order without repeating creation and does not present its stale state as current", async () => {
    let next: Response | Promise<Response> = json({ data: unpaid });
    const view = mount(() => next);
    const user = userEvent.setup();
    const trigger = await create(user);
    await screen.findByText("等待付款确认");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    let finish!: (value: Response) => void;
    next = new Promise((resolve) => {
      finish = resolve;
    });
    await user.click(trigger!);
    await screen.findByText("正在更新订单状态");
    expect(
      screen.queryByText("未付款", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish(json({ data: confirmed }));
    });
    await screen.findByText("收款已确认");
    expect(
      screen.getByRole("dialog").querySelector("[data-slot=dialog-footer]"),
    ).toHaveClass("shrink-0", "flex-row");
    expect(screen.getByText("已确认", { exact: true })).toBeVisible();
    expect(screen.getByText("实收金额")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看订单" })).toHaveAttribute(
      "href",
      "/orders/" + orderId,
    );
    expect(view.reads()).toHaveLength(2);
    expect(view.writes()).toHaveLength(1);
    expect(queryClient.getQueryData(["order", orderId])).toEqual({
      data: confirmed,
    });
  });

  it.each([
    ["EXPIRED", "UNPAID", "收银台已过期"],
    ["CLOSED", "UNPAID", "收银台已关闭"],
    ["OPEN", "DISPUTED", "收款需要核查"],
    ["CLOSED", "CONFIRMED", "收款已确认"],
  ] as const)(
    "guides %s / %s without inviting another payment",
    async (checkout, payment, title) => {
      const state: AdminOrderDetail = {
        ...(payment === "CONFIRMED" ? confirmed : unpaid),
        version: 2,
        checkout: { ...unpaid.checkout, status: checkout },
        payment: { ...unpaid.payment, status: payment },
      };
      const view = mount(() => json({ data: state }));
      await create(userEvent.setup());
      await screen.findByText(title);
      expect(
        screen.queryByRole("link", { name: "打开收银台" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "查看订单" })).toBeVisible();
      expect(view.writes()).toHaveLength(1);
    },
  );

  it("keeps the order through a read failure and retries only its status", async () => {
    let failure = true;
    const view = mount(() =>
      failure
        ? apiError("internal_error", "状态暂不可用", 503)
        : json({ data: confirmed }),
    );
    const user = userEvent.setup();
    await create(user);
    await screen.findByText(/最新状态暂不可用/);
    expect(screen.getByText(created.merchant_order_no)).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("未付款", { exact: true }),
    ).not.toBeInTheDocument();
    failure = false;
    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    await screen.findByText("收款已确认");
    expect(view.writes()).toHaveLength(1);
    expect(view.reads()).toHaveLength(2);
  });

  it("polls only a displayed unconfirmed result, stops after confirmation and preserves focus", async () => {
    let state = unpaid;
    const view = mount(() => json({ data: state }));
    const user = userEvent.setup();
    await create(user);
    await screen.findByText("等待付款确认");
    const refresh = screen.getByRole("button", { name: "刷新状态" });
    refresh.focus();
    focusManager.setFocused(true);
    vi.useFakeTimers();
    state = confirmed;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(refresh).toHaveFocus();
    const readCount = view.reads().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(view.reads()).toHaveLength(readCount);
    expect(view.writes()).toHaveLength(1);
  });

  it("aborts an unfinished read when closed and ignores its late response", async () => {
    let finish!: (response: Response) => void;
    let first = true;
    const view = mount(() =>
      first
        ? new Promise((resolve) => {
            finish = resolve;
            first = false;
          })
        : json({ data: unpaid }),
    );
    const user = userEvent.setup();
    const trigger = await create(user);
    await waitFor(() => expect(view.reads()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(view.reads()[0]!.signal.aborted).toBe(true);
    await act(async () => {
      finish(json({ data: confirmed }));
    });
    expect(queryClient.getQueryData(["order", orderId])).toBeUndefined();
    await user.click(trigger!);
    await screen.findByText("等待付款确认");
    expect(screen.queryByText("收款已确认")).not.toBeInTheDocument();
    expect(view.reads()).toHaveLength(2);
    expect(view.writes()).toHaveLength(1);
  });

  it("refreshes the standalone result too", async () => {
    const view = mount(() => json({ data: confirmed }), true);
    await create(userEvent.setup(), true);
    await screen.findByText("收款已确认");
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
    expect(view.reads()).toHaveLength(1);
  });

  it("discards a status response completed after session expiry", async () => {
    let finish!: (response: Response) => void;
    const view = mount(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await create(userEvent.setup());
    await waitFor(() => expect(view.reads()).toHaveLength(1));
    fireEvent(window, new Event("perpay:session-expired"));
    await screen.findByRole("heading", { name: "登录管理后台" });
    await act(async () => {
      finish(json({ data: confirmed }));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(queryClient.getQueryData(["order", orderId])).toBeUndefined();
  });
  it("pauses polling while hidden and refetches on return, without making the user reopen the dialog", async () => {
    let state = unpaid;
    const view = mount(() => json({ data: state }));
    await create(userEvent.setup());
    await screen.findByText("等待付款确认");
    focusManager.setFocused(false);
    vi.useFakeTimers();
    const reads = view.reads().length;
    state = confirmed;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(view.reads()).toHaveLength(reads);
    await act(async () => {
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(view.writes()).toHaveLength(1);
  });

  it("does not keep polling or create a request while the result dialog is closed", async () => {
    const view = mount(() => json({ data: unpaid }));
    const user = userEvent.setup();
    await create(user);
    await screen.findByText("等待付款确认");
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    vi.useFakeTimers();
    const reads = view.reads().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(view.reads()).toHaveLength(reads);
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps the last confirmed amount but labels it historical when refresh fails", async () => {
    let failure = false;
    const view = mount(() =>
      failure
        ? apiError("internal_error", "状态读取失败", 503)
        : json({ data: confirmed }),
    );
    const user = userEvent.setup();
    await create(user);
    await screen.findByText("收款已确认");
    failure = true;
    const refresh = screen.getByRole("button", { name: "刷新状态" });
    await user.click(refresh);
    await screen.findByText("最新状态暂不可用");
    expect(screen.getByText("上次实收金额")).toBeVisible();
    expect(
      screen.queryByText("未付款", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
    expect(refresh).toHaveFocus();
    expect(view.writes()).toHaveLength(1);
  });
});
