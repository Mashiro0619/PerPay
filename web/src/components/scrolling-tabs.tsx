import { useCallback, useId, useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useReducedMotion } from "@/lib/motion";
import { Button } from "@/components/ui/button";

export function ScrollingTabs({ children }: { children: ReactNode }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const hint = useId();
  const reducedMotion = useReducedMotion();
  const measure = useCallback(() => {
    if (!scroller || scroller.clientWidth === 0) return;
    const before = scroller.scrollLeft > 1;
    const after = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    setEdges(previous => previous.before === before && previous.after === after ? previous : { before, after });
  }, [scroller]);
  const reveal = useCallback((tab: HTMLElement | null) => {
    if (!scroller || !tab || scroller.clientWidth === 0) return;
    const viewport = scroller.getBoundingClientRect();
    const style = getComputedStyle(scroller);
    const left = viewport.left + scroller.clientLeft + (Number.parseFloat(style.paddingLeft) || 0);
    const right = viewport.left + scroller.clientLeft + scroller.clientWidth - (Number.parseFloat(style.paddingRight) || 0);
    const bounds = tab.getBoundingClientRect();
    const delta = bounds.left < left || bounds.width > right - left
      ? bounds.left - left
      : bounds.right > right ? bounds.right - right : 0;
    // Base UI moves tab focus without scrolling. Reveal it in this strip only,
    // so keyboard navigation and text reflow never move the surrounding page.
    if (Math.abs(delta) > 1) scroller.scrollLeft += delta;
    measure();
  }, [scroller, measure]);
  useLayoutEffect(() => {
    if (!scroller) return;
    const resized = () => {
      measure();
      const focused = document.activeElement instanceof HTMLElement && scroller.contains(document.activeElement)
        ? document.activeElement.closest<HTMLElement>('[role="tab"]') : null;
      reveal(focused ?? scroller.querySelector<HTMLElement>('[aria-selected="true"]'));
    };
    resized();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);
    observer?.observe(scroller);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    window.addEventListener("resize", resized);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resized); };
  }, [children, scroller, measure, reveal]);
  function scroll(direction: number) {
    scroller?.scrollBy({ left: direction * Math.max(100, scroller.clientWidth * .65), behavior: reducedMotion ? "instant" : "smooth" });
  }
  return <div className="flex min-w-0 items-center gap-1" data-settings-tabs-navigation>
    <Button variant="ghost" size="icon-sm" aria-label="向前滚动设置分类" hidden={!edges.before && !edges.after} disabled={!edges.before} onClick={() => scroll(-1)}><ChevronLeft /></Button>
    <div ref={setScroller} className="no-scrollbar min-w-0 flex-1 scroll-p-1 overflow-x-auto p-1" data-settings-tabs-scroll onScroll={measure}
      onFocusCapture={event => {
        // Moving a pointer-focused tab can cancel the touch's following click.
        if (event.target.matches(":focus-visible")) reveal(event.target.closest<HTMLElement>('[role="tab"]'));
      }}
      aria-describedby={edges.before || edges.after ? hint : undefined}>
      {children}
    </div>
    <Button variant="ghost" size="icon-sm" aria-label="向后滚动设置分类" hidden={!edges.before && !edges.after} disabled={!edges.after} onClick={() => scroll(1)}><ChevronRight /></Button>
    <span id={hint} className="sr-only">还有设置分类，可横向滚动；方向键移动焦点，Enter 或空格打开分类。</span>
  </div>;
}
