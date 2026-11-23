import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { Toaster } from "../src/components/ui/toast";
import { DraftProvider } from "../src/drafts";
import { SiteSettingsPage } from "../src/pages/Sites";
import { json } from "./fixtures";

function makeSite(): Site {
  return {
    secrets: { api_secret: true, webhook_secret: true },
    client_id: "site_visual",
    revision: 2,
    configuration: {
      name: "可视化收银台测试站",
      accepting_orders: true,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
      policy: {
        orders: {
          order_ttl_seconds: 300,
          allow_zero_amount_offset: false,
          amount_offset_maximum_cents: 99,
          amount_reuse_cooldown_seconds: 600,
          pending_order_limit: null,
        },
        display: {
          checkout_name: "星河商店收银台",
          checkout_help_url: "https://help.example.com",
          checkout_help_label: null,
          checkout_show_product_name: true,
          checkout_show_merchant_order_no: true,
          checkout_show_countdown: true,
          checkout_show_amount_adjustment: true,
          checkout_show_qr_tools: true,
          checkout_show_alipay_launch: true,
          checkout_show_theme_toggle: true,
          checkout_payment_instructions: null,
          checkout_adjustment_hint: null,
          checkout_notice: null,
          checkout_confirmed_detail: null,
          checkout_expired_detail: null,
          checkout_disputed_detail: null,
          checkout_closed_detail: null,
        },
        notification_delivery: {
          timeout_milliseconds: 5000,
          maximum_attempts: 12,
          retry_base_seconds: 5,
          retry_maximum_seconds: 3600,
        },
      },
    },
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
  };
}

function mountStudio() {
  let saved = makeSite();
  const writes: Array<{ revision: number; configuration: Site["configuration"] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sites/site_visual" && request.method === "GET") {
        return json({ data: saved });
      }
      if (path === "/api/admin/v1/sites/site_visual" && request.method === "PUT") {
        const body = (await request.clone().json()) as {
          revision: number;
          configuration: Site["configuration"];
        };
        writes.push(body);
        saved = {
          ...saved,
          revision: saved.revision + 1,
          configuration: body.configuration,
        };
        return json({ data: saved });
      }
      return json({ error: { code: "route_not_found", message: "Not found" } }, 404);
    }),
  );

  const router = createMemoryRouter(
    [
      {
        element: (
          <DraftProvider>
            <Outlet />
          </DraftProvider>
        ),
        children: [
          { path: "/sites/:clientId/settings/:section", element: <SiteSettingsPage /> },
        ],
      },
    ],
    { initialEntries: ["/sites/site_visual/settings/display"] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <RouterProvider router={router} />
      </Toaster>
    </QueryClientProvider>,
  );

  return { writes };
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("CheckoutDisplayStudio", () => {
  it("renders a live interactive preview, syncs hotspot clicks with inspector controls, and saves updates", async () => {
    const { writes } = mountStudio();
    const user = userEvent.setup();

    const preview = await screen.findByText("星河商店收银台");
    expect(preview).toBeVisible();
    const previewShell = document.querySelector("[data-checkout-preview]") as HTMLElement;
    expect(previewShell).toHaveAttribute("data-preview-state", "UNPAID");
    expect(previewShell).toHaveAttribute("data-preview-viewport", "desktop");
    expect(previewShell.querySelector("[data-preview-product-name]")).not.toBeNull();
    expect(previewShell.querySelector("[data-preview-breakdown]")).not.toBeNull();
    expect(previewShell.querySelector("[data-preview-adjustment-hint]")).toBeNull();

    // Toggling a module updates the live preview immediately and exposes a quick restore chip.
    const productSwitch = screen.getByRole("switch", { name: "显示商品名称" });
    await user.click(productSwitch);
    expect(previewShell.querySelector("[data-preview-product-name]")).toBeNull();
    expect(screen.getByRole("button", { name: "商品名称" })).toBeVisible();

    // Clicking a canvas hotspot switches to the matching inspector tab and focuses its control.
    await user.click(within(previewShell).getByRole("button", { name: "定位配置：待付款指引文案" }));
    const instructionsInput = screen.getByLabelText("待付款指引文案");
    expect(instructionsInput).toBeVisible();
    fireEvent.change(instructionsInput, { target: { value: "请严格支付 {amount}，完成后自动跳转。" } });
    expect(previewShell.querySelector("[data-preview-instructions]")).toHaveTextContent(
      "请严格支付 ¥19.01，完成后自动跳转。",
    );

    // Focusing a terminal copy field switches the live preview to that order state.
    const expiredInput = screen.getByLabelText("付款时间已过说明");
    fireEvent.focus(expiredInput);
    expect(previewShell).toHaveAttribute("data-preview-state", "EXPIRED");
    fireEvent.change(expiredInput, { target: { value: "超时后请点击刷新或联系客服核对。" } });
    expect(previewShell.querySelector("[data-preview-terminal-note]")).toHaveTextContent(
      "超时后请点击刷新或联系客服核对。",
    );

    // Clicking the brand hotspot switches to the brand tab and updates the live header.
    await user.click(within(previewShell).getByRole("button", { name: "定位配置：收银台名称" }));
    const nameInput = screen.getByLabelText("收银台名称");
    fireEvent.change(nameInput, { target: { value: "极光数字收银台" } });
    expect(previewShell.querySelector("[data-preview-brand-name]")).toHaveTextContent(
      "极光数字收银台",
    );

    // Saving submits PUT /api/admin/v1/sites/:clientId with the updated policy.display.
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.revision).toBe(2);
    expect(writes[0]?.configuration.policy.display).toMatchObject({
      checkout_name: "极光数字收银台",
      checkout_show_product_name: false,
      checkout_payment_instructions: "请严格支付 {amount}，完成后自动跳转。",
      checkout_expired_detail: "超时后请点击刷新或联系客服核对。",
    });
  });

  it("switches preview viewport to mobile when toggling the Alipay launch button", async () => {
    mountStudio();
    const user = userEvent.setup();

    await screen.findByText("星河商店收银台");
    const previewShell = document.querySelector("[data-checkout-preview]") as HTMLElement;
    expect(previewShell).toHaveAttribute("data-preview-viewport", "desktop");

    await user.click(screen.getByRole("switch", { name: "显示“打开支付宝”按钮" }));
    expect(previewShell).toHaveAttribute("data-preview-viewport", "mobile");
    expect(within(previewShell).queryByText("打开支付宝")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "显示“打开支付宝”按钮" }));
    expect(within(previewShell).getByText("打开支付宝")).toBeVisible();
  });
});
