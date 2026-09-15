import { runInNewContext } from "node:vm";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeControl } from "../src/theme";
import source from "../public/theme.js?raw";

function boot(stored: string | null = null, dark = false, unavailable = false, palette: string | null = null) {
  document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#f6f8fc">');
  let mediaChange = () => undefined as void;
  let storageChange = (_event: { key: string | null; newValue: string | null }) => undefined as void;
  const media = { matches: dark, addEventListener: (_name: string, callback: () => void) => { mediaChange = callback; } };
  const storage = {
    getItem: vi.fn((key: string) => { if (unavailable) throw new Error("storage blocked"); return key === "perpay:theme" ? stored : palette; }),
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
  delete document.documentElement.dataset.palette;
  document.documentElement.style.colorScheme = "";
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
});

describe("independent palette and brightness preferences", () => {
  it("resolves both preferences and native controls before React, following OS changes", () => {
    const { theme, system, storage } = boot(null, true);
    expect(theme.getPreference()).toBe("system");
    expect(theme.getPalette()).toBe("blue");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-palette", "blue");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#12151c");
    system(false);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it.each(["light", "dark"])("preserves the legacy %s mode without requiring a stored palette", (mode) => {
    const { theme, system } = boot(mode, mode !== "dark");
    expect(theme.getPalette()).toBe("blue");
    expect(theme.getPreference()).toBe(mode);
    system(mode !== "dark");
    expect(document.documentElement.dataset.theme).toBe(mode);
  });
  it("keeps palette changes independent of light, dark and system", () => {
    const { theme, system, storage } = boot("light", true, false, "sand");
    theme.setPalette("violet");
    expect(theme.getPreference()).toBe("light");
    expect(storage.setItem).toHaveBeenLastCalledWith("perpay:palette", "violet");
    theme.setPreference("dark");
    expect(theme.getPalette()).toBe("violet");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#17141e");
    system(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.setPreference("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#f8f6fc");
  });
  it.each(["blue", "bamboo", "sand", "violet", "graphite"] as const)("restores the %s palette after restart", (palette) => {
    const { theme } = boot("dark", false, false, palette);
    expect(theme.getPalette()).toBe(palette);
    expect(document.documentElement.dataset.palette).toBe(palette);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("synchronizes tabs, validates each preference independently and handles storage clearing", () => {
    const { theme, sync } = boot("light", true, false, "sand");
    sync("bamboo", "perpay:palette");
    expect(theme.getPreference()).toBe("light");
    expect(theme.getPalette()).toBe("bamboo");
    sync("bad-mode");
    expect(theme.getPreference()).toBe("system");
    expect(theme.getPalette()).toBe("bamboo");
    sync("bad-palette", "perpay:palette");
    expect(theme.getPalette()).toBe("blue");
    sync("light", "unrelated");
    expect(theme.getPreference()).toBe("system");
    theme.setPalette("violet");
    sync(null, null);
    expect(theme.getPalette()).toBe("blue");
    expect(theme.getPreference()).toBe("system");
  });
  it("falls back only the invalid startup preference", () => {
    expect(boot("invalid", true, false, "bamboo").theme.getPalette()).toBe("bamboo");
    const validMode = boot("dark", false, false, "__proto__");
    expect(validMode.theme.getPreference()).toBe("dark");
    expect(validMode.theme.getPalette()).toBe("blue");
  });
  it("continues changing both preferences in memory when storage is blocked", () => {
    const { theme } = boot(null, false, true);
    expect(() => { theme.setPreference("dark"); theme.setPalette("graphite"); }).not.toThrow();
    expect(theme.getPreference()).toBe("dark");
    expect(theme.getPalette()).toBe("graphite");
  });
  it("notifies and unsubscribes React observers for either preference", () => {
    const { theme } = boot();
    const listener = vi.fn(); const unsubscribe = theme.subscribe(listener);
    theme.setPreference("dark"); theme.setPalette("sand");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe(); theme.setPreference("light");
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("keeps the panel open when selecting and restores focus only when closed", () => {
    const { theme } = boot(); vi.stubGlobal("perpayTheme", theme);
    const hide = vi.fn(); Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: hide });
    render(<ThemeControl />);
    const trigger = screen.getByRole("button", { name: "外观，当前经典蓝 · 跟随系统" });
    expect(trigger).toHaveTextContent("外观");
    expect(screen.getAllByRole("radio", { hidden: true })).toHaveLength(8);
    const violet = screen.getByRole("radio", { name: "柔紫", hidden: true });
    fireEvent.click(violet);
    fireEvent.click(screen.getByRole("radio", { name: "深色", hidden: true }));
    expect(trigger).toHaveAccessibleName("外观，当前柔紫 · 深色");
    expect(hide).not.toHaveBeenCalled();
    fireEvent.keyDown(violet, { key: "Escape" });
    expect(hide).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
  it("syncs an open control across tabs without resetting a sibling form", () => {
    const { theme, sync } = boot(); vi.stubGlobal("perpayTheme", theme);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<><ThemeControl /><input aria-label="未保存表单" defaultValue="original" /></>);
    const field = screen.getByLabelText("未保存表单");
    fireEvent.change(field, { target: { value: "draft" } });
    act(() => { sync("sand", "perpay:palette"); sync("dark"); });
    expect(screen.getByRole("radio", { name: "暖砂", hidden: true })).toBeChecked();
    expect(screen.getByRole("radio", { name: "深色", hidden: true })).toBeChecked();
    expect(field).toHaveValue("draft");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
