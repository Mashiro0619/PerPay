const API_ROOT = "/api/admin/v1";

export type JsonObject = Record<string, any>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfter: string | null;

  constructor(status: number, body: JsonObject | null, retryAfter: string | null) {
    super(body?.error?.message || `请求失败（HTTP ${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error?.code || "request_failed";
    this.requestId = body?.error?.request_id || null;
    this.retryAfter = retryAfter;
  }
}

export interface ApiOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly redirectOnUnauthorized?: boolean;
}

export async function api(path: string, options: ApiOptions = {}): Promise<JsonObject> {
  const method = options.method || "GET";
  const headers = new Headers({ Accept: "application/json" });
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = readCsrfCookie();
    if (csrfToken) headers.set("x-csrf-token", csrfToken);
  }

  const response = await fetch(`${API_ROOT}${path}`, init);
  const contentType = response.headers.get("content-type") || "";
  let body: JsonObject | null = null;
  if (contentType.includes("application/json")) {
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = new ApiError(response.status, body, response.headers.get("retry-after"));
    if (response.status === 401 && options.redirectOnUnauthorized !== false) {
      const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
      location.replace(`/admin/login?return_to=${returnTo}`);
    }
    throw error;
  }
  return body ?? {};
}

export function readCsrfCookie(): string | null {
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "perpay_csrf" || name === "__Host-perpay_csrf") {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfter) {
      return `${error.message}，请在 ${error.retryAfter} 秒后重试。`;
    }
    return error.message;
  }
  if (error instanceof TypeError) return "网络连接失败，请检查服务器状态后重试。";
  return error instanceof Error ? error.message : "发生未知错误";
}
