import { useLayoutEffect, useState, type CSSProperties } from "react";
import { createRafCoalescer } from "@/lib/raf-coalesce";

type Viewport = { width: number; height: number; left: number; top: number };

/** The keyboard and pinch zoom can shrink the visible area without a layout resize. */
export function useOverlayViewport(): CSSProperties {
  const [viewport, setViewport] = useState<Viewport | null>(null);
  useLayoutEffect(() => {
    const visible = window.visualViewport;
    const measure = () => {
      const next = {
        width: visible?.width ?? window.innerWidth,
        height: visible?.height ?? window.innerHeight,
        left: visible?.offsetLeft ?? 0,
        top: visible?.offsetTop ?? 0,
      };
      setViewport(previous => previous && Object.keys(next).every(key => previous[key as keyof Viewport] === next[key as keyof Viewport]) ? previous : next);
    };
    const throttled = createRafCoalescer(measure);
    measure();
    visible?.addEventListener("resize", throttled.schedule);
    visible?.addEventListener("scroll", throttled.schedule, { passive: true });
    window.addEventListener("resize", throttled.schedule);
    return () => {
      throttled.cancel();
      visible?.removeEventListener("resize", throttled.schedule);
      visible?.removeEventListener("scroll", throttled.schedule);
      window.removeEventListener("resize", throttled.schedule);
    };
  }, []);
  return viewport ? {
    "--overlay-viewport-width": `${viewport.width}px`,
    "--overlay-viewport-height": `${viewport.height}px`,
    "--overlay-viewport-left": `${viewport.left}px`,
    "--overlay-viewport-top": `${viewport.top}px`,
  } as CSSProperties : {};
}
