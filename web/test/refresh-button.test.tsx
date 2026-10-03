import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RefreshButton } from "../src/components/refresh-button";
import { CopyValue } from "../src/components/copy-value";
describe("shared administrator actions", () => {
  it("keeps refresh accessible, prevents requests while busy and preserves its callback", () => {
    const click = vi.fn();
    const view = render(<RefreshButton onClick={click} />);
    const button = screen.getByRole("button", { name: "刷新" });
    expect(button).toHaveClass("size-8");
    expect(button).not.toHaveAttribute("title");
    fireEvent.click(button); expect(click).toHaveBeenCalledTimes(1);
    view.rerender(<RefreshButton busy onClick={click} />);
    expect(button).toBeDisabled();
    fireEvent.click(button); expect(click).toHaveBeenCalledTimes(1);
  });
  it("only opts backend copies into custom tooltips", () => {
    const view = render(<CopyValue value="value" label="复制编号" />);
    expect(screen.getByRole("button", { name: "复制编号" })).toHaveAttribute("title", "复制编号");
    view.rerender(<CopyValue tooltip value="value" label="复制编号" />);
    expect(screen.getByRole("button", { name: "复制编号" })).not.toHaveAttribute("title");
  });
});
