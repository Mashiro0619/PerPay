import { useLayoutEffect, useRef, useState } from "react";
import type { TableSize } from "@/lib/table-columns";
import { createRafCoalescer } from "@/lib/raf-coalesce";

const SUMMARY_WIDTH_REM = 40;

/** Measure the available list space, including sidebar and content-width changes. */
export function useListSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<TableSize>({
    viewport: 0,
    container: 0,
    rem: 16,
  });

  useLayoutEffect(() => {
    let lastViewport = -1;
    let lastContainer = -1;
    let lastRem = -1;
    function readSize(): TableSize {
      const viewport = window.innerWidth;
      const container = ref.current?.getBoundingClientRect().width || viewport;
      const rem =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;
      return { viewport, container, rem };
    }
    function measure() {
      const next = readSize();
      lastViewport = next.viewport;
      lastContainer = next.container;
      lastRem = next.rem;
      setSize((previous) =>
        previous.viewport === next.viewport &&
        previous.container === next.container &&
        previous.rem === next.rem
          ? previous
          : next,
      );
    }

    const throttled = createRafCoalescer(measure);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const next = readSize();
            if (
              next.viewport === lastViewport &&
              next.container === lastContainer &&
              next.rem === lastRem
            ) {
              return;
            }
            throttled.schedule();
          });
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener("resize", throttled.schedule);
    return () => {
      throttled.cancel();
      observer?.disconnect();
      window.removeEventListener("resize", throttled.schedule);
    };
  }, []);

  return { ref, size, isSummary: size.container > 0 && size.container < SUMMARY_WIDTH_REM * size.rem };
}
