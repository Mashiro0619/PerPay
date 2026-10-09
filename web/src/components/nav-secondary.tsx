import { useId, type ComponentProps } from "react";
import {
  navigationItemActive,
  type NavigationItem,
} from "@/components/nav-main";
import { Link } from "@/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
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
  return (
    <SidebarGroup {...props}>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => {
            const active = navigationItemActive(pathname, item);
            const system = item.section === "system" || item.url.split(/[?#]/)[0] === "/system";
            return (
              <SidebarMenuItem key={item.section ?? item.url}>
                <SidebarMenuButton
                  render={<Link global={item.global} to={item.url} />}
                  aria-describedby={
                    system && notice ? noticeId : undefined
                  }
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
                {system && notice && (
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
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
