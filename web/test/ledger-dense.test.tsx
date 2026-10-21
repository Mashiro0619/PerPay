import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource } from "../src/api/client";
import LedgerDetail from "../src/pages/LedgerDetail";
import { json, ledger, ledgerId } from "./fixtures";

const secondSourceId = "33333333-3333-4333-8333-333333333333";
const providerOrder = "202610212001000000000000000000000000000000000000000000000000000123";
const appId = "2026000000000001";
const memo = "第一行完整备注\n第二行完整备注";

function source(id: string): AdminLedgerSource {
  return { ...ledger, ledger_entry_id: id, app_id: appId, environment: "PRODUCTION", provider_account_key: "historical-account", raw_event_id: "raw-" + id, provider_order_no: providerOrder, memo };
}

function detailFixture(): AdminLedgerDetail {
  return { ...ledger, provider_order_no: providerOrder, memo, environment: "PRODUCTION", states: ["UNALLOCATED"], source_record_count: 2, content_consistent: true, has_conflicts: false, active_match_count: 0, active_match: null, sources: [source(ledgerId), source(secondSourceId)], matches: [], conflicts: [] };
}

function mount(detail = detailFixture()) {
  const fetchMock = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/admin/v1/ledger/entries/" + ledgerId);
    return json({ data: detail });
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ path: "/ledger/:ledgerEntryId", element: <LedgerDetail /> }], { initialEntries: ["/ledger/" + ledgerId + "?selected_site=remembered-site"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return fetchMock;
}

describe("compact administrator ledger detail", () => {
  it("keeps complete source evidence directly readable and copies the full identifiers", async () => {
    const fetchMock = mount();
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    await screen.findByRole("heading", { name: "采集来源（2）" });
    const sourceCard = screen.getByRole("heading", { name: "采集来源 1" }).closest<HTMLElement>("[data-ledger-source]")!;
    expect(within(sourceCard).getByText(providerOrder)).toBeVisible();
    expect(within(sourceCard).getByText(memo, { normalizer: value => value })).toBeVisible();
    expect(within(sourceCard).getByRole("link", { name: "查看原始凭据与处理" })).toHaveAttribute("href", "/reconciliation/ledger/" + ledgerId + "?selected_site=remembered-site");
    expect(screen.getByRole("heading", { name: "采集来源 2" })).toBeVisible();
    expect(screen.getByText("暂无关联记录。")).toBeVisible();
    expect(screen.getByText("暂无账本冲突。")).toBeVisible();
    await user.click(within(sourceCard).getByRole("button", { name: "复制来源支付宝订单号" }));
    expect(writeText).toHaveBeenLastCalledWith(providerOrder);
    await user.click(within(sourceCard).getByRole("button", { name: "复制支付宝 App ID" }));
    expect(writeText).toHaveBeenLastCalledWith(appId);
    await user.click(screen.getByRole("button", { name: "复制归组流水编号" }));
    expect(writeText).toHaveBeenLastCalledWith(ledgerId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the source technical evidence from inline actions and restores keyboard focus without changing business state", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "采集来源（2）" });
    const trigger = screen.getByRole("button", { name: "采集来源 2 记录操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(dialog).getByRole("group", { name: "技术详情" })).toHaveTextContent("raw-" + secondSourceId);
    expect(within(dialog).getByRole("group", { name: "技术详情" })).toHaveTextContent("historical-account");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "技术详情" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps every disputed source, two settled matches, reversal and conflict visible with their real evidence links", async () => {
    const historical: AdminLedgerMatch = {
      payment_match_id: "44444444-4444-4444-8444-444444444441",
      ledger_entry_id: ledgerId,
      order_id: "55555555-5555-4555-8555-555555555551",
      merchant_order_no: "merchant-reversed-001",
      product_name: "历史撤销关联商品",
      api_client_id: "historical-shop",
      site_name: "历史关联网站",
      evidence_type: "MANUAL",
      status: "REVERSED",
      created_at: "2026-09-06T00:02:00.000Z",
      resolved_at: "2026-09-06T00:03:00.000Z",
    };
    const firstSettled: AdminLedgerMatch = {
      ...historical,
      payment_match_id: "44444444-4444-4444-8444-444444444442",
      order_id: "55555555-5555-4555-8555-555555555552",
      merchant_order_no: "merchant-settled-001",
      product_name: "第一个生效关联商品",
      api_client_id: "first-shop",
      site_name: "第一个关联网站",
      evidence_type: "AMOUNT_INFERRED",
      status: "SETTLED",
      created_at: "2026-09-06T00:04:00.000Z",
      resolved_at: "2026-09-06T00:04:00.000Z",
    };
    const secondSettled: AdminLedgerMatch = {
      ...firstSettled,
      payment_match_id: "44444444-4444-4444-8444-444444444443",
      ledger_entry_id: secondSourceId,
      order_id: "55555555-5555-4555-8555-555555555553",
      merchant_order_no: "merchant-settled-002",
      product_name: "第二个生效关联商品",
      api_client_id: "second-shop",
      site_name: "第二个关联网站",
      evidence_type: "MANUAL",
      created_at: "2026-09-06T00:04:30.000Z",
      resolved_at: "2026-09-06T00:04:30.000Z",
    };
    const sources: AdminLedgerSource[] = [
      { ...source(ledgerId), state: "CONFLICT", provider_account_key: "first-source", raw_event_id: "66666666-6666-4666-8666-666666666661" },
      { ...source(secondSourceId), state: "CONFLICT", provider_account_key: "second-source", app_id: "2026000000000002", raw_event_id: "66666666-6666-4666-8666-666666666662", amount_cents: 102, semantic_fingerprint: "b".repeat(64) },
    ];
    const variant: AdminLedgerDetail = {
      ...detailFixture(),
      amount_cents: null,
      states: ["CONFLICT"],
      content_consistent: false,
      has_conflicts: true,
      active_match_count: 2,
      active_match: null,
      sources,
      matches: [historical, firstSettled, secondSettled],
      conflicts: [
        { conflict_id: "77777777-7777-4777-8777-777777777771", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "OPEN", existing_ledger_entry_id: ledgerId, created_at: "2026-09-06T00:05:00.000Z", resolved_at: null },
        { conflict_id: "77777777-7777-4777-8777-777777777772", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "RESOLVED", existing_ledger_entry_id: secondSourceId, created_at: "2026-09-06T00:06:00.000Z", resolved_at: "2026-09-06T00:07:00.000Z" },
      ],
    };
    const fetchMock = mount(variant);
    await screen.findByText("流水需要核查");
    expect(screen.getByText("采集来源的交易信息有差异，有争议的字段不合并显示。请核对下方全部采集来源。")).toBeVisible();
    expect(screen.getByText("这笔流水存在账本冲突，请从冲突记录查看处理情况。")).toBeVisible();
    expect(screen.getByText("存在 2 条生效关联，无法确定唯一的实际关联订单。")).toBeVisible();
    expect(screen.getByText("多条生效关联 · 请核查")).toBeVisible();
    expect(screen.queryByText("当前实际关联")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "采集来源（2）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "关联记录（3）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "账本冲突（2）" })).toBeVisible();
    expect(document.querySelectorAll("[data-ledger-source]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-ledger-match]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-ledger-conflict]")).toHaveLength(2);
    for (const [index, item] of sources.entries()) {
      const card = screen.getByRole("heading", { name: "采集来源 " + (index + 1) }).closest<HTMLElement>("[data-ledger-source]")!;
      expect(card).toBeVisible();
      expect(within(card).getByText(item.ledger_entry_id)).toBeVisible();
      expect(within(card).getByRole("link", { name: "查看原始凭据与处理" })).toHaveAttribute("href", "/reconciliation/ledger/" + item.ledger_entry_id + "?selected_site=remembered-site");
    }
    for (const match of variant.matches) {
      const card = screen.getByRole("heading", { name: match.product_name }).closest<HTMLElement>("[data-ledger-match]")!;
      expect(card).toBeVisible();
      expect(within(card).getByText(match.status === "SETTLED" ? "已关联" : "已撤销")).toBeVisible();
      expect(within(card).getByRole("link", { name: "查看订单：" + match.merchant_order_no })).toHaveAttribute("href", "/orders/" + match.order_id);
      expect(within(card).getByRole("link", { name: "查看关联记录" })).toHaveAttribute("href", "/reconciliation/matches/" + match.payment_match_id + "?selected_site=remembered-site");
      expect(within(card).getByRole("link", { name: "查看关联凭据" })).toHaveAttribute("href", "/reconciliation/ledger/" + match.ledger_entry_id + "?selected_site=remembered-site");
      expect(within(card).getByText(match.ledger_entry_id)).toBeVisible();
      const reversal = within(card).getByText("撤销时间").parentElement!;
      expect(reversal.querySelector("time")?.getAttribute("datetime") ?? null).toBe(match.status === "REVERSED" ? match.resolved_at : null);
    }
    const conflictLinks = screen.getAllByRole("link", { name: "查看冲突记录" });
    for (const conflict of variant.conflicts) {
      const link = conflictLinks.find(item => item.getAttribute("href") === "/reconciliation/conflicts/" + conflict.conflict_id + "?selected_site=remembered-site");
      expect(link).toBeVisible();
      const card = link!.closest<HTMLElement>("[data-ledger-conflict]")!;
      expect(within(card).getByText(conflict.existing_ledger_entry_id!)).toBeVisible();
      expect(within(card).getByText(conflict.status === "OPEN" ? "待处理" : "已处理")).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
