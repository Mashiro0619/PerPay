import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type CheckoutStatus,
  type PaymentStatus,
} from "../src/api/client";
import { OrderDetail } from "../src/pages/OrderDetail";
import { apiError, json, order, orderId } from "./fixtures";

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/orders/" + orderId]}>
        <Routes>
          <Route path="/orders/:orderId" element={<OrderDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("administrator checkout entry", () => {
  it.each<[CheckoutStatus, PaymentStatus, string]>([
    ["OPEN", "UNPAID", "收银台开放中"],
    ["CLOSED", "UNPAID", "收银台已关闭"],
    ["EXPIRED", "UNPAID", "收银台已过期"],
    ["OPEN", "CONFIRMED", "收银台开放中"],
    ["OPEN", "DISPUTED", "收银台开放中"],
    ["CLOSED", "CONFIRMED", "收银台已关闭"],
    ["CLOSED", "DISPUTED", "收银台已关闭"],
  ])(
    "links to the authenticated existing checkout for %s / %s without changing state",
    async (checkoutStatus, paymentStatus, statusText) => {
      const requests: Request[] = [];
      const snapshot = {
        ...order,
        checkout: { ...order.checkout, status: checkoutStatus },
        payment: { ...order.payment, status: paymentStatus },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          if (
            new URL(request.url).pathname ===
            "/api/admin/v1/orders/" + orderId
          )
            return json({ data: snapshot });
          if (
            new URL(request.url).pathname.endsWith("/notifications/deliveries")
          )
            return json({ data: [], page: { next_cursor: null } });
          throw new Error(
            "Unexpected request: " + request.method + " " + request.url,
          );
        }),
      );
      mount();
      const link = await screen.findByRole("link", { name: "打开收银台" });
      expect(link).toHaveAttribute(
        "href",
        "/api/admin/v1/orders/" + orderId + "/checkout",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("title", "在新标签页打开收银台");
      const footer = link.closest('[data-slot="card-footer"]')! as HTMLElement;
      expect(within(footer).getByText(statusText)).toBeVisible();
      expect(link).toHaveClass("group/button");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      expect(
        requests.some((request) => request.url.endsWith("/checkout")),
      ).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain("pct1_");
    },
  );

  it("does not offer an entry when the order cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError("order_not_found", "订单不存在", 404)),
    );
    mount();
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "打开收银台" }),
    ).not.toBeInTheDocument();
  });
});
