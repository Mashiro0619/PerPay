import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ClipboardList, LayoutDashboard, Settings } from "lucide-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { NavMain, isNavigationItemActive } from "../src/components/nav-main";
import { NavSecondary } from "../src/components/nav-secondary";
import { SettingsEditor } from "../src/components/SettingsForms";
import { SidebarProvider } from "../src/components/ui/sidebar";
import { OrderDetail } from "../src/pages/OrderDetail";
import { PasswordEditorPage, SecuritySettings } from "../src/pages/SecuritySettings";
import { json, order, orderId, settings, withSessionList } from "./fixtures";

describe("official block composition", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((media: string) => ({
        media,
        matches: false,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });
  it.each(["/", "/orders/order-id", "/settings/collection"])(
    "keeps default button sizing with separated navigation groups for %s",
    (pathname) => {
      const { container } = render(
        <MemoryRouter initialEntries={[pathname]}>
          <SidebarProvider>
            <NavMain
              pathname={pathname}
              items={[
                { title: "收款概览", url: "/", icon: LayoutDashboard },
                { title: "订单", url: "/orders", icon: ClipboardList },
              ]}
            />
            <NavSecondary
              pathname={pathname}
              items={[{ title: "系统设置", url: "/settings", icon: Settings }]}
            />
          </SidebarProvider>
        </MemoryRouter>,
      );
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(3);
      for (const menu of container.querySelectorAll("[data-sidebar=menu]"))
        expect(menu).toHaveClass("gap-1");
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(
        1,
      );
      for (const link of links)
        expect(link).toHaveAttribute("data-size", "default");
      expect(
        container.querySelectorAll(
          "[data-slot=sidebar-menu-button][data-active]",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["/orders-old", "/orders", false],
    ["/settings-old", "/settings", false],
    ["/orders/order-id", "/orders", true],
    ["/settings/provider", "/settings", true],
    ["/orders", "/", false],
  ] as const)(
    "matches navigation path boundaries for %s",
    (pathname, url, expected) => {
      expect(isNavigationItemActive(pathname, url)).toBe(expected);
    },
  );

  it.each([
    ["collection", "收款码", "支付宝收款码内容"],
    ["display", "界面显示", "支付系统名称"],
  ] as const)(
    "groups %s fields in one official card with fieldsets and a form-wide save footer",
    (section, first, second) => {
      const { container } = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SettingsEditor
              section={section}
              settings={settings}
              onSaved={vi.fn()}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const firstCard = screen
        .getByRole("group", { name: first })
        .closest("[data-slot=card]");
      const secondCard = screen
        .getByRole("textbox", { name: second })
        .closest("[data-slot=card]");
      expect(firstCard).not.toBeNull();
      expect(secondCard).toBe(firstCard);
      if (section === "collection") expect(screen.queryByLabelText("收银台有效期（秒）")).not.toBeInTheDocument();
      if (section === "display") {
        const fields = screen.getByRole("group", { name: "界面显示" });
        expect(fields).toContainElement(screen.getByRole("textbox", { name: "支付系统名称" }));
        expect(fields).toContainElement(screen.getByRole("switch", { name: "收银台显示商品名称" }));
        expect(fields).toContainElement(screen.getByRole("textbox", { name: "商家帮助链接" }));
        expect(screen.queryByRole("group", { name: "首页图表样式" })).not.toBeInTheDocument();
        expect(fields.querySelector("[data-slot=field-legend]")).toHaveClass("sr-only");
      }
      expect(container.querySelectorAll("[data-slot=card]")).toHaveLength(1);
      expect(container.querySelectorAll("form")).toHaveLength(1);
      const save = screen.getByRole("button", { name: "保存" });
      expect(save.closest("[data-slot=card-footer]")).not.toBeNull();
      expect(save.closest("[data-slot=card]")).toBe(secondCard);
      expect(save.closest("form")).toBe(firstCard?.closest("form"));
      expect(save).toBeDisabled();
    },
  );

  it("keeps security summaries separate from the password form and preserves local input on rerender", () => {
    vi.stubGlobal("fetch", withSessionList(vi.fn(async () => json({ data: settings }))));
    const content = (revision: number) => <QueryClientProvider client={queryClient}><MemoryRouter>
      <SecuritySettings settings={{ ...settings, revision }} onSaved={vi.fn()} />
      <PasswordEditorPage />
    </MemoryRouter></QueryClientProvider>;
    const { container, rerender } = render(content(settings.revision));
    const summary = container.querySelector<HTMLElement>("[data-security-summary]")!;
    expect(summary.querySelector("form")).toBeNull();
    expect(within(summary).getByRole("link", { name: "修改登录密码" })).toHaveAttribute("href", "/settings/security/password");
    const password = screen.getByLabelText("新密码");
    const confirmation = screen.getByLabelText("再次输入新密码");
    const submit = screen.getByRole("button", { name: "修改并重新登录" });
    expect(submit.closest("form")).toBe(password.closest("form"));
    expect(confirmation.closest("form")).toBe(password.closest("form"));
    expect(submit).toBeDisabled();
    fireEvent.change(password, { target: { value: "unsubmitted-password" } });
    password.focus();
    rerender(content(settings.revision + 1));
    expect(screen.getByLabelText("新密码")).toBe(password);
    expect(password).toHaveValue("unsubmitted-password");
    expect(password).toHaveFocus();
  });
  it("keeps amount and order cards independent in the original reading order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/admin/v1/orders/" + orderId)
          return Response.json({ data: order });
        if (
          pathname ===
          "/api/admin/v1/orders/" + orderId + "/notifications/deliveries"
        )
          return Response.json({ data: [], page: { next_cursor: null } });
        throw new Error("Unexpected request: " + pathname);
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/orders/" + orderId]}>
          <Routes>
            <Route path="/orders/:orderId" element={<OrderDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "订单信息" });
    const amount = screen.getByRole("region", { name: "金额明细" });
    const information = screen.getByRole("region", { name: "订单信息" });
    expect(amount).not.toBeNull();
    expect(information).not.toBeNull();
    expect(amount).not.toBe(information);
    expect(amount?.closest("[data-slot=tabs-content]")).toBe(information?.closest("[data-slot=tabs-content]"));
    expect(information!.compareDocumentPosition(amount!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: order.product_name }),
    ).toBeVisible();
  });
});
