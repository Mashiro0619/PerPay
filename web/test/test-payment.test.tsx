import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { queryClient } from "../src/api/client";
import { apiError, json, order, orderId } from "./fixtures";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

const target = "/api/admin/v1/test-payments";
const checkoutUrl = window.location.origin + "/checkout/pct1_" + "a".repeat(43);
const createdOrder = { ...order, requested_amount_cents: 1, payable_amount_cents: 2,
  checkout: { ...order.checkout, checkout_url: checkoutUrl } };
const isCreate = (request: Request) => new URL(request.url).pathname === target && request.method === "POST";

function mount(handle?: (request: Request) => Response | Promise<Response> | undefined) {
  return mountOnboarding({ stage: 4, path: "/test-payment", handle: request => handle?.(request)
    ?? (isCreate(request) ? json({ data: createdOrder }, 201) : undefined) });
}

describe("minimal test payment page", () => {
  it("shows one amount field without redundant prompts and creates only on explicit submit", async () => {
    const view = mount();
    const user = userEvent.setup();
    const amount = await screen.findByLabelText("测试金额（元）");
    expect(amount).toHaveValue("0.01");
    expect(amount).toHaveAccessibleDescription("真实付款，以收银台金额为准。");
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("创建小额测试订单")).not.toBeInTheDocument();
    expect(screen.queryByText(/这不是模拟支付|随机尾差|我了解这会创建真实收款订单/)).not.toBeInTheDocument();
    expect(view.container.querySelector(".test-payment-page .notice")).toBeNull();
    expect(view.writes()).toHaveLength(0);
    const submit = screen.getByRole("button", { name: "创建测试订单" });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByRole("heading", { name: "测试订单已创建" })).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    expect(await view.writes()[0]!.clone().json()).toEqual({ amount_cents: 1, test_payment_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(screen.getByRole("link", { name: "打开收银台" })).toHaveAttribute("href", checkoutUrl);
    expect(screen.getByRole("link", { name: "打开收银台" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "查看订单" })).toHaveAttribute("href", "/orders/" + orderId);
    expect(screen.getByText("¥0.02")).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/test-payment");
    expect(view.container.querySelector(".test-payment-page .notice--success")).toBeNull();
  });

  it.each(["0", "-1", "100.01", "1.001", "invalid"])("retains amount validation for %s without creating an order", async value => {
    const view = mount();
    const amount = await screen.findByLabelText("测试金额（元）");
    fireEvent.change(amount, { target: { value } });
    await userEvent.setup().click(screen.getByRole("button", { name: "创建测试订单" }));
    expect(amount).toHaveFocus();
    expect(amount).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/金额须介于|请输入正确的人民币金额/)).toBeVisible();
    expect(view.writes()).toHaveLength(0);
    fireEvent.change(amount, { target: { value: "0.50" } });
    expect(amount).not.toHaveAttribute("aria-invalid", "true");
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps collection readiness blocking even without the confirmation checkbox", async () => {
    const view = mount(request => request.url.endsWith("/system/status")
      ? json({ data: { ...systemStatus(), status: "not_ready" } }) : undefined);
    const amount = await screen.findByLabelText("测试金额（元）");
    const submit = screen.getByRole("button", { name: "创建测试订单" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("link", { name: "完成配置" })).toHaveAttribute("href", "/settings");
    fireEvent.submit(amount.closest("form")!);
    expect(view.writes()).toHaveLength(0);
  });

  it("disables creation after a status refresh fails and preserves the entered amount", async () => {
    let fail = false;
    const view = mount(request => fail && request.url.endsWith("/system/status") ? apiError("internal_error", "状态读取失败", 503) : undefined);
    const amount = await screen.findByLabelText("测试金额（元）");
    fireEvent.change(amount, { target: { value: "1.23" } });
    fail = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["status"], exact: true }); });
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "创建测试订单" })).toBeDisabled();
    expect(amount).toHaveValue("1.23");
    fireEvent.submit(amount.closest("form")!);
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps the idempotency key after a network failure and resets it only for an explicit new order", async () => {
    let attempts = 0;
    const view = mount(request => isCreate(request) ? ++attempts === 1
      ? Promise.reject(new TypeError("connection interrupted"))
      : json({ data: createdOrder }, 201) : undefined);
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("测试金额（元）"), { target: { value: "1.23" } });
    await user.click(screen.getByRole("button", { name: "创建测试订单" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("测试金额（元）")).toHaveValue("1.23");
    expect(view.writes()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "创建测试订单" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    const first = await view.writes()[0]!.clone().json();
    const retry = await view.writes()[1]!.clone().json();
    expect(retry).toEqual(first);
    expect(first.amount_cents).toBe(123);
    await user.click(screen.getByRole("button", { name: "再创建一笔" }));
    expect(await screen.findByLabelText("测试金额（元）")).toHaveValue("0.01");
    expect(view.writes()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("测试金额（元）"), { target: { value: "1.23" } });
    await user.click(screen.getByRole("button", { name: "创建测试订单" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect((await view.writes()[2]!.clone().json()).test_payment_id).not.toBe(first.test_payment_id);
  });

  it("prevents duplicate submissions while the original request is pending", async () => {
    let finish!: (response: Response) => void;
    const view = mount(request => isCreate(request) ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
    const amount = await screen.findByLabelText("测试金额（元）");
    await userEvent.setup().dblClick(screen.getByRole("button", { name: "创建测试订单" }));
    expect(amount).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建测试订单" })).toBeDisabled();
    fireEvent.submit(amount.closest("form")!);
    expect(view.writes()).toHaveLength(1);
    await act(async () => { finish(json({ data: createdOrder }, 201)); });
    await screen.findByRole("heading", { name: "测试订单已创建" });
  });

  it("discards a late checkout result after the administrator session expires", async () => {
    let finish!: (response: Response) => void;
    const view = mount(request => isCreate(request) ? new Promise<Response>(resolve => { finish = resolve; }) : undefined);
    await screen.findByLabelText("测试金额（元）");
    await userEvent.setup().click(screen.getByRole("button", { name: "创建测试订单" }));
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    fireEvent(window, new Event("perpay:session-expired"));
    await screen.findByRole("heading", { name: "登录管理后台" });
    await act(async () => { finish(json({ data: createdOrder }, 201)); });
    expect(screen.queryByRole("link", { name: "打开收银台" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "测试订单已创建" })).not.toBeInTheDocument();
  });
});
