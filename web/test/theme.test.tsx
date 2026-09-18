import { runInNewContext } from "node:vm";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeControl } from "../src/theme";
import source from "../public/theme.js?raw";
function boot(stored: string | null = null, dark = false, blocked = false) {
  document.head.insertAdjacentHTML(
    "beforeend",
    '<meta name="theme-color" content="#ffffff">',
  );
  let changed = () => {};
  let storageChanged = (_e: {
    key: string | null;
    newValue: string | null;
  }) => {};
  const media = {
    matches: dark,
    addEventListener: (_name: string, fn: () => void) => {
      changed = fn;
    },
  };
  const storage = {
    getItem: vi.fn(() => {
      if (blocked) throw new Error("blocked");
      return stored;
    }),
    setItem: vi.fn(() => {
      if (blocked) throw new Error("blocked");
    }),
  };
  const browser = {
    localStorage: storage,
    matchMedia: () => media,
    perpayTheme: undefined as Window["perpayTheme"],
    addEventListener: (_name: string, fn: typeof storageChanged) => {
      storageChanged = fn;
    },
  };
  runInNewContext(source, { window: browser, document });
  return {
    theme: browser.perpayTheme!,
    storage,
    system(value: boolean) {
      media.matches = value;
      changed();
    },
    sync(value: string | null, key: string | null = "perpay:theme") {
      storageChanged({ key, newValue: value });
    },
  };
}
afterEach(() => {
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((e) => e.remove());
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  delete window.perpayTheme;
});
describe("official neutral appearance", () => {
  it("applies system brightness and native control colors before React", () => {
    const { theme, system, storage } = boot(null, true);
    expect(theme.getPreference()).toBe("system");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#0a0a0a",
    );
    system(false);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it.each(["light", "dark"] as const)(
    "preserves existing %s preference",
    (mode) => {
      const { theme, system } = boot(mode, mode !== "dark");
      system(mode !== "dark");
      expect(theme.getPreference()).toBe(mode);
      expect(document.documentElement.dataset.theme).toBe(mode);
    },
  );
  it("ignores retired palettes and synchronizes only the brightness preference", () => {
    const { theme, storage, sync } = boot("light", true);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledWith("perpay:theme");
    sync("sand", "perpay:palette");
    expect(theme.getPreference()).toBe("light");
    sync("dark");
    expect(theme.getPreference()).toBe("dark");
    sync("invalid");
    expect(theme.getPreference()).toBe("system");
    sync(null, null);
    expect(theme.getPreference()).toBe("system");
  });
  it("uses memory when local storage is unavailable", () => {
    const { theme } = boot(null, false, true);
    expect(() => theme.setPreference("dark")).not.toThrow();
    expect(document.documentElement).toHaveClass("dark");
  });
  it("rejects invalid values and unsubscribes observers", () => {
    const { theme } = boot("invalid", false);
    const listener = vi.fn();
    const remove = theme.subscribe(listener);
    theme.setPreference("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    remove();
    theme.setPreference("light");
    expect(listener).toHaveBeenCalledTimes(1);
    theme.setPreference("bad" as "dark");
    expect(theme.getPreference()).toBe("light");
  });
  it("uses the official accessible theme menu and restores trigger focus", async () => {
    const { theme } = boot();
    window.perpayTheme = theme;
    render(<ThemeControl />);
    const trigger = screen.getByRole("button", { name: /外观/ });
    const user = userEvent.setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: "深色" }),
    );
    expect(theme.getPreference()).toBe("dark");
    expect(screen.queryByText("青竹")).not.toBeInTheDocument();
    act(() => theme.setPreference("system"));
    expect(trigger).toHaveAccessibleName(/跟随系统/);
  });
});
