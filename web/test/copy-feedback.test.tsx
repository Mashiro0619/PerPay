import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyValue } from "../src/components/copy-value";

describe("copy feedback", () => {
  it.each(["success", "error"] as const)("clears %s feedback when the displayed value changes", async state => {
    const writeText = state === "success" ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(<CopyValue value="旧编号" label="复制编号" />);
    const button = screen.getByRole("button", { name: "复制编号" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-state", state));
    view.rerender(<CopyValue value="新编号" label="复制编号" />);
    expect(button).toHaveAttribute("data-copy-state", "idle");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("新编号")).toBeVisible();
  });

  it("ignores an earlier value's clipboard response while copying the current value", async () => {
    let finishOld!: () => void;
    let finishCurrent!: () => void;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishCurrent = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(<CopyValue value="旧编号" label="复制编号" />);
    const button = screen.getByRole("button", { name: "复制编号" });
    fireEvent.click(button);
    view.rerender(<CopyValue value="新编号" label="复制编号" />);
    fireEvent.click(button);
    await act(async () => finishOld());
    expect(button).toHaveAttribute("data-copy-state", "idle");
    await act(async () => finishCurrent());
    expect(button).toHaveAttribute("data-copy-state", "success");
    expect(writeText.mock.calls).toEqual([["旧编号"], ["新编号"]]);
  });

  it("keeps the latest retry result when an earlier clipboard request fails late", async () => {
    let rejectOld!: (reason: Error) => void;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopyValue value="编号" label="复制编号" />);
    const button = screen.getByRole("button", { name: "复制编号" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-copy-state", "success"));
    await act(async () => rejectOld(new Error("denied")));
    expect(button).toHaveAttribute("data-copy-state", "success");
  });

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
