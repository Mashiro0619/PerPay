import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, it, expect } from "vitest";
import { RecentOrders } from "../src/components/recent-orders";
import { order } from "./fixtures";
describe("concise overview orders", () => {
  it("shows one amount and payment result without repeating full order-list controls", () => {
    const data = {
      ...order,
      product_name: "演示商品",
      merchant_order_no: "merchant-visible",
      payment: { ...order.payment, status: "CONFIRMED" as const },
    };
    render(
      <MemoryRouter>
        <RecentOrders orders={[data]} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/orders/" + order.order_id);
    expect(within(link).getByText("演示商品")).toBeVisible();
    expect(within(link).getByText("merchant-visible")).toBeVisible();
    expect(within(link).getByText("收款已确认")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/可查看收银台|收银台开放中|实收/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /显示列|排序/ }),
    ).not.toBeInTheDocument();
  });
  it("does not repeat the merchant number when the product uses the same text", () => {
    render(
      <MemoryRouter>
        <RecentOrders
          orders={[
            { ...order, product_name: "same", merchant_order_no: "same" },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("same")).toHaveLength(1);
  });
});
