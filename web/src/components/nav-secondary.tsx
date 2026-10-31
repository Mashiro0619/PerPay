import { useId, type ComponentProps } from "react";
import { BellDot, CircleArrowUp, CircleHelp, CirclePause, TriangleAlert } from "lucide-react";
import {
  navigationItemActive,
  type NavigationItem,
} from "@/components/nav-main";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

function runtimeNoticeIcon(notice: string) {
  switch (notice) {
    case "已暂停接收新订单": return CirclePause;
    case "有运行告警": return TriangleAlert;
    case "有待处理提醒": return BellDot;
    case "正在检查状态": return Spinner;
    default: return CircleHelp;
  }
}

export function NavSecondary({
  items,
  pathname,
  notice = null,
  updateAvailable = false,
  label,
  ...props
}: {
  items: NavigationItem[];
  pathname: string;
  notice?: string | null;
  updateAvailable?: boolean;
  label?: string;
} & ComponentProps<typeof SidebarGroup>) {
  const noticeId = useId();
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed" && !isMobile;
  return (
    <SidebarGroup {...props}>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => {
            const active = navigationItemActive(pathname, item);
            const system =
              item.section === "system" ||
              item.url.split(/[?#]/)[0] === "/system";
            const hasUpdate = system && updateAvailable;
            const accessibleTitle = hasUpdate ? `${item.title}，有更新` : item.title;
            const runtimeNotice = system ? notice : null;
            const Icon = runtimeNotice ? runtimeNoticeIcon(runtimeNotice) : item.icon;
            const tooltip = runtimeNotice ? `${accessibleTitle} · ${runtimeNotice}` : accessibleTitle;
            const button = (
              <SidebarMenuButton
                tooltip={system ? "" : item.title}
                aria-label={runtimeNotice && collapsed ? `${accessibleTitle}，${runtimeNotice}` : accessibleTitle}
                render={
                  <Link
                    global={item.global}
                    to={item.url}
                    viewTransition={false}
                  />
                }
                aria-describedby={runtimeNotice ? noticeId : undefined}
                isActive={active}
                aria-current={active ? "page" : undefined}
              >
                <span
                  data-runtime-notice={runtimeNotice ? "" : undefined}
                  aria-hidden="true"
                  className={cn(
                    "relative inline-flex shrink-0",
                    runtimeNotice && runtimeNotice !== "正在检查状态" && runtimeNotice !== "有待处理提醒" && "text-warning-foreground",
                  )}
                >
                  <Icon aria-hidden="true" />
                  {hasUpdate && collapsed && <Badge data-update-indicator className="absolute -right-1 -top-1 size-1.5 p-0" />}
                </span>
                <span className="min-w-0 truncate group-data-[collapsible=icon]:hidden">{item.title}</span>
                {hasUpdate && !collapsed && <CircleArrowUp data-update-indicator aria-hidden="true" />}
              </SidebarMenuButton>
            );
            return (
              <SidebarMenuItem key={item.section ?? item.url}>
                {system ? <Tooltip>
                  <TooltipTrigger render={button} />
                  <TooltipContent role="tooltip" side="right" align="start">{tooltip}</TooltipContent>
                </Tooltip> : button}
                {runtimeNotice && <span id={noticeId} className="sr-only">{runtimeNotice}</span>}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
