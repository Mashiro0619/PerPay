import { createContext, useContext, useLayoutEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { createRafCoalescer } from "@/lib/raf-coalesce";

type ToolbarHost = { leading: HTMLDivElement | null; controls: HTMLDivElement | null };
const ToolbarContext = createContext<ToolbarHost | null>(null);

/** Remember the last positive measurement during a hidden/zero-width transition. */
export function useMeasuredHeight(node: HTMLElement | null, property: string, owner?: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!node) return;
    const target = owner ?? node.closest<HTMLElement>('[data-slot="sidebar-inset"]') ?? node;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) target.style.setProperty(property, `${rect.height}px`);
    };
    const throttled = createRafCoalescer(measure);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(throttled.schedule);
    observer?.observe(node);
    window.addEventListener("resize", throttled.schedule);
    return () => {
      throttled.cancel();
      observer?.disconnect();
      window.removeEventListener("resize", throttled.schedule);
      target.style.removeProperty(property);
    };
  }, [node, property, owner]);
}

export function ListLayout({ children, className, ...props }: ComponentProps<"div">) {
  const [leading, setLeading] = useState<HTMLDivElement | null>(null);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  useMeasuredHeight(toolbar, "--list-toolbar-height");
  const host = useMemo(() => ({ leading, controls }), [leading, controls]);
  return <ToolbarContext value={host}>
    <div {...props} className={cn("list-layout min-w-0", className)} data-list-layout-root>
      <div ref={setToolbar} className="list-toolbar" data-list-toolbar>
        <div ref={setLeading} className="list-toolbar-part" data-list-toolbar-leading />
        <div ref={setControls} className="list-toolbar-part" data-list-toolbar-controls />
      </div>
      {children}
    </div>
  </ToolbarContext>;
}
/** Move the DOM once, retaining Tabs, query, column and draft contexts. */
export function ListToolbarPart({ children, area = "controls" }: { children: ReactNode; area?: keyof ToolbarHost }) {
  const host = useContext(ToolbarContext);
  if (!host) return <div className="list-toolbar-part">{children}</div>;
  const target = host[area];
  return target ? createPortal(children, target) : null;
}
