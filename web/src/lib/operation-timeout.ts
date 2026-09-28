/** Bounds client-side waiting without claiming that a server write was cancelled. */
export async function waitForOperation<T>(
  operation: AbortController,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  operation.signal.throwIfAborted();
  let detach = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(operation.signal.reason);
    operation.signal.addEventListener("abort", abort, { once: true });
    detach = () => operation.signal.removeEventListener("abort", abort);
  });
  const timer = window.setTimeout(
    () => operation.abort(new DOMException("等待操作结果超时", "TimeoutError")),
    20_000,
  );
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        operation.signal.throwIfAborted();
        return execute(operation.signal);
      }),
      aborted,
    ]);
    operation.signal.throwIfAborted();
    return value;
  } catch (error) {
    if (
      operation.signal.reason instanceof DOMException &&
      operation.signal.reason.name === "TimeoutError"
    )
      throw new Error("等待操作结果超时。停止等待不代表服务端已取消操作。");
    throw error;
  } finally {
    window.clearTimeout(timer);
    detach();
  }
}
