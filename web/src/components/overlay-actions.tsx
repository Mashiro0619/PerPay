import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverlayActionsContext, OverlaySummaryContext, useOverlayContext } from "@/lib/overlay-context";
import { cn } from "@/lib/utils";
import { CardFooter } from "@/components/ui/card";

/** Portalled submit buttons must keep their explicit `form` attribute. */
export function OverlayActions({ children, className }: { children: ReactNode; className?: string }) {
  const overlay = useOverlayContext();
  const target = useContext(OverlayActionsContext);
  const content = <div data-overlay-actions className={cn("flex flex-wrap items-center justify-end gap-2", className)}>{children}</div>;
  if (!overlay) return content;
  return target ? createPortal(content, target) : null;
}

/** Places a record's summary in the overlay's fixed area, so it stays in view while the content scrolls. */
export function OverlaySummary({ children }: { children: ReactNode }) {
  const overlay = useOverlayContext();
  const target = useContext(OverlaySummaryContext);
  if (!overlay) return <>{children}</>;
  return target ? createPortal(children, target) : null;
}

/** A form only keeps its card footer when its actions stay inside that card. */
export function OverlayFormActions({ children, className }: { children: ReactNode; className?: string }) {
  const overlay = useOverlayContext();
  const actions = <OverlayActions className={className}>{children}</OverlayActions>;
  return overlay ? actions : <CardFooter className={className}>{actions}</CardFooter>;
}
