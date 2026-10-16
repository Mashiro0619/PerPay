import { TableRow } from "./ui/table";
import { Item } from "./ui/item";
import { useListDensity, type ListDensity } from "./list-density";
import { cn } from "cn";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

const interactiveTargetSelector =
  "a, button, input, select, textarea, label, summary, [role=button], [contenteditable]";

export function followRowLink(event: ReactMouseEvent<HTMLElement>) {
  if (event.defaultPrevented || ![0, 1].includes(event.button)) return;
  if (
    event.target instanceof Element &&
    event.target.closest(interactiveTargetSelector)
  )
    return;
  if (window.getSelection()?.toString()) return;
  const link =
    event.currentTarget.querySelector<HTMLAnchorElement>("a[data-row-link]");
  if (!link) return;
  event.preventDefault();
  link.dispatchEvent(
    new MouseEvent(event.button === 1 ? "auxclick" : "click", {
      bubbles: true,
      cancelable: true,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    }),
  );
}

type LinkedRowProps = {
  children: ReactNode;
  className?: string;
  rowId?: string;
  "aria-label"?: string;
};

const linkedRowClassName = "cursor-pointer";

export function LinkedTableRow({
  children,
  className,
  rowId,
  "aria-label": ariaLabel,
}: LinkedRowProps) {
  return (
    <TableRow
      className={cn(linkedRowClassName, className)}
      data-business-row={rowId ?? ""}
      role="row"
      aria-label={ariaLabel}
      onClick={followRowLink}
      onAuxClick={followRowLink}
    >
      {children}
    </TableRow>
  );
}

export function LinkedSummaryRow({
  children,
  className,
  rowId,
  density,
  "aria-label": ariaLabel,
}: LinkedRowProps & { density?: ListDensity }) {
  const preferredDensity = useListDensity();
  return (
    <Item
      size={(density ?? preferredDensity) === "compact" ? "xs" : "default"}
      className={cn(
        "business-summary-row min-w-0",
        linkedRowClassName,
        className,
      )}
      data-business-row={rowId ?? ""}
      role="listitem"
      aria-label={ariaLabel}
      onClick={followRowLink}
      onAuxClick={followRowLink}
    >
      {children}
    </Item>
  );
}
