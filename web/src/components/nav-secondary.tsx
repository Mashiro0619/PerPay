import type { ComponentProps } from "react";
import { isNavigationItemActive, type NavigationItem } from "@/components/nav-main";
import { Link } from "@/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
export function NavSecondary({
  items,
  pathname,
  ...props
}: { items: NavigationItem[]; pathname: string } & ComponentProps<
  typeof SidebarGroup
>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                render={<Link to={item.url} />}
                isActive={isNavigationItemActive(pathname, item.url)}
                aria-current={isNavigationItemActive(pathname, item.url) ? "page" : undefined}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
