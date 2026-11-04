import { StrictMode, createRef, type ComponentProps, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DialogFooter } from "../src/components/ui/dialog";
import { AlertDialogFooter } from "../src/components/ui/alert-dialog";
import { SheetFooter } from "../src/components/ui/sheet";
import { ToastDockContext, useToastDockRegistry } from "../src/lib/toast-layout";

const rects = new Map<string, { y: number; height: number }>();
const resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; disconnect: ReturnType<typeof vi.fn> }> = [];

function DockProvider({ children }: { children: ReactNode }) {
  const { dock, register } = useToastDockRegistry();
  return <ToastDockContext value={register}>
    {children}
    <output data-testid="dock">{dock ? JSON.stringify(dock) : "none"}</output>
  </ToastDockContext>;
}

function Surface({ id, children, ...props }: { id: string; children: ReactNode } & ComponentProps<"div">) {
  return <div data-testid={id} data-slot="dialog-content" data-open {...props}>{children}</div>;
}

function currentDock() {
  return JSON.parse(screen.getByTestId("dock").textContent!) as { bottom: number; maxHeight: number };
}

beforeEach(() => {
  rects.clear();
  resizeObservers.length = 0;
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("ResizeObserver", class {
    readonly targets = new Set<Element>();
    readonly disconnect = vi.fn(() => this.targets.clear());
    constructor(readonly callback: ResizeObserverCallback) { resizeObservers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rect = rects.get(this.dataset.testid ?? "") ?? { y: 0, height: 0 };
    return DOMRect.fromRect({ x: 0, y: rect.y, width: 400, height: rect.height });
  });
});

describe("foreground toast footer docking", () => {
  it("uses the nested foreground footer and restores its parent after the child closes", async () => {
    rects.set("parent", { y: 0, height: 800 });
    rects.set("parent-footer", { y: 700, height: 100 });
    rects.set("child", { y: 100, height: 600 });
    rects.set("child-footer", { y: 540, height: 100 });
    const view = (child: boolean) => <DockProvider>
      <Surface id="parent" data-nested-dialog-open={child ? "" : undefined}>
        <DialogFooter data-testid="parent-footer">父操作</DialogFooter>
        {child && <Surface id="child"><AlertDialogFooter data-testid="child-footer">子操作</AlertDialogFooter></Surface>}
      </Surface>
    </DockProvider>;
    const rendered = render(view(true));
    expect(currentDock()).toEqual({ bottom: 272, maxHeight: 416 });
    rendered.rerender(view(false));
    await waitFor(() => expect(currentDock()).toEqual({ bottom: 112, maxHeight: 676 }));
  });

  it("ignores closing, hidden, and inert surfaces without clearing another active dock", async () => {
    for (const id of ["foreground", "background"]) rects.set(id, { y: 50, height: 700 });
    rects.set("foreground-footer", { y: 500, height: 90 });
    rects.set("background-footer", { y: 680, height: 70 });
    render(<DockProvider>
      <Surface id="foreground"><DialogFooter data-testid="foreground-footer">当前操作</DialogFooter></Surface>
      <Surface id="background" data-ending-style><SheetFooter data-testid="background-footer">关闭中操作</SheetFooter></Surface>
    </DockProvider>);
    expect(currentDock()).toEqual({ bottom: 312, maxHeight: 426 });
    const background = screen.getByTestId("background");
    await act(async () => {
      background.removeAttribute("data-ending-style");
      background.hidden = true;
    });
    expect(currentDock().bottom).toBe(312);
    await act(async () => {
      background.hidden = false;
      background.setAttribute("inert", "");
    });
    expect(currentDock().bottom).toBe(312);
    await act(async () => {
      background.removeAttribute("inert");
      background.setAttribute("data-closed", "");
    });
    expect(currentDock().bottom).toBe(312);
  });

  it("follows activation order for separately portaled surfaces and restores a remaining registration", async () => {
    for (const id of ["first", "second"]) rects.set(id, { y: 0, height: 800 });
    rects.set("first-footer", { y: 500, height: 100 });
    rects.set("second-footer", { y: 600, height: 100 });
    const view = (second: boolean) => <DockProvider>
      <Surface id="first"><DialogFooter data-testid="first-footer">先打开</DialogFooter></Surface>
      {second && <Surface id="second"><SheetFooter data-testid="second-footer">后打开</SheetFooter></Surface>}
    </DockProvider>;
    const rendered = render(view(true));
    expect(currentDock().bottom).toBe(212);
    await act(async () => { screen.getByTestId("second").setAttribute("hidden", ""); });
    await waitFor(() => expect(currentDock().bottom).toBe(312));
    await act(async () => { screen.getByTestId("second").removeAttribute("hidden"); });
    await waitFor(() => expect(currentDock().bottom).toBe(212));
    rendered.rerender(view(false));
    expect(currentDock().bottom).toBe(312);
  });

  it("updates for footer reflow, popup scrolling, and the visual viewport", async () => {
    const viewport = Object.assign(new EventTarget(), { offsetTop: 100, height: 500 });
    vi.stubGlobal("visualViewport", viewport);
    rects.set("popup", { y: 100, height: 500 });
    rects.set("footer", { y: 560, height: 40 });
    render(<DockProvider><Surface id="popup"><div data-testid="scroll"><DialogFooter data-testid="footer">操作</DialogFooter></div></Surface></DockProvider>);
    expect(currentDock()).toEqual({ bottom: 252, maxHeight: 436 });
    const observer = resizeObservers.find(item => item.targets.has(screen.getByTestId("footer")))!;
    rects.set("footer", { y: 440, height: 160 });
    act(() => { observer.callback([], observer as unknown as ResizeObserver); });
    await waitFor(() => expect(currentDock()).toEqual({ bottom: 372, maxHeight: 316 }));
    rects.set("footer", { y: 520, height: 160 });
    act(() => { screen.getByTestId("scroll").dispatchEvent(new Event("scroll")); });
    await waitFor(() => expect(currentDock().bottom).toBe(292));
    viewport.height = 350;
    act(() => { viewport.dispatchEvent(new Event("resize")); });
    await waitFor(() => expect(currentDock()).toEqual({ bottom: 362, maxHeight: 326 }));
  });

  it("keeps feedback in view while an independent footer scrolls into view", async () => {
    rects.set("popup", { y: 50, height: 700 });
    rects.set("footer", { y: 900, height: 80 });
    render(<DockProvider><Surface id="popup"><div data-testid="scroll"><DialogFooter data-testid="footer">滚动后操作</DialogFooter></div></Surface></DockProvider>);
    expect(currentDock()).toEqual({ bottom: 62, maxHeight: 676 });
    rects.set("footer", { y: 600, height: 80 });
    act(() => { screen.getByTestId("scroll").dispatchEvent(new Event("scroll")); });
    await waitFor(() => expect(currentDock()).toEqual({ bottom: 212, maxHeight: 526 }));
  });

  it("preserves forwarded object and callback refs, including cleanup, under StrictMode", () => {
    rects.set("popup", { y: 0, height: 800 });
    rects.set("footer", { y: 600, height: 100 });
    const objectRef = createRef<HTMLDivElement>();
    const cleanup = vi.fn();
    const callbackRef = vi.fn(() => cleanup);
    const rendered = render(<StrictMode><DockProvider><Surface id="popup">
      <DialogFooter data-testid="footer" ref={objectRef}>操作</DialogFooter>
      <AlertDialogFooter ref={callbackRef}>确认</AlertDialogFooter>
    </Surface></DockProvider></StrictMode>);
    expect(objectRef.current).toBe(screen.getByTestId("footer"));
    expect(callbackRef).toHaveBeenLastCalledWith(expect.any(HTMLDivElement));
    expect(currentDock().bottom).toBe(212);
    const cleanupCalls = cleanup.mock.calls.length;
    rendered.unmount();
    expect(objectRef.current).toBeNull();
    expect(cleanup.mock.calls.length).toBe(cleanupCalls + 1);
    expect(resizeObservers.every(item => item.targets.size === 0)).toBe(true);
  });
});
