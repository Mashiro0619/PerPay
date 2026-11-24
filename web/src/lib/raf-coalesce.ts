/**
 * Throttles rapid observer or viewport callbacks to at most one leading call
 * and one trailing animation-frame call per burst.
 */
export function createRafCoalescer(callback: () => void) {
  let frameId = 0;
  let pending = false;
  function flush() {
    frameId = 0;
    if (!pending) return;
    pending = false;
    callback();
    frameId = requestAnimationFrame(flush);
  }
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
      frameId = requestAnimationFrame(flush);
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
