import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { Link, useDetailBack, useLedgerListPosition } from "../src/navigation";
import { LedgerDetailRedirect, LedgerListRedirect } from "../src/pages/ReconciliationRedirect";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { ledgerId, json } from "./fixtures";
import { matchId, paymentMatch } from "./detail-fixtures";

function Location() {
  const location = useLocation();
  return <output>{JSON.stringify(location)}</output>;
}
function mount(initialEntry: { pathname: string; search?: string; state?: unknown; hash?: string }) {
  const router = createMemoryRouter([
    { path: "/ledger", element: <LedgerListRedirect /> },
    { path: "/ledger/:ledgerEntryId", element: <LedgerDetailRedirect /> },
    { path: "/reconciliation", element: <Location /> },
    { path: "/reconciliation/transactions/:ledgerEntryId", element: <Location /> },
    { path: "/reconciliation/:kind/:resourceId", element: <EvidenceDetail /> },
  ], { initialEntries: [initialEntry] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
describe("one reconciliation destination", () => {
  it("keeps old ledger list filters, cursor, pagination state and site memory", async () => {
    const state = { pagination: { cursor: { cursors: [null, "next"] } } };
    const router = mount({ pathname: "/ledger", search: "?q=blue%20book&cursor=next&page=2&selected_site=shop", state });
    await waitFor(() => expect(router.state.location.pathname).toBe("/reconciliation"));
    expect(new URLSearchParams(router.state.location.search).get("tab")).toBe("transactions");
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("blue book");
    expect(router.state.location.search).toContain("cursor=next&page=2&selected_site=shop");
    expect(router.state.location.state).toEqual(state);
  });

  it.each(["/ledger/", "/reconciliation/ledger/"])("routes a legacy source from %s to the same transaction", async prefix => {
    const state = { listReturn: { to: "/reconciliation?has_reversals=true&page=2", label: "对账" } };
    const router = mount({ pathname: prefix + ledgerId, search: "?selected_site=shop", state });
    await waitFor(() => expect(router.state.location.pathname).toBe("/reconciliation/transactions/" + ledgerId));
    expect(router.state.location.search).toBe("?selected_site=shop");
    expect(router.state.location.hash).toBe(prefix.includes("reconciliation") ? "#source-" + ledgerId : "");
    expect(router.state.location.state).toEqual(state);
  });

  it("resolves a legacy match to its real source and history anchor, retaining return state", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/api/admin/v1/reconciliation/matches/" + matchId);
      expect(request.method).toBe("GET");
      return json({ data: paymentMatch });
    });
    vi.stubGlobal("fetch", fetchMock);
    const state = { listReturn: { to: "/reconciliation?tab=matches&status=REVERSED", label: "对账" } };
    const router = mount({ pathname: "/reconciliation/matches/" + matchId, search: "?selected_site=shop", state });
    await waitFor(() => expect(router.state.location.pathname).toBe("/reconciliation/transactions/" + paymentMatch.ledger_entry_id));
    expect(router.state.location.hash).toBe("#match-" + matchId);
    expect(router.state.location.state).toEqual(state);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captures the unified list scroll and restores it after data is ready with filters and page", async () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    function List() {
      useLedgerListPosition(true);
      return <Link to={"/reconciliation/transactions/" + ledgerId}>打开流水</Link>;
    }
    function Detail() {
      const back = useDetailBack("/reconciliation", "返回对账");
      return <><Link to="#source-real">核对来源</Link><Link to={back.to} state={back.state}>返回{back.label}</Link></>;
    }
    const router = createMemoryRouter([
      { path: "/reconciliation", element: <List /> },
      { path: "/reconciliation/transactions/:id", element: <Detail /> },
    ], { initialEntries: [{ pathname: "/reconciliation", search: "?q=book&has_reversals=true&cursor=next&page=2", state: { pagination: { cursor: { cursors: [null, "next"] } } } }] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    vi.stubGlobal("scrollY", 720);
    await user.click(screen.getByRole("link", { name: "打开流水" }));
    expect(router.state.location.state.listReturn.state.ledgerPosition.y).toBe(720);
    await user.click(screen.getByRole("link", { name: "核对来源" }));
    expect(router.state.location.hash).toBe("#source-real");
    expect(router.state.location.state.listReturn.state.ledgerPosition.y).toBe(720);
    await user.click(screen.getByRole("link", { name: "返回对账" }));
    expect(router.state.location.search).toBe("?q=book&has_reversals=true&cursor=next&page=2");
    expect(router.state.location.state.pagination.cursor.cursors).toEqual([null, "next"]);
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 720, left: 0, behavior: "instant" }));
  });
});
