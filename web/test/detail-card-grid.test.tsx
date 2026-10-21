import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DetailCardGrid } from "../src/components/detail/DetailCardGrid";

function measuredEnvironment(initialWidth = 900, initialGap = 16) {
  let width = initialWidth;
  let gap = initialGap;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const instances: ControlledObserver[] = [];
  class ControlledObserver {
    readonly targets = new Set<Element>();
    readonly disconnect = vi.fn(() => this.targets.clear());
    constructor(readonly callback: ResizeObserverCallback) { instances.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    notify() { this.callback([], this as unknown as ResizeObserver); }
  }
  vi.stubGlobal("ResizeObserver", ControlledObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  const boundingBox = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-detail-card-grid")) return DOMRect.fromRect({ width });
    if (this.hasAttribute("data-detail-grid-content"))
      return DOMRect.fromRect({ width: width > 0 ? width / 3 : 0, height: Number(this.firstElementChild?.getAttribute("data-height") ?? 0) });
    return boundingBox.call(this);
  });
  const computedStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computedStyle.call(window, element, pseudo);
    return element.hasAttribute("data-detail-card-grid")
      ? new Proxy(style, { get: (target, property) => property === "columnGap" ? gap + "px" : Reflect.get(target, property, target) })
      : style;
  });
  return {
    instances,
    frames,
    resize(nextWidth: number, nextGap = gap) { width = nextWidth; gap = nextGap; },
    notify() { instances.at(-1)!.notify(); },
    flush() {
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback(performance.now()));
      });
    },
  };
}

function Evidence({ name, height = 100 }: { name: string; height?: number }) {
  const [expanded, setExpanded] = useState(false);
  return <section data-height={expanded ? height + 200.5 : height}>
    <label>{name} 草稿<input aria-label={name + " 草稿"} /></label>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{name} 历史</button>
    {expanded && <p>{name} 展开的完整证据</p>}
  </section>;
}

describe("stable detail card grid", () => {
  it("reserves each natural border box and the actual gap before the first frame", () => {
    const environment = measuredEnvironment(900, 12.5);
    const { container } = render(<DetailCardGrid><Evidence key="a" name="A" height={100.3} /><Evidence key="b" name="B" height={55.1} /></DetailCardGrid>);
    const grid = container.querySelector("[data-detail-card-grid]")!;
    const items = [...container.querySelectorAll<HTMLElement>("[data-detail-grid-item]")];
    expect(grid).toHaveAttribute("data-measured", "true");
    expect(items.map(item => item.style.gridRowEnd)).toEqual(["span 113", "span 68"]);
    expect(environment.instances[0]!.targets).toEqual(new Set([grid, ...container.querySelectorAll("[data-detail-grid-content]")]));
  });

  it("reflows expanded evidence and container changes in one frame without losing drafts or focus", () => {
    const environment = measuredEnvironment();
    const { container } = render(<DetailCardGrid><Evidence key="a" name="A" /><Evidence key="b" name="B" height={200} /></DetailCardGrid>);
    const input = screen.getByRole("textbox", { name: "A 草稿" });
    fireEvent.change(input, { target: { value: "保留人工处理理由" } });
    fireEvent.click(screen.getByRole("button", { name: "A 历史" }));
    input.focus();
    environment.resize(640, 20);
    environment.notify();
    environment.notify();
    environment.notify();
    expect(environment.frames.size).toBe(1);
    environment.flush();
    const items = [...container.querySelectorAll<HTMLElement>("[data-detail-grid-item]")];
    expect(items.map(item => item.style.gridRowEnd)).toEqual(["span 321", "span 220"]);
    expect(screen.getByText("A 展开的完整证据")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "A 草稿" })).toBe(input);
    expect(input).toHaveValue("保留人工处理理由");
    expect(input).toHaveFocus();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["A 历史", "B 历史"]);
    expect(environment.frames.size).toBe(0);
  });

  it("retains keyed child state when asynchronous cards are added and removes stale observers", () => {
    const environment = measuredEnvironment();
    const { rerender } = render(<DetailCardGrid><Evidence key="a" name="A" /><Evidence key="b" name="B" /></DetailCardGrid>);
    const input = screen.getByRole("textbox", { name: "A 草稿" });
    fireEvent.change(input, { target: { value: "待处理草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "A 历史" }));
    const previousObserver = environment.instances.at(-1)!;
    environment.notify();
    rerender(<DetailCardGrid><Evidence key="notice" name="通知" /><Evidence key="a" name="A" /><Evidence key="b" name="B" /></DetailCardGrid>);
    expect(previousObserver.disconnect).toHaveBeenCalledOnce();
    expect(environment.frames.size).toBe(0);
    expect(screen.getByRole("textbox", { name: "A 草稿" })).toBe(input);
    expect(input).toHaveValue("待处理草稿");
    expect(screen.getByRole("button", { name: "A 历史" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["通知 历史", "A 历史", "B 历史"]);
  });

  it("keeps a hidden grid in ordinary flow and resumes when a real width is available", () => {
    const environment = measuredEnvironment(0);
    const { container } = render(<DetailCardGrid><Evidence key="a" name="A" /></DetailCardGrid>);
    const grid = container.querySelector("[data-detail-card-grid]")!;
    const item = container.querySelector<HTMLElement>("[data-detail-grid-item]")!;
    expect(grid).not.toHaveAttribute("data-measured");
    expect(item.style.gridRowEnd).toBe("");
    environment.resize(600);
    environment.notify();
    environment.flush();
    expect(grid).toHaveAttribute("data-measured", "true");
    expect(item.style.gridRowEnd).toBe("span 116");
    environment.resize(0);
    environment.notify();
    environment.flush();
    expect(grid).not.toHaveAttribute("data-measured");
    expect(item.style.gridRowEnd).toBe("");
  });

  it("falls back without observation support and cancels pending work when removed", () => {
    const environment = measuredEnvironment();
    const first = render(<DetailCardGrid><Evidence key="a" name="A" /></DetailCardGrid>);
    const observer = environment.instances.at(-1)!;
    environment.notify();
    expect(environment.frames.size).toBe(1);
    first.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(environment.frames.size).toBe(0);
    observer.notify();
    expect(environment.frames.size).toBe(0);
    vi.stubGlobal("ResizeObserver", undefined);
    const fallback = render(<DetailCardGrid><Evidence key="b" name="B" /></DetailCardGrid>);
    expect(fallback.container.querySelector("[data-detail-card-grid]")).not.toHaveAttribute("data-measured");
    expect(fallback.container.querySelector<HTMLElement>("[data-detail-grid-item]")!.style.gridRowEnd).toBe("");
    expect(screen.getByRole("button", { name: "B 历史" })).toBeVisible();
  });
});
