import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuccessMessage, useFeedback } from "../src/components/Feedback";
import { ErrorNotice } from "../src/components/request-state";
function Demo() { const [message, setMessage] = useFeedback(); return <><button onClick={() => setMessage("已保存")}>保存</button><SuccessMessage message={message} /><ErrorNotice error={new Error("仍需处理的错误")} /></>; }
afterEach(() => vi.useRealTimers());
describe("success feedback ownership", () => {
  it("restarts one timeout on identical messages without dismissing errors", () => {
    vi.useFakeTimers(); render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByText("已保存")).toBeVisible();
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    expect(screen.getByText("仍需处理的错误")).toBeVisible();
  });
  it("keeps the renderer stateless for explicitly persistent notices", () => {
    vi.useFakeTimers(); render(<SuccessMessage message="持续通知" multiline />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("持续通知")).toBeVisible();
  });
});
