import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, order, orderId } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";
import { recordAction } from "./menu-helper";

const target = "/api/admin/v1/test-payments";
const createdOrder = {
  ...order,
  requested_amount_cents: 1,
  payable_amount_cents: 2,
  checkout: {
    ...order.checkout,
    checkout_url: window.location.origin + "/checkout/pct1_" + "a".repeat(43),
  },
};
const isCreate = (r: Request) =>
  new URL(r.url).pathname === target && r.method === "POST";
function mount(
  handle?: (request: Request) => Response | Promise<Response> | undefined,
) {
  return mountOnboarding({
    stage: 4,
    path: "/orders",
    handle: (request) =>
      handle?.(request) ??
      (isCreate(request) ? json({ data: createdOrder }, 201) : undefined),
  });
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "测试收款" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "测试收款" });
  await within(dialog).findByLabelText("测试金额（元）");
  return { dialog, trigger };
}

describe("test-payment dialog lifecycle", () => {
  it("keeps the amount when canceled and reopened without creating anything", async () => {
    const view = mount();
    const user = userEvent.setup();
    const { dialog, trigger } = await open(user);
    fireEvent.change(within(dialog).getByLabelText("测试金额（元）"), {
      target: { value: "1.23" },
    });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(await screen.findByLabelText("测试金额（元）")).toHaveValue("1.23");
    expect(view.router.state.location.pathname).toBe("/orders");
    expect(view.writes()).toHaveLength(0);
  });

  it("blocks dismissal while creating and preserves the completed result across reopening", async () => {
    let finish!: (r: Response) => void;
    const view = mount((r) =>
      isCreate(r)
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const user = userEvent.setup();
    const { dialog, trigger } = await open(user);
    await user.dblClick(
      within(dialog).getByRole("button", { name: "创建测试订单" }),
    );
    expect(view.writes()).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(
      within(dialog).queryByRole("button", { name: "关闭对话框" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(dialog).toBeVisible();
    await act(async () => {
      finish(json({ data: createdOrder }, 201));
    });
    await within(dialog).findByRole("heading", { name: "测试订单已创建" });
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "测试收款" });
    expect(
      within(reopened).getByRole("link", { name: "查看订单" }),
    ).toHaveAttribute("href", "/orders/" + orderId);
    expect(view.writes()).toHaveLength(1);
  });

  it("retains the original request after a lost response even when the dialog is closed", async () => {
    let attempts = 0;
    const view = mount((r) =>
      isCreate(r)
        ? ++attempts === 1
          ? Promise.reject(new TypeError("lost response"))
          : json({ data: createdOrder }, 201)
        : undefined,
    );
    const user = userEvent.setup();
    const { dialog, trigger } = await open(user);
    fireEvent.change(within(dialog).getByLabelText("测试金额（元）"), {
      target: { value: "1.23" },
    });
    await user.click(
      within(dialog).getByRole("button", { name: "创建测试订单" }),
    );
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(trigger);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "创建测试订单",
      }),
    );
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(await view.writes()[0]!.clone().json()).toEqual(
      await view.writes()[1]!.clone().json(),
    );
    await user.click(screen.getByRole("button", { name: "再创建一笔" }));
    fireEvent.change(await screen.findByLabelText("测试金额（元）"), {
      target: { value: "1.23" },
    });
    await user.click(screen.getByRole("button", { name: "创建测试订单" }));
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect((await view.writes()[2]!.clone().json()).test_payment_id).not.toBe(
      (await view.writes()[0]!.clone().json()).test_payment_id,
    );
  });

  it("keeps the payment result beneath a nested technical dialog and restores focus within it", async () => {
    const view = mount();
    const user = userEvent.setup();
    const { dialog } = await open(user);
    await user.click(
      within(dialog).getByRole("button", { name: "创建测试订单" }),
    );
    await screen.findByRole("heading", { name: "测试订单已创建" });
    const menu = within(dialog).getByRole("button", { name: "记录操作" });
    await user.click(await recordAction("技术详情", "记录操作"));
    const technical = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(technical).getByLabelText("技术详情")).toHaveTextContent(
      orderId,
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "技术详情" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("dialog", { name: "测试收款" }),
    ).toBeVisible();
    expect(menu).toHaveFocus();
    expect(view.writes()).toHaveLength(1);
  });

  it("closes the modal when opening the created order and preserves list-return navigation", async () => {
    const view = mount((r) =>
      new URL(r.url).pathname === "/api/admin/v1/orders/" + orderId
        ? json({ data: order })
        : r.url.includes("webhook-deliveries")
          ? json({ data: [], page: { next_cursor: null } })
          : undefined,
    );
    const user = userEvent.setup();
    const { dialog } = await open(user);
    await user.click(
      within(dialog).getByRole("button", { name: "创建测试订单" }),
    );
    await screen.findByRole("heading", { name: "测试订单已创建" });
    await user.click(within(dialog).getByRole("link", { name: "查看订单" }));
    await screen.findByRole("heading", { name: "订单信息" });
    expect(view.router.state.location.pathname).toBe("/orders/" + orderId);
    expect(view.router.state.location.state?.listReturn?.to).toBe("/orders");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("unmounts the dialog on session expiry and never exposes its late checkout response", async () => {
    let finish!: (r: Response) => void;
    const view = mount((r) =>
      isCreate(r)
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const user = userEvent.setup();
    const { dialog } = await open(user);
    await user.click(
      within(dialog).getByRole("button", { name: "创建测试订单" }),
    );
    expect(view.writes()).toHaveLength(1);
    fireEvent(window, new Event("perpay:session-expired"));
    await screen.findByRole("heading", { name: "登录管理后台" });
    await act(async () => {
      finish(json({ data: createdOrder }, 201));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
  });
});
