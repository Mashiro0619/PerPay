import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSuccessToast } from "../src/components/Feedback";
import { ErrorNotice } from "../src/components/request-state";
import { Toaster } from "../src/components/ui/toast";

function Demo({ name = "设置" }: { name?: string }) {
  const notify = useSuccessToast();
  return <>
    <button onClick={() => notify(name + "已保存")}>保存{name}</button>
    <button onClick={() => notify("")}>清除{name}提示</button>
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

describe("success toast ownership", () => {
  it("refreshes one notification for repeated success and keeps persistent errors", async () => {
    render(<Toaster><Demo /><ErrorNotice error={new Error("仍需处理的错误")} /></Toaster>);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getAllByText("设置已保存")).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("仍需处理的错误");
  });

  it("clears only the caller's notification", async () => {
    render(<Toaster><Demo /><Demo name="备份" /></Toaster>);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    fireEvent.click(screen.getByRole("button", { name: "保存备份" }));
    fireEvent.click(screen.getByRole("button", { name: "清除设置提示" }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
    expect(screen.getByText("备份已保存")).toBeVisible();
  });

  it("keeps a completed action's notification when its row unmounts", async () => {
    const view = render(<Toaster><Demo /></Toaster>);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    view.rerender(<Toaster><p>记录已移入历史</p></Toaster>);
    expect(screen.getByText("设置已保存")).toBeVisible();
    fireEvent.focus(screen.getByRole("dialog", { name: "设置已保存" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
    expect(screen.getByText("记录已移入历史")).toBeVisible();
  });

  it("pauses expiry while the notification region is hovered", async () => {
    render(<Toaster><Demo /></Toaster>);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    const region = screen.getByRole("region", { name: "提示" });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    fireEvent.mouseEnter(region);
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(screen.getByText("设置已保存")).toBeVisible();
    fireEvent.mouseLeave(region);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
  });
});
