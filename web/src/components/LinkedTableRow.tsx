import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

function followRowLink(event: ReactMouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented || ![0, 1].includes(event.button)) return;
  if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, label, summary, [role=button], [contenteditable]")) return;
  if (window.getSelection()?.toString()) return;
  const link = event.currentTarget.querySelector<HTMLAnchorElement>("a[data-row-link]");
  if (!link) return;
  event.preventDefault();
  link.dispatchEvent(new MouseEvent(event.button === 1 ? "auxclick" : "click", {
    bubbles: true, cancelable: true,
    button: event.button, buttons: event.buttons,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
  }));
}

export function LinkedTableRow({ children }: { children: ReactNode }) {
  return <tr className="linked-table-row" role="row" onClick={followRowLink} onAuxClick={followRowLink}>{children}</tr>;
}
