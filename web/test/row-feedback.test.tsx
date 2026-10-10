import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LinkedSummaryRow,
  LinkedTableRow,
} from "../src/components/LinkedTableRow";

function mountRow(kind: "table" | "summary" = "summary", buttonPrimary = false) {
  const primary = (
    <a
      data-row-link
      href="#record"
      className={buttonPrimary ? "group/button" : undefined}
    >
      <span>记录标题</span>
    </a>
  );
  const content = <span>记录编号</span>;
  const actions = (
    <>
      <a href="#related">关联订单</a>
      <button>复制编号</button>
      <input aria-label="备注" />
    </>
  );
  render(
    kind === "table" ? (
      <table>
        <tbody>
          <LinkedTableRow rowId="record">
            <td>{primary}</td>
            <td>{content}</td>
            <td>{actions}</td>
          </LinkedTableRow>
        </tbody>
      </table>
    ) : (
      <div role="list">
        <LinkedSummaryRow rowId="record">
          {primary}
          {content}
          {actions}
        </LinkedSummaryRow>
      </div>
    ),
  );
  return {
    row: screen.getByRole(kind === "table" ? "row" : "listitem"),
    content: screen.getByText("记录编号"),
    primary: screen.getByRole("link", { name: "记录标题" }),
  };
}

function pointer(target: Element, type: string, options: PointerEventInit = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    button: 0,
    clientX: 20,
    clientY: 30,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

describe("navigation row pointer feedback", () => {
  it.each(["table", "summary"] as const)(
    "presses and releases the %s row without changing native pointer or click behavior",
    (kind) => {
      const { row, content, primary } = mountRow(kind);
      const capture = vi.fn();
      Object.defineProperty(row, "setPointerCapture", { value: capture });
      const navigate = vi.fn((event: Event) => event.preventDefault());
      primary.addEventListener("click", navigate);
      expect(row).toHaveAttribute("data-navigation-row");
      expect(row).toHaveAttribute("data-business-row", "record");

      const down = pointer(content, "pointerdown", { pointerType: "mouse" });
      expect(row).toHaveAttribute("data-navigation-pressed", "true");
      expect(down.defaultPrevented).toBe(false);
      expect(capture).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      const up = pointer(content, "pointerup", { pointerType: "mouse" });
      expect(row).not.toHaveAttribute("data-navigation-pressed");
      expect(up.defaultPrevented).toBe(false);

      pointer(screen.getByText("记录标题"), "pointerdown");
      expect(row).toHaveAttribute("data-navigation-pressed", "true");
      pointer(primary, "pointerup");
      expect(row).not.toHaveAttribute("data-navigation-pressed");
      fireEvent.click(content);
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it.each(["pointercancel", "pointerout"])("clears an active press on %s", (type) => {
    const { row, content } = mountRow();
    pointer(content, "pointerdown");
    pointer(row, type, { relatedTarget: document.body });
    expect(row).not.toHaveAttribute("data-navigation-pressed");
  });

  it("stops feedback after an 8px movement tolerance and does not rearm on movement back", () => {
    const { row, content } = mountRow();
    pointer(content, "pointerdown");
    pointer(content, "pointermove", { clientX: 28 });
    expect(row).toHaveAttribute("data-navigation-pressed", "true");
    pointer(content, "pointermove", { clientX: 27, clientY: 36 });
    expect(row).not.toHaveAttribute("data-navigation-pressed");
    pointer(content, "pointermove");
    expect(row).not.toHaveAttribute("data-navigation-pressed");
  });

  it("leaves independent links, buttons and inputs to their own feedback", () => {
    const { row } = mountRow();
    for (const control of [
      screen.getByRole("link", { name: "关联订单" }),
      screen.getByRole("button", { name: "复制编号" }),
      screen.getByRole("textbox", { name: "备注" }),
    ]) {
      pointer(control, "pointerdown");
      expect(row).not.toHaveAttribute("data-navigation-pressed");
      pointer(control, "pointerup");
    }
  });

  it("does not press the row when its primary link is presented as an independent button", () => {
    const { row, primary } = mountRow("table", true);
    pointer(primary, "pointerdown");
    expect(row).not.toHaveAttribute("data-navigation-pressed");
  });

  it("ignores selected text and clears feedback when a press turns into text selection", () => {
    const { row, content } = mountRow();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      pointer(content, "pointerdown");
      expect(row).not.toHaveAttribute("data-navigation-pressed");
      expect(selection.toString()).toBe("记录编号");
      selection.removeAllRanges();
      pointer(content, "pointerdown");
      expect(row).toHaveAttribute("data-navigation-pressed", "true");
      selection.addRange(range);
      pointer(content, "pointermove");
      expect(row).not.toHaveAttribute("data-navigation-pressed");
      expect(selection.toString()).toBe("记录编号");
    } finally {
      selection.removeAllRanges();
    }
  });

  it("accepts only primary left-button presses with a real navigation link", () => {
    const { row, content, primary } = mountRow();
    for (const options of [{ button: 1 }, { button: 2 }, { isPrimary: false }]) {
      pointer(content, "pointerdown", options);
      expect(row).not.toHaveAttribute("data-navigation-pressed");
    }
    primary.removeAttribute("href");
    pointer(content, "pointerdown");
    expect(row).not.toHaveAttribute("data-navigation-pressed");
  });

  it("keeps the owning pointer's feedback when another finger moves, leaves or releases", () => {
    const { row, content } = mountRow();
    pointer(content, "pointerdown");
    pointer(content, "pointerdown", { pointerId: 2, isPrimary: false });
    for (const type of ["pointermove", "pointerout", "pointercancel", "pointerup"]) {
      pointer(row, type, {
        pointerId: 2,
        isPrimary: false,
        clientX: 100,
        relatedTarget: document.body,
      });
      expect(row).toHaveAttribute("data-navigation-pressed", "true");
    }
    pointer(content, "pointerup");
    expect(row).not.toHaveAttribute("data-navigation-pressed");
  });
});
