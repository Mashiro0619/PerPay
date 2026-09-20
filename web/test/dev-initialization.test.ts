import { describe, expect, it, vi } from "vitest";
import {
  adminInitialization,
  withBackendInitialization,
} from "../dev/initialization";

const html =
  '<html><head><meta name="perpay-initialized" content="__PERPAY_INITIALIZED__" /></head><body>Vite application</body></html>';
const backend = "http://127.0.0.1:6190";
const stateHtml = (state: string) =>
  '<html><head><meta name="perpay-initialized" content="' +
  state +
  '" /></head></html>';

describe("Vite administrator initialization bridge", () => {
  it.each(["true", "false"])(
    "uses the backend's explicit %s state without exposing its document",
    async (state) => {
      const request = vi.fn(
        async (_url: RequestInfo | URL, _options?: RequestInit) =>
          new Response(stateHtml(state) + "<script>backendOnly()</script>"),
      );
      const rendered = await withBackendInitialization(html, backend, request);
      expect(rendered).toBe(html.replace("__PERPAY_INITIALIZED__", state));
      expect(rendered).not.toContain("backendOnly");
      expect(request).toHaveBeenCalledOnce();
      const [url, options] = request.mock.calls[0]!;
      expect(String(url)).toBe(backend + "/admin/");
      expect(options).toMatchObject({
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "text/html" },
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("reads initialization again on each page load instead of caching first-run forever", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(stateHtml("false")))
      .mockResolvedValueOnce(new Response(stateHtml("true")));
    expect(await withBackendInitialization(html, backend, request)).toContain(
      'content="false"',
    );
    expect(await withBackendInitialization(html, backend, request)).toContain(
      'content="true"',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["__PERPAY_INITIALIZED__", "unknown", "true-ish", "", "FALSE"])(
    "preserves unknown state for malformed backend metadata: %s",
    async (state) => {
      expect(
        await withBackendInitialization(
          html,
          backend,
          vi.fn(async () => new Response(stateHtml(state))),
        ),
      ).toBe(html);
    },
  );

  it.each([404, 503])(
    "never interprets HTTP %s as an uninitialized instance",
    async (status) => {
      expect(
        await withBackendInitialization(
          html,
          backend,
          vi.fn(async () => new Response(stateHtml("false"), { status })),
        ),
      ).toBe(html);
    },
  );

  it("leaves retryable unknown state when the backend cannot be reached", async () => {
    expect(
      await withBackendInitialization(
        html,
        backend,
        vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      ),
    ).toBe(html);
  });

  it("does not replace an already resolved production document or run during a build", async () => {
    const request = vi.fn();
    expect(
      await withBackendInitialization(stateHtml("true"), backend, request),
    ).toBe(stateHtml("true"));
    expect(request).not.toHaveBeenCalled();
    expect(adminInitialization(backend).apply).toBe("serve");
  });
});
