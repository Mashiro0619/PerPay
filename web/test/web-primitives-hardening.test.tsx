import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ShortId } from "../src/components/short-id";
import { createRafCoalescer } from "../src/lib/raf-coalesce";
import { ListFilterPanelContext } from "../src/components/list-filter-context";
import { LedgerAmountFilter } from "../src/components/ledger-amount-filter";
import { CreatedDateFilter } from "../src/components/created-date-filter";
import type { ListQueryControl } from "../src/lib/list-query";

function makeControl(overrides: Partial<ListQueryControl["query"]> = {}): ListQueryControl {
  return {
    query: { q: "", sortBy: "created_at", sortOrder: "desc", ...overrides },
    setSort: vi.fn(),
    setKeyword: vi.fn(),
    clear: vi.fn(),
    update: vi.fn(),
  };
}

describe("ShortId", () => {
  it("renders short identifiers inline and splits long identifiers cleanly with newline-free copy", () => {
    const { rerender } = render(<ShortId value="SHORT-123" />);
    expect(screen.getByText("SHORT-123")).toBeVisible();

    const longId = "2026112400001234567890abcdef";
    rerender(<ShortId value={longId} />);
    const container = screen.getByTitle(longId);
    expect(container.querySelector(".short-id-head")).toHaveTextContent(longId.slice(0, -6));
    expect(container.textContent).toBe(longId);

    const setData = vi.fn();
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => `${longId.slice(0, -6)}\n${longId.slice(-6)}`,
    } as Selection);
    try {
      const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      fireEvent(container, event);
      expect(event.defaultPrevented).toBe(true);
      expect(setData).toHaveBeenCalledWith("text/plain", longId);

      // Partial selection leaves browser default copy untouched.
      setData.mockClear();
      getSelectionSpy.mockReturnValue({ toString: () => "abcdef" } as Selection);
      const partial = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(partial, "clipboardData", { value: { setData } });
      fireEvent(container, partial);
      expect(partial.defaultPrevented).toBe(false);
      expect(setData).not.toHaveBeenCalled();
    } finally {
      getSelectionSpy.mockRestore();
    }
  });
});

describe("createRafCoalescer", () => {
  it("runs a leading call, coalesces bursts, re-arms across continuous frames, and cancels cleanly", () => {
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    });
    const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      queue.delete(id);
    });
    try {
      const spy = vi.fn();
      const coalescer = createRafCoalescer(spy);

      // Leading call fires immediately; burst calls in same frame coalesce into 1 trailing call.
      coalescer.schedule();
      coalescer.schedule();
      coalescer.schedule();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(queue.size).toBe(1);

      // First RAF flushes trailing call and re-arms cooldown frame.
      const [id1, cb1] = [...queue.entries()][0]!;
      queue.delete(id1);
      cb1(16);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(queue.size).toBe(1);

      // Another burst during cooldown schedules one more trailing frame (not dropped!).
      coalescer.schedule();
      coalescer.schedule();
      expect(spy).toHaveBeenCalledTimes(2);
      const [id2, cb2] = [...queue.entries()][0]!;
      queue.delete(id2);
      cb2(32);
      expect(spy).toHaveBeenCalledTimes(3);

      // Idle cooldown ends cleanly.
      const [id3, cb3] = [...queue.entries()][0]!;
      queue.delete(id3);
      cb3(48);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(queue.size).toBe(0);

      // Cancel drops pending trailing frame.
      coalescer.schedule();
      coalescer.schedule();
      expect(spy).toHaveBeenCalledTimes(4);
      coalescer.cancel();
      expect(queue.size).toBe(0);
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });
});

describe("deferred inline filter validation", () => {
  it("separates single-field and cross-field validation in inline LedgerAmountFilter", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ListFilterPanelContext value={true}>
          <form noValidate>
            <LedgerAmountFilter control={makeControl()} />
          </form>
        </ListFilterPanelContext>
      </MemoryRouter>,
    );
    const min = screen.getByRole("textbox", { name: "最低金额（元）" });

    // Typing an invalid single field stays quiet until blur.
    await user.type(min, "12.345");
    expect(min).toHaveAttribute("aria-invalid", "false");
    await user.tab();
    expect(min).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/最多保留两位小数/)).toBeVisible();

    // Fixing min clears the single-field error.
    await user.clear(min);
    await user.type(min, "100");
    expect(min).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText(/最多保留两位小数/)).not.toBeInTheDocument();
  });

  it("defers inverted amount range errors in inline LedgerAmountFilter until both bounds are touched", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ListFilterPanelContext value={true}>
          <form noValidate>
            <LedgerAmountFilter control={makeControl()} />
          </form>
        </ListFilterPanelContext>
      </MemoryRouter>,
    );
    const min = screen.getByRole("textbox", { name: "最低金额（元）" });
    const max = screen.getByRole("textbox", { name: "最高金额（元）" });

    await user.type(min, "100");
    await user.tab(); // blurs min -> focuses max (max not yet blurred)
    await user.type(max, "50");
    expect(screen.queryByText(/最低金额不能大于最高金额/)).not.toBeInTheDocument();
    await user.tab(); // blurs max -> both bounds now touched
    expect(min).toHaveAttribute("aria-invalid", "true");
    expect(max).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/最低金额不能大于最高金额/)).toBeVisible();
  });

  it("defers inverted date range errors in inline CreatedDateFilter until both bounds are touched or submitted", async () => {
    render(
      <MemoryRouter>
        <ListFilterPanelContext value={true}>
          <form noValidate>
            <CreatedDateFilter
              control={makeControl({ createdFrom: "2026-10-05", createdTo: "2026-10-06" })}
            />
          </form>
        </ListFilterPanelContext>
      </MemoryRouter>,
    );
    const from = screen.getByLabelText("开始日期");
    const to = screen.getByLabelText("结束日期");

    fireEvent.change(to, { target: { value: "2026-10-01" } });
    expect(screen.queryByText("开始日期不能晚于结束日期")).not.toBeInTheDocument();

    // Blurring only `to` without touching `from` does not prematurely flag cross-field error.
    fireEvent.blur(to);
    expect(screen.queryByText("开始日期不能晚于结束日期")).not.toBeInTheDocument();

    // Blurring `from` touches both bounds and reveals the cross-field error.
    fireEvent.blur(from);
    expect(screen.getByText("开始日期不能晚于结束日期")).toBeVisible();
    expect(from).toHaveAttribute("aria-invalid", "true");
    expect(to).toHaveAttribute("aria-invalid", "true");
  });
});
