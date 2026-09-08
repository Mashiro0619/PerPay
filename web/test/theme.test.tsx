import { runInNewContext } from "node:vm";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeControl } from "../src/theme";
import source from "../public/theme.js?raw";

function boot(stored: string | null = null, dark = false, unavailable = false) {
  document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#f7f8fa">');
  let mediaChange = () => undefined as void;
  let storageChange = (_event: { key: string | null; newValue: string | null }) => undefined as void;
  const media = { matches: dark, addEventListener: (_name: string, callback: () => void) => { mediaChange = callback; } };
  const storage = {
    getItem: vi.fn(() => { if (unavailable) throw new Error("storage blocked"); return stored; }),
    setItem: vi.fn(() => { if (unavailable) throw new Error("storage blocked"); }),
  };
  const browser = {
    localStorage: storage, matchMedia: () => media, perpayTheme: undefined as Window["perpayTheme"],
    addEventListener: (_name: string, callback: typeof storageChange) => { storageChange = callback; },
  };
  runInNewContext(source, { window: browser, document });
  return { theme: browser.perpayTheme!, storage, system: (value: boolean) => { media.matches = value; mediaChange(); }, sync: (value: string | null, key: string | null = "perpay:theme") => storageChange({ key, newValue: value }) };
}

afterEach(() => {
  document.querySelector('meta[name="theme-color"]')?.remove();
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
});

describe("theme bootstrap", () => {
  it("resolves the system theme before React and tracks system changes", () => {
    const { theme, system, storage } = boot(null, true);
    expect(theme.getPreference()).toBe("system");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#111214");
    system(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("honors explicit preferences instead of following OS changes", () => {
    const { theme, system, storage } = boot("light", true);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    theme.setPreference("dark");
    system(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(storage.setItem).toHaveBeenCalledWith("perpay:theme", "dark");
    theme.setPreference("system");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("synchronizes tabs and treats cleared or invalid settings as system", () => {
    const { theme, sync } = boot("light", true);
    sync("dark");
    expect(theme.getPreference()).toBe("dark");
    sync("light", "unrelated");
    expect(theme.getPreference()).toBe("dark");
    sync(null, null);
    expect(theme.getPreference()).toBe("system");
    sync("not-a-theme");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("keeps an in-memory preference when storage is unavailable", () => {
    const { theme } = boot(null, false, true);
    expect(() => theme.setPreference("dark")).not.toThrow();
    expect(theme.getPreference()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("notifies React subscribers and removes them on unsubscribe", () => {
    const { theme } = boot("invalid");
    const listener = vi.fn();
    const unsubscribe = theme.subscribe(listener);
    theme.setPreference("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    theme.setPreference("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("offers native radio options and returns focus after a selection event", () => {
    const { theme } = boot();
    vi.stubGlobal("perpayTheme", theme);
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: vi.fn() });
    render(<ThemeControl />);
    const trigger = screen.getByRole("button", { name: "切换主题，当前跟随系统" });
    expect(trigger.textContent).toBe("");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger).toHaveAttribute("title", "切换主题，当前跟随系统");
    expect(screen.getByRole("group", { name: "外观主题", hidden: true })).toBeInTheDocument();
    expect(screen.queryByText("外观主题")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "深色", hidden: true }));
    expect(trigger).toHaveAccessibleName("切换主题，当前深色");
    expect(trigger).toHaveAttribute("title", "切换主题，当前深色");
    expect(trigger).toHaveFocus();
    expect(screen.getAllByRole("radio", { hidden: true })).toHaveLength(3);
  });
});
