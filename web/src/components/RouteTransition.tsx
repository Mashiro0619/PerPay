import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useViewTransitionState } from "react-router";

import { playMotion } from "../lib/motion";
import { isPrivateRoute } from "../navigation";

export function RouteTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const nativeTransition = useViewTransitionState(pathname);
  const container = useRef<HTMLDivElement>(null);
  const previousPath = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (previousPath.current === pathname) return;
    const initial = previousPath.current === undefined;
    previousPath.current = pathname;
    const element = container.current;
    if (!element || nativeTransition || isPrivateRoute(pathname)) return;
    return playMotion(element, initial
      ? [{ opacity: 0.65, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }]
      : [{ opacity: 0.65 }, { opacity: 1 }], { duration: initial ? 340 : 180 });
  }, [pathname, nativeTransition]);

  return <div className="route-content" data-private-route={isPrivateRoute(pathname) || undefined} ref={container}>{children}</div>;
}
