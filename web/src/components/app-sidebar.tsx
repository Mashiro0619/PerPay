import { useNavigationWorkspace } from "@/workspace";
import { useSystemName } from "@/branding";
import { useOptionalSystemStatus } from "@/features/system-status";
import { useEffect, useState, type ComponentProps } from "react";
import {
  Activity,
  Bell,
  ClipboardList,
  Globe,
  LayoutDashboard,
  ListChecks,
  Settings2,
  WalletCards,
} from "lucide-react";
import { Link } from "@/navigation";
import { navigationSection, sidebarHref, type NavigationSection } from "@/lib/navigation-selection";
import { NavMain, type NavigationItem } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
import { NavUser } from "@/components/nav-user";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
const SITE_MENU_STORAGE_KEY = "perpay:sidebar-sites";
const SITE_MENU_STORAGE_VERSION = 2;
type SiteMenuDisclosure = { context: string; open: boolean };

function readSiteMenuDisclosure(context: string): SiteMenuDisclosure {
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(SITE_MENU_STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && "version" in saved && saved.version === SITE_MENU_STORAGE_VERSION &&
      "context" in saved && typeof saved.context === "string" && "open" in saved && typeof saved.open === "boolean") {
      return { context, open: saved.context === context || context === "global" ? saved.open : true };
    }
  } catch {
    // Navigation remains usable when browser storage is unavailable.
  }
  // The previous version also persisted its collapsed global default.
  return { context, open: true };
}

export const navigation = [
  { section: "overview", url: "/", title: "总览", icon: LayoutDashboard },
  { section: "orders", url: "/orders", title: "订单", icon: ClipboardList },
  { section: "work-items", url: "/work-items", title: "待处理", icon: ListChecks },
  { section: "notifications", url: "/notifications", title: "通知", icon: Bell },
  { section: "settings", url: "/settings", title: "设置", icon: Settings2 },
  { section: "sites", url: "/sites", title: "业务网站", icon: Globe },
  { section: "reconciliation", url: "/reconciliation", title: "对账", icon: WalletCards },
  { section: "system", url: "/system", title: "运行状态", icon: Activity },
] satisfies (NavigationItem & { section: NavigationSection })[];
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
  const selection = useNavigationWorkspace();
  const section = navigationSection(pathname);
  const siteMenuContext = selection.clientId ? "site:" + selection.clientId
    : section === "sites" ? "sites" : "global";
  // Keep this state outside the mobile Sheet, which unmounts its menu on close.
  const [siteMenu, setSiteMenu] = useState(() => readSiteMenuDisclosure(siteMenuContext));
  if (siteMenu.context !== siteMenuContext) {
    setSiteMenu({ context: siteMenuContext, open: siteMenuContext === "global" ? siteMenu.open : true });
  }
  useEffect(() => {
    try {
      window.sessionStorage.setItem(SITE_MENU_STORAGE_KEY, JSON.stringify({ version: SITE_MENU_STORAGE_VERSION, ...siteMenu }));
    } catch {
      // Session persistence is optional; the in-memory disclosure still works.
    }
  }, [siteMenu]);
  const items = navigation.map(item => ({
    ...item,
    url: sidebarHref(item.section, selection),
    global: true,
    active: section === item.section,
  }));
  const sharedStatus = useOptionalSystemStatus();
  const statusNotice = sharedStatus?.checking
    ? sharedStatus.unavailable
      ? "状态未知"
      : "正在检查状态"
    : sharedStatus?.presentation?.notice;
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label={systemName}
              tooltip={systemName}
              className="data-[slot=sidebar-menu-button]:p-1.5!"
              render={<Link global to="/" />}
            >
              <WalletCards className="size-5!" />
              <span
                className="min-w-0 truncate text-base font-semibold group-data-[collapsible=icon]:hidden"
                title={systemName}
              >
                {systemName}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <div data-sidebar-scroll-body className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SidebarContent className="flex-none overflow-visible group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:py-2 group-data-[collapsible=icon]:[&_[data-slot=sidebar-group]]:py-0">
          <nav aria-label="主导航">
            <NavMain items={items.slice(0, 4)} pathname={pathname} />
          </nav>
          <nav aria-label="网站选择">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <WorkspaceSwitcher
                    open={siteMenu.open}
                    onOpenChange={open => setSiteMenu({ context: siteMenuContext, open })}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        </SidebarContent>
        <SidebarFooter className="mt-auto shrink-0">
          <nav aria-label="全局管理">
            <NavSecondary
              items={items.slice(5)}
              pathname={pathname}
              notice={statusNotice ?? null}
              label="全局管理"
              className="p-0"
            />
          </nav>
          <nav aria-label="设置导航">
            <NavSecondary
              items={items.slice(4, 5)}
              pathname={pathname}
              className="p-0"
            />
          </nav>
          <NavUser name={username} pending={logoutPending} onLogout={onLogout} />
        </SidebarFooter>
      </div>
    </Sidebar>
  );
}
