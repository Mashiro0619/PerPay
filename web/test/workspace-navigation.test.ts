import { waitFor } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSessionRequests, queryClient, sessionKey, type AdminSessionEnvelope } from "../src/api/client";
import { prepareWorkspaceNavigation } from "../src/lib/workspace-navigation";
import { json, order } from "./fixtures";

function authenticate() {
  queryClient.setQueryData<AdminSessionEnvelope>(sessionKey, { data: {
    username: "admin", csrf_token_required: true,
    idle_expires_at: "2026-12-01T00:00:00Z", absolute_expires_at: "2026-12-01T00:00:00Z",
  } });
}
function site(clientId: string) {
  return { client_id: clientId, revision: 1, configuration: { name: clientId }, deleted_at: null };
}
function deferred() {
  let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>(finish => { resolve = finish; }), resolve: (response: Response) => resolve(response) };
}
function navigation(path: string, signal?: AbortSignal) {
  return new Request("http://localhost/admin" + path, { signal });
}
function scopedOrders(clientId: string) {
  return queryClient.getQueryCache().findAll({ queryKey: ["orders"] })
    .filter(query => (query.queryKey.at(-1) as { workspace?: string })?.workspace === clientId);
}
afterEach(() => { onlineManager.setOnline(true); });

describe("workspace navigation preparation", () => {
  it.each([undefined, null])("leaves cold or anonymous navigation to the authentication boundary (%s)", async session => {
    if (session === null) queryClient.setQueryData(sessionKey, null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leave offline navigation waiting for a paused query", async () => {
    authenticate();
    onlineManager.setOnline(false);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", () => json({ error: { code: "site_not_found", message: "网站不存在" } }, 404)],
    ["forbidden", () => json({ error: { code: "forbidden", message: "无权读取网站" } }, 403)],
    ["mismatched", () => json({ data: site("b") })],
    ["deleted", () => json({ data: { ...site("a"), deleted_at: "2026-10-20T00:00:00Z" } })],
  ] as const)("does not prepare business data when authoritative metadata is %s", async (_kind, response) => {
    authenticate();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      return response();
    }));
    await expect(prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders")).resolves.toBeNull();
    expect(paths).toEqual(["/api/admin/v1/sites/a"]);
    expect(scopedOrders("a")).toHaveLength(0);
  });

  it("waits for metadata, then the target rows, without changing the global cache", async () => {
    authenticate();
    const metadata = deferred(), rows = deferred();
    const paths: string[] = [];
    queryClient.setQueryData(["orders", "global-control"], { data: [order] });
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path.endsWith("/orders") ? rows.promise : metadata.promise;
    }));
    let finished = false;
    const prepared = prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders").then(() => { finished = true; });
    await waitFor(() => expect(paths).toEqual(["/api/admin/v1/sites/a"]));
    expect(finished).toBe(false);
    metadata.resolve(json({ data: site("a") }));
    await waitFor(() => expect(paths).toHaveLength(2));
    expect(paths[1]).toBe("/api/admin/v1/sites/a/orders");
    expect(finished).toBe(false);
    rows.resolve(json({ data: [{ ...order, api_client_id: "a", product_name: "A 订单" }], page: { next_cursor: null } }));
    await prepared;
    expect(scopedOrders("a")[0]?.state.data).toMatchObject({ data: [{ product_name: "A 订单" }] });
    expect(queryClient.getQueryData(["orders", "global-control"])).toEqual({ data: [order] });
  });

  it.each([
    ["/orders", "payment=invalid&checkout=CLOSED&sort_by=unknown&sort_order=wrong&q=%20hello%20&created_from=&created_to=invalid&cursor=opaque", { limit: "20", checkout_status: "CLOSED", sort_by: "created_at", sort_order: "desc", q: "hello", created_from: "", created_to: "invalid", cursor: "opaque" }],
    ["/notifications", "status=DEAD_LETTER&sort_by=attempt_count&sort_order=asc&cursor=opaque", { limit: "20", status: "DEAD_LETTER", sort_by: "attempt_count", sort_order: "asc", cursor: "opaque" }],
    ["/notifications", "status=invalid&sort_by=invalid", { limit: "20", sort_by: "created_at", sort_order: "desc" }],
    ["/work-items", "type=LEDGER_CONFLICT&visibility=IGNORED&sort_by=priority&created_from=ignored", { limit: "20", type: "ALL", visibility: "IGNORED", sort_by: "ignored_at", sort_order: "desc" }],
    ["/work-items", "type=FINANCIAL_EXCEPTION&visibility=invalid&sort_by=ignored_at", { limit: "20", type: "FINANCIAL_EXCEPTION", visibility: "ACTIVE", sort_by: "actionable_at", sort_order: "desc" }],
  ] as const)("preserves the page's filter parsing for %s (%s)", async (localPath, search, expected) => {
    authenticate();
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      urls.push(url);
      return url.pathname === "/api/admin/v1/sites/a" ? json({ data: site("a") }) : json({ data: [], page: { next_cursor: null } });
    }));
    await prepareWorkspaceNavigation(navigation("/sites/a" + localPath + "?" + search), "a", localPath);
    expect(urls).toHaveLength(2);
    expect(urls[1]!.pathname).toBe("/api/admin/v1/sites/a" + (localPath === "/notifications" ? "/webhooks/deliveries" : localPath));
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual(expected);
  });

  it("waits for every independent overview read and uses the first site-overview page globally", async () => {
    authenticate();
    const rows = deferred();
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      urls.push(url);
      if (url.pathname.endsWith("/orders")) return rows.promise;
      if (url.pathname.endsWith("/sites/overview")) return json({ data: [], page: { next_cursor: "second-page" } });
      return json({ data: [], page: { next_cursor: null } });
    }));
    let finished = false;
    const prepared = prepareWorkspaceNavigation(navigation("/?range=7"), null, "/").then(() => { finished = true; });
    await waitFor(() => expect(urls).toHaveLength(5));
    expect(finished).toBe(false);
    expect(urls.map(url => url.pathname)).toEqual(expect.arrayContaining([
      "/api/admin/v1/system/analytics", "/api/admin/v1/settings", "/api/admin/v1/orders",
      "/api/admin/v1/work-items", "/api/admin/v1/sites/overview",
    ]));
    expect(Object.fromEntries(urls.find(url => url.pathname.endsWith("/sites/overview"))!.searchParams)).toEqual({ range: "7", limit: "10" });
    rows.resolve(json({ data: [], page: { next_cursor: null } }));
    await prepared;
    expect(queryClient.getQueryState(["site-overview", 7, 10])?.status).toBe("success");
    expect(urls.filter(url => url.pathname.endsWith("/sites/overview"))).toHaveLength(1);
  });

  it("reuses all three cached site-overview pages without waiting for a stale multi-page refresh", async () => {
    authenticate();
    const cached = {
      pages: [
        { data: [site("first")], page: { next_cursor: "second-page" } },
        { data: [site("second")], page: { next_cursor: "third-page" } },
        { data: [site("third")], page: { next_cursor: null } },
      ],
      pageParams: [null, "second-page", "third-page"],
    };
    const key = ["site-overview", 7, 10];
    queryClient.setQueryData(key, cached, { updatedAt: 1 });
    const before = queryClient.getQueryData(key);
    const slowRefresh = deferred();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/sites/overview")) return slowRefresh.promise;
      return json({ data: [], page: { next_cursor: null } });
    }));
    let finished = false;
    const prepared = prepareWorkspaceNavigation(navigation("/?range=7"), null, "/").then(() => { finished = true; });
    await waitFor(() => expect(finished).toBe(true));
    await prepared;
    expect(paths).not.toContain("/api/admin/v1/sites/overview");
    expect(queryClient.getQueryData(key)).toBe(before);
    expect(queryClient.getQueryData<typeof cached>(key)?.pages).toHaveLength(3);
    expect(queryClient.getQueryData<typeof cached>(key)?.pageParams).toEqual([null, "second-page", "third-page"]);
  });

  it("prepares site overview counts inside their original workspace", async () => {
    authenticate();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path === "/api/admin/v1/sites/a" ? json({ data: site("a") }) : json({ data: [], page: { next_cursor: null } });
    }));
    await prepareWorkspaceNavigation(navigation("/sites/a?range=90"), "a", "/");
    expect(paths).toHaveLength(6);
    expect(paths).toContain("/api/admin/v1/sites/a/work-items/summary");
    expect(paths).not.toContain("/api/admin/v1/sites/overview");
    expect(queryClient.getQueryState(["analytics", 90, "a", { workspace: "a" }])?.status).toBe("success");
  });

  it("prepares the site editor snapshot only after its workspace identity passes", async () => {
    authenticate();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      return json({ data: site("a") });
    }));
    await prepareWorkspaceNavigation(navigation("/sites/a/settings/basic"), "a", "/settings/basic");
    expect(paths).toEqual(["/api/admin/v1/sites/a", "/api/admin/v1/sites/a"]);
    expect(queryClient.getQueryData(["site-editor", "a"])).toMatchObject({ site: { client_id: "a" } });
  });

  it("leaves business read errors in the query cache instead of rejecting the route loader", async () => {
    authenticate();
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => new URL(request.url).pathname.endsWith("/orders")
      ? json({ error: { code: "internal_error", message: "订单读取失败" } }, 500)
      : json({ data: site("a") })));
    await expect(prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders")).resolves.toBeNull();
    expect(scopedOrders("a")[0]?.state.error?.message).toBe("订单读取失败");
  });

  it("ends an aborted metadata wait promptly and never starts its business reads", async () => {
    authenticate();
    const metadata = deferred();
    const controller = new AbortController();
    const fetch = vi.fn(async () => metadata.promise);
    vi.stubGlobal("fetch", fetch);
    const prepared = prepareWorkspaceNavigation(navigation("/sites/a/orders", controller.signal), "a", "/orders");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(prepared).resolves.toBeNull();
    metadata.resolve(json({ data: site("a") }));
    await waitFor(() => expect(queryClient.getQueryState(["workspace-site", "a"])?.status).toBe("success"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not continue preparation when the authenticated session disappears", async () => {
    authenticate();
    const metadata = deferred();
    const fetch = vi.fn(async () => metadata.promise);
    vi.stubGlobal("fetch", fetch);
    const prepared = prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    queryClient.setQueryData(sessionKey, null);
    metadata.resolve(json({ data: site("a") }));
    await expect(prepared).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps preparing the first screen when a session refresh only extends its idle expiry", async () => {
    authenticate();
    const metadata = deferred(), rows = deferred();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path.endsWith("/orders") ? rows.promise : metadata.promise;
    }));
    let finished = false;
    const prepared = prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders").then(() => { finished = true; });
    await waitFor(() => expect(paths).toHaveLength(1));
    queryClient.setQueryData<AdminSessionEnvelope>(sessionKey, previous => ({
      data: { ...previous!.data, idle_expires_at: "2026-12-01T01:00:00Z" },
    }));
    metadata.resolve(json({ data: site("a") }));
    await waitFor(() => expect(paths).toEqual(["/api/admin/v1/sites/a", "/api/admin/v1/sites/a/orders"]));
    expect(finished).toBe(false);
    rows.resolve(json({ data: [order], page: { next_cursor: null } }));
    await prepared;
    expect(scopedOrders("a")[0]?.state.status).toBe("success");
  });

  it("does not continue after session requests are invalidated at the metadata completion boundary", async () => {
    authenticate();
    let invalidated = false;
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (!invalidated && event.type === "updated" && event.action.type === "success" &&
        event.query.queryKey[0] === "workspace-site") {
        // Metadata has passed its own request-generation check, but the loader has not resumed yet.
        invalidated = true;
        invalidateSessionRequests();
        authenticate();
      }
    });
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path.endsWith("/orders") ? json({ data: [], page: { next_cursor: null } }) : json({ data: site("a") });
    }));
    try {
      await expect(prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders")).resolves.toBeNull();
      expect(invalidated).toBe(true);
      expect(queryClient.getQueryState(["workspace-site", "a"])?.status).toBe("success");
      expect(paths).toEqual(["/api/admin/v1/sites/a"]);
      expect(scopedOrders("a")).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("releases the route when the network goes offline during metadata preparation", async () => {
    authenticate();
    const metadata = deferred();
    const fetch = vi.fn(async () => metadata.promise);
    vi.stubGlobal("fetch", fetch);
    const prepared = prepareWorkspaceNavigation(navigation("/sites/a/orders"), "a", "/orders");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    onlineManager.setOnline(false);
    await expect(prepared).resolves.toBeNull();
    metadata.resolve(json({ data: site("a") }));
    await waitFor(() => expect(queryClient.getQueryState(["workspace-site", "a"])?.status).toBe("success"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates a late response from an aborted navigation to the original site", async () => {
    authenticate();
    const rows = deferred();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sites/a/orders") return rows.promise;
      if (path.endsWith("/orders")) return json({ data: [{ ...order, product_name: "B 订单" }], page: { next_cursor: null } });
      return json({ data: site(path.endsWith("/a") ? "a" : "b") });
    }));
    const first = prepareWorkspaceNavigation(navigation("/sites/a/orders", controller.signal), "a", "/orders");
    await waitFor(() => expect(scopedOrders("a")[0]?.state.fetchStatus).toBe("fetching"));
    controller.abort();
    await first;
    await prepareWorkspaceNavigation(navigation("/sites/b/orders"), "b", "/orders");
    rows.resolve(json({ data: [{ ...order, product_name: "A 迟到订单" }], page: { next_cursor: null } }));
    await waitFor(() => expect(scopedOrders("a")[0]?.state.status).toBe("success"));
    expect(scopedOrders("b")[0]?.state.data).toMatchObject({ data: [{ product_name: "B 订单" }] });
  });
});
