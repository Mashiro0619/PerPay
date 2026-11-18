import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    ["OPEN", "UNPAID", "打开收银台"],
    ["CLOSED", "UNPAID", "查看收银台结果"],
    ["EXPIRED", "UNPAID", "查看收银台结果"],
    ["OPEN", "CONFIRMED", "查看收银台结果"],
    ["OPEN", "DISPUTED", "查看收银台结果"],
    ["CLOSED", "CONFIRMED", "查看收银台结果"],
    ["CLOSED", "DISPUTED", "查看收银台结果"],
  ])(
    "links to the authenticated existing checkout for %s / %s without changing state",
    async (checkoutStatus, paymentStatus, actionLabel) => {
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
      await screen.findByRole("heading", { name: "订单信息" });
      // A disputed order keeps its footer for the two decisions; the checkout moves into the menu.
      const inMenu = paymentStatus === "DISPUTED";
      if (inMenu) {
        expect(screen.queryByRole("link", { name: actionLabel })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "更多操作，订单操作" }));
      }
      const link = await screen.findByRole(inMenu ? "menuitem" : "link", { name: actionLabel });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute(
        "href",
        "/api/admin/v1/orders/" + orderId + "/checkout",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("title", "在新标签页查看收银台");
      if (inMenu) fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      else expect(link.closest("[data-record-primary-actions]")).not.toBeNull();
      const information = await screen.findByRole("region", { name: "订单信息" });
      const checkout = within(information).getByText("收银台状态").closest("div")!;
      expect(within(checkout).getByText({ OPEN: "开放中", CLOSED: "已关闭", EXPIRED: "已过期" }[checkoutStatus])).toBeVisible();
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
      screen.queryByRole("link", { name: /打开收银台|查看收银台结果/ }),
    ).not.toBeInTheDocument();
  });
});
