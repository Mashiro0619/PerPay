import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DetailCredentials, DetailFields, DetailNavigation, OrderFacts } from "../src/components/detail/DetailPrimitives";
import { isReadableDetailPage } from "../src/lib/detail-layout";
import { paidOrder } from "./detail-fixtures";

describe("independent readable detail scope", () => {
  it.each([
    "/notifications/delivery", "/notifications/delivery/", "/reconciliation/matches/match", "/ledger/entry", "/reconciliation/transactions/entry",
    "/sites/site-a/notifications/delivery", "/sites/site-a/reconciliation/matches/match",
    "/reconciliation/exceptions/exception", "/sites/site-a/reconciliation/exceptions/exception",
  ])("enables the selected detail %s", path => expect(isReadableDetailPage(path)).toBe(true));

  it.each([
    "/", "/orders/order", "/notifications", "/reconciliation", "/ledger", "/settings/security",
    "/reconciliation/candidates/candidate", "/reconciliation/ledger/source", "/reconciliation/conflicts/conflict",
    "/sites/site-a/orders/order", "/sites/site-a/ledger/entry",
    "/sites/site-a/notifications", "/sites/new/notifications/delivery", "/notifications/delivery/extra",
  ])("preserves the existing layout of %s", path => expect(isReadableDetailPage(path)).toBe(false));

  it("keeps complete field values and definition-list semantics in the opt-in layout", () => {
    const identifier = "202610212200101235120001187";
    const { container } = render(<DetailFields density="comfortable" layout="flow" wide={["支付宝订单号", "备注"]} items={[
      ["交易金额", "¥49.01"], ["支付宝订单号", identifier], ["备注", "第一行\n第二行"], ["撤销时间", null],
    ]} />);
    const list = container.querySelector("dl")!;
    expect(within(list).getAllByRole("term")).toHaveLength(4);
    expect(within(list).getAllByRole("definition")).toHaveLength(4);
    expect(within(list).getByText(identifier)).toBeVisible();
    expect(list.textContent).toContain("第一行\n第二行");
    expect(within(list).getByText("—")).toBeVisible();
    expect(within(list).getByText("交易金额")).not.toHaveClass("record-list-meta");
    expect(within(list).getByText(identifier).closest("dd")?.parentElement).toHaveAttribute("data-field-wide", "true");
  });

  it("separates the order's labelled business facts from internal client identity", () => {
    const router = createMemoryRouter([{ path: "/", element: <OrderFacts order={paidOrder} density="comfortable" layout="flow" /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("link", { name: paidOrder.product_name })).toBeVisible();
    for (const name of ["应付金额", "实收金额", "所属网站", "创建时间", "商户订单号（业务网站）"]) {
      expect(screen.getByText(name, { selector: "dt" })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "复制商户订单号" })).toBeVisible();
    expect(screen.queryByText(paidOrder.api_client_id, { exact: false })).not.toBeInTheDocument();
  });

  it("keeps existing fields and embedded order summaries on their default layout", () => {
    const router = createMemoryRouter([{ path: "/", element: <>
      <DetailFields compact items={[["金额", "¥49.01"], ["备注", "完整备注"]]} />
      <OrderFacts order={paidOrder} />
    </> }]);
    const { container } = render(<RouterProvider router={router} />);
    expect(container.querySelector('[data-detail-fields]')).toHaveAttribute("data-layout", "columns");
    expect(container.querySelector('[data-layout="flow"]')).toBeNull();
    expect(screen.getByText("完整备注")).toBeVisible();
    expect(screen.getByRole("link", { name: paidOrder.product_name })).toBeVisible();
  });

  it("groups complete credential values in a labelled definition list without hiding empty values", () => {
    const identifier = "202610212200101235120001187".repeat(4);
    render(<DetailCredentials items={[["支付宝订单号", identifier], ["商户订单号", null]]} headingLevel={4} />);
    const credentials = screen.getByRole("region", { name: "凭据编号" });
    expect(within(credentials).getByRole("heading", { level: 4 })).toBeVisible();
    expect(within(credentials).getByText(identifier)).toBeVisible();
    expect(within(credentials).getAllByRole("term").map(term => term.textContent)).toEqual(["支付宝订单号", "商户订单号"]);
    expect(within(credentials).getByText("—")).toBeVisible();
    expect(credentials.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "columns");
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
