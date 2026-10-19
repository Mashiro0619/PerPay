import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Orders from "../src/pages/Orders";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { apiError, json, order } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const site = (clientId: string) => ({
  client_id: clientId,
  revision: 0,
  configuration: {
    name: clientId === "site_a" ? "网站 A" : "网站 B",
    accepting_orders: true,
    notifications_enabled: false,
  },
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
  deleted_at: null,
});

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}</output>;
}

function mount() {
  const requests: Array<{ request: Request; finish: (response: Response) => void }> = [];
  vi.stubGlobal("fetch", vi.fn((request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/sites"))
      return Promise.resolve(json({ data: [site("site_a"), site("site_b")], page: { next_cursor: null } }));
    if (url.pathname.endsWith("/orders"))
      return Promise.resolve(json({ data: [order], page: { next_cursor: null } }));
    if (url.pathname.includes("/orders/by-merchant-no/")) {
      // Ignore abort to exercise stale responses as well as request cancellation.
      return new Promise<Response>((finish) => requests.push({ request, finish }));
    }
    throw new Error("Unexpected request " + request.url);
  }));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/orders"]}>
        <TestPaymentProvider>
          <Routes>
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:orderId" element={<h1>测试订单详情</h1>} />
          </Routes>
          <CurrentLocation />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
}

async function chooseSite(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "业务网站" }));
  await user.click(await screen.findByRole("option", { name }));
  expect(screen.getByRole("combobox", { name: "业务网站" })).toHaveTextContent(name);
}

async function lookupInSiteA(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "查询方式：关键词" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "商户订单号（业务网站）" }));
  await chooseSite(user, "网站 A");
  await user.type(screen.getByRole("searchbox", { name: "订单号" }), order.merchant_order_no);
  await user.click(screen.getByRole("button", { name: "查找" }));
}

describe("merchant order lookup website changes", () => {
  it.each([1600, 390])("cancels the previous website lookup and keeps the new lookup active at %i pixels", async (width) => {
    mobileMedia(width);
    const requests = mount();
    const user = userEvent.setup();
    await lookupInSiteA(user);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(new URL(requests[0]!.request.url).searchParams.get("api_client_id")).toBe("site_a");

    await chooseSite(user, "网站 B");
    expect(requests[0]!.request.signal.aborted).toBe(true);
    expect(screen.getByRole("searchbox", { name: "订单号" })).toBeEnabled();
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(order.merchant_order_no);
    await user.click(screen.getByRole("button", { name: "查找" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(new URL(requests[1]!.request.url).searchParams.get("api_client_id")).toBe("site_b");

    await act(async () => requests[0]!.finish(json({ data: { ...order, api_client_id: "site_a" } })));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(/^\/orders$/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查找$/ })).toBeDisabled();
    expect(requests[1]!.request.signal.aborted).toBe(false);

    const siteBOrderId = "22222222-2222-4222-8222-222222222222";
    await act(async () => requests[1]!.finish(json({ data: { ...order, order_id: siteBOrderId, api_client_id: "site_b" } })));
    await screen.findByRole("heading", { name: "测试订单详情" });
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders/" + siteBOrderId);
  });

  it("clears the previous website error without requiring the merchant number to be edited", async () => {
    const requests = mount();
    const user = userEvent.setup();
    await lookupInSiteA(user);
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.finish(apiError("order_not_found", "未找到网站 A 的订单", 404)));
    await screen.findByRole("alert");

    await chooseSite(user, "网站 B");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(order.merchant_order_no);
    expect(requests).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "查找" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(new URL(requests[1]!.request.url).searchParams.get("api_client_id")).toBe("site_b");
    await act(async () => requests[1]!.finish(json({ data: { ...order, api_client_id: "site_b" } })));
    await screen.findByRole("heading", { name: "测试订单详情" });
  });
});
