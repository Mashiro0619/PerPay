import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ListDensityProvider, ListDensityControl, LIST_DENSITY_KEY, useListDensity } from "../src/components/list-density";

function Value() { return <output>{useListDensity()}</output>; }
function mount() { return render(<ListDensityProvider><ListDensityControl compact={false} /><Value /><input aria-label="草稿" defaultValue="未提交" /></ListDensityProvider>); }
beforeEach(() => localStorage.removeItem(LIST_DENSITY_KEY));
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(LIST_DENSITY_KEY); });
describe("list density preference", () => {
  it("persists selection, restores trigger focus and keeps the same unsaved input", async () => {
    const view = mount();
    expect(screen.getByRole("status")).toHaveTextContent("compact");
    const input = screen.getByRole("textbox");
    const trigger = screen.getByRole("button", { name: "列表密度" });
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitemradio", { name: "舒适" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(localStorage.getItem(LIST_DENSITY_KEY)).toBe("comfortable");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("未提交");
    view.unmount(); mount();
    expect(screen.getByRole("status")).toHaveTextContent("comfortable");
  });
  it("synchronizes other tabs, ignores session storage and resets malformed or cleared preferences", () => {
    mount();
    const input = screen.getByRole("textbox"); input.focus();
    function storage(value: string | null, area = localStorage, key: string | null = LIST_DENSITY_KEY) {
      act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: area })));
    }
    storage("comfortable"); expect(screen.getByRole("status")).toHaveTextContent("comfortable");
    storage("compact", sessionStorage); expect(screen.getByRole("status")).toHaveTextContent("comfortable");
    storage("invalid"); expect(screen.getByRole("status")).toHaveTextContent("compact");
    storage("comfortable"); storage(null, localStorage, null);
    expect(screen.getByRole("status")).toHaveTextContent("compact");
    expect(input).toHaveFocus();
  });
  it("keeps working when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "列表密度" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "舒适" }));
    expect(screen.getByRole("status")).toHaveTextContent("comfortable");
  });
});
