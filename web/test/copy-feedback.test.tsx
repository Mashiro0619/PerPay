import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../src/components/copy-value";

describe("copy feedback", () => {
  it("keeps success, failure and retry feedback mutually exclusive without replacing the button or text", async () => {
    let finish!: () => void;
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopyValue value="可手动选择的完整内容" label="复制编号" />);
    const button = screen.getByRole("button", { name: "复制编号" });
    const text = screen.getByText("可手动选择的完整内容");
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-state", "success"));
    expect(screen.getByRole("status")).toHaveTextContent("已复制");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-state", "error"));
    expect(button.querySelector(".lucide-check")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("复制失败，请选中文本手动复制。");
    fireEvent.click(button);
    expect(button).toHaveAttribute("data-copy-state", "idle");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("可手动选择的完整内容")).toBe(text);
    await act(async () => finish());
    expect(button).toHaveAttribute("data-copy-state", "success");
    expect(screen.getByRole("button", { name: "复制编号" })).toBe(button);
    expect(button).toHaveFocus();
    expect(writeText).toHaveBeenCalledTimes(3);
  });
});
