import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation, type To } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, NavLink, useNavigate } from "../src/navigation";

type NavigationKind = "link" | "navlink" | "navigate";
type NavigationProps = { kind: NavigationKind; to: To; viewTransition?: boolean };

function NavigationProbe({ kind, to, viewTransition }: NavigationProps) {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <input aria-label="保留的草稿" defaultValue="未保存内容" />
    <output aria-label="当前位置">{location.pathname + location.search + location.hash}</output>
    {kind === "navigate" ? <button onClick={() => void navigate(to, { global: true, preserveSelectedSite: false, viewTransition })}>切换</button>
      : kind === "navlink" ? <NavLink to={to} preserveSelectedSite={false} viewTransition={viewTransition}>切换</NavLink>
      : <Link global to={to} preserveSelectedSite={false} viewTransition={viewTransition}>切换</Link>}
  </>;
}

const originalTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
afterEach(() => {
  if (originalTransition) Object.defineProperty(document, "startViewTransition", originalTransition);
  else Reflect.deleteProperty(document, "startViewTransition");
});

function mount(path: string, props: NavigationProps) {
  const startViewTransition = vi.fn((update: () => Promise<void> | void) => {
    const updated = Promise.resolve().then(update);
    return { ready: updated, updateCallbackDone: updated, finished: updated, skipTransition: vi.fn() };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
  const router = createMemoryRouter([{ path: "*", element: <NavigationProbe {...props} /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, startViewTransition };
}

async function activate(kind: NavigationKind) {
  await userEvent.setup().click(screen.getByRole(kind === "navigate" ? "button" : "link", { name: "切换" }));
}

describe("workspace selection motion", () => {
  it.each(["link", "navlink", "navigate"] as const)("changes selection through %s without snapshotting or remounting the shared page", async kind => {
    const view = mount("/system?selected_site=a#health", {
      kind,
      to: { pathname: "/system", search: "?selected_site=b", hash: "#health" },
    });
    const draft = screen.getByRole("textbox", { name: "保留的草稿" });
    await userEvent.setup().type(draft, "继续编辑");
    await activate(kind);
    await waitFor(() => expect(view.router.state.location.search).toBe("?selected_site=b"));
    expect(view.router.state.location.hash).toBe("#health");
    expect(view.startViewTransition).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "保留的草稿" })).toBe(draft);
    expect(draft).toHaveValue("未保存内容继续编辑");
    expect(screen.getByRole(kind === "navigate" ? "button" : "link", { name: "切换" })).toHaveFocus();
  });

  it.each([
    ["link", "?selected_site=b"],
    ["navlink", "?selected_site=b"],
    ["navigate", "?selected_site=b"],
    ["link", { search: "?selected_site=b" }],
    ["navlink", { search: "?selected_site=b" }],
    ["navigate", { search: "?selected_site=b" }],
  ] satisfies Array<[NavigationKind, To]>)("resolves a query-only %s selection without a view transition (%j)", async (kind, to) => {
    const view = mount("/system?selected_site=a", { kind, to });
    await activate(kind);
    await waitFor(() => expect(view.router.state.location.search).toBe("?selected_site=b"));
    expect(view.router.state.location.pathname).toBe("/system");
    expect(view.startViewTransition).not.toHaveBeenCalled();
  });

  it("clears the selected website without changing the shared filters or starting a snapshot", async () => {
    const view = mount("/reconciliation?tab=matches&selected_site=a&q=tea#rows", {
      kind: "link", to: "/reconciliation?tab=matches&q=tea#rows",
    });
    await activate("link");
    await waitFor(() => expect(view.router.state.location.search).toBe("?tab=matches&q=tea"));
    expect(view.startViewTransition).not.toHaveBeenCalled();
  });

  it.each([
    ["/orders", "/notifications"],
    ["/reconciliation?tab=matches&selected_site=a", "/reconciliation?tab=exceptions&selected_site=b"],
    ["/system?selected_site=a#health", "/system?selected_site=a#backup"],
  ])("retains ordinary route, filter and hash motion from %s to %s", async (path, to) => {
    const view = mount(path, { kind: "link", to });
    await activate("link");
    await waitFor(() => expect(screen.getByLabelText("当前位置")).toHaveTextContent(to));
    expect(view.startViewTransition).toHaveBeenCalledOnce();
  });

  it.each([
    ["/sites/a", "/system"],
    ["/orders", "/sites/b"],
    ["/orders", "/settings/security"],
  ])("keeps sensitive source or target routes out of snapshots (%s to %s)", async (path, to) => {
    const view = mount(path, { kind: "link", to });
    await activate("link");
    await waitFor(() => expect(view.router.state.location.pathname).toBe(to));
    expect(view.startViewTransition).not.toHaveBeenCalled();
  });

  it.each(["preference", "option"] as const)("keeps the reduced-motion %s effective", async source => {
    if (source === "preference") {
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    }
    const view = mount("/orders", { kind: "navigate", to: "/notifications", ...(source === "option" ? { viewTransition: false } : {}) });
    await activate("navigate");
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/notifications"));
    expect(view.startViewTransition).not.toHaveBeenCalled();
  });
});
