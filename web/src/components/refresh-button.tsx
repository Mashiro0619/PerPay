import type { ComponentProps } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export function RefreshButton({ busy = false, disabled, ...props }: Omit<ComponentProps<typeof Button>, "children" | "title"> & { busy?: boolean }) {
  return <Tooltip><TooltipTrigger render={<Button {...props} variant={props.variant ?? "ghost"} size={props.size ?? "icon"} aria-label="刷新" disabled={disabled || busy} />}>
    {busy ? <Spinner aria-hidden="true" /> : <RefreshCw />}
  </TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>;
}
