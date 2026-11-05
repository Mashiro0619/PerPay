import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminLedgerDetail } from "../src/api/client";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import LedgerDetail from "../src/pages/LedgerDetail";
import { ledger, ledgerId, order, orderId, json, settings } from "./fixtures";
import { candidate, candidateId, financialException, exceptionId } from "./detail-fixtures";

describe("reconciliation detail refresh", () => {
  it.each(["candidates", "exceptions", "transactions"])("refreshes the %s record and its separately cached evidence", async kind => {
    let changed = false;
    const reads = new Map<string, number>();
    const transaction: AdminLedgerDetail = {
      ...ledger, environment: "PRODUCTION", states: ["CANDIDATE"], source_record_count: 1,
      content_consistent: true, has_conflicts: false, active_match_count: 0, reversed_match_count: 0,
      last_associated_at: null, last_handled_at: null, active_match: null, matches: [], conflicts: [],
      sources: [{ ...ledger, app_id: "app-test", environment: "PRODUCTION", provider_account_key: "account-test", raw_event_id: "raw-test" }],
    };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const nextCandidate = { ...candidate, status: changed ? "SELECTED" : "ELIGIBLE" };
      if (path.endsWith("/candidates/" + candidateId)) return json({ data: nextCandidate });
      if (path.endsWith("/exceptions/" + exceptionId)) return json({ data: financialException });
      if (path.endsWith("/candidates")) return json({ data: [nextCandidate] });
      if (path.endsWith("/reconciliation/ledger/" + ledgerId)) return json({ data: { ...ledger, state: changed ? "ALLOCATED" : "CANDIDATE" } });
      if (path.endsWith("/ledger/entries/" + ledgerId)) return json({ data: transaction });
      if (path.endsWith("/orders/" + orderId)) return json({ data: {
        ...order, product_name: changed ? "已更新关联订单" : "原关联订单",
        payment: { ...order.payment, status: changed ? "CONFIRMED" : "UNPAID" },
      } });
      throw new Error("Unexpected request " + path);
    }));
    queryClient.setQueryData(["settings"], { data: settings });
    queryClient.setQueryData(["orders", "background"], { data: [order] });
    queryClient.setQueryData(["order", "cached-reference"], { data: order });
    const resourceId = kind === "transactions" ? ledgerId : kind === "exceptions" ? exceptionId : candidateId;
    const router = createMemoryRouter([
      { path: "/reconciliation/transactions/:ledgerEntryId", element: <LedgerDetail /> },
      { path: "/reconciliation/:kind/:resourceId", element: <EvidenceDetail /> },
    ], { initialEntries: ["/reconciliation/" + kind + "/" + resourceId] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findAllByText("原关联订单");
    const orderPath = "/api/admin/v1/orders/" + orderId;
    expect(reads.get(orderPath)).toBe(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());
    const loadedPaths = [...reads.keys()];
    changed = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    await screen.findAllByText("已更新关联订单");
    await waitFor(() => {
      for (const path of loadedPaths) expect(reads.get(path), path).toBe(2);
    });
    expect(queryClient.getQueryState(["order", "cached-reference"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["settings"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["orders", "background"])?.isInvalidated).toBe(false);
  });
});
