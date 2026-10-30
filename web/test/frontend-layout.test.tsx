import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClipboardList, LayoutDashboard, Settings } from "lucide-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { NavMain, isNavigationItemActive } from "../src/components/nav-main";
import { NavSecondary } from "../src/components/nav-secondary";
import { SettingsEditor } from "../src/components/SettingsForms";
import { SidebarProvider } from "../src/components/ui/sidebar";
import { OrderDetail } from "../src/pages/OrderDetail";
import { SecuritySettings } from "../src/pages/SecuritySettings";
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
    ["collection", "收款码", "收款码"],
    ["display", "界面显示", "首页图表样式"],
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
        .getByRole("group", { name: second })
        .closest("[data-slot=card]");
      expect(firstCard).not.toBeNull();
      expect(secondCard).toBe(firstCard);
      if (section === "collection") expect(screen.queryByLabelText("收银台有效期（秒）")).not.toBeInTheDocument();
      if (section === "display") {
        const fields = screen.getByRole("group", { name: "界面显示" });
        expect(fields).toContainElement(screen.getByRole("textbox", { name: "支付系统名称" }));
        expect(fields).toContainElement(screen.getByRole("switch", { name: "收银台显示商品名称" }));
        expect(fields).toContainElement(screen.getByRole("group", { name: "首页图表样式" }));
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

  it("keeps four security cards stable and password submission in the same form as its fields", () => {
    vi.stubGlobal("fetch", withSessionList(vi.fn(async () => json({ data: settings }))));
    const { container, rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SecuritySettings settings={settings} onSaved={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const card = screen
      .getByRole("heading", { name: "修改密码" })
      .closest("[data-slot=card]");
    const submit = screen.getByRole("button", { name: "修改并重新登录" });
    const grid = container.querySelector(".security-settings-card-grid")!;
    const items = [...grid.children];
    expect([...grid.children].map(item => item.querySelector("[data-slot=card-title]")?.textContent)).toEqual([
      "管理员 IP 白名单", "密钥", "修改密码", "登录会话",
    ]);
    const sessions = screen.getByRole("heading", { name: "登录会话" }).closest("[data-slot=card]");
    expect(items[3]).toContainElement(sessions as HTMLElement);
    expect(submit.closest("[data-slot=card-footer]")).not.toBeNull();
    expect(submit.closest("[data-slot=card]")).toBe(card);
    expect(submit.closest("form")).toBe(
      screen.getByLabelText("新密码").closest("form"),
    );
    expect(submit.closest("form")).toBe(
      screen.getByLabelText("再次输入新密码").closest("form"),
    );
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(submit).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^查看/ })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "生成 API 密钥" })).toBeEnabled();
    const whitelist = screen.getByLabelText("允许的 IP / 网段");
    const password = screen.getByLabelText("新密码");
    fireEvent.change(whitelist, { target: { value: "192.0.2.0/24\n2001:db8::/32" } });
    fireEvent.change(password, { target: { value: "unsubmitted-password" } });
    password.focus();
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SecuritySettings settings={{ ...settings, revision: settings.revision + 1 }} onSaved={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector(".security-settings-card-grid")).toBe(grid);
    expect(grid.children).toHaveLength(items.length);
    items.forEach((item, index) => expect(grid.children[index]).toBe(item));
    expect(screen.getByRole("heading", { name: "登录会话" }).closest("[data-slot=card]")).toBe(sessions);
    expect(screen.getByLabelText("允许的 IP / 网段")).toBe(whitelist);
    expect(whitelist).toHaveValue("192.0.2.0/24\n2001:db8::/32");
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
    const amount = screen.getByRole("heading", { name: "金额" }).closest("[data-detail-grid-item]");
    const information = screen.getByRole("heading", { name: "订单信息" }).closest("[data-detail-grid-item]");
    expect(amount).not.toBeNull();
    expect(information).not.toBeNull();
    expect(amount).not.toBe(information);
    expect(amount?.parentElement).toBe(information?.parentElement);
    expect(amount!.compareDocumentPosition(information!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: order.product_name }),
    ).toBeVisible();
  });
});
