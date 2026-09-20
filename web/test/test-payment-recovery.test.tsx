import { onlineManager } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, order, orderId } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const endpoint = "/api/admin/v1/test-payments";
const created = {
  ...order,
  requested_amount_cents: 123,
  payable_amount_cents: 124,
  checkout: {
    ...order.checkout,
    checkout_url: window.location.origin + "/checkout/pct1_" + "a".repeat(43),
  },
};
function mount(
  handle: (r: Request, attempt: number) => Response | Promise<Response>,
  path = "/orders",
) {
  let attempts = 0;
  let statusError = false;
  const view = mountOnboarding({
    stage: 4,
    path,
    handle: (r) => {
      const url = new URL(r.url);
      if (url.pathname === endpoint && r.method === "POST")
        return handle(r, ++attempts);
      if (url.pathname === "/api/admin/v1/orders/" + orderId)
        return json({ data: { ...created, checkout: order.checkout } });
      if (url.pathname.endsWith("/system/status") && statusError)
        return apiError("internal_error", "就绪状态读取失败", 503);
      return undefined;
    },
  });
  return {
    ...view,
    failStatus: () => {
      statusError = true;
    },
    requests: () =>
      view.writes().filter((r) => new URL(r.url).pathname === endpoint),
  };
}
async function open(
  user: ReturnType<typeof userEvent.setup>,
  standalone = false,
) {
  const trigger = standalone
    ? null
    : await screen.findByRole("button", { name: "测试收款" });
  if (trigger) await user.click(trigger);
  const amount = await screen.findByLabelText("测试金额（元）");
  fireEvent.change(amount, { target: { value: "1.23" } });
  await user.click(screen.getByRole("button", { name: "创建测试订单" }));
  return { trigger, amount };
}
function unloadBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
afterEach(() => onlineManager.setOnline(true));

describe("uncertain test-payment creation recovery", () => {
  it("locks the original amount and request, including close/reopen, and only starts another request after success", async () => {
    const view = mount((_r, attempt) =>
      attempt === 1
        ? Promise.reject(new TypeError("response lost"))
        : json({ data: created }, 200),
    );
    const user = userEvent.setup();
    const { trigger, amount } = await open(user);
    await screen.findByText("创建结果待确认");
    expect(amount).toHaveAttribute("readonly");
    expect(amount).toHaveAccessibleDescription(
      expect.stringContaining("原金额已锁定"),
    );
    const body = await view.requests()[0]!.clone().json();
    expect(screen.getByText("test-" + body.test_payment_id)).toBeVisible();
    expect(
      within(screen.getByRole("dialog")).getByText("商户订单号").tagName,
    ).toBe("DIV");
    expect(
      screen.getByRole("button", { name: "复制商户订单号" }),
    ).toBeVisible();
    fireEvent.change(amount, { target: { value: "9.99" } });
    expect(amount).toHaveValue("1.23");
    expect(unloadBlocked()).toBe(true);
    await user.click(screen.getByRole("button", { name: "暂时关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(unloadBlocked()).toBe(true);
    await user.click(trigger!);
    expect(screen.getByLabelText("测试金额（元）")).toHaveValue("1.23");
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(await view.requests()[1]!.clone().json()).toEqual(body);
    expect(unloadBlocked()).toBe(false);
    await user.click(screen.getByRole("button", { name: "再创建一笔" }));
    const fresh = await screen.findByLabelText("测试金额（元）");
    expect(fresh).toHaveValue("0.01");
    expect(fresh).not.toHaveAttribute("readonly");
    fireEvent.change(fresh, { target: { value: "1.23" } });
    await user.click(screen.getByRole("button", { name: "创建测试订单" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect((await view.requests()[2]!.clone().json()).test_payment_id).not.toBe(
      body.test_payment_id,
    );
  });

  it("allows recovery when readiness cannot be read, without hiding the original request", async () => {
    const view = mount((_r, attempt) =>
      attempt === 1
        ? Promise.reject(new TypeError("lost"))
        : json({ data: created }, 200),
    );
    const user = userEvent.setup();
    const { trigger } = await open(user);
    await screen.findByText("创建结果待确认");
    view.failStatus();
    await user.click(screen.getByRole("button", { name: "暂时关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(trigger!);
    const retry = screen.getByRole("button", { name: "重试原请求" });
    expect(retry).toBeEnabled();
    await user.click(retry);
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(await view.requests()[1]!.clone().json()).toEqual(
      await view.requests()[0]!.clone().json(),
    );
  });

  it.each([
    [422, "validation_failed"],
    [403, "csrf_invalid"],
    [503, "reconciliation_not_ready"],
  ] as const)(
    "does not erase earlier uncertainty after a later %i / %s rejection",
    async (status, code) => {
      const view = mount((_r, attempt) =>
        attempt === 1
          ? Promise.reject(new TypeError("lost"))
          : attempt === 2
            ? apiError(code, "本次请求被拒绝", status)
            : json({ data: created }, 200),
      );
      const user = userEvent.setup();
      await open(user);
      await screen.findByText("创建结果待确认");
      await user.click(screen.getByRole("button", { name: "重试原请求" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "重试原请求" }),
        ).toBeEnabled(),
      );
      expect(screen.getByLabelText("测试金额（元）")).toHaveAttribute(
        "readonly",
      );
      await user.click(screen.getByRole("button", { name: "重试原请求" }));
      await screen.findByRole("heading", { name: "测试订单已创建" });
      const body = await view.requests()[0]!.clone().json();
      expect(await view.requests()[1]!.clone().json()).toEqual(body);
      expect(await view.requests()[2]!.clone().json()).toEqual(body);
    },
  );

  it.each([
    [422, "validation_failed"],
    [403, "csrf_invalid"],
    [503, "amount_slots_exhausted"],
    [503, "reconciliation_not_ready"],
  ] as const)(
    "leaves a definitively rejected first %i / %s request editable",
    async (status, code) => {
      const view = mount((_r, attempt) =>
        attempt === 1
          ? apiError(code, "明确拒绝本次创建", status)
          : json({ data: created }, 201),
      );
      const user = userEvent.setup();
      const { amount } = await open(user);
      await screen.findByText("明确拒绝本次创建");
      expect(screen.queryByText("创建结果待确认")).not.toBeInTheDocument();
      expect(amount).not.toHaveAttribute("readonly");
      expect(unloadBlocked()).toBe(false);
      fireEvent.change(amount, { target: { value: "2.34" } });
      await user.click(screen.getByRole("button", { name: "创建测试订单" }));
      await screen.findByRole("heading", { name: "测试订单已创建" });
      expect((await view.requests()[1]!.clone().json()).amount_cents).toBe(234);
    },
  );

  it.each([500, 502, 403, 422])(
    "treats an unrecognized HTTP %i outcome as uncertain instead of guessing it did not create",
    async (status) => {
      mount(() => apiError("upstream_failure", "上游返回异常", status));
      await open(userEvent.setup());
      await screen.findByText("创建结果待确认");
      expect(screen.getByLabelText("测试金额（元）")).toHaveAttribute(
        "readonly",
      );
    },
  );

  it("shares the unresolved request across the standalone page and modal entry points", async () => {
    const view = mount(
      (_r, attempt) =>
        attempt === 1
          ? Promise.reject(new TypeError("lost"))
          : json({ data: created }, 200),
      "/test-payment",
    );
    const user = userEvent.setup();
    await open(user, true);
    await screen.findByText("创建结果待确认");
    await act(async () => {
      await view.router.navigate("/");
    });
    const trigger = await screen.findByRole("button", { name: "测试收款" });
    await user.click(trigger);
    await screen.findByText("创建结果待确认");
    expect(screen.getByLabelText("测试金额（元）")).toHaveValue("1.23");
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(await view.requests()[1]!.clone().json()).toEqual(
      await view.requests()[0]!.clone().json(),
    );
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => {
      await view.router.navigate("/test-payment");
    });
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(view.requests()).toHaveLength(2);
  });

  it("does not queue an offline retry to run silently when connectivity returns", async () => {
    const view = mount(() => Promise.reject(new TypeError("offline")));
    const user = userEvent.setup();
    await open(user);
    await screen.findByText("创建结果待确认");
    onlineManager.setOnline(false);
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    await waitFor(() => expect(view.requests()).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重试原请求" })).toBeEnabled(),
    );
    await act(async () => {
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(view.requests()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "暂时关闭" })).toBeEnabled();
  });

  it("releases a timed-out wait into recovery without claiming the server canceled the order", async () => {
    const view = mount((request, attempt) =>
      attempt === 1
        ? new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          })
        : json({ data: created }, 200),
    );
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "测试收款" });
    await user.click(trigger);
    await screen.findByLabelText("测试金额（元）");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "创建测试订单" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(screen.getByText("创建结果待确认")).toBeVisible();
    expect(view.requests()[0]!.signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "重试原请求" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试原请求" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(
      screen.getByRole("heading", { name: "测试订单已创建" }),
    ).toBeVisible();
    expect(await view.requests()[1]!.clone().json()).toEqual(
      await view.requests()[0]!.clone().json(),
    );
  });

  it("removes recovery and unload guards on session expiry", async () => {
    const view = mount(() => Promise.reject(new TypeError("lost")));
    const user = userEvent.setup();
    await open(user);
    await screen.findByText("创建结果待确认");
    expect(unloadBlocked()).toBe(true);
    fireEvent(window, new Event("perpay:session-expired"));
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unloadBlocked()).toBe(false);
    await user.type(
      screen.getByLabelText("管理员密码"),
      "a-secure-local-password",
    );
    await user.click(screen.getByRole("button", { name: "登录" }));
    await user.click(await screen.findByRole("button", { name: "测试收款" }));
    const amount = await screen.findByLabelText("测试金额（元）");
    expect(amount).toHaveValue("0.01");
    expect(amount).not.toHaveAttribute("readonly");
    expect(view.requests()).toHaveLength(1);
  });
  it.each([{}, { data: null }, { data: { order_id: orderId } }])(
    "retains the request for an incomplete success body instead of becoming stuck",
    async (body) => {
      const view = mount((_request, attempt) =>
        attempt === 1 ? json(body) : json({ data: created }, 200),
      );
      const user = userEvent.setup();
      await open(user);
      await screen.findByText("创建结果待确认");
      expect(screen.getByLabelText("测试金额（元）")).toHaveAttribute(
        "readonly",
      );
      await user.click(screen.getByRole("button", { name: "重试原请求" }));
      await screen.findByRole("heading", { name: "测试订单已创建" });
      expect(await view.requests()[1]!.clone().json()).toEqual(
        await view.requests()[0]!.clone().json(),
      );
    },
  );
  it("supports the standalone route with a trailing slash without disabling its readiness query", async () => {
    const view = mount(() => json({ data: created }, 201), "/test-payment/");
    await screen.findByLabelText("测试金额（元）");
    expect(
      screen.getByRole("heading", { level: 1, name: "测试收款" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "创建测试订单" })).toBeEnabled();
    expect(view.requests()).toHaveLength(0);
  });
});
