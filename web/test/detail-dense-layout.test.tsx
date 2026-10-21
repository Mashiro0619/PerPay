import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DetailFields, DetailNavigation } from "../src/components/detail/DetailPrimitives";
import { isDenseDetailPage } from "../src/lib/detail-layout";

describe("independent dense detail scope", () => {
  it.each([
    "/notifications/delivery", "/notifications/delivery/", "/reconciliation/matches/match", "/ledger/entry",
    "/sites/site-a/notifications/delivery", "/sites/site-a/reconciliation/matches/match",
  ])("enables the selected detail %s", path => expect(isDenseDetailPage(path)).toBe(true));

  it.each([
    "/", "/orders/order", "/notifications", "/reconciliation", "/ledger", "/settings/security",
    "/reconciliation/candidates/candidate", "/reconciliation/ledger/source", "/reconciliation/conflicts/conflict",
    "/reconciliation/exceptions/exception", "/sites/site-a/orders/order", "/sites/site-a/ledger/entry",
    "/sites/site-a/notifications", "/sites/new/notifications/delivery", "/notifications/delivery/extra",
  ])("preserves the existing layout of %s", path => expect(isDenseDetailPage(path)).toBe(false));

  it("keeps complete field values and definition-list semantics in the opt-in layout", () => {
    const identifier = "202610212200101235120001187";
    const { container } = render(<DetailFields density="dense" wide={["支付宝订单号", "备注"]} items={[
      ["交易金额", "¥49.01"], ["支付宝订单号", identifier], ["备注", "第一行\n第二行"], ["撤销时间", null],
    ]} />);
    const list = container.querySelector("dl")!;
    expect(within(list).getAllByRole("term")).toHaveLength(4);
    expect(within(list).getAllByRole("definition")).toHaveLength(4);
    expect(within(list).getByText(identifier)).toBeVisible();
    expect(list.textContent).toContain("第一行\n第二行");
    expect(within(list).getByText("—")).toBeVisible();
  });

  it("copies the complete navigation ID and preserves the saved return query and state", async () => {
    const identifier = "11111111-1111-4111-8111-111111111111";
    const user = userEvent.setup();
    function Destination() { const location = useLocation(); return <output>{JSON.stringify({ search: location.search, state: location.state })}</output>; }
    const router = createMemoryRouter([
      { path: "/ledger/:id", element: <DetailNavigation global back={{ to: "/ledger?q=a%20b&cursor=two&page=2", label: "返回流水", state: { page: 2 } }} identifier={identifier} identifierLabel="归组流水编号" /> },
      { path: "/ledger", element: <Destination /> },
    ], { initialEntries: ["/ledger/" + identifier] });
    render(<RouterProvider router={router} />);
    await user.click(screen.getByRole("button", { name: "复制归组流水编号" }));
    expect(await navigator.clipboard.readText()).toBe(identifier);
    await user.click(screen.getByRole("link", { name: "返回流水" }));
    expect(router.state.location.search).toBe("?q=a%20b&cursor=two&page=2");
    expect(router.state.location.state).toEqual({ page: 2 });
  });
});
