import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminOrderDetail, type ReconciliationLedgerEntry } from "../src/api/client";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { apiError, json, ledger, ledgerId, order, orderId } from "./fixtures";

function mount(selectedOrder: AdminOrderDetail, selectedLedger: ReconciliationLedgerEntry) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/orders/" + orderId)) return json({ data: selectedOrder });
    if (path.endsWith("/ledger-entries/" + ledgerId)) return json({ data: selectedLedger });
    return apiError("route_not_found", "unexpected test request", 404);
  }));
  render(<QueryClientProvider client={queryClient}><MemoryRouter>
    <FinancialDialog initialOrderId={orderId} initialLedgerId={ledgerId} lockContext onClose={vi.fn()} onSuccess={vi.fn()} />
  </MemoryRouter></QueryClientProvider>);
  return requests;
}

function accountField(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return within(term.parentElement!);
}

describe("manual settlement receiving accounts", () => {
  it("keeps the order and ledger accounts distinct in the final confirmation without fetching an account catalog", async () => {
    const requests = mount(
      { ...order, alipay_account_id: "order-account", alipay_account_name: "网站订单收款账号" },
      { ...ledger, alipay_account_id: "ledger-account", alipay_account_name: "实际入账收款账号" },
    );
    expect(await screen.findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    expect(accountField("订单收款账号").getByRole("link", { name: "网站订单收款账号" })).toHaveAttribute("href", "/settings/accounts/order-account");
    expect(accountField("流水收款账号").getByRole("link", { name: "实际入账收款账号" })).toHaveAttribute("href", "/settings/accounts/ledger-account");
    expect(accountField("流水收款账号").queryByText("网站订单收款账号")).not.toBeInTheDocument();
    expect(screen.queryByText(/账号 ID：/)).not.toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("disambiguates different accounts with the same visible name at the final confirmation", async () => {
    mount(
      { ...order, alipay_account_id: "order-account", alipay_account_name: "同名收款账号" },
      { ...ledger, alipay_account_id: "ledger-account", alipay_account_name: "同名收款账号" },
    );
    expect(await screen.findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    expect(accountField("订单收款账号").getByText("账号 ID：order-account")).toBeVisible();
    expect(accountField("流水收款账号").getByText("账号 ID：ledger-account")).toBeVisible();
  });

  it("keeps the same account concise on both sides", async () => {
    const identity = { alipay_account_id: "same-account", alipay_account_name: "同一收款账号" };
    mount({ ...order, ...identity }, { ...ledger, ...identity });
    expect(await screen.findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    expect(accountField("订单收款账号").getByRole("link", { name: identity.alipay_account_name })).toBeVisible();
    expect(accountField("流水收款账号").getByRole("link", { name: identity.alipay_account_name })).toBeVisible();
    expect(screen.queryByText(/账号 ID：/)).not.toBeInTheDocument();
  });

  it.each([undefined, null])("shows an unavailable historical ledger identity (%s) without substituting the order account", async value => {
    mount(
      { ...order, alipay_account_id: "order-account", alipay_account_name: "订单账号" },
      value === undefined ? ledger : { ...ledger, alipay_account_id: value, alipay_account_name: value },
    );
    expect(await screen.findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    expect(accountField("流水收款账号").getByText("历史账号")).toBeVisible();
    expect(accountField("流水收款账号").queryByRole("link")).not.toBeInTheDocument();
    expect(accountField("订单收款账号").getByRole("link", { name: "订单账号" })).toBeVisible();
  });

  it("keeps a historical order account separate from a known ledger account", async () => {
    mount(order, { ...ledger, alipay_account_id: "ledger-account", alipay_account_name: "实际入账账号" });
    expect(await screen.findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    expect(accountField("订单收款账号").getByText("历史账号")).toBeVisible();
    expect(accountField("流水收款账号").getByRole("link", { name: "实际入账账号" })).toBeVisible();
  });
});
