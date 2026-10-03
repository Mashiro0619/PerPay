import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRef, type ReactNode, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";

export function ListActionsMenu({
  label,
  disabled = false,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: (trigger: RefObject<HTMLButtonElement | null>) => ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
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
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>} /><TooltipContent>{label}</TooltipContent></Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>{children(trigger)}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
