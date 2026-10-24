import { useLayoutEffect, useState, type CSSProperties } from "react";

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
    measure();
    visible?.addEventListener("resize", measure);
    visible?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      visible?.removeEventListener("resize", measure);
      visible?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);
  return viewport ? {
    "--overlay-viewport-width": `${viewport.width}px`,
    "--overlay-viewport-height": `${viewport.height}px`,
    "--overlay-viewport-left": `${viewport.left}px`,
    "--overlay-viewport-top": `${viewport.top}px`,
  } as CSSProperties : {};
}
