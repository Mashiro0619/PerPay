import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRef, useState } from "react";
import { MoreHorizontal, Code, ExternalLink } from "lucide-react";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { useOverlayContext } from "@/lib/overlay-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TechnicalDetails, TechnicalDetailsDialog } from "./DetailPrimitives";
export type RecordAction = {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: (trigger: HTMLButtonElement | null) => void;
  to?: string;
};
export function RecordTools({
  data,
  identifiers = [],
  actions = [],
  to,
  label = "记录操作",
  inline = false,
  technical = true,
}: {
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
  actions?: readonly RecordAction[];
  to?: string | undefined;
  label?: string;
  inline?: boolean;
  technical?: boolean;
}) {
  const overlay = useOverlayContext();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  if (!technical && actions.length === 0 && !to) return null;
  return (
    <>
      <div className={cn("flex min-w-0 flex-wrap justify-end gap-2", inline && "inline-flex shrink-0", overlay && technical && "w-full flex-col items-stretch")} data-record-tools>
        {((technical && !overlay) || actions.length > 0 || to) &&
        <DropdownMenu>
          <Tooltip><TooltipTrigger render={<DropdownMenuTrigger
            render={
              <Button
                ref={trigger}
                variant="ghost"
                size="sm"
                className={cn(overlay && "h-auto min-h-8 max-w-full whitespace-normal", overlay && technical && "w-fit self-end")}
                aria-label={label === "更多操作" ? label : `更多操作，${label}`}
              />
            }
          >
            <MoreHorizontal data-icon="inline-start" />
            {overlay ? label : "更多操作"}
          </DropdownMenuTrigger>} /><TooltipContent>{label}</TooltipContent></Tooltip>
          <DropdownMenuContent align="end">
            {actions.length > 0 && (
              <>
                <DropdownMenuGroup>
                  {actions.map((action) => (
                    <DropdownMenuItem
                      key={action.label}
                      variant={action.danger ? "destructive" : "default"}
                      disabled={action.disabled}
                      render={action.to ? <Link to={action.to} /> : undefined}
                      onClick={() => action.onSelect?.(trigger.current)}
                    >
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                {(to || (technical && !overlay)) && <DropdownMenuSeparator />}
              </>
            )}
            <DropdownMenuGroup>
              {technical && !overlay && <DropdownMenuItem onClick={() => setOpen(true)}>
                <Code />
                技术详情
              </DropdownMenuItem>}
              {to && (
                <DropdownMenuItem render={<Link to={to} />}>
                  <ExternalLink />
                  查看详情
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>}
        {technical && overlay && <TechnicalDetails title={label.replace(/操作$/, "") + "技术信息"} data={data} identifiers={identifiers} />}
      </div>
      {technical && !overlay && <TechnicalDetailsDialog
        open={open}
        onOpenChange={setOpen}
        finalFocus={() => trigger.current}
        data={data}
        identifiers={identifiers}
      />}
    </>
  );
}
