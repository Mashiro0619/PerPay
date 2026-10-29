import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Activity,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  Settings2,
  WalletCards,
} from "lucide-react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavMain, type NavigationItem } from "../src/components/nav-main";
import { NavSecondary } from "../src/components/nav-secondary";
import { SidebarProvider, SidebarTrigger } from "../src/components/ui/sidebar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Link } from "../src/navigation";

const mainItems: NavigationItem[] = [
  {
    section: "overview",
    title: "总览",
    url: "/",
    icon: LayoutDashboard,
    global: true,
  },
  {
    section: "orders",
    title: "订单",
    url: "/orders",
    icon: ClipboardList,
    global: true,
  },
  {
    section: "work-items",
    title: "待处理",
    url: "/work-items",
    icon: ListChecks,
    global: true,
  },
];
const secondaryItems: NavigationItem[] = [
  {
    section: "reconciliation",
    title: "对账",
    url: "/reconciliation",
    icon: WalletCards,
    global: true,
  },
  {
    section: "system",
    title: "运行状态",
    url: "/system",
    icon: Activity,
    global: true,
  },
  {
    section: "settings",
    title: "设置",
    url: "/settings",
    icon: Settings2,
    global: true,
  },
];

function NavigationFixture() {
  const location = useLocation();
  return (
    <TooltipProvider>
      <SidebarProvider>
        <SidebarTrigger />
        <nav aria-label="主导航">
          <NavMain items={mainItems} pathname={location.pathname} />
        </nav>
        <nav aria-label="全局管理">
          <NavSecondary
            items={secondaryItems}
            pathname={location.pathname}
            notice="有运行告警"
          />
        </nav>
        <output aria-label="当前位置">
          {location.pathname + location.search}
        </output>
        <input aria-label="保留内容" defaultValue="草稿" />
        <Link global to="/notifications">
          正文通知链接
        </Link>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const originalTransition = Object.getOwnPropertyDescriptor(
  document,
  "startViewTransition",
);
afterEach(() => {
  if (originalTransition)
    Object.defineProperty(document, "startViewTransition", originalTransition);
  else Reflect.deleteProperty(document, "startViewTransition");
});

function mount(path = "/") {
  const startViewTransition = vi.fn((update: () => Promise<void> | void) => {
    const updated = Promise.resolve().then(update);
    return {
      ready: updated,
      updateCallbackDone: updated,
      finished: updated,
      skipTransition: vi.fn(),
    };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  const router = createMemoryRouter(
    [{ path: "*", element: <NavigationFixture /> }],
    { initialEntries: [path] },
  );
  const rendered = render(<RouterProvider router={router} />);
  return { ...rendered, router, startViewTransition };
}

describe("sidebar selection motion", () => {
  it("changes the active route without replacing links or invoking whole-page snapshots", async () => {
    const user = userEvent.setup();
    const { router, startViewTransition } = mount();
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    const orders = within(navigation).getByRole("link", { name: "订单" });
    const work = within(navigation).getByRole("link", { name: "待处理" });
    const content = screen.getByRole("textbox", { name: "保留内容" });
    await user.type(content, "继续");
    await user.click(orders);
    await waitFor(() => expect(router.state.location.pathname).toBe("/orders"));
    expect(within(navigation).getByRole("link", { name: "订单" })).toBe(orders);
    expect(orders).toHaveFocus();
    expect(orders).toHaveAttribute("aria-current", "page");
    expect(
      orders.querySelector('[data-selection-indicator="sidebar"]'),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      navigation.querySelectorAll("[data-selection-indicator]"),
    ).toHaveLength(1);
    await user.click(work);
    await waitFor(() => expect(work).toHaveAttribute("aria-current", "page"));
    expect(orders).not.toHaveAttribute("aria-current");
    expect(work).toHaveFocus();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(content).toHaveValue("草稿继续");

    await user.click(screen.getByRole("link", { name: "正文通知链接" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/notifications"),
    );
    expect(startViewTransition).toHaveBeenCalledOnce();
  });

  it("keeps main and global groups independent while retaining global site-selection URLs and notices", async () => {
    const user = userEvent.setup();
    const { router, startViewTransition } = mount(
      "/system?selected_site=site-a",
    );
    const main = screen.getByRole("navigation", { name: "主导航" });
    const global = screen.getByRole("navigation", { name: "全局管理" });
    const status = within(global).getByRole("link", { name: "运行状态" });
    expect(status).toHaveAccessibleDescription("需关注");
    expect(main.querySelectorAll("[data-selection-indicator]")).toHaveLength(0);
    expect(global.querySelectorAll("[data-selection-indicator]")).toHaveLength(
      1,
    );
    const reconciliation = within(global).getByRole("link", { name: "对账" });
    expect(reconciliation).toHaveAttribute(
      "href",
      "/reconciliation?selected_site=site-a",
    );
    await user.click(reconciliation);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/reconciliation"),
    );
    expect(router.state.location.search).toBe("?selected_site=site-a");
    expect(reconciliation).toHaveAttribute("aria-current", "page");
    expect(main.querySelectorAll("[data-selection-indicator]")).toHaveLength(0);
    expect(global.querySelectorAll("[data-selection-indicator]")).toHaveLength(
      1,
    );
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("keeps selection and accessible names through icon-mode changes", async () => {
    const user = userEvent.setup();
    mount("/system");
    await user.click(screen.getByRole("button", { name: "切换导航" }));
    const collapsedStatus = screen.getByRole("link", {
      name: "运行状态，有运行告警",
    });
    expect(collapsedStatus).toHaveAttribute("aria-current", "page");
    expect(
      collapsedStatus.querySelector('[data-selection-indicator="sidebar"]'),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "切换导航" }));
    expect(screen.getByRole("link", { name: "运行状态" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("stops only decoration on document hiding and preserves the selected link and focus", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const user = userEvent.setup();
    mount();
    const orders = screen.getByRole("link", { name: "订单" });
    await user.click(orders);
    await waitFor(() => expect(orders).toHaveAttribute("aria-current", "page"));
    const indicator = orders.querySelector("[data-selection-indicator]");
    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(indicator).not.toBeInTheDocument();
    expect(orders.querySelector("[data-selection-indicator]")).toHaveAttribute(
      "data-selection-mode",
      "static",
    );
    expect(screen.getByRole("link", { name: "订单" })).toBe(orders);
    expect(orders).toHaveFocus();
  });
});
