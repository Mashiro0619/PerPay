import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { json, order } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

describe("test-payment URL recovery", () => {
  it("restores a website-scoped overlay and submits to that website without selecting it again", async () => {
    const clientId = "site_alpha";
    const created = { ...order, api_client_id: clientId, checkout: { ...order.checkout, checkout_url: "/checkout/scope-test" } };
    const view = mountOnboarding({ stage: 4, path: "/sites/" + clientId + "/orders?overlay=%2Ftest-payment", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sites/" + clientId) return json({ data: {
        client_id: clientId, revision: 1, configuration: { name: "网站甲", accepting_orders: true, notifications_enabled: false }, deleted_at: null,
      } });
      if (path === "/api/admin/v1/sites/" + clientId + "/orders") return json({ data: [], page: { next_cursor: null } });
      if (path.endsWith("/test-payments")) return json({ data: created }, 201);
      if (path.endsWith("/orders/" + order.order_id)) return json({ data: created });
      return undefined;
    } });
    const dialog = await screen.findByRole("dialog", { name: "测试收款" });
    await within(dialog).findByLabelText("测试金额（元）");
    expect(within(dialog).getByText("本次操作所属网站")).toBeVisible();
    expect(within(dialog).getByText(clientId, { exact: true })).toBeVisible();
    expect(within(dialog).queryByRole("combobox", { name: "业务网站" })).not.toBeInTheDocument();
    const create = within(dialog).getByRole("button", { name: "创建测试订单" });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.setup().click(create);
    await screen.findByRole("heading", { name: "测试订单已创建" });
    expect(view.writes()).toHaveLength(1);
    const write = view.writes()[0]!;
    expect(new URL(write.url).pathname).toBe("/api/admin/v1/sites/" + clientId + "/test-payments");
    expect(await write.clone().json()).toEqual({ amount_cents: 1, test_payment_id: expect.any(String) });
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "再创建一笔" }));
    const amount = await within(dialog).findByLabelText("测试金额（元）");
    await waitFor(() => expect(amount).toHaveFocus());
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps navigation-only website selection from silently binding a global test-payment URL", async () => {
    const view = mountOnboarding({ stage: 4, path: "/system?selected_site=site_alpha&overlay=%2Ftest-payment", handle: request => {
      if (new URL(request.url).pathname === "/api/admin/v1/sites/site_alpha") return json({ data: {
        client_id: "site_alpha", revision: 1, configuration: { name: "网站甲", accepting_orders: true, notifications_enabled: false }, deleted_at: null,
      } });
      return undefined;
    } });
    const dialog = await screen.findByRole("dialog", { name: "测试收款" });
    await within(dialog).findByLabelText("测试金额（元）");
    expect(within(dialog).getByRole("combobox", { name: "业务网站" })).toHaveTextContent("请选择网站");
    expect(within(dialog).queryByText("本次操作所属网站")).not.toBeInTheDocument();
    const create = within(dialog).getByRole("button", { name: "创建测试订单" });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.setup().click(create);
    expect(await within(dialog).findByText("请选择业务网站。")).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });
});
