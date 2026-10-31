import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { onlineManager, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";

type RequestNoticeInput = {
  error?: unknown;
  paused?: boolean;
  retainedData?: boolean;
  retry?: (() => void) | undefined;
  showDiagnostics?: boolean;
};

export type RequestNotice = {
  error: unknown;
  paused: boolean;
  retainedData: boolean;
  retry: (() => void) | undefined;
  showDiagnostics: boolean;
  retryAt: number;
};

/** Only explicitly shared reads participate; command failures stay at their action. */
export function isSharedRequestError(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.code.startsWith("update_check_")) return false;
    if (error.code === "invalid_response") return true;
    return error.status >= 500 || error.status === 429 ||
      (error.status === 0 && error.code === "request_failed");
  }
  return error instanceof Error && error.name !== "AbortError";
}

const emptyNotices: readonly RequestNotice[] = [];

class RequestNoticeStore {
  private entries = new Map<string, RequestNotice>();
  private deadlines = new WeakMap<Error, number>();
  private listeners = new Set<() => void>();
  private snapshot: readonly RequestNotice[] = emptyNotices;

  constructor(private readonly client: QueryClient) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  set(id: string, notice: Omit<RequestNotice, "retryAt">) {
    const error = notice.error;
    let retryAt = 0;
    if (error instanceof ApiError && error.retryAfter !== null &&
        Number.isFinite(error.retryAfter) && error.retryAfter > 0) {
      const existing = this.deadlines.get(error);
      if (existing !== undefined) retryAt = existing;
      else {
        const query = this.client.getQueryCache().findAll({
          predicate: item => item.state.error === error,
        })[0];
        retryAt = (query?.state.errorUpdatedAt || Date.now()) + error.retryAfter * 1000;
        this.deadlines.set(error, retryAt);
      }
    }
    this.entries.set(id, { ...notice, retryAt });
    this.publish();
  }

  remove(id: string) {
    if (this.entries.delete(id)) this.publish();
  }

  private publish() {
    this.snapshot = this.entries.size ? [...this.entries.values()] : emptyNotices;
    this.listeners.forEach(listener => listener());
  }
}

const RequestNoticeContext = createContext<RequestNoticeStore | null>(null);

function subscribeConnection(listener: () => void) {
  const unsubscribe = onlineManager.subscribe(listener);
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    unsubscribe();
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useRequestConnectionOnline() {
  return useSyncExternalStore(subscribeConnection,
    () => onlineManager.isOnline() && navigator.onLine,
    () => true);
}

function ConnectionNotice() {
  const online = useRequestConnectionOnline();
  usePageRequestNotice({ paused: !online });
  return null;
}

export function RequestNoticeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [store] = useState(() => new RequestNoticeStore(client));
  return <RequestNoticeContext value={store}>
    <ConnectionNotice />
    {children}
  </RequestNoticeContext>;
}

/** A modal must keep its recovery controls inside the active focus scope. */
export function LocalRequestNotices({ children }: { children: ReactNode }) {
  return <RequestNoticeContext value={null}>{children}</RequestNoticeContext>;
}

export function usePageRequestNotice(input: RequestNoticeInput | null): boolean {
  const store = useContext(RequestNoticeContext);
  const id = useId();
  const error = input?.error;
  const paused = input?.paused ?? false;
  const retainedData = input?.retainedData ?? false;
  const showDiagnostics = input?.showDiagnostics ?? true;
  const retry = input?.retry;
  const retryRef = useRef(retry);
  useLayoutEffect(() => { retryRef.current = retry; });
  const runRetry = useCallback(() => { retryRef.current?.(); }, []);
  const canRetry = retry !== undefined;
  const shared = store !== null && (paused || isSharedRequestError(error));

  useLayoutEffect(() => {
    if (!store || !shared) return;
    store.set(id, {
      error, paused, retainedData, showDiagnostics,
      retry: canRetry ? runRetry : undefined,
    });
    return () => store.remove(id);
  }, [store, id, shared, error, paused, retainedData, showDiagnostics, canRetry, runRetry]);
  return shared;
}

const subscribeNone = () => () => {};
const getEmptyNotices = () => emptyNotices;

export function useRequestNotices() {
  const store = useContext(RequestNoticeContext);
  return useSyncExternalStore(store?.subscribe ?? subscribeNone,
    store?.getSnapshot ?? getEmptyNotices, getEmptyNotices);
}
