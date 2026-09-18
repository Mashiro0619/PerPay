import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { queryClient } from "../src/api/client";

configure({ asyncUtilTimeout: 5000 });

class TestResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const chart = target.classList.contains("recharts-responsive-container");
    const rect = chart
      ? DOMRect.fromRect({ width: 640, height: 250 })
      : target.getBoundingClientRect();
    this.callback(
      [
        {
          target,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          devicePixelContentBoxSize: [],
        },
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value() {},
});

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity },
    mutations: { retry: false, gcTime: 0 },
  });
  document.cookie = "perpay_csrf=; Max-Age=0; Path=/";
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  document.querySelector('meta[name="perpay-initialized"]')?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
