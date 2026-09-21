import type { LucideIcon } from "lucide-react";
import { Link } from "@/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type NavigationItem = { title: string; url: string; icon: LucideIcon };
export const isNavigationItemActive = (pathname: string, url: string) =>
  pathname === url || (url !== "/" && pathname.startsWith(url + "/"));

export function NavMain({
  items,
  pathname,
}: {
  items: NavigationItem[];
  pathname: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                tooltip={item.title}
                isActive={isNavigationItemActive(pathname, item.url)}
                aria-current={isNavigationItemActive(pathname, item.url) ? "page" : undefined}
                render={<Link to={item.url} />}
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
