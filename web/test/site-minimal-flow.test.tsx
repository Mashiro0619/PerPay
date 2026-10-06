import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SitePicker } from "../src/components/site-picker";
import { SitePolicyFields } from "../src/components/SitePolicyFields";
import CreateSite from "../src/pages/CreateSite";
import { queryClient } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { json } from "./fixtures";
const policy = {
  orders: {
    order_ttl_seconds: 300,
    amount_offset_maximum_cents: 99,
    amount_reuse_cooldown_seconds: 600,
    pending_order_limit: null,
  },
  display: {
    checkout_name: "模板名",
    checkout_help_url: null,
    checkout_show_product_name: true,
  },
  notification_delivery: {
    timeout_milliseconds: 5000,
    maximum_attempts: 3,
    retry_base_seconds: 5,
    retry_maximum_seconds: 60,
  },
};
function createPage() {
  const router = createMemoryRouter(
    [
      {
        path: "/sites/new",
        element: (
          <DraftProvider>
            <CreateSite />
          </DraftProvider>
        ),
      },
    ],
    { initialEntries: ["/sites/new"] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
describe("minimal website workflows", () => {
  it("does not create with missing template or fall back to hardcoded defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          { error: { code: "internal_error", message: "模板读取失败" } },
          500,
        ),
      ),
    );
    createPage();
    await screen.findByText("模板读取失败");
    expect(
      screen.queryByRole("button", { name: "创建网站" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("网站名称")).not.toBeInTheDocument();
  });
  it("keeps the captured template and exact command after an uncertain creation", async () => {
    const writes: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) => {
        if (req.method === "GET")
          return json({ data: { revision: 2, policy } });
        writes.push(req.clone());
        throw new TypeError("lost response");
      }),
    );
    createPage();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("网站名称"), "我的网站");
    await user.click(screen.getByRole("button", { name: "创建网站" }));
    await screen.findByText("创建结果待确认");
    expect(screen.getByLabelText("网站名称")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    const first = await writes[0]!.json();
    expect(await writes[1]!.json()).toEqual(first);
    expect(first.configuration).toMatchObject({
      policy,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
    });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
  it("loads further sites inside the selector without search and disambiguates repeated names", async () => {
    const requests: URL[] = [];
    const change = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) => {
        const url = new URL(req.url);
        requests.push(url);
        const second = url.searchParams.has("after");
        return json({
          data: [
            {
              client_id: second ? "site_bbbbbbbb-x" : "site_aaaaaaaa-x",
              configuration: { name: "同名网站", accepting_orders: true },
            },
          ],
          page: { next_cursor: second ? null : "next" },
        });
      }),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SitePicker value="" onChange={change} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await screen.findByRole("option", { name: "同名网站" });
    await user.click(screen.getByRole("button", { name: "加载更多网站" }));
    await user.click(
      await screen.findByRole("option", { name: "同名网站 · bbbbbbbb" }),
    );
    expect(change).toHaveBeenCalledWith("site_bbbbbbbb-x");
    expect(requests.every((u) => !u.searchParams.has("q"))).toBe(true);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("expands advanced policy fields and focuses the failed control", async () => {
    const view = render(
      <SitePolicyFields
        value={policy}
        section="integration"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("最大投递次数")).not.toBeVisible();
    await act(async () => {
      view.rerender(
        <SitePolicyFields
          value={policy}
          section="integration"
          onChange={vi.fn()}
          errors={{
            "configuration.policy.notification_delivery.maximum_attempts":
              "次数错误",
          }}
        />,
      );
    });
    await waitFor(() =>
      expect(screen.getByLabelText("最大投递次数")).toBeVisible(),
    );
    expect(screen.getByLabelText("最大投递次数")).toHaveFocus();
  });
});
