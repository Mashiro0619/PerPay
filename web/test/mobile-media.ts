import { act } from "@testing-library/react";
import { vi } from "vitest";
import { matchesTestMedia } from "./media-query";

export function mobileMedia(width = 390, options: { coarse?: boolean } = {}) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      media,
      get matches() {
        return matchesTestMedia(media, window.innerWidth, options.coarse);
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );
  return {
    resize(next: number) {
      act(() => {
        vi.stubGlobal("innerWidth", next);
        for (const listener of listeners) listener();
        window.dispatchEvent(new Event("resize"));
      });
    },
  };
}
