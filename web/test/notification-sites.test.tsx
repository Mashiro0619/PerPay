import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Notifications, { NotificationDetail } from "../src/pages/Notifications";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
import { delivery } from "./detail-fixtures";
import { json, order } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const identities = [{ api_client_id: "site_first", site_name: "第一个网站" }, { api_client_id: "site_second", site_name: "第二个网站" }];
describe("notification website identity", () => {
  it.each([1440, 390, 320])("shows website sources for same-number orders without displacing retry information at %ipx", async width => {
    mobileMedia(width);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: identities.map((identity, index) => ({ ...delivery.delivery,
      delivery_id: "delivery_" + index, event: delivery.event, attempt_count: 3, next_attempt_at: "2026-11-04T04:00:00.000Z",
      order_summary: { ...identity, product_name: "同名商品", merchant_order_no: "same-number", payable_amount_cents: 1000 },
    })), page: { next_cursor: null } })));
    render(<QueryClientProvider client={queryClient}><MemoryRouter><Notifications /></MemoryRouter></QueryClientProvider>);
    for (const identity of identities) {
      const link = await screen.findByRole("link", { name: identity.site_name + " · " + identity.api_client_id });
      expect(link).toHaveAttribute("href", "/sites/" + identity.api_client_id + "/summary");
      const row = link.closest<HTMLElement>("[data-business-row]")!;
      expect(within(row).getByText("同名商品")).toBeVisible();
      if (width < 640) {
        expect(within(row).getByText("收款已确认").closest("[data-summary-status]")).toHaveTextContent("通知类型：收款已确认");
        expect(within(row).getByText("尝试次数", { selector: "dt" }).nextElementSibling).toHaveTextContent("3");
        expect(within(row).getByText("下次尝试", { selector: "dt" }).nextElementSibling).toHaveTextContent("2026/11/04 12:00");
      }
    }
  });
  it.each([1440, 390])("distinguishes confirmation and dispute events for the same order at %ipx", async width => {
    mobileMedia(width);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: ["PAYMENT_CONFIRMED", "PAYMENT_DISPUTED"].map((event_type, index) => ({
      ...delivery.delivery, delivery_id: "event_" + index, status: "ACKNOWLEDGED", event: { ...delivery.event, event_type },
      order_summary: { ...identities[0], product_name: "同一订单", merchant_order_no: "same-order", payable_amount_cents: 1000 },
    })), page: { next_cursor: null } })));
    render(<QueryClientProvider client={queryClient}><MemoryRouter><Notifications /></MemoryRouter></QueryClientProvider>);
    const confirmed = await screen.findByText("收款已确认");
    const disputed = await screen.findByText("收款有争议");
    for (const event of [confirmed, disputed]) {
      const row = event.closest<HTMLElement>("[data-business-row]")!;
      expect(within(row).getByText("同一订单")).toBeVisible();
      expect(within(row).getByText("通知已确认")).toBeVisible();
    }
  });
  it.each([false, true])("shows website identity in standalone or embedded delivery evidence: embedded=%s", async embedded => {
    const detail = { ...delivery, target: { ...delivery.target, ...identities[1] } };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/attempts")) return json({ data: detail.attempts });
      if (path.includes("/orders/")) return json({ data: order });
      return json({ data: detail });
    }));
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/notifications/" + detail.delivery.delivery_id]}>
      <Routes><Route path="/notifications/:deliveryId" element={embedded ? <DeliveryCard detail={detail} embedded /> : <NotificationDetail />} /></Routes>
    </MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole("link", { name: "第二个网站 · site_second" })).toHaveAttribute("href", "/sites/site_second/summary");
  });
});
