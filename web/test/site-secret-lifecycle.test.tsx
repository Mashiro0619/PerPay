import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { SiteEditorPage } from "../src/pages/Sites";
import { json } from "./fixtures";

function mount(action: "view" | "rotate", purpose: "api_secret" | "webhook_secret") {
  let site: Site = { client_id: "site_a", revision: 0, configuration: {
    name: "A", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
    policy: { orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "A", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 1, retry_maximum_seconds: 60 } },
  }, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z", deleted_at: null };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Request[] = [];
  let delayNext = false;
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (request.method === "GET") return json({ data: request.url.endsWith("/site_b") ? { ...site, client_id: "site_b", configuration: { ...site.configuration, name: "B" } } : site });
    requests.push(request);
    if (delayNext) {
      delayNext = false;
      expect(request.url).toContain(`/secrets/${purpose}/actions/${action}`);
      // A committed rotation can finish after the user has cancelled only its display.
      if (action === "rotate") site = { ...site, revision: site.revision + 1 };
      await held;
      return json({ data: action === "rotate" ? { site, secret: "late-secret" } : { secret: "late-secret" } });
    }
    return json({ data: { secret: "explicit-secret" } });
  }));
  const router = createMemoryRouter([{ path: "/sites/:clientId/settings/:section", element: <DraftProvider><SiteEditorPage /></DraftProvider> }], { initialEntries: ["/sites/site_a/settings/integration"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, requests, delay: () => { delayNext = true; }, release };
}

describe("website secret display lifetime", () => {
  for (const action of ["view", "rotate"] as const) for (const purpose of ["api_secret", "webhook_secret"] as const) {
    it(`hides a late ${purpose} ${action} response without cancelling the operation or losing its revision`, async () => {
      const view = mount(action, purpose), user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "查看 API 密钥" }));
      await screen.findByDisplayValue("explicit-secret");
      view.delay();
      const label = action === "rotate"
        ? purpose === "api_secret" ? "生成／轮换 API 密钥" : "生成／轮换通知密钥"
        : purpose === "api_secret" ? "查看 API 密钥" : "查看通知密钥";
      await user.click(screen.getByRole("button", { name: label }));
      if (action === "rotate") await user.click(await screen.findByRole("button", { name: "确认" }));
      await waitFor(() => expect(view.requests).toHaveLength(2));
      await user.click(screen.getByRole("button", { name: "隐藏密钥" }));
      expect(screen.queryByDisplayValue("explicit-secret")).not.toBeInTheDocument();
      // Hiding a secret is not completion of the outstanding API operation.
      expect(screen.getByRole("button", { name: "查看 API 密钥" })).toBeDisabled();
      expect(view.requests[1]!.signal.aborted).toBe(false);
      await act(async () => { view.release(); });
      await waitFor(() => expect(screen.getByRole("button", { name: "查看 API 密钥" })).not.toBeDisabled());
      expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
      if (action === "rotate") {
        expect(queryClient.getQueryData(["site-editor", "site_a", "integration"])).toMatchObject({ site: { revision: 1 } });
        expect(await screen.findByText("密钥已生成或轮换，请更新业务网站配置。")).toBeVisible();
      }
      expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("secret");
      await user.click(screen.getByRole("button", { name: "查看 API 密钥" }));
      expect(await screen.findByDisplayValue("explicit-secret")).toBeVisible();
      expect(view.requests).toHaveLength(3);
    });
  }

  it("does not display the previous website's late secret after navigation", async () => {
    const view = mount("view", "webhook_secret"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "查看 API 密钥" }));
    await screen.findByDisplayValue("explicit-secret");
    view.delay();
    await user.click(screen.getByRole("button", { name: "查看通知密钥" }));
    await waitFor(() => expect(view.requests).toHaveLength(2));
    await act(async () => { await view.router.navigate("/sites/site_b/settings/integration"); });
    await screen.findByRole("heading", { name: "接入与通知" });
    await act(async () => { view.release(); });
    expect(screen.queryByDisplayValue("explicit-secret")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
  });
});
