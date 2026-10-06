import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import Notifications, { NotificationDetail } from "../src/pages/Notifications";
import { DeliveryCard } from "../src/components/detail/NotificationEvidence";
import { delivery } from "./detail-fixtures";
import { json, order } from "./fixtures";

const identities = [{ api_client_id: "site_first", site_name: "第一个网站" }, { api_client_id: "site_second", site_name: "第二个网站" }];
describe("notification website identity", () => {
  it("shows names and IDs for same-number orders from different websites in the all-sites list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: identities.map((identity, index) => ({ ...delivery.delivery,
      delivery_id: "delivery_" + index, event: delivery.event,
      order_summary: { ...identity, product_name: "同名商品", merchant_order_no: "same-number", payable_amount_cents: 1000 },
    })), page: { next_cursor: null } })));
    render(<QueryClientProvider client={queryClient}><MemoryRouter><Notifications /></MemoryRouter></QueryClientProvider>);
    for (const identity of identities) {
      const link = await screen.findByRole("link", { name: identity.site_name + " · " + identity.api_client_id });
      expect(link).toHaveAttribute("href", "/sites/" + identity.api_client_id);
      expect(within(link.closest("tr")!).getAllByText("same-number")[0]).toBeVisible();
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
    expect(await screen.findByRole("link", { name: "第二个网站 · site_second" })).toHaveAttribute("href", "/sites/site_second");
  });
});
