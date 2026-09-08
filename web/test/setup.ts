import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { queryClient } from "../src/api/client";

Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity }, mutations: { retry: false, gcTime: 0 } });
  document.cookie = "perpay_csrf=; Max-Age=0; Path=/";
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  document.querySelector('meta[name="perpay-initialized"]')?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
