import { useState } from "react";
import {
  EllipsisVerticalIcon,
  CircleUserRoundIcon,
  LogOutIcon,
} from "lucide-react";
import { Link } from "@/navigation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export function NavUser({
  name,
  pending,
  onLogout,
}: {
  name: string;
  pending: boolean;
  onLogout: () => void;
}) {
  const { isMobile, state } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const showTooltip = state === "collapsed" && !isMobile;
  const triggerButton = (
    <SidebarMenuButton
      size="lg"
      aria-label={`${name.slice(0, 2).toUpperCase()} ${name} 管理员，账户菜单`}
      className="aria-expanded:bg-muted"
    />
  );
  const triggerContent = (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg">
          {name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>{" "}
      <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
        <span className="truncate font-medium">{name}</span>{" "}
        <span className="truncate text-xs text-muted-foreground">
          管理员
        </span>
      </div>
      <EllipsisVerticalIcon className="ml-auto group-data-[collapsible=icon]:hidden" />
    </>
  );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          {showTooltip ? (
            <Tooltip disabled={menuOpen}>
              <DropdownMenuTrigger
                render={<TooltipTrigger render={triggerButton} />}
              >
                {triggerContent}
              </DropdownMenuTrigger>
              <TooltipContent side="right" align="center">
                {`账户菜单 · ${name}`}
              </TooltipContent>
            </Tooltip>
          ) : (
            <DropdownMenuTrigger render={triggerButton}>
              {triggerContent}
            </DropdownMenuTrigger>
          )}
          <DropdownMenuContent
            className="min-w-[min(14rem,calc(100dvw-2rem))] max-w-[calc(100dvw-2rem)]"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/settings/security" />}>
                <CircleUserRoundIcon />
                账户与安全
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={pending} onClick={onLogout}>
                <LogOutIcon />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
