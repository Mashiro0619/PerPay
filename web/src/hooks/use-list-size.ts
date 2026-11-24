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
    function measure() {
      const viewport = window.innerWidth;
      const container = ref.current?.getBoundingClientRect().width || viewport;
      const rem =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;
      setSize((previous) =>
        previous.viewport === viewport &&
        previous.container === container &&
        previous.rem === rem
          ? previous
          : { viewport, container, rem },
      );
    }

    const throttled = createRafCoalescer(measure);
    measure();
    let initialObserve = true;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (initialObserve) {
              initialObserve = false;
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
