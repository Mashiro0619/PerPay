import { MutationCache, QueryClient } from "@tanstack/react-query";

import { client } from "./generated/client.gen";
import type { ErrorEnvelope } from "./generated/types.gen";
import { apiErrorMessage } from "../lib/api-errors";

export * as api from "./generated/sdk.gen";
export type * from "./generated/types.gen";

export const sessionKey = ["session"] as const;
let sessionGeneration = 0;
let sessionController = new AbortController();
const requestGenerations = new WeakMap<Request, number>();
const mutationGenerations = new WeakMap<object, number>();

export function invalidateSessionRequests(): void {
  sessionGeneration += 1;
  const previous = sessionController;
  sessionController = new AbortController();
  client.setConfig({ signal: sessionController.signal });
  previous.abort();
}

function requireCurrentGeneration(generation: number | undefined): void {
  if (generation !== sessionGeneration) throw new DOMException("管理员会话已变化，已忽略旧请求结果。", "AbortError");
}

export function readCsrfToken(cookie = document.cookie): string | null {
  const cookies = new Map(cookie.split(";").map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator).trim(), part.slice(separator + 1)];
  }));
  const value = cookies.get("__Host-perpay_csrf") ?? cookies.get("perpay_csrf");
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(response: Response | undefined, payload: unknown) {
    const envelope = payload as Partial<ErrorEnvelope> | null | undefined;
    const detail = envelope && typeof envelope === "object" ? envelope.error : undefined;
    const message = apiErrorMessage(detail?.code, detail?.message, response?.status);
    super(message);
    this.name = "ApiError";
    this.status = response?.status ?? 0;
    this.code = typeof detail?.code === "string" ? detail.code : "request_failed";
    this.requestId = typeof detail?.request_id === "string" ? detail.request_id : response?.headers.get("x-request-id") ?? null;
    const retryAfter = response?.headers.get("retry-after");
    this.retryAfter = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  }
}

client.setConfig({
  baseUrl: window.location.origin,
  credentials: "same-origin",
  cache: "no-store",
  redirect: "error",
  signal: sessionController.signal,
});

client.interceptors.request.use((request) => {
  request.signal.throwIfAborted();
  requestGenerations.set(request, sessionGeneration);
  if (new URL(request.url).origin !== window.location.origin) {
    throw new Error("管理请求不能发送到其他站点。");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const token = readCsrfToken();
    if (token) request.headers.set("X-CSRF-Token", token);
  }
  return request;
});

client.interceptors.response.use((response, request) => {
  requireCurrentGeneration(requestGenerations.get(request));
  request.signal.throwIfAborted();
  if (response.status === 401 && !/\/session(?:\/login)?$|\/setup$/.test(new URL(request.url).pathname)) {
    window.dispatchEvent(new Event("perpay:session-expired"));
  }
  return response;
});

export async function result<Data>(request: Promise<{
  data?: Data | undefined; error?: unknown; response?: Response | undefined;
}>): Promise<Data> {
  const generation = sessionGeneration;
  const response = await request;
  requireCurrentGeneration(generation);
  if (response.error instanceof Error && response.error.name === "AbortError") throw response.error;
  if (!response.response?.ok) {
    throw new ApiError(response.response, response.error);
  }
  if (response.response.status !== 204 && !response.response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(response.response, { error: { code: "invalid_response", message: "服务未返回有效的 JSON，请检查反向代理配置。" } });
  }
  return response.data as Data;
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onMutate: (_variables, mutation) => { mutationGenerations.set(mutation, sessionGeneration); },
    onSuccess: (_data, _variables, _context, mutation) => { requireCurrentGeneration(mutationGenerations.get(mutation)); },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (attempt, error) => attempt < 1 && error.name !== "AbortError" && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false, gcTime: 0 },
  },
});

export async function refreshOperationalData(): Promise<void> {
  await queryClient.invalidateQueries({ predicate: (query) => !["session", "settings"].includes(String(query.queryKey[0])) });
}
