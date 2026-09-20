import { expect, it, vi } from "vitest";

const entry = vi.hoisted(() => ({
  createBrowserRouter: vi.fn((_routes: unknown, _options: unknown) => ({})),
  render: vi.fn(),
}));
vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: entry.render })),
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  createBrowserRouter: entry.createBrowserRouter,
}));

it.each([
  ["/admin", "/admin/"],
  ["/admin?from=preview#main", "/admin/?from=preview#main"],
  ["/admin/", "/admin/"],
  ["/admin/login?from=preview", "/admin/login?from=preview"],
  ["/admin/orders?payment=UNPAID#row", "/admin/orders?payment=UNPAID#row"],
])(
  "keeps the Vite base canonical before creating the router at %s",
  async (initial, expected) => {
    vi.resetModules();
    entry.createBrowserRouter.mockClear();
    entry.render.mockClear();
    const originalUrl = window.location.href;
    const originalState = window.history.state;
    window.history.replaceState({ preserved: "history-state" }, "", initial);
    const replace = vi.spyOn(window.history, "replaceState");
    const mount = document.createElement("div");
    mount.id = "root";
    document.body.append(mount);
    vi.stubEnv("BASE_URL", "/admin/");
    try {
      await import("../src/main");
      expect(
        window.location.pathname +
          window.location.search +
          window.location.hash,
      ).toBe(expected);
      expect(window.history.state).toEqual({ preserved: "history-state" });
      expect(replace).toHaveBeenCalledTimes(initial === expected ? 0 : 1);
      expect(entry.createBrowserRouter).toHaveBeenCalledOnce();
      expect(entry.createBrowserRouter.mock.calls[0]?.[1]).toEqual({
        basename: "/admin/",
      });
      expect(entry.render).toHaveBeenCalledOnce();
    } finally {
      replace.mockRestore();
      window.history.replaceState(originalState, "", originalUrl);
      vi.unstubAllEnvs();
      mount.remove();
    }
  },
);
