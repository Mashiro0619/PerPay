import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverlayActionsContext, useOverlayContext } from "@/lib/overlay-context";
import { cn } from "@/lib/utils";

/** Portalled submit buttons must keep their explicit `form` attribute. */
export function OverlayActions({ children, className }: { children: ReactNode; className?: string }) {
  const overlay = useOverlayContext();
  const target = useContext(OverlayActionsContext);
  const content = <div data-overlay-actions className={cn("flex flex-wrap items-center justify-end gap-2", className)}>{children}</div>;
  if (!overlay) return content;
  return target ? createPortal(content, target) : null;
}
