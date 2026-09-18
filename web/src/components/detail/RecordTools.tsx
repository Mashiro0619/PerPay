import { useRef, useState } from "react";
import { MoreHorizontal, Code, ExternalLink } from "lucide-react";
import { Link } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DetailFields } from "./DetailPrimitives";
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
    <Collapsible open={open} onOpenChange={setOpen}>
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
              <DropdownMenuItem onClick={() => setOpen(!open)}>
                <Code />
                {open ? "收起技术详情" : "技术详情"}
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
      <CollapsibleContent>
        <div className="flex min-w-0 flex-col gap-4 pt-4">
          {identifiers.length > 0 && (
            <DetailFields
              items={identifiers
                .filter(
                  (entry): entry is readonly [string, string] => !!entry[1],
                )
                .map(([name, value]) => [
                  name,
                  <CopyValue value={value} label={"复制" + name} />,
                ])}
            />
          )}
          <pre
            tabIndex={0}
            aria-label="技术详情"
            className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs"
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
