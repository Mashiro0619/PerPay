import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Notifications from "../src/pages/Notifications";
import { delivery } from "./detail-fixtures";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";

it("distinguishes otherwise identical acknowledged notifications by order, amount and creation time", async () => {
  mobileMedia(390);
  localStorage.setItem("perpay.table-columns.v2.notifications", JSON.stringify({ order: false, created_at: false, payable_amount_cents: false }));
  vi.stubGlobal("fetch", vi.fn(async () => json({ data: [1, 2].map(index => ({
    ...delivery.delivery, delivery_id: "delivery_" + index, status: "ACKNOWLEDGED", attempt_count: 1,
    next_attempt_at: null, last_error_code: null, created_at: `2026-11-0${index}T04:00:00.000Z`,
    event: { ...delivery.event, order_id: "order_" + index },
    order_summary: { api_client_id: "same_site", site_name: "同一网站", product_name: "同一商品", merchant_order_no: "ORDER-" + index, payable_amount_cents: index * 1000 },
  })), page: { next_cursor: null } })));
  render(<QueryClientProvider client={queryClient}><MemoryRouter><Notifications /></MemoryRouter></QueryClientProvider>);
  await screen.findAllByText("同一商品");
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).not.toBe(rows[1]!.textContent);
  for (const [index, row] of rows.entries()) {
    const content = within(row);
    expect(content.getByRole("link", { name: "ORDER-" + (index + 1) })).toHaveAttribute("href", "/orders/order_" + (index + 1));
    expect(content.getByText("商户订单号")).toBeVisible();
    expect(content.getByText("创建时间")).toBeVisible();
    expect(content.getByText(index ? "¥20.00" : "¥10.00")).toBeVisible();
    expect(row.querySelector("time")).toHaveAttribute("datetime", `2026-11-0${index + 1}T04:00:00.000Z`);
  }
});
