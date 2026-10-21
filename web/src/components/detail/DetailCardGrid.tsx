import { Children, isValidElement, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Pack whole cards without changing their DOM order, keys or component state. */
export function DetailCardGrid({ children, className }: { children: ReactNode; className?: string }) {
  const container = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const grid = container.current;
    if (!grid) return;
    const items = Array.from(grid.children) as HTMLElement[];
    const contents = items.map(item => item.firstElementChild as HTMLElement);
    const reset = () => {
      grid.removeAttribute("data-measured");
      for (const item of items) item.style.removeProperty("grid-row-end");
    };

    // A static measurement cannot keep expanding evidence safe. Leave the
    // ordinary grid in place when ongoing size observation is unavailable.
    if (typeof ResizeObserver === "undefined") {
      reset();
      return;
    }

    const measure = () => {
      const width = grid.getBoundingClientRect().width;
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap);
      const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 16;
      const sizes = contents.map(content => content.getBoundingClientRect());
      if (!items.length || !Number.isFinite(width) || width <= 0 ||
        sizes.some(size => !Number.isFinite(size.height) || size.height < 0 || size.width <= 0)) {
        reset();
        return;
      }

      // Read every natural border box before writing spans. The inner content
      // never stretches to its grid area, so these writes cannot inflate it.
      for (const [index, item] of items.entries()) {
        const span = "span " + Math.max(1, Math.ceil(sizes[index]!.height + spacing));
        if (item.style.gridRowEnd !== span) item.style.gridRowEnd = span;
      }
      if (grid.dataset.measured !== "true") grid.dataset.measured = "true";
    };

    let frame: number | null = null;
    let active = true;
    const observer = new ResizeObserver(() => {
      if (!active || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (active) measure();
      });
    });

    measure();
    observer.observe(grid);
    for (const content of contents) observer.observe(content);
    return () => {
      active = false;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [children, className]);

  return (
    <div ref={container} className={cn("detail-card-grid min-w-0", className)} data-detail-card-grid>
      {Children.toArray(children).map((child, index) => (
        <div key={isValidElement(child) ? child.key : index} className="min-w-0" data-detail-grid-item>
          <div className="flow-root min-w-0" data-detail-grid-content>{child}</div>
        </div>
      ))}
    </div>
  );
}
