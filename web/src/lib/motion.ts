import { useSyncExternalStore } from "react";

export const motionEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const motionQuery = "(prefers-reduced-motion: reduce)";

function subscribeMotion(listener: () => void) {
  const preference = window.matchMedia?.(motionQuery);
  preference?.addEventListener("change", listener);
  return () => preference?.removeEventListener("change", listener);
}

export function prefersReducedMotion() {
  return window.matchMedia?.(motionQuery).matches ?? false;
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => true);
}

export function playMotion(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
  if (!element.animate || document.hidden || prefersReducedMotion()) return () => {};
  const preference = window.matchMedia?.(motionQuery);
  let animation: Animation;
  try { animation = element.animate(frames, { easing: motionEase, ...options }); } catch { return () => {}; }
  let stopped = false;
  const detach = () => {
    preference?.removeEventListener("change", stop);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    animation.cancel();
    detach();
  };
  const onVisibilityChange = () => { if (document.hidden) stop(); };
  preference?.addEventListener("change", stop);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void animation.finished.then(detach, detach);
  return stop;
}
