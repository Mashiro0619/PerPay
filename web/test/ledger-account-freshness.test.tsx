import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";
import { expect, it, vi } from "vitest";
import { queryClient, type AlipayAccount } from "../src/api/client";
import { SystemStatusBoundary } from "../src/features/system-status";
import Ledger from "../src/pages/Ledger";
import LedgerDetail from "../src/pages/LedgerDetail";
import { alipayAccount, json, ledgerId } from "./fixtures";
import { groupedLedger } from "./ledger-fixtures";
import { systemStatus } from "./onboarding-fixture";

const staleTime = "2026-11-05T00:00:00.000Z";
const freshTime = "2026-11-07T01:55:00.000Z";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function ChangeAccount() {
  const [, setSearch] = useSearchParams();
  return <button onClick={() => setSearch({ alipay_account_id: secondId })}>改查账号 B</button>;
}

function mount(path: string, options: { accountMissing?: boolean; lastSuccess?: string | null; detailAccount?: string | null } = {}) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const first: AlipayAccount = { ...alipayAccount, name: "账号 A", health: {
    state: "degraded", last_success_at: options.lastSuccess === undefined ? staleTime : options.lastSuccess,
    last_error_code: "provider_timeout", collection_ready: false,
  } };
  const second: AlipayAccount = { ...alipayAccount, id: secondId, name: "账号 B", health: {
    state: "healthy", last_success_at: freshTime, last_error_code: null, collection_ready: true,
  } };
  const accounts = options.accountMissing ? [second] : [first, second];
  queryClient.setQueryData(["alipay-accounts"], { data: accounts });
  const status = systemStatus();
  status.alipay_accounts = accounts;
  status.ledger.last_success_at = Date.parse(freshTime);
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/v1/system/status") return json({ data: status });
    if (url.pathname === "/api/admin/v1/ledger/entries") {
      requests.push(url);
      return json({ data: [], environment: "PRODUCTION", page: { next_cursor: null } });
    }
    if (url.pathname === "/api/admin/v1/ledger/entries/" + ledgerId) return json({ data: {
      ...groupedLedger, alipay_account_id: options.detailAccount === undefined ? first.id : options.detailAccount,
      sources: [], matches: [], conflicts: [],
    } });
    throw new Error("Unexpected request: " + url.pathname);
  }));
  const view = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}>
    <SystemStatusBoundary><Routes>
      <Route path="/reconciliation" element={<><ChangeAccount /><Ledger /></>} />
      <Route path="/ledger/:ledgerEntryId" element={<LedgerDetail />} />
    </Routes></SystemStatusBoundary>
  </MemoryRouter></QueryClientProvider>);
  return { ...view, requests, freshness: () => view.container.querySelector("[data-ledger-freshness]")! };
}

it("uses the filtered account's scan and switches account scope without borrowing a fresher timestamp", async () => {
  const view = mount("/reconciliation?alipay_account_id=" + alipayAccount.id);
  await waitFor(() => expect(view.freshness().querySelector("time")).toHaveAttribute("datetime", staleTime));
  expect(view.freshness()).toHaveTextContent("本账号最近查账成功");
  expect(view.requests[0]!.searchParams.get("alipay_account_id")).toBe(alipayAccount.id);
  await userEvent.click(screen.getByRole("button", { name: "改查账号 B" }));
  await waitFor(() => expect(view.freshness().querySelector("time")).toHaveAttribute("datetime", freshTime));
  await waitFor(() => expect(view.requests.at(-1)!.searchParams.get("alipay_account_id")).toBe(secondId));
});

it.each([
  [{ accountMissing: true }, "暂不可用"],
  [{ lastSuccess: null }, "暂无记录"],
] as const)("keeps missing and never-successful account health distinct: %j", async (options, expected) => {
  const view = mount("/reconciliation?alipay_account_id=" + alipayAccount.id, options);
  await waitFor(() => expect(view.freshness()).toHaveTextContent(expected));
  expect(view.freshness().querySelector("time")).toBeNull();
});

it("labels the unfiltered maximum as a success from any account", async () => {
  const view = mount("/reconciliation");
  await waitFor(() => expect(view.freshness().querySelector("time")).toHaveAttribute("datetime", freshTime));
  expect(view.freshness()).toHaveTextContent("（任一账号）");
});

it("takes the detail record account even when its URL carries another account filter", async () => {
  const view = mount("/ledger/" + ledgerId + "?alipay_account_id=" + secondId);
  await waitFor(() => expect(view.freshness().querySelector("time")).toHaveAttribute("datetime", staleTime));
});

it("never falls back to global health for a detail with unknown account provenance", async () => {
  const view = mount("/ledger/" + ledgerId, { detailAccount: null });
  await screen.findByRole("heading", { name: "支付宝交易" });
  expect(view.freshness()).toHaveTextContent("本账号最近查账成功：暂不可用");
  expect(view.freshness().querySelector("time")).toBeNull();
});
