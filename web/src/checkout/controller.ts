import {
  checkoutState,
  initialCheckoutState,
  parseCheckoutPayload,
  type CheckoutInitial,
  type CheckoutViewOrder,
  type CheckoutViewState,
} from "../../../src/shared/checkout-view";
export interface CheckoutSnapshot {
  order: CheckoutViewOrder | null;
  visual: CheckoutViewState;
  now: number;
  busy: boolean;
  unavailable: boolean;
  suspended: boolean;
  message: string;
  feedback: string;
  retryAt: number;
  qrAvailable: boolean;
}
export function retryDelay(
  value: string | null,
  fallback: number,
  now = Date.now(),
) {
  if (value === null) return fallback;
  const seconds = Number(value),
    date = Date.parse(value);
  const delay =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(date)
        ? date - now
        : fallback;
  return Math.min(60000, Math.max(250, delay));
}
export function createCheckoutController(initial: CheckoutInitial) {
  const listeners = new Set<() => void>();
  let state: CheckoutSnapshot = {
    order: initial.checkout,
    visual: initialCheckoutState(initial),
    now: initial.serverTime,
    busy: false,
    unavailable: false,
    suspended: false,
    message: "",
    feedback: "",
    retryAt: 0,
    qrAvailable: initial.qrAvailable,
  };
  const serverSnapshot = state;
  let alive = false,
    listening = false,
    generation = 0,
    failures = 0,
    active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    tickTimer: ReturnType<typeof setInterval> | undefined;
  let anchor = 0,
    wallAnchor = 0,
    serverTime = initial.serverTime;
  const mono = () => performance.now();
  const emit = (patch: Partial<CheckoutSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const interval = () =>
    state.visual === "UNPAID"
      ? 2500
      : ["CONFIRMED", "DISPUTED"].includes(state.visual)
        ? 30000
        : ["UNAVAILABLE", "RATE_LIMITED"].includes(state.visual)
          ? 2500
          : null;
  const schedule = (delay: number | null) => {
    stopTimer();
    if (
      alive &&
      state.visual !== "NOT_FOUND" &&
      delay !== null &&
      !document.hidden &&
      navigator.onLine
    )
      timer = setTimeout(
        () => void refresh(),
        Math.max(250, delay, state.retryAt - Date.now()),
      );
  };
  function updateClock() {
    const now =
      serverTime + Math.max(0, mono() - anchor, Date.now() - wallAnchor);
    const suspended =
      state.visual === "UNPAID" &&
      (!state.order || Date.parse(state.order.checkout.expires_at) <= now);
    emit({ now, suspended, unavailable: document.hidden || !navigator.onLine });
  }
  function abort() {
    generation++;
    active?.abort();
    active = undefined;
    emit({ busy: false });
    stopTimer();
  }
  function visibility() {
    if (!alive) return;
    if (document.hidden) {
      abort();
      clearInterval(tickTimer);
      emit({ unavailable: true });
    } else {
      updateClock();
      clearInterval(tickTimer);
      tickTimer = setInterval(updateClock, 1000);
      if (interval() !== null) void refresh();
    }
  }
  function offline() {
    if (!alive) return;
    abort();
    emit({
      unavailable: true,
      message: "网络已断开，恢复连接后会继续刷新订单状态。",
    });
  }
  function online() {
    if (!alive) return;
    failures = 0;
    emit({ unavailable: false, message: "网络已恢复，正在刷新订单状态。" });
    if (interval() !== null) void refresh();
  }
  function hide() {
    alive = false;
    abort();
    clearInterval(tickTimer);
  }
  function show(event: PageTransitionEvent) {
    if (event.persisted && state.visual !== "NOT_FOUND") {
      alive = true;
      updateClock();
      serverTime = state.now;
      anchor = mono();
      wallAnchor = Date.now();
      visibility();
    }
  }
  function detach() {
    if (!listening) return;
    listening = false;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", online);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
  }
  async function refresh(manual = false) {
    if (
      !alive ||
      active ||
      document.hidden ||
      !navigator.onLine ||
      !initial.apiUrl ||
      state.visual === "NOT_FOUND"
    )
      return;
    if (Date.now() < state.retryAt) {
      schedule(state.retryAt - Date.now());
      return;
    }
    const target = new URL(initial.apiUrl, location.origin);
    if (target.origin !== location.origin) return;
    stopTimer();
    const controller = new AbortController();
    active = controller;
    const request = ++generation;
    const start = mono();
    let timedOut = false;
    const current = () =>
      alive && generation === request && !controller.signal.aborted;
    emit({ busy: true, feedback: "" });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const response = await fetch(target, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!current()) return;
      if (!response.ok) {
        if (response.status === 404) {
          emit({
            visual: "NOT_FOUND",
            order: null,
            message: "",
            feedback: "",
            qrAvailable: false,
            suspended: false,
          });
          alive = false;
          abort();
          clearInterval(tickTimer);
          detach();
          return;
        }
        if (response.status === 429) {
          const delay = retryDelay(response.headers.get("retry-after"), 1000);
          emit({
            retryAt: Date.now() + delay,
            message: "刷新过于频繁，页面会在稍后继续获取订单状态。",
            ...(!state.order ? { visual: "RATE_LIMITED" as const } : {}),
          });
          schedule(delay);
          return;
        }
        failures++;
        const retryAfter = response.headers.get("retry-after");
        const delay = retryDelay(
          retryAfter,
          Math.min(30000, 1000 * 2 ** Math.min(failures, 5)),
        );
        emit({
          // Manual/visibility retries may bypass local backoff, not a server deadline.
          retryAt: retryAfter === null ? 0 : Date.now() + delay,
          ...(response.status === 503
            ? {
                visual: "UNAVAILABLE" as const,
                qrAvailable: false,
                message: "",
              }
            : {
                message: "订单状态暂时无法刷新，当前显示的是上次获取的结果。",
              }),
        });
        schedule(delay);
        return;
      }
      const payload = await response.json();
      if (!current()) return;
      const order = parseCheckoutPayload(payload);
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) {
        serverTime = date + 1000 + Math.max(0, mono() - start);
        anchor = mono();
        wallAnchor = Date.now();
      }
      failures = 0;
      emit({
        order,
        visual: checkoutState(order),
        message: "",
        retryAt: 0,
        qrAvailable: !!initial.qrUrl,
        feedback:
          manual && checkoutState(order) === "UNPAID"
            ? "已检查，暂未确认付款。"
            : "",
      });
      updateClock();
      schedule(interval());
    } catch {
      if (
        !alive ||
        request !== generation ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      failures++;
      emit({
        message: timedOut
          ? "订单状态刷新超时，页面会自动重试。"
          : "订单状态暂时无法刷新，当前显示的是上次获取的结果。",
      });
      schedule(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    } finally {
      clearTimeout(timeout);
      if (active === controller) {
        active = undefined;
        emit({ busy: false });
      }
    }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    start() {
      if (state.visual === "NOT_FOUND" || !initial.apiUrl) return () => {};
      alive = true;
      const navigation = performance.getEntriesByType?.("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const loadingElapsed = Math.max(
        0,
        mono() - (navigation?.responseStart ?? 0),
      );
      serverTime = Math.max(serverTime, initial.serverTime + loadingElapsed);
      anchor = mono();
      wallAnchor = Date.now();
      const cooldown =
        Math.min(60, initial.initialError?.retryAfterSeconds ?? 0) * 1000;
      emit({ retryAt: cooldown ? Date.now() + cooldown : 0 });
      updateClock();
      tickTimer = setInterval(updateClock, 1000);
      listening = true;
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("offline", offline);
      window.addEventListener("online", online);
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", show);
      schedule(
        initial.initialError
          ? Math.max(2500, cooldown)
          : state.visual === "UNPAID"
            ? 1500
            : interval(),
      );
      return () => {
        alive = false;
        abort();
        clearInterval(tickTimer);
        detach();
      };
    },
  };
}
