import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteTransition } from "../src/components/RouteTransition";
import { SelectionIndicator } from "../src/components/SelectionIndicator";
import { motionEase } from "../src/lib/motion";
import { Link, isPrivateRoute, useNavigate } from "../src/navigation";

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
const originalViewTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");

afterEach(() => {
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else delete (Element.prototype as Partial<Element>).animate;
  if (originalViewTransition) Object.defineProperty(document, "startViewTransition", originalViewTransition);
  else delete (document as Partial<Document>).startViewTransition;
});

function motionEnvironment({ reduced = false, hidden = false } = {}) {
  const media = Object.assign(new EventTarget(), { matches: reduced });
  const removeListener = vi.spyOn(media, "removeEventListener");
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; finish: () => void }> = [];
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const cancel = vi.fn(finish);
    animations.push({ cancel, finish });
    return { cancel, finished };
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value: animate });
  return { media, removeListener, visibility, animate, animations };
}

function mount() {
  const router = createMemoryRouter([{ path: "*", element: <RouteTransition><input aria-label="草稿" defaultValue="" /><button>保存</button></RouteTransition> }], { initialEntries: ["/orders"] });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("route motion lifecycle", () => {
  it("keeps content interactive while the route animates", () => {
    const { animate, animations } = motionEnvironment();
    mount();
    expect(animate).toHaveBeenCalledWith([
      { opacity: 0.65, transform: "translateY(8px)" }, { opacity: 1, transform: "none" },
    ], { duration: 340, easing: motionEase });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(screen.getByLabelText("草稿")).toBeVisible();
    expect(animations[0]!.cancel).not.toHaveBeenCalled();
  });

  it("preserves form DOM and values across route motion without replaying for query changes", async () => {
    const { animate, animations } = motionEnvironment();
    const { router, container } = mount();
    const input = screen.getByLabelText("草稿");
    await userEvent.setup().type(input, "尚未保存");
    await act(async () => { await router.navigate("/orders/example"); });
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("草稿")).toBe(input);
    expect(input).toHaveValue("尚未保存");
    await act(async () => { await router.navigate("/orders/example?tab=events"); });
    expect(animate).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue("尚未保存");
    expect(container.querySelector("[style]")).toBeNull();
    await act(async () => { await router.navigate("/orders"); });
    expect(animate.mock.calls.at(-1)?.[0]).toEqual([
      { opacity: 0.65 }, { opacity: 1 },
    ]);
  });

  it("keeps reduced-motion navigation immediate without moving the page", () => {
    const { animate } = motionEnvironment({ reduced: true });
    mount();
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("草稿")).toBeVisible();
  });

  it("cancels immediately when the motion preference changes", () => {
    const { media, animations, removeListener } = motionEnvironment();
    mount();
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("stops a running animation when the page becomes hidden", () => {
    const { visibility, animations } = motionEnvironment();
    mount();
    visibility.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it("does not start background animations", () => {
    const { animate } = motionEnvironment({ hidden: true });
    mount();
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("草稿")).toBeVisible();
  });

  it("releases listeners on completion and cancels on unmount", async () => {
    const { animations, removeListener } = motionEnvironment();
    const { unmount } = mount();
    await act(async () => { animations[0]!.finish(); });
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
    unmount();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it("works without the Web Animations API", () => {
    motionEnvironment();
    delete (Element.prototype as Partial<Element>).animate;
    mount();
    expect(screen.getByLabelText("草稿")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("does not turn an animation failure into a page failure", () => {
    const { animate } = motionEnvironment();
    animate.mockImplementation(() => { throw new Error("Animation unavailable"); });
    mount();
    expect(screen.getByLabelText("草稿")).toBeVisible();
  });
});

describe("selection continuity", () => {
  function group(active: number, underline = false) {
    return <nav aria-label="测试选择"><SelectionIndicator active={active} underline={underline} />{[0, 1, 2].map((index) => <button key={index} data-position={index} aria-pressed={active === index}>{index}</button>)}</nav>;
  }

  function geometry() {
    let visual: DOMRect | null = null;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.tagName.toLowerCase() === "rect") return visual ?? new DOMRect(Number(this.getAttribute("x")), Number(this.getAttribute("y")), Number(this.getAttribute("width")), Number(this.getAttribute("height")));
      if (this instanceof HTMLButtonElement) return new DOMRect(12, Number(this.dataset.position) * 50, 150, 44);
      return new DOMRect(0, 0, 180, 144);
    });
    return (bounds: DOMRect) => { visual = bounds; };
  }

  it("moves one marker from its current visible position when interrupted", () => {
    const { animate, animations } = motionEnvironment();
    const setVisual = geometry();
    const { rerender, container } = render(group(0));
    expect(animate).not.toHaveBeenCalled();
    rerender(group(1));
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: "translate(0px, -50px) scale(1, 1)" }, { transform: "none" },
    ]);
    setVisual(new DOMRect(12, 18, 150, 44));
    rerender(group(2));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(animate.mock.calls[1]?.[0][0]).toEqual({ transform: "translate(0px, -82px) scale(1, 1)" });
    expect(container.querySelector("rect")).toHaveAttribute("y", "100");
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelectorAll(".selection-indicator")).toHaveLength(1);
  });

  it("uses the same marker for underlines and immediately honors reduced motion", () => {
    const { animate, media, animations } = motionEnvironment();
    geometry();
    const { rerender, container } = render(group(0, true));
    expect(container.querySelector("rect")).toHaveAttribute("height", "2");
    expect(container.querySelector("rect")).toHaveAttribute("y", "42");
    rerender(group(1, true));
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    rerender(group(2, true));
    expect(animate).toHaveBeenCalledOnce();
    expect(container.querySelector("rect")).toHaveAttribute("y", "142");
  });

  it("keeps the selected state visible without animation support and releases work on unmount", () => {
    const { animations } = motionEnvironment();
    geometry();
    const { rerender, container, unmount } = render(group(0));
    rerender(group(1));
    expect(container.querySelector(".selection-indicator")).toHaveAttribute("data-ready");
    unmount();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    delete (Element.prototype as Partial<Element>).animate;
    const next = render(group(2));
    expect(next.container.querySelector("rect")).toHaveAttribute("y", "100");
    expect(next.container.querySelector(".selection-indicator")).toHaveAttribute("data-ready");
  });
});

describe("safe native route transitions", () => {
  function navigation(pathname = "/orders") {
    function Links() {
      const navigate = useNavigate();
      return <><Link to="/work-items">待处理</Link><Link to="/settings/security">安全</Link><button onClick={() => { void navigate("/notifications"); }}>通知</button></>;
    }
    const router = createMemoryRouter([{ path: "*", element: <Links /> }], { initialEntries: [pathname] });
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
    render(<RouterProvider router={router} />);
    return navigate;
  }

  it("opts real links and programmatic navigation into continuity, not private surfaces", async () => {
    motionEnvironment();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: vi.fn() });
    const navigate = navigation();
    const user = userEvent.setup();
    expect(screen.getByRole("link", { name: "待处理" })).toHaveAttribute("href", "/work-items");
    await user.click(screen.getByRole("link", { name: "待处理" }));
    expect(navigate).toHaveBeenLastCalledWith("/work-items", expect.objectContaining({ viewTransition: true }));
    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(navigate).toHaveBeenLastCalledWith("/notifications", expect.objectContaining({ viewTransition: true }));
    await user.click(screen.getByRole("link", { name: "安全" }));
    expect(navigate).toHaveBeenLastCalledWith("/settings/security", expect.objectContaining({ viewTransition: false }));
  });

  it.each(["/settings/provider", "/test-payment", "/login", "/setup"])("never snapshots private content from %s", async (pathname) => {
    motionEnvironment();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: vi.fn() });
    const navigate = navigation(pathname);
    expect(isPrivateRoute(pathname)).toBe(true);
    await userEvent.setup().click(screen.getByRole("link", { name: "待处理" }));
    expect(navigate).toHaveBeenLastCalledWith("/work-items", expect.objectContaining({ viewTransition: false }));
  });

  it("reacts to a changed motion preference before the next navigation", async () => {
    const { media } = motionEnvironment();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: vi.fn() });
    const navigate = navigation();
    act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
    await userEvent.setup().click(screen.getByRole("link", { name: "待处理" }));
    expect(navigate).toHaveBeenLastCalledWith("/work-items", expect.objectContaining({ viewTransition: false }));
  });
});
