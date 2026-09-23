import { useId, type ComponentProps } from "react";
import {
  isNavigationItemActive,
  type NavigationItem,
} from "@/components/nav-main";
import { Link } from "@/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
} from "@/components/ui/sidebar";
export function NavSecondary({
  items,
  pathname,
  notice = null,
  ...props
}: {
  items: NavigationItem[];
  pathname: string;
  notice?: string | null;
} & ComponentProps<typeof SidebarGroup>) {
  const noticeId = useId();
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                render={<Link to={item.url} />}
                aria-describedby={
                  item.url === "/system" && notice ? noticeId : undefined
                }
                isActive={isNavigationItemActive(pathname, item.url)}
                aria-current={
                  isNavigationItemActive(pathname, item.url)
                    ? "page"
                    : undefined
                }
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
              {item.url === "/system" && notice && (
                <SidebarMenuBadge id={noticeId} data-runtime-notice>
                  {notice === "有运行告警"
                    ? "需关注"
                    : notice === "有待处理事项"
                      ? "待处理"
                      : notice === "正在检查状态"
                        ? "检查中"
                        : notice}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
