import { QueryClient } from "@tanstack/react-query";

import { client } from "./generated/client.gen";
import type { ErrorEnvelope } from "./generated/types.gen";
import { apiErrorMessage } from "../lib/api-errors";

export * as api from "./generated/sdk.gen";
export type * from "./generated/types.gen";

export const sessionKey = ["session"] as const;

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
});

client.interceptors.request.use((request) => {
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
  if (response.status === 401 && !/\/session(?:\/login)?$|\/setup$/.test(new URL(request.url).pathname)) {
    window.dispatchEvent(new Event("perpay:session-expired"));
  }
  return response;
});

export async function result<Data>(request: Promise<{
  data?: Data | undefined; error?: unknown; response?: Response | undefined;
}>): Promise<Data> {
  const response = await request;
  if (!response.response?.ok) {
    if (response.error instanceof Error && response.error.name === "AbortError") throw response.error;
    throw new ApiError(response.response, response.error);
  }
  if (response.response.status !== 204 && !response.response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(response.response, { error: { code: "invalid_response", message: "服务未返回有效的 JSON，请检查反向代理配置。" } });
  }
  return response.data as Data;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (attempt, error) => attempt < 1 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false, gcTime: 0 },
  },
});

export async function refreshOperationalData(): Promise<void> {
  await queryClient.invalidateQueries({ predicate: (query) => !["session", "settings"].includes(String(query.queryKey[0])) });
}
