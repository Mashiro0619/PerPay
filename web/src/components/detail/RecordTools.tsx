import { useRef, useState } from "react";
import { MoreHorizontal, Code, ExternalLink } from "lucide-react";
import { Link } from "@/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TechnicalDetailsDialog } from "./DetailPrimitives";
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
}: {
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
  actions?: readonly RecordAction[];
  to?: string | undefined;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={trigger}
                variant="ghost"
                size="sm"
                aria-label={label}
              />
            }
          >
            <MoreHorizontal data-icon="inline-start" />
            更多操作
          </DropdownMenuTrigger>
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
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setOpen(true)}>
                <Code />
                技术详情
              </DropdownMenuItem>
              {to && (
                <DropdownMenuItem render={<Link to={to} />}>
                  <ExternalLink />
                  单独打开
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <TechnicalDetailsDialog
        open={open}
        onOpenChange={setOpen}
        finalFocus={() => trigger.current}
        data={data}
        identifiers={identifiers}
      />
    </>
  );
}
