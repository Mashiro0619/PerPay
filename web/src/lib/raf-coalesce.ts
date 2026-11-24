/**
 * Throttles rapid observer or viewport callbacks to at most one leading call
 * and one trailing animation-frame call per burst.
 */
export function createRafCoalescer(callback: () => void) {
  let frameId = 0;
  let pending = false;
  return {
    schedule() {
      if (typeof requestAnimationFrame !== "function") {
        callback();
        return;
      }
      if (frameId !== 0) {
        pending = true;
        return;
      }
      callback();
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        if (pending) {
          pending = false;
          callback();
        }
      });
    },
    cancel() {
      if (frameId !== 0 && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
      frameId = 0;
      pending = false;
    },
  };
}
