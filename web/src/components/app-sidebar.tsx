import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/workspace";
import { useSystemName } from "@/branding";
import { useOptionalSystemStatus } from "@/features/system-status";
import type { ComponentProps } from "react";
import {
  Activity,
  Globe,
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
  { url: "/", title: "总览", icon: LayoutDashboard },
  { url: "/sites", title: "业务网站", icon: Globe },
  { url: "/orders", title: "全部订单", icon: ClipboardList },
  { url: "/work-items", title: "全局待办", icon: ListChecks },
  { url: "/reconciliation", title: "共享账本", icon: WalletCards },
  { url: "/notifications", title: "全部通知", icon: Bell },
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
  const systemName = useSystemName();
  const { clientId, base, site } = useWorkspace();
  const siteNavigation = [
    { url: base, title: "网站概览", icon: LayoutDashboard },
    { url: base + "/orders", title: "本站订单", icon: ClipboardList },
    { url: base + "/notifications", title: "本站通知", icon: Bell },
    { url: base + "/work-items", title: "本站待办", icon: ListChecks },
    { url: base + "/settings/basic", title: "网站设置", icon: Settings2 },
  ];
  const sharedStatus = useOptionalSystemStatus();
  const statusNotice = sharedStatus?.checking
    ? sharedStatus.unavailable
      ? "状态未知"
      : "正在检查状态"
    : sharedStatus?.presentation?.notice;
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link global to="/" />}
            >
              <WalletCards className="size-5!" />
              <span
                className="min-w-0 truncate text-base font-semibold"
                title={systemName}
              >
                {systemName}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {clientId && site?.data && !site.isError && (
          <div className="flex flex-wrap gap-2 px-2">
            <Badge variant="secondary">
              {site.data.data.configuration.accepting_orders
                ? "接单中"
                : "已暂停接单"}
            </Badge>
            <Badge variant="outline">
              {site.data.data.configuration.notifications_enabled
                ? "通知已开启"
                : "通知已关闭"}
            </Badge>
          </div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="主导航">
          <NavMain
            items={clientId ? siteNavigation : navigation.slice(0, 6)}
            pathname={pathname}
          />
        </nav>
        {!clientId && (
          <NavSecondary
            items={navigation.slice(6)}
            pathname={pathname}
            notice={statusNotice ?? null}
            className="mt-auto"
          />
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser name={username} pending={logoutPending} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  );
}
