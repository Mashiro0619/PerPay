import { describe, expect, it, vi } from "vitest";

import { waitFor } from "@testing-library/react";
import { api, ApiError, invalidateSessionRequests, queryClient, readCsrfToken, result } from "../src/api/client";
import { client } from "../src/api/generated/client.gen";
import { apiError, json } from "./fixtures";

describe("administrator API boundary", () => {
  it("cancels old session requests without preventing requests from the next session", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = vi.fn((request: Request) => request.method === "PUT"
      ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(json({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const pending = result(api.updateBackupSettings({ body: { revision: 1, interval_seconds: 3600, keep_count: 7 } }));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]![0].signal;
    invalidateSessionRequests();
    expect(signal.aborted).toBe(true);
    finish(json({ data: { revision: 2 } }));
    await rejected;
    await expect(result(api.listAdministratorOrders())).resolves.toEqual({ data: [] });
    expect(fetchMock.mock.calls[1]![0].signal.aborted).toBe(false);
  });

  it("never sends a queued write after its session was invalidated", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const pending = result(api.updateBackupSettings({ body: { revision: 1, interval_seconds: 3600, keep_count: 7 } }));
    invalidateSessionRequests();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expire the next session because an old request returns 401", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const expired = vi.fn(); window.addEventListener("perpay:session-expired", expired);
    try {
      const pending = result(api.listAdministratorOrders());
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      invalidateSessionRequests();
      finish(apiError("session_invalid", "old session", 401));
      await rejected;
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener("perpay:session-expired", expired); }
  });

  it("ignores a response body that finishes parsing after session invalidation", async () => {
    let finish: () => void = () => {};
    let reading = false;
    const response = json({ data: [] });
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>((resolve) => {
      reading = true; finish = () => resolve('{"data":[]}');
    }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const pending = result(api.listAdministratorOrders());
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(reading).toBe(true));
    invalidateSessionRequests(); finish();
    await rejected;
  });

  it("blocks mutation success callbacks belonging to a discarded session", async () => {
    let finish: (value: string) => void = () => {};
    const mutate = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const onSuccess = vi.fn();
    const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: mutate, onSuccess });
    const pending = mutation.execute(undefined);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    invalidateSessionRequests(); finish("old result");
    await rejected;
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("localizes server errors without dropping diagnostics", () => {
    const error = new ApiError(new Response(null, { status: 409 }), { error: { code: "candidate_set_changed", message: "candidate set changed", request_id: "evidence-123" } });
    expect(error.message).toContain("候选证据已变化");
    expect(error.requestId).toBe("evidence-123");
    expect(error.code).toBe("candidate_set_changed");
  });
  it("prefers the host-prefixed CSRF cookie and tolerates malformed encoding", () => {
    expect(readCsrfToken("perpay_csrf=old; __Host-perpay_csrf=current")).toBe("current");
    expect(readCsrfToken("perpay_csrf=%ZZ")).toBeNull();
    expect(readCsrfToken("unrelated=value")).toBeNull();
  });

  it("reads the current CSRF cookie for each write without persisting session secrets", async () => {
    const fetchMock = vi.fn(async () => json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "perpay_csrf=first-token; Path=/";
    await result(api.updateBackupSettings({ body: { revision: 1, interval_seconds: 3600, keep_count: 7 } }));
    document.cookie = "perpay_csrf=rotated-token; Path=/";
    await result(api.updateBackupSettings({ body: { revision: 2, interval_seconds: 3600, keep_count: 7 } }));
    const requests = fetchMock.mock.calls as unknown as Array<[Request]>;
    expect(requests[0]![0].headers.get("x-csrf-token")).toBe("first-token");
    expect(requests[1]![0].headers.get("x-csrf-token")).toBe("rotated-token");
    expect(requests[0]![0].credentials).toBe("same-origin");
    expect(requests[0]![0].cache).toBe("no-store");
    expect(requests[0]![0].headers.get("origin")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("preserves rate limit and request ID details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "auth_rate_limited", message: "请稍后重试", request_id: "request-123" } }, 429, { "retry-after": "60" })));
    await expect(result(api.loginAdministrator({ body: { password: "not-a-real-password" } }))).rejects.toMatchObject({ status: 429, retryAfter: 60, requestId: "request-123", message: "请稍后重试" });
  });

  it("reports network failures and rejects HTML masquerading as API data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network failed"); }));
    await expect(result(api.getAdministratorSession())).rejects.toMatchObject({ status: 0, name: "ApiError" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>proxy error</html>", { headers: { "content-type": "text/html" } })));
    await expect(result(api.getAdministratorSession())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("prevents configured cross-origin requests before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client.setConfig({ baseUrl: "https://untrusted.example.test" });
    try { await expect(result(api.getAdministratorSession())).rejects.toBeInstanceOf(ApiError); expect(fetchMock).not.toHaveBeenCalled(); }
    finally { client.setConfig({ baseUrl: window.location.origin }); }
  });

  it("signals expired sessions without treating incorrect login as an expired session", async () => {
    const expired = vi.fn();
    window.addEventListener("perpay:session-expired", expired);
    vi.stubGlobal("fetch", vi.fn(async () => apiError("session_invalid", "登录已失效", 401)));
    try {
      await expect(result(api.listAdministratorOrders())).rejects.toBeInstanceOf(ApiError);
      expect(expired).toHaveBeenCalledTimes(1);
      await expect(result(api.loginAdministrator({ body: { password: "incorrect-password" } }))).rejects.toBeInstanceOf(ApiError);
      expect(expired).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("perpay:session-expired", expired); }
  });
});
