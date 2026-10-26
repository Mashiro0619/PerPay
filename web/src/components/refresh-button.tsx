import type { ComponentProps } from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePageActionMenu } from "@/components/page-header-actions";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
export function RefreshButton({ busy = false, disabled, ...props }: Omit<ComponentProps<typeof Button>, "children" | "title"> & { busy?: boolean }) {
  const menu = usePageActionMenu();
  if (menu) {
    const { variant: _variant, size: _size, ...buttonProps } = props;
    return <DropdownMenuItem className="w-full" nativeButton disabled={disabled || busy} render={<ButtonPrimitive {...buttonProps} type="button" />}>
      {busy ? <Spinner aria-hidden="true" /> : <RefreshCw />}
      刷新
    </DropdownMenuItem>;
  }
  return <Tooltip><TooltipTrigger render={<Button {...props} variant={props.variant ?? "ghost"} size={props.size ?? "icon"} aria-label="刷新" disabled={disabled || busy} />}>
    {busy ? <Spinner aria-hidden="true" /> : <RefreshCw />}
    <span data-refresh-label className="sr-only">刷新</span>
  </TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>;
}
