import { useLayoutEffect, useRef, useState } from "react";
import type { TableSize } from "@/lib/table-columns";

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

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return { ref, size, isSummary: size.container > 0 && size.container < SUMMARY_WIDTH_REM * size.rem };
}
