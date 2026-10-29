import { useId, type ComponentProps } from "react";
import {
  navigationItemActive,
  type NavigationItem,
} from "@/components/nav-main";
import { Link } from "@/navigation";
import { Badge } from "@/components/ui/badge";
import {
  SelectionMotionGroup,
  SelectionMotionIndicator,
} from "@/components/selection-motion";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
  useSidebar,
} from "@/components/ui/sidebar";
export function NavSecondary({
  items,
  pathname,
  notice = null,
  label,
  ...props
}: {
  items: NavigationItem[];
  pathname: string;
  notice?: string | null;
  label?: string;
} & ComponentProps<typeof SidebarGroup>) {
  const noticeId = useId();
  const { state, isMobile } = useSidebar();
  return (
    <SidebarGroup {...props}>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SelectionMotionGroup>
          <SidebarMenu className="gap-1" data-selection-motion="sidebar">
            {items.map((item) => {
              const active = navigationItemActive(pathname, item);
              const system =
                item.section === "system" ||
                item.url.split(/[?#]/)[0] === "/system";
              return (
                <SidebarMenuItem key={item.section ?? item.url}>
                  <SidebarMenuButton
                    tooltip={
                      system && notice
                        ? `${item.title} · ${notice}`
                        : item.title
                    }
                    aria-label={
                      system && notice && state === "collapsed" && !isMobile
                        ? `${item.title}，${notice}`
                        : item.title
                    }
                    render={
                      <Link
                        global={item.global}
                        to={item.url}
                        viewTransition={false}
                      />
                    }
                    aria-describedby={system && notice ? noticeId : undefined}
                    isActive={active}
                    aria-current={active ? "page" : undefined}
                  >
                    <SelectionMotionIndicator
                      active={active}
                      variant="sidebar"
                    />
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {system && notice && (
                    <SidebarMenuBadge
                      id={noticeId}
                      data-runtime-notice
                      className="p-0"
                    >
                      <Badge
                        variant={
                          notice === "有运行告警" || notice === "状态未知"
                            ? "warning"
                            : "secondary"
                        }
                      >
                        {notice === "有运行告警"
                          ? "需关注"
                          : notice === "有待处理提醒"
                            ? "待处理"
                            : notice === "正在检查状态"
                              ? "检查中"
                              : notice}
                      </Badge>
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SelectionMotionGroup>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
