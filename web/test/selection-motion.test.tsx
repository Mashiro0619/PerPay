import { useRef, useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { animate } from "motion/mini";
import {
  SelectionMotionGroup,
  SelectionMotionIndicator,
  useChartSeriesMotion,
} from "../src/components/selection-motion";
import { ChartAreaInteractive } from "../src/components/chart-area-interactive";
import type { SystemAnalytics } from "../src/api/client";
import { ToggleGroup, ToggleGroupItem } from "../src/components/ui/toggle-group";

vi.mock("motion/mini", async (importOriginal) => {
  const motion = await importOriginal<typeof import("motion/mini")>();
  return { ...motion, animate: vi.fn(motion.animate) };
});

function Choices({ label }: { label: string }) {
  const [value, setValue] = useState("amount");
  return (
    <SelectionMotionGroup>
      <ToggleGroup
        aria-label={label}
        value={[value]}
        onValueChange={(values) => {
          if (values[0]) setValue(values[0]);
        }}
      >
        {[
          ["amount", "确认金额"],
          ["orders", "新建订单"],
        ].map(([id, title]) => (
          <ToggleGroupItem key={id} value={id}>
            <SelectionMotionIndicator active={value === id} />
            {title}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SelectionMotionGroup>
  );
}

function reducedMotionPreference(initial = false) {
  let reduced = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === "(prefers-reduced-motion: reduce)" && reduced;
    },
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: vi.fn(),
  }));
  return (value: boolean) => {
    act(() => {
      reduced = value;
      for (const listener of listeners) {
        listener({ matches: value, media: "(prefers-reduced-motion: reduce)" } as MediaQueryListEvent);
      }
    });
  };
}

describe("selection motion boundaries", () => {
  it("updates the selected control immediately without retaining the old indicator or replacing buttons", async () => {
    reducedMotionPreference();
    const user = userEvent.setup();
    const { container } = render(<Choices label="指标" />);
    const amount = screen.getByRole("button", { name: "确认金额" });
    const orders = screen.getByRole("button", { name: "新建订单" });
    const firstIndicator = amount.querySelector("[data-selection-indicator]");

    expect(firstIndicator).toHaveAttribute("aria-hidden", "true");
    await user.click(orders);
    expect(orders).toHaveAttribute("aria-pressed", "true");
    expect(amount).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "新建订单" })).toBe(orders);
    expect(orders).toHaveFocus();
    expect(firstIndicator).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
    expect(orders.querySelector("[data-selection-indicator]")).not.toBeNull();

    await user.click(amount);
    await user.click(orders);
    expect(orders).toHaveAttribute("aria-pressed", "true");
    expect(orders).toHaveFocus();
    expect(container.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
  });

  it("keeps independent groups selected separately without adding animation style blocks", async () => {
    reducedMotionPreference();
    const user = userEvent.setup();
    const existingStyles = [...document.querySelectorAll("style")];
    render(<><Choices label="第一个指标" /><Choices label="第二个指标" /></>);
    const first = screen.getByRole("group", { name: "第一个指标" });
    const second = screen.getByRole("group", { name: "第二个指标" });
    await user.click(within(first).getByRole("button", { name: "新建订单" }));

    expect(within(first).getByRole("button", { name: "新建订单" })).toHaveAttribute("aria-pressed", "true");
    expect(within(second).getByRole("button", { name: "确认金额" })).toHaveAttribute("aria-pressed", "true");
    expect(first.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
    expect(second.querySelectorAll("[data-selection-indicator]")).toHaveLength(1);
    expect([...document.querySelectorAll("style")]).toEqual(existingStyles);
  });

  it("replaces only the decoration when reduced motion changes during a visit", async () => {
    const setReduced = reducedMotionPreference();
    const user = userEvent.setup();
    render(<Choices label="指标" />);
    const orders = screen.getByRole("button", { name: "新建订单" });
    await user.click(orders);
    const animated = orders.querySelector("[data-selection-indicator]");
    expect(animated).toHaveAttribute("data-selection-mode", "motion");

    setReduced(true);
    const stationary = orders.querySelector("[data-selection-indicator]");
    expect(animated).not.toBeInTheDocument();
    expect(stationary).not.toBeNull();
    expect(stationary).not.toBe(animated);
    expect(stationary).toHaveAttribute("data-selection-mode", "static");
    expect(orders).toHaveFocus();
    expect(orders).toHaveAttribute("aria-pressed", "true");

    setReduced(false);
    expect(stationary).not.toBeInTheDocument();
    expect(orders.querySelector("[data-selection-indicator]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "新建订单" })).toBe(orders);
    expect(orders).toHaveFocus();
  });

  it("unmounts controls and their decoration immediately", async () => {
    reducedMotionPreference();
    const user = userEvent.setup();
    const { container, unmount } = render(<Choices label="指标" />);
    await user.click(screen.getByRole("button", { name: "新建订单" }));
    const indicator = container.querySelector("[data-selection-indicator]");
    unmount();
    expect(indicator).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "指标" })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces only the decoration while the document is hidden", async () => {
    reducedMotionPreference();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const user = userEvent.setup();
    render(<Choices label="指标" />);
    const orders = screen.getByRole("button", { name: "新建订单" });
    await user.click(orders);
    const indicator = orders.querySelector("[data-selection-indicator]");

    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(indicator).not.toBeInTheDocument();
    expect(orders.querySelector("[data-selection-indicator]")).toHaveAttribute("data-selection-mode", "static");
    expect(orders).toHaveFocus();
    expect(orders).toHaveAttribute("aria-pressed", "true");

    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(orders.querySelector("[data-selection-indicator]")).toHaveAttribute("data-selection-mode", "motion");
    expect(screen.getByRole("button", { name: "新建订单" })).toBe(orders);
  });
});

function SeriesContent({ token, text, mark = "area" }: { token: string; text: string; mark?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useChartSeriesMotion(ref, token);
  return <div ref={ref} data-testid="content">
    <button>切换</button>
    <strong>{text}</strong>
    <svg><g className="axis"><text>金额轴</text></g><g key={mark} className="trend-series-motion"><path d="M0,0L10,10" /></g></svg>
    <div role="tooltip">精确读数</div>
  </div>;
}

function controlledSeriesAnimations() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const reveals: { stop: ReturnType<typeof vi.fn>; complete: () => void }[] = [];
  vi.mocked(animate).mockImplementation(() => {
    let complete = () => {};
    const promise = new Promise<void>((resolve) => { complete = resolve; });
    const stop = vi.fn();
    reveals.push({ stop, complete });
    return { stop, then: promise.then.bind(promise) } as unknown as ReturnType<typeof animate>;
  });
  const flush = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  });
  return { reveals, flush, frames };
}

describe("chart series motion", () => {
  it("animates only the committed marks, never initial content, refreshed data, text or controls", () => {
    reducedMotionPreference();
    const { flush } = controlledSeriesAnimations();
    const { rerender } = render(<SeriesContent token="amount:area" text="旧金额" />);
    const content = screen.getByTestId("content");
    const control = screen.getByRole("button");
    const axis = screen.getByText("金额轴");
    const tooltip = screen.getByRole("tooltip");
    flush();
    expect(animate).not.toHaveBeenCalled();

    rerender(<SeriesContent token="amount:area" text="刷新金额" />);
    flush();
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByTestId("content")).toBe(content);

    rerender(<SeriesContent token="orders:area" text="新建订单" mark="line" />);
    expect(content).toHaveTextContent("新建订单");
    expect(screen.queryByText("刷新金额")).not.toBeInTheDocument();
    expect(animate).not.toHaveBeenCalled();
    flush();
    expect(animate).toHaveBeenCalledExactlyOnceWith(content.querySelector(".trend-series-motion"), { opacity: [0.95, 1] }, {
      duration: 0.18,
      ease: [0.22, 1, 0.36, 1],
    });
    expect(screen.getByRole("button")).toBe(control);
    for (const element of [content, control, axis, tooltip, screen.getByText("新建订单")]) {
      expect(element).not.toHaveAttribute("style");
    }
  });

  it("interrupts the current series while only the latest animation may restore it", async () => {
    reducedMotionPreference();
    const { reveals, flush } = controlledSeriesAnimations();
    const { rerender } = render(<SeriesContent token="amount" text="金额" />);
    const series = screen.getByTestId("content").querySelector<SVGElement>(".trend-series-motion")!;
    rerender(<SeriesContent token="orders" text="订单" />);
    flush();
    series.style.opacity = "0.97";

    rerender(<SeriesContent token="amount" text="金额" />);
    expect(reveals[0]!.stop).toHaveBeenCalledOnce();
    flush();
    expect(animate).toHaveBeenLastCalledWith(series, { opacity: [0.97, 1] }, expect.anything());
    series.style.opacity = "0.98";
    await act(async () => { reveals[0]!.complete(); });
    expect(series.style.opacity).toBe("0.98");
    await act(async () => { reveals[1]!.complete(); });
    expect(series.style.opacity).toBe("");
  });

  it("uses only the latest series after changes before the next frame", () => {
    reducedMotionPreference();
    const { flush, frames } = controlledSeriesAnimations();
    const { rerender } = render(<SeriesContent token="area" text="面积图" />);
    rerender(<SeriesContent token="bar" text="柱状图" mark="bar" />);
    const previous = screen.getByTestId("content").querySelector(".trend-series-motion");
    rerender(<SeriesContent token="line" text="折线图" mark="line" />);
    expect(previous).not.toBeInTheDocument();
    expect(frames.size).toBe(1);
    flush();
    expect(animate).toHaveBeenCalledOnce();
    expect(vi.mocked(animate).mock.calls[0]![0]).toBe(screen.getByTestId("content").querySelector(".trend-series-motion"));
  });

  it("stops on reduced motion and does not replay when the preference is disabled", () => {
    const setReduced = reducedMotionPreference();
    const { reveals, flush } = controlledSeriesAnimations();
    const { rerender } = render(<SeriesContent token="amount" text="确认金额" />);
    const series = screen.getByTestId("content").querySelector<SVGElement>(".trend-series-motion")!;
    rerender(<SeriesContent token="orders" text="新建订单" />);
    flush();
    series.style.opacity = "0.96";

    setReduced(true);
    expect(reveals[0]!.stop).toHaveBeenCalledOnce();
    expect(series.style.opacity).toBe("");
    rerender(<SeriesContent token="amount" text="确认金额" />);
    flush();
    expect(animate).toHaveBeenCalledOnce();
    setReduced(false);
    flush();
    expect(animate).toHaveBeenCalledOnce();
  });

  it("stops pending and active animation on hiding and unmount", () => {
    reducedMotionPreference();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const { reveals, flush, frames } = controlledSeriesAnimations();
    const { rerender, unmount } = render(<SeriesContent token="area" text="面积图" />);
    const series = screen.getByTestId("content").querySelector<SVGElement>(".trend-series-motion")!;
    rerender(<SeriesContent token="bar" text="柱状图" />);
    flush();
    series.style.opacity = "0.96";
    hidden.mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(reveals[0]!.stop).toHaveBeenCalledOnce();
    expect(series.style.opacity).toBe("");

    hidden.mockReturnValue(false);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    flush();
    expect(animate).toHaveBeenCalledOnce();
    rerender(<SeriesContent token="line" text="折线图" />);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(series).not.toBeInTheDocument();
  });

  it("preserves readable content when the animation API is unavailable", () => {
    reducedMotionPreference();
    const { flush } = controlledSeriesAnimations();
    vi.mocked(animate).mockImplementation(() => { throw new Error("Web Animations API unavailable"); });
    const { rerender } = render(<SeriesContent token="area" text="面积图" />);
    rerender(<SeriesContent token="bar" text="柱状图" />);
    expect(flush).not.toThrow();
    expect(screen.getByText("柱状图")).toBeVisible();
    expect(screen.getByTestId("content")).not.toHaveAttribute("style");
  });

  it("integrates with Recharts without fading its axes, summary, toolbar or daily table", async () => {
    reducedMotionPreference();
    vi.mocked(animate).mockImplementation(() => ({ stop: vi.fn(), then: () => {} }) as unknown as ReturnType<typeof animate>);
    const day = { date: "2026-06-01", orders_created: 2, confirmations: 1, confirmed_amount_cents: 12345, notifications_acknowledged: 0, notifications_failed: 0 };
    const analytics: SystemAnalytics = {
      range_days: 7, from: "2026-05-31T16:00:00.000Z", to: "2026-06-07T16:00:00.000Z",
      orders: { created: 2, confirmed: 1, unpaid: 1, disputed: 0, closed: 0, expired: 0 },
      confirmations: { count: 1, amount_cents: 12345 }, notifications: { acknowledged: 0, failed: 0, pending: 0 },
      pending: { orders: 1, exceptions: 0, conflicts: 0, notifications: 0 }, daily: [day],
    };
    const user = userEvent.setup();
    const { container } = render(<ChartAreaInteractive analytics={analytics} pending={false} range={7} onRangeChange={vi.fn()} />);
    expect(animate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "新建订单" }));
    await waitFor(() => expect(animate).toHaveBeenCalled());
    for (const call of vi.mocked(animate).mock.calls) expect(call[0]).toBeInstanceOf(SVGElement);
    for (const element of container.querySelectorAll<HTMLElement>('.trend-content, .trend-toolbar, .trend-summary, .recharts-cartesian-axis')) expect(element.style.opacity).toBe("");
    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("table", { name: "每日收款数据" })).toBeVisible();
    for (const element of container.querySelectorAll<HTMLElement>('[data-slot="card-content"], .daily-report')) expect(element.style.opacity).toBe("");
  });
});
