import { TableRow } from "./ui/table";
import { cn } from "cn";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

function followRowLink(event: ReactMouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented || ![0, 1].includes(event.button)) return;
  if (
    event.target instanceof Element &&
    event.target.closest(
      "a, button, input, select, textarea, label, summary, [role=button], [contenteditable]",
    )
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

export function LinkedTableRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <TableRow
      className={cn(
        "cursor-pointer has-[[data-row-link]:focus-visible]:ring-2 has-[[data-row-link]:focus-visible]:ring-ring",
        className,
      )}
      role="row"
      onClick={followRowLink}
      onAuxClick={followRowLink}
    >
      {children}
    </TableRow>
  );
}
