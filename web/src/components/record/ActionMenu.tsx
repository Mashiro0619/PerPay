import { useRef, type ReactNode, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import { Link } from "@/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { RecordAction } from "@/components/detail/RecordTools";

export type { RecordAction };

/** A single action shown as a plain text button. */
export function ActionButton({ action }: { action: RecordAction }) {
  const trigger = useRef<HTMLButtonElement>(null);
  if (action.to && !action.disabled) return <Link to={action.to} className={buttonVariants({ variant: "ghost", size: "sm" })}>{action.label}</Link>;
  return <Button ref={trigger} type="button" variant="ghost" size="sm" disabled={action.disabled}
    className={action.danger ? "text-destructive hover:text-destructive" : undefined}
    onClick={() => action.onSelect?.(trigger.current)}>{action.label}</Button>;
}

/**
 * Actions collected behind one trigger. `onSelect` receives the trigger so a
 * dialog opened from the menu can return focus to it.
 */
export function ActionMenu({ actions, label, text, extra, triggerRef, align = "end" }: {
  actions: readonly RecordAction[];
  /** Accessible name of the trigger, such as "更多操作，订单操作". */
  label: string;
  /** Visible text beside the icon; an icon-only trigger when omitted. */
  text?: string;
  /** Additional menu items below the actions. */
  extra?: ReactNode;
  /** Lets the owner return focus to the trigger after a dialog opened from `extra`. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  align?: "start" | "end";
}) {
  const own = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? own;
  const extras = Array.isArray(extra) ? extra.length > 0 && extra : extra;
  if (!actions.length && !extras) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button ref={trigger} type="button" variant="ghost" size={text ? "sm" : "icon-sm"} aria-label={label} />}>
      <MoreHorizontal data-icon={text ? "inline-start" : undefined} aria-hidden="true" />
      {text}
    </DropdownMenuTrigger>
    <DropdownMenuContent align={align}>
      {actions.length > 0 && <DropdownMenuGroup>
        {actions.map(action => <DropdownMenuItem key={action.label} variant={action.danger ? "destructive" : "default"} disabled={action.disabled}
          render={action.to ? <Link to={action.to} /> : undefined} onClick={() => action.onSelect?.(trigger.current)}>{action.label}</DropdownMenuItem>)}
      </DropdownMenuGroup>}
      {actions.length > 0 && extras && <DropdownMenuSeparator />}
      {extras && <DropdownMenuGroup>{extras}</DropdownMenuGroup>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
