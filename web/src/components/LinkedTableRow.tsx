import { TableRow } from "./ui/table";
import { Item } from "./ui/item";
import { cn } from "cn";
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

const interactiveTargetSelector =
  "a, button, input, select, textarea, label, summary, [role=button], [contenteditable]";

function useRowFeedback() {
  const [pressed, setPressed] = useState(false);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);

  function clear(event: ReactPointerEvent<HTMLElement>) {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    setPressed(false);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      !event.isPrimary ||
      event.button !== 0 ||
      pointer.current ||
      window.getSelection()?.toString()
    )
      return;
    const primary = event.currentTarget.querySelector<HTMLAnchorElement>(
      "a[data-row-link][href]",
    );
    if (!primary) return;
    const interactive =
      event.target instanceof Element
        ? event.target.closest(interactiveTargetSelector)
        : null;
    if (
      interactive &&
      (interactive !== primary || interactive.matches('a[class~="group/button"]'))
    )
      return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setPressed(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (window.getSelection()?.toString() || dx * dx + dy * dy > 64) clear(event);
  }

  return {
    "data-navigation-row": "",
    "data-navigation-pressed": pressed || undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  };
}

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
  const feedback = useRowFeedback();
  return (
    <TableRow
      {...feedback}
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
  "aria-label": ariaLabel,
}: LinkedRowProps) {
  const feedback = useRowFeedback();
  return (
    <Item
      {...feedback}
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
