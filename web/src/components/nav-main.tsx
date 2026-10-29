import type { LucideIcon } from "lucide-react";
import { Link } from "@/navigation";
import type { NavigationSection } from "@/lib/navigation-selection";
import {
  SelectionMotionGroup,
  SelectionMotionIndicator,
} from "@/components/selection-motion";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type NavigationItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  section?: NavigationSection;
  active?: boolean;
  global?: boolean;
};

export function isNavigationItemActive(pathname: string, url: string) {
  const path = pathname.split(/[?#]/)[0]!;
  const target = url.split(/[?#]/)[0]!;
  return (
    path === target ||
    (target !== "/" &&
      !/^\/sites\/[^/]+$/.test(target) &&
      path.startsWith(target.replace(/\/settings\/basic$/, "/settings") + "/"))
  );
}

export function navigationItemActive(pathname: string, item: NavigationItem) {
  return item.active ?? isNavigationItemActive(pathname, item.url);
}

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
        <SelectionMotionGroup>
          <SidebarMenu className="gap-1" data-selection-motion="sidebar">
            {items.map((item) => {
              const active = navigationItemActive(pathname, item);
              return (
                <SidebarMenuItem key={item.section ?? item.url}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={active}
                    aria-current={active ? "page" : undefined}
                    // The live sidebar indicator owns this navigation feedback;
                    // a full-page View Transition would hide it under snapshots.
                    render={
                      <Link
                        global={item.global}
                        to={item.url}
                        viewTransition={false}
                      />
                    }
                  >
                    <SelectionMotionIndicator
                      active={active}
                      variant="sidebar"
                    />
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SelectionMotionGroup>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
