import { act } from "@testing-library/react";
import { vi } from "vitest";

export function mobileMedia(width = 390) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      media,
      get matches() {
        if (/max-width|pointer:\s*coarse|hover:\s*none/.test(media))
          return window.innerWidth < 768;
        if (/pointer:\s*fine|hover:\s*hover/.test(media))
          return window.innerWidth >= 768;
        return false;
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
      });
    },
  };
}
