import { useLayoutEffect, useRef } from "react";

import { playMotion } from "../lib/motion";

export function SelectionIndicator({ active, underline = false }: { active: string | number; underline?: boolean }) {
  const canvas = useRef<SVGSVGElement>(null);
  const marker = useRef<SVGRectElement>(null);
  const update = useRef<((animate: boolean) => void) | undefined>(undefined);

  useLayoutEffect(() => {
    const surface = canvas.current;
    const rectangle = marker.current;
    const group = surface?.parentElement;
    if (!surface || !rectangle || !group) return;
    let cancel = () => {};
    let positioned = false;
    const measure = (animate: boolean) => {
      const selected = group.querySelector<HTMLElement>('[aria-current="page"], [aria-pressed="true"]');
      const target = selected?.getBoundingClientRect();
      if (!target?.width || !target.height) {
        cancel();
        positioned = false;
        surface.removeAttribute("data-ready");
        return;
      }
      const current = positioned ? rectangle.getBoundingClientRect() : null;
      cancel();
      const bounds = group.getBoundingClientRect();
      const height = underline ? 2 : target.height;
      const top = underline ? target.bottom - height : target.top;
      surface.setAttribute("width", String(group.clientWidth));
      surface.setAttribute("height", String(group.clientHeight));
      rectangle.setAttribute("x", String(target.left - bounds.left - group.clientLeft + group.scrollLeft));
      rectangle.setAttribute("y", String(top - bounds.top - group.clientTop + group.scrollTop));
      rectangle.setAttribute("width", String(target.width));
      rectangle.setAttribute("height", String(height));
      surface.setAttribute("data-ready", "");
      positioned = true;
      if (!animate || !current?.width || !current.height) return;
      const horizontal = current.left - target.left;
      const vertical = current.top - top;
      if (Math.abs(horizontal) + Math.abs(vertical) + Math.abs(current.width - target.width) < 0.5) return;
      cancel = playMotion(rectangle, [
        { transform: `translate(${horizontal}px, ${vertical}px) scale(${current.width / target.width}, ${current.height / height})` },
        { transform: "none" },
      ], { duration: Math.min(360, 240 + Math.hypot(horizontal, vertical) * 0.2) });
    };
    update.current = measure;
    const resize = () => measure(false);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(group);
    window.addEventListener("resize", resize);
    measure(false);
    return () => {
      cancel();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      update.current = undefined;
    };
  }, [underline]);

  useLayoutEffect(() => { update.current?.(true); }, [active]);

  return <svg ref={canvas} className={`selection-indicator ${underline ? "selection-indicator--underline" : ""}`} aria-hidden="true" focusable="false"><rect ref={marker} rx={underline ? 1 : 7} /></svg>;
}
