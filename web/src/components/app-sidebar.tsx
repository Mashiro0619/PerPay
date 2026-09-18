import type { ComponentProps } from "react";
import {
  Activity,
  Bell,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  Settings2,
  WalletCards,
} from "lucide-react";
import { Link } from "@/navigation";
import { NavMain } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
export const navigation = [
  { url: "/", title: "收款概览", icon: LayoutDashboard },
  { url: "/orders", title: "订单", icon: ClipboardList },
  { url: "/work-items", title: "待处理", icon: ListChecks },
  { url: "/reconciliation", title: "账本与对账", icon: WalletCards },
  { url: "/notifications", title: "业务通知", icon: Bell },
  { url: "/settings", title: "实例设置", icon: Settings2 },
  { url: "/system", title: "运行状态", icon: Activity },
];
export function AppSidebar({
  pathname,
  username,
  logoutPending,
  onLogout,
  ...props
}: ComponentProps<typeof Sidebar> & {
  pathname: string;
  username: string;
  logoutPending: boolean;
  onLogout: () => void;
}) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link to="/" />}
            >
              <WalletCards className="size-5!" />
              <span className="text-base font-semibold">PerPay</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="主导航">
          <NavMain items={navigation.slice(0, 5)} pathname={pathname} />
        </nav>
        <NavSecondary
          items={navigation.slice(5)}
          pathname={pathname}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser name={username} pending={logoutPending} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  );
}
