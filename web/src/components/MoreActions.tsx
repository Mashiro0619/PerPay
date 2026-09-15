import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import { Link } from "../navigation";
import { Button } from "./ui";

export interface MenuAction { label: string; onSelect?: () => void; to?: string; danger?: boolean; disabled?: boolean; }
export function MoreActions({ actions, label = "更多操作" }: { actions: readonly MenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false); const [position, setPosition] = useState({ top: 0, left: 0 });
  const menu = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null); const last = useRef(false); const id = useId();
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); }
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const reposition = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && menu.current?.contains(event.target)) return;
      if (!menu.current || !trigger.current) return;
      const box = trigger.current.getBoundingClientRect(); const bounds = menu.current.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) { setOpen(false); return; }
      setPosition({ left: Math.max(12, Math.min(box.right - bounds.width, window.innerWidth - bounds.width - 12)), top: Math.max(12, box.bottom + bounds.height + 8 > window.innerHeight ? box.top - bounds.height - 6 : box.bottom + 6) });
    };
    reposition();
    const items = menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
    if (!menu.current.contains(document.activeElement)) (last.current ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    if (!items.length) menu.current.focus({ preventScroll: true });
    window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open, actions.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); };
  }, [open]);
  if (!actions.length) return null;
  return <><Button ref={trigger} variant="quiet" className="more-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label}
    onClick={() => { last.current = false; setOpen(value => !value); }} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); last.current = event.key === "ArrowUp"; setOpen(true); } }}><Ellipsis size={17} aria-hidden="true" /><span>更多</span></Button>
    {open && createPortal(<div ref={menu} id={id} role="menu" tabIndex={-1} aria-label={label} className="action-menu" style={position} onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(true);
      else if (items.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus({ preventScroll: true }); }
    }}>{actions.map(action => action.to && !action.disabled ? <Link key={action.label} to={action.to} role="menuitem" tabIndex={-1} onClick={() => close()}>{action.label}</Link> : <button key={action.label} type="button" role="menuitem" tabIndex={-1} className={action.danger ? "is-danger" : undefined} disabled={action.disabled} onClick={() => { close(true); action.onSelect?.(); }}>{action.label}</button>)}</div>, document.body)}
  </>;
}
