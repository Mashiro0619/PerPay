import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { LayoutGroup, motion } from "motion/react";
import { animate } from "motion/mini";
import { useReducedMotion } from "@/lib/motion";

const ReducedSelectionMotion = createContext<boolean | null>(null);
const selectionTransition = {
  layout: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
};

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function useStaticMotion() {
  const reduced = useReducedMotion();
  const hidden = useSyncExternalStore(subscribeVisibility, () => document.hidden, () => true);
  return reduced || hidden;
}

/** Scope a shared indicator without wrapping or replacing its actual controls. */
export function SelectionMotionGroup({ children }: { children: ReactNode }) {
  const id = useId();
  const reduced = useStaticMotion();
  return (
    <ReducedSelectionMotion value={reduced}>
      <LayoutGroup id={id}>{children}</LayoutGroup>
    </ReducedSelectionMotion>
  );
}

export function SelectionMotionIndicator({
  active,
  variant = "fill",
}: {
  active: boolean;
  variant?: "fill" | "underline" | "sidebar";
}) {
  const controlId = useId();
  const reduced = useContext(ReducedSelectionMotion);
  if (reduced === null) {
    throw new Error("Selection indicators require SelectionMotionGroup");
  }
  if (!active) return null;

  // Replacing only this decoration stops in-flight layout motion immediately.
  // The button/link and its focus, value and mounted content remain untouched.
  if (reduced) {
    return (
      <span
        aria-hidden="true"
        data-selection-indicator={variant}
        data-selection-mode="static"
      />
    );
  }
  return (
    <motion.span
      aria-hidden="true"
      data-selection-indicator={variant}
      data-selection-mode="motion"
      layoutId="selection"
      // Query results may move the entire control group during first load.
      // Only changing selection should animate this decoration between controls.
      layoutDependency={controlId}
      initial={false}
      transition={selectionTransition}
    />
  );
}

type SeriesMotion = {
  element: SVGElement;
  animation: ReturnType<typeof animate>;
};

/** Animate only plotted marks; axes, exact values and controls stay fully opaque. */
export function useChartSeriesMotion(
  ref: RefObject<HTMLDivElement | null>,
  token: string,
) {
  const previousToken = useRef(token);
  const frame = useRef<number | null>(null);
  const running = useRef<SeriesMotion | null>(null);
  const stationary = useStaticMotion();
  const finish = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const series = running.current;
    running.current = null;
    if (!series) return;
    series.animation.stop();
    series.element.style.removeProperty("opacity");
  }, []);

  useLayoutEffect(() => {
    const changed = previousToken.current !== token;
    previousToken.current = token;
    if (stationary) {
      finish();
      return;
    }
    if (!changed) return;

    const previous = running.current?.element;
    const current = previous ? Number.parseFloat(getComputedStyle(previous).opacity) : 0.95;
    finish();
    // Recharts commits its new SVG marks after its chart state has settled.
    // One frame selects the new group without retaining or cloning old marks.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (document.hidden) return;
      const element = ref.current?.querySelector<SVGElement>(".trend-series-motion");
      if (!element) return;
      const opacity = element === previous && Number.isFinite(current)
        ? Math.min(1, Math.max(0.95, current))
        : 0.95;
      // Do not translate/scale SVG data coordinates or dim surrounding text.
      let animation: ReturnType<typeof animate>;
      try {
        animation = animate(element, { opacity: [opacity, 1] }, {
          duration: 0.18,
          ease: [0.22, 1, 0.36, 1],
        });
      } catch {
        // A missing/disabled Web Animations API cannot prevent reading data.
        return;
      }
      const series = { element, animation };
      running.current = series;
      const restore = () => {
        if (running.current !== series) return;
        running.current = null;
        element.style.removeProperty("opacity");
      };
      void Promise.resolve(series.animation).then(restore, restore);
    });
  }, [token, stationary, finish, ref]);

  useLayoutEffect(() => finish, [finish]);
}
