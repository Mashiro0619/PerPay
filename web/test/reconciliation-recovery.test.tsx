import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { LegacyOverlayRedirect } from "../src/components/overlay-host";
import { queryClient } from "../src/api/client";

describe("invalid reconciliation link recovery", () => {
  it.each([
    ["/reconciliation/unknown/record", undefined, "/reconciliation", "返回对账"],
    ["/sites/a/reconciliation/unknown/record", undefined, "/sites/a/work-items", "本站待处理"],
    ["/reconciliation/unknown/record", { listReturn: { to: "/reconciliation?tab=exceptions&status=OPEN&cursor=next&page=3", state: { pagination: { previous: ["before"] } } } }, "/reconciliation?tab=exceptions&status=OPEN&cursor=next&page=3", "对账"],
    ["/sites/a/reconciliation/unknown/record", { listReturn: { to: "/sites/b/work-items" } }, "/sites/a/work-items", "本站待处理"],
  ] as const)("restores only a compatible source or the scoped fallback: %s", async (pathname, state, href, label) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[{ pathname, state }]}><Routes>
      <Route path="/reconciliation/:kind/:resourceId" element={<LegacyOverlayRedirect />} />
      <Route path="/sites/:clientId/reconciliation/:kind/:resourceId" element={<LegacyOverlayRedirect />} />
    </Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("未找到这条对账记录");
    expect(screen.getByText("链接中的记录类型无效，请点击「" + label + "」重新选择记录。")).toBeVisible();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(fetch).not.toHaveBeenCalled();
  });
});
