import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
import { order, orderId, settings } from "./fixtures";

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
              items={[{ title: "实例设置", url: "/settings", icon: Settings }]}
            />
          </SidebarProvider>
        </MemoryRouter>,
      );
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(3);
      for (const menu of container.querySelectorAll("[data-sidebar=menu]"))
        expect(menu).toHaveClass("gap-1");
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
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
  ] as const)("matches navigation path boundaries for %s", (pathname, url, expected) => {
    expect(isNavigationItemActive(pathname, url)).toBe(expected);
  });

  it.each([
    ["collection", "支付宝经营码", "订单规则"],
    ["display", "收银台", "收款概览"],
  ] as const)(
    "groups %s fields in official cards with one form and a contextual save footer",
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
        .getByRole("heading", { name: first })
        .closest("[data-slot=card]");
      const secondCard = screen
        .getByRole("heading", { name: second })
        .closest("[data-slot=card]");
      expect(firstCard).not.toBeNull();
      expect(secondCard).not.toBe(firstCard);
      expect(container.querySelectorAll("form")).toHaveLength(1);
      const save = screen.getByRole("button", { name: "保存" });
      expect(save.closest("[data-slot=card-footer]")).not.toBeNull();
      expect(save.closest("[data-slot=card]")).toBe(secondCard);
      expect(save.closest("form")).toBe(firstCard?.closest("form"));
      expect(save).toBeDisabled();
    },
  );

  it("keeps password submission in the card footer and in the same form as its fields", () => {
    const { container } = render(
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
  });

  it("does not stretch the amount card to the height of the adjacent order information", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/admin/v1/orders/" + orderId)
          return Response.json({ data: order });
        if (
          pathname ===
          "/api/admin/v1/orders/" + orderId + "/webhook-deliveries"
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
    const summary = screen.getByRole("region", { name: "金额与订单信息" });
    expect(summary).toHaveClass("items-start");
    expect(summary.querySelectorAll("[data-slot=card]")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: order.product_name }),
    ).toBeVisible();
  });
});
