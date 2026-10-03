import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminContent, CONTENT_WIDTH_KEY, ContentWidthControl, ContentWidthProvider } from "../src/components/content-width";

function mount(child = <input aria-label="草稿" defaultValue="未保存" />) {
  return render(<ContentWidthProvider><ContentWidthControl /><AdminContent>{child}</AdminContent></ContentWidthProvider>);
}
const content = () => document.querySelector("[data-content-width]")!;
function storage(key: string | null, newValue: string | null, storageArea = localStorage) {
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea })));
}
beforeEach(() => localStorage.removeItem(CONTENT_WIDTH_KEY));
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(CONTENT_WIDTH_KEY); });

describe("administrator content width", () => {
  it.each([null, "", "invalid", "compact"])("defaults to compact for %s", (value) => {
    if (value !== null) localStorage.setItem(CONTENT_WIDTH_KEY, value);
    mount();
    expect(content()).toHaveAttribute("data-content-width", "compact");
    expect(content()).toHaveClass("max-w-7xl", "@container/main", "mx-auto");
    expect(content().parentElement).toHaveClass("px-4", "lg:px-6");
    expect(screen.getByRole("button", { name: "切换为全屏布局" })).toHaveClass("hidden", "md:inline-flex");
  });
  it("persists keyboard switches without remounting content or losing a focused draft", async () => {
    const mounted = vi.fn();
    function Draft() { useEffect(() => { mounted(); }, []); return <input aria-label="草稿" />; }
    const view = mount(<Draft />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "草稿保留" } });
    const user = userEvent.setup();
    const control = screen.getByRole("button", { name: "切换为全屏布局" });
    control.focus();
    await user.keyboard("{Enter}");
    expect(content()).toHaveAttribute("data-content-width", "full");
    expect(content()).toHaveClass("max-w-none");
    expect(control).toHaveAttribute("aria-pressed", "true");
    expect(control).toHaveFocus();
    expect(localStorage.getItem(CONTENT_WIDTH_KEY)).toBe("full");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("草稿保留");
    expect(mounted).toHaveBeenCalledTimes(1);
    view.unmount();
    mount();
    expect(content()).toHaveAttribute("data-content-width", "full");
    await user.click(screen.getByRole("button", { name: "切换为收缩布局" }));
    expect(localStorage.getItem(CONTENT_WIDTH_KEY)).toBe("compact");
  });
  it("synchronizes cross-tab changes and resets deletions without disturbing fields", () => {
    mount();
    const input = screen.getByRole("textbox");
    storage(CONTENT_WIDTH_KEY, "full");
    expect(content()).toHaveAttribute("data-content-width", "full");
    storage("unrelated", "compact");
    storage(CONTENT_WIDTH_KEY, "compact", sessionStorage);
    expect(content()).toHaveAttribute("data-content-width", "full");
    storage(CONTENT_WIDTH_KEY, "bad");
    expect(content()).toHaveAttribute("data-content-width", "compact");
    storage(CONTENT_WIDTH_KEY, "full");
    storage(CONTENT_WIDTH_KEY, null);
    expect(content()).toHaveAttribute("data-content-width", "compact");
    storage(CONTENT_WIDTH_KEY, "full");
    storage(null, null);
    expect(content()).toHaveAttribute("data-content-width", "compact");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("未保存");
  });
  it("still toggles when storage reads and writes are blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "切换为全屏布局" }));
    expect(content()).toHaveAttribute("data-content-width", "full");
    fireEvent.click(screen.getByRole("button", { name: "切换为收缩布局" }));
    expect(content()).toHaveAttribute("data-content-width", "compact");
  });
});
