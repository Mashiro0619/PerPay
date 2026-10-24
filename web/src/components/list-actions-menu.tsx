import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const ListActionsContext = createContext<{
  items: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
} | null>(null);

/** Append shared list settings to the page's existing More menu. */
export function ListActionsProvider({
  children,
  items,
  triggerRef,
}: {
  children: ReactNode;
  items: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return <ListActionsContext value={{ items, triggerRef }}>{children}</ListActionsContext>;
}

export function ListActionsMenu({
  label,
  disabled = false,
  children,
}: {
  label: string;
  disabled?: boolean;
  children?: (trigger: RefObject<HTMLButtonElement | null>) => ReactNode;
}) {
  const localTrigger = useRef<HTMLButtonElement | null>(null);
  const shared = useContext(ListActionsContext);
  const trigger = shared?.triggerRef ?? localTrigger;
  return (
    <DropdownMenu>
      <Tooltip><TooltipTrigger render={<DropdownMenuTrigger
        render={
          <Button
            ref={trigger}
            variant="outline"
            size="icon"
            disabled={disabled}
          />
        }
        aria-label={label}
        data-list-actions-trigger
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>} /><TooltipContent>{label}</TooltipContent></Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        {children && <DropdownMenuGroup>{children(trigger)}</DropdownMenuGroup>}
        {children && shared?.items && <DropdownMenuSeparator />}
        {shared?.items && <DropdownMenuGroup>{shared.items}</DropdownMenuGroup>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
