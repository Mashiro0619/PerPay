import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect } from "vite";
import { describe, expect, it, vi } from "vitest";
import { adminBasePath, redirectBasePath } from "../dev/base-path";

function invoke(url?: string, method = "GET", base = "/admin/") {
  const request = { url, method } as IncomingMessage;
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  redirectBasePath(base)(request, response as unknown as ServerResponse, next);
  return { request, response, next };
}

describe("preview base path compatibility", () => {
  it.each(["GET", "HEAD"])(
    "normalizes a bare /admin %s without touching the request",
    (method) => {
      const { request, response, next } = invoke("/admin", method);
      expect(response.writeHead).toHaveBeenCalledWith(302, {
        Location: "/admin/",
        "Cache-Control": "no-store",
      });
      expect(response.end).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      expect(request.url).toBe("/admin");
    },
  );

  it.each([
    "?from=preview",
    "?return=%2Forders%3Fpayment%3DCONFIRMED",
    "?tag=1&tag=2&empty=&next=https%3A%2F%2Fexample.com",
  ])(
    "preserves the full query string %s on a same-origin redirect",
    (search) => {
      const { response } = invoke("/admin" + search);
      expect(response.writeHead).toHaveBeenCalledWith(302, {
        Location: "/admin/" + search,
        "Cache-Control": "no-store",
      });
    },
  );

  it.each([
    "/",
    "/?from=preview",
    "/admin/",
    "/admin/?from=preview",
    "/admin/login",
    "/admin/orders?payment=UNPAID",
    "/admin/@vite/client",
    "/api/admin/v1/session",
    "/checkout/test",
    "/assets/checkout/theme.js",
    "/administrator",
    "/admin-other",
    "/login",
    "//admin",
    undefined,
  ])("leaves non-entry request %s for the existing router or proxy", (url) => {
    const { response, next } = invoke(url);
    expect(next).toHaveBeenCalledOnce();
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "never redirects %s writes",
    (method) => {
      const { response, next } = invoke("/admin?from=preview", method);
      expect(next).toHaveBeenCalledOnce();
      expect(response.writeHead).not.toHaveBeenCalled();
    },
  );

  it("uses the configured base and does not redirect an already canonical root", () => {
    expect(
      invoke("/nested/admin?from=preview", "GET", "/nested/admin/").response
        .writeHead,
    ).toHaveBeenCalledWith(302, {
      Location: "/nested/admin/?from=preview",
      "Cache-Control": "no-store",
    });
    expect(invoke("/", "GET", "/").next).toHaveBeenCalledOnce();
  });

  it("registers before built-in Vite middleware and is not a production-build hook", () => {
    const plugin = adminBasePath();
    expect(plugin.apply).toBe("serve");
    const use = vi.fn<(handler: Connect.NextHandleFunction) => void>();
    if (typeof plugin.configureServer !== "function")
      throw new Error("Missing preview hook");
    expect(
      Reflect.apply(plugin.configureServer, {}, [
        { config: { base: "/admin/" }, middlewares: { use } },
      ]),
    ).toBeUndefined();
    expect(use).toHaveBeenCalledOnce();
    const response = { writeHead: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    use.mock.calls[0]![0](
      { url: "/admin", method: "GET" } as IncomingMessage,
      response as unknown as ServerResponse,
      next,
    );
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: "/admin/",
      "Cache-Control": "no-store",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
