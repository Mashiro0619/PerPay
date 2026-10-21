import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource } from "../src/api/client";
import LedgerDetail from "../src/pages/LedgerDetail";
import { json, ledger, ledgerId } from "./fixtures";

const secondSourceId = "33333333-3333-4333-8333-333333333333";
const externalEventId = "202610212200101235120001187";
const providerOrder = "202610212001000000000000000000000000000000000000000000000000000123";
const merchantOrder = "merchant-order-with-complete-identifier-".repeat(5);
const appId = "2026000000000001";
const memo = "第一行完整备注\n第二行完整备注";

function source(id: string): AdminLedgerSource {
  return { ...ledger, ledger_entry_id: id, external_event_id: externalEventId, app_id: appId, environment: "PRODUCTION", provider_account_key: "historical-account", raw_event_id: "raw-" + id, provider_order_no: providerOrder, merchant_order_no: merchantOrder, memo };
}

function detailFixture(): AdminLedgerDetail {
  return { ...ledger, external_event_id: externalEventId, provider_order_no: providerOrder, merchant_order_no: merchantOrder, memo, environment: "PRODUCTION", states: ["UNALLOCATED"], source_record_count: 2, content_consistent: true, has_conflicts: false, active_match_count: 0, active_match: null, sources: [source(ledgerId), source(secondSourceId)], matches: [], conflicts: [] };
}

function credentialsIn(card: HTMLElement, headingLevel: 3 | 4) {
  const credentials = card.querySelector<HTMLElement>("[data-detail-credentials]")!;
  expect(credentials).not.toBeNull();
  expect(within(credentials).getByRole("heading", { level: headingLevel })).toBeVisible();
  expect(credentials.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "columns");
  expect(credentials.querySelector('[data-field-wide="true"]')).toBeNull();
  return credentials;
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

describe("readable administrator ledger detail", () => {
  it("shows identical transaction facts once while keeping every source identity and processing link readable", async () => {
    const fetchMock = mount();
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    await screen.findByRole("heading", { name: "查账记录（2）" });
    expect(screen.getByRole("heading", { name: "支付宝交易" })).toBeVisible();
    const summary = screen.getByRole("heading", { name: "支付宝交易" }).closest<HTMLElement>("[data-ledger-summary]")!;
    const businessFields = summary.querySelector<HTMLElement>('[data-detail-fields][data-layout="flow"]')!;
    expect(businessFields).not.toBeNull();
    expect(within(businessFields).getAllByRole("term").map(term => term.textContent)).toEqual([
      "交易金额", "收支方向", "交易时间", "对方", "支付宝备注",
    ]);
    expect(within(businessFields).getByText("支付宝备注", { selector: "dt" }).parentElement).toHaveAttribute("data-field-wide", "true");
    const summaryCredentials = credentialsIn(summary, 3);
    expect(within(summaryCredentials).getAllByRole("term").map(term => term.textContent)).toEqual([
      "支付宝流水号", "支付宝订单号", "支付宝商户单号",
    ]);
    expect(within(summaryCredentials).getByText(providerOrder)).toBeVisible();
    expect(within(summaryCredentials).getByText(merchantOrder)).toBeVisible();
    expect(screen.queryByRole("heading", { name: externalEventId })).not.toBeInTheDocument();
    expect(within(summary).queryByRole("button", { name: "复制内部流水编号（PerPay）" })).not.toBeInTheDocument();
    expect(within(summary).queryByText("PerPay 处理状态")).not.toBeInTheDocument();
    expect(screen.queryByText(appId)).not.toBeInTheDocument();
    expect(screen.queryByText("historical-account")).not.toBeInTheDocument();
    expect(screen.getAllByText(providerOrder, { exact: true })).toHaveLength(1);
    expect(screen.getAllByText(merchantOrder, { exact: true })).toHaveLength(1);
    expect(screen.getAllByText(memo, { normalizer: value => value })).toHaveLength(1);
    expect(screen.getAllByText("交易金额", { selector: "dt" })).toHaveLength(1);
    expect(screen.getAllByText("交易时间", { selector: "dt" })).toHaveLength(1);
    expect(screen.getByText("PerPay 保存了多份相同的交易信息，按一笔流水展示。下面保留每份记录的编号和处理入口。")).toBeVisible();
    for (const [index, id] of [ledgerId, secondSourceId].entries()) {
      const sourceCard = screen.getByRole("heading", { name: "查账记录 " + (index + 1) }).closest<HTMLElement>("[data-ledger-source]")!;
      expect(sourceCard).toBeVisible();
      expect(within(sourceCard).getAllByRole("term").map(term => term.textContent)).toEqual(["内部流水编号（PerPay）", "保存时间"]);
      expect(within(sourceCard).getByText("PerPay 记录状态")).toBeVisible();
      expect(within(sourceCard).getByText(id, { exact: true })).toBeVisible();
      expect(within(sourceCard).getByRole("link", { name: "查看记录与处理" })).toHaveAttribute("href", "/reconciliation/ledger/" + id + "?selected_site=remembered-site");
      await user.click(within(sourceCard).getByRole("button", { name: "复制内部流水编号（PerPay）" }));
      expect(writeText).toHaveBeenLastCalledWith(id);
    }
    const correspondingOrders = screen.getByRole("heading", { name: "对应订单" }).closest("section")!;
    const sourceRecords = screen.getByRole("heading", { name: "查账记录（2）" }).closest("section")!;
    expect(correspondingOrders.compareDocumentPosition(sourceRecords) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "未关联收款订单" })).toBeVisible();
    expect(screen.queryByText(/账本冲突记录（/)).not.toBeInTheDocument();
    expect(document.querySelector("[data-ledger-conflict]")).toBeNull();
    await user.click(within(summaryCredentials).getByRole("button", { name: "复制支付宝订单号" }));
    expect(writeText).toHaveBeenLastCalledWith(providerOrder);
    await user.click(within(summaryCredentials).getByRole("button", { name: "复制支付宝商户单号" }));
    expect(writeText).toHaveBeenLastCalledWith(merchantOrder);
    await user.click(screen.getByRole("button", { name: "复制支付宝流水号" }));
    expect(writeText).toHaveBeenLastCalledWith(externalEventId);
    await user.click(screen.getByRole("button", { name: "支付宝流水记录操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(dialog.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "columns");
    expect(dialog.querySelector('[data-detail-fields][data-layout="flow"]')).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "复制内部流水编号（PerPay）" }));
    expect(writeText).toHaveBeenLastCalledWith(ledgerId);
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps source identifiers in copyable technical evidence and restores keyboard focus without changing business state", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "查账记录（2）" });
    expect(screen.queryByText("raw-" + secondSourceId)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "复制支付宝 App ID" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "查账记录 2 操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(dialog).getByRole("group", { name: "技术详情" })).toHaveTextContent("raw-" + secondSourceId);
    expect(within(dialog).getByRole("group", { name: "技术详情" })).toHaveTextContent("historical-account");
    for (const [field, value] of [
      ["原始事件编号", "raw-" + secondSourceId],
      ["支付宝 App ID", appId],
      ["采集来源标识", "historical-account"],
      ["语义指纹", ledger.semantic_fingerprint],
    ]) {
      await user.click(within(dialog).getByRole("button", { name: "复制" + field }));
      expect(writeText).toHaveBeenLastCalledWith(value);
    }
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
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByText("同一笔流水关联了多个订单");
    expect(screen.getByText("保存的账单信息出现过差异，不能把其中一份当作确定结果，也不能相加金额。下方保留各份查账记录和冲突详情。")).toBeVisible();
    expect(screen.getByText("还有 1 条账本冲突待处理，请查看页面下方的冲突记录。")).toBeVisible();
    expect(screen.getByText("有 2 条收款关联仍生效，无法确定唯一对应的订单。下面列出全部关联，请核对后处理。")).toBeVisible();
    expect(screen.getAllByText("仍生效 · 请核对", { exact: true })).toHaveLength(2);
    expect(screen.queryByText("已关联订单", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("当前实际关联")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "查账记录（2）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "对应订单" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "已撤销的历史关联（1）" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "账本冲突记录（2）" })).toBeVisible();
    expect(document.querySelectorAll("[data-ledger-source]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-ledger-match]")).toHaveLength(3);
    expect(document.querySelectorAll("[data-ledger-conflict]")).toHaveLength(2);
    for (const [index, item] of sources.entries()) {
      const card = screen.getByRole("heading", { name: "查账记录 " + (index + 1) }).closest<HTMLElement>("[data-ledger-source]")!;
      expect(card).toBeVisible();
      expect(card.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "flow");
      const credentials = credentialsIn(card, 4);
      expect(within(credentials).getByText(item.ledger_entry_id)).toBeVisible();
      expect(within(credentials).getByText(item.provider_order_no!)).toBeVisible();
      expect(within(credentials).getByText(item.merchant_order_no!)).toBeVisible();
      expect(within(card).getByText(item.memo!, { normalizer: value => value })).toBeVisible();
      const amount = within(card).getByText("交易金额", { selector: "dt" }).parentElement!;
      expect(amount).toHaveTextContent(item.amount_cents === 101 ? "¥1.01" : "¥1.02");
      expect(within(card).getByRole("link", { name: "查看记录与处理" })).toHaveAttribute("href", "/reconciliation/ledger/" + item.ledger_entry_id + "?selected_site=remembered-site");
      for (const [name, value] of [["内部流水编号（PerPay）", item.ledger_entry_id], ["来源支付宝订单号", item.provider_order_no!], ["来源支付宝商户单号", item.merchant_order_no!]]) {
        await user.click(within(card).getByRole("button", { name: "复制" + name }));
        expect(writeText).toHaveBeenLastCalledWith(value);
      }
    }
    for (const match of variant.matches) {
      const card = screen.getByRole("heading", { name: match.product_name }).closest<HTMLElement>("[data-ledger-match]")!;
      expect(card).toBeVisible();
      expect(card.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "flow");
      const fields = within(card).getAllByRole("term").map(term => term.textContent);
      expect(fields).toEqual(match.status === "REVERSED" ? ["所属网站", "关联时间", "撤销时间", "商户订单号（业务网站）"] : ["所属网站", "关联时间", "商户订单号（业务网站）"]);
      expect(card).toHaveTextContent(match.evidence_type === "MANUAL" ? "管理员根据支付宝流水人工关联" : "PerPay 按金额和付款时间推断，自动关联");
      expect(within(card).getByText(match.status === "SETTLED" ? "仍生效 · 请核对" : "已撤销", { exact: true })).toBeVisible();
      expect(within(card).getByRole("link", { name: "查看订单：" + match.merchant_order_no })).toHaveAttribute("href", "/orders/" + match.order_id);
      expect(within(card).getByRole("link", { name: "查看收款关联" })).toHaveAttribute("href", "/reconciliation/matches/" + match.payment_match_id + "?selected_site=remembered-site");
      expect(within(card).getByRole("link", { name: "核对使用的查账记录" })).toHaveAttribute("href", "/reconciliation/ledger/" + match.ledger_entry_id + "?selected_site=remembered-site");
      expect(within(card).getByText(match.merchant_order_no, { exact: true })).toBeVisible();
      await user.click(within(card).getByRole("button", { name: "复制商户订单号（业务网站）" }));
      expect(writeText).toHaveBeenLastCalledWith(match.merchant_order_no);
      if (match.status === "REVERSED") {
        const reversal = within(card).getByText("撤销时间").parentElement!;
        expect(reversal.querySelector("time")?.getAttribute("datetime")).toBe(match.resolved_at);
        expect(card).toHaveTextContent("这次关联已撤销，当前不再生效。");
      } else expect(within(card).queryByText("撤销时间")).not.toBeInTheDocument();
      const trigger = within(card).getByRole("button", { name: /关联记录 \d+ 记录操作/ });
      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
      const dialog = await screen.findByRole("dialog", { name: "技术详情" });
      for (const [name, value] of [["收款关联编号", match.payment_match_id], ["内部流水编号（PerPay）", match.ledger_entry_id], ["内部订单编号（PerPay）", match.order_id], ["客户端 ID", match.api_client_id]]) {
        await user.click(within(dialog).getByRole("button", { name: "复制" + name }));
        expect(writeText).toHaveBeenLastCalledWith(value);
      }
      await user.click(within(dialog).getByRole("button", { name: "关闭" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
    }
    const conflictLinks = screen.getAllByRole("link", { name: "查看冲突记录" });
    for (const conflict of variant.conflicts) {
      const link = conflictLinks.find(item => item.getAttribute("href") === "/reconciliation/conflicts/" + conflict.conflict_id + "?selected_site=remembered-site");
      expect(link).toBeVisible();
      const card = link!.closest<HTMLElement>("[data-ledger-conflict]")!;
      expect(card.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "flow");
      const credentials = credentialsIn(card, 4);
      expect(within(credentials).getByText("关联内部流水编号（PerPay）", { selector: "dt" })).toBeVisible();
      expect(within(credentials).getByText(conflict.existing_ledger_entry_id!)).toBeVisible();
      expect(within(card).getByText(conflict.status === "OPEN" ? "待处理" : "已处理")).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["AMOUNT_INFERRED", "MANUAL"] as const)("puts the current %s order before source records with complete business identifiers and one association status", async evidence => {
    const match: AdminLedgerMatch & { status: "SETTLED" } = {
      payment_match_id: "44444444-4444-4444-8444-444444444444", ledger_entry_id: secondSourceId,
      order_id: "55555555-5555-4555-8555-555555555555", merchant_order_no: "web-" + "0".repeat(60),
      product_name: "对应的网站商品", site_name: "对应业务网站", api_client_id: "real-site-client",
      evidence_type: evidence, status: "SETTLED", created_at: ledger.created_at, resolved_at: ledger.updated_at,
    };
    const fetchMock = mount({ ...detailFixture(), active_match_count: 1, active_match: match, matches: [match] });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const card = (await screen.findByRole("heading", { name: match.product_name })).closest<HTMLElement>("[data-ledger-match]")!;
    expect(within(card).getByText("已关联订单", { exact: true })).toBeVisible();
    expect(card.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
    expect(card).toHaveTextContent(evidence === "MANUAL" ? "管理员根据支付宝流水人工关联，用于确认这个订单的收款。" : "PerPay 按金额和付款时间推断，自动关联，用于确认这个订单的收款。");
    expect(within(card).getByText(match.site_name!, { exact: true })).toBeVisible();
    expect(within(card).getByText(match.merchant_order_no, { exact: true })).toBeVisible();
    expect(within(card).queryByText("撤销时间")).not.toBeInTheDocument();
    expect(document.querySelector("[data-ledger-unmatched]")).toBeNull();
    expect(screen.queryByText("当前实际关联")).not.toBeInTheDocument();
    const summary = document.querySelector<HTMLElement>("[data-ledger-summary]")!;
    expect(within(summary).queryByText(match.merchant_order_no, { exact: true })).not.toBeInTheDocument();
    expect(within(summary).queryByRole("link", { name: "查看订单：" + match.merchant_order_no })).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "查看订单：" + match.merchant_order_no })).toHaveAttribute("href", "/orders/" + match.order_id);
    expect(within(card).getByRole("link", { name: "核对使用的查账记录" })).toHaveAttribute("href", "/reconciliation/ledger/" + secondSourceId + "?selected_site=remembered-site");
    expect(card.compareDocumentPosition(document.querySelector("[data-ledger-source]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "复制商户订单号（业务网站）" }));
    expect(writeText).toHaveBeenLastCalledWith(match.merchant_order_no);
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains debit entries without inventing a receipt order", async () => {
    const fetchMock = mount({ ...detailFixture(), direction: "DEBIT", sources: [{ ...source(ledgerId), direction: "DEBIT" }] });
    expect(await screen.findByRole("heading", { name: "未关联收款订单" })).toBeVisible();
    expect(screen.getByText("这是支付宝支出流水，不对应收款订单。")).toBeVisible();
    expect(document.querySelectorAll("[data-ledger-match]")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /^查看订单：/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains that a reversed-only history has no current order while retaining its facts and links", async () => {
    const historical: AdminLedgerMatch = {
      payment_match_id: "44444444-4444-4444-8444-444444444444", ledger_entry_id: ledgerId,
      order_id: "55555555-5555-4555-8555-555555555555", merchant_order_no: "reversed-merchant-order",
      product_name: "已撤销的网站商品", site_name: "历史业务网站", api_client_id: "historical-site",
      evidence_type: "MANUAL", status: "REVERSED", created_at: ledger.created_at, resolved_at: ledger.updated_at,
    };
    const fetchMock = mount({ ...detailFixture(), matches: [historical] });
    expect(await screen.findByRole("heading", { name: "当前没有对应的收款订单" })).toBeVisible();
    expect(screen.getByText(/之前的关联已撤销，历史记录仍保留在下面。/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "已撤销的历史关联（1）" })).toBeVisible();
    const card = screen.getByRole("heading", { name: historical.product_name }).closest<HTMLElement>("[data-ledger-match]")!;
    expect(within(card).getByText("已撤销", { exact: true })).toBeVisible();
    expect(card).toHaveTextContent("这次关联已撤销，当前不再生效。");
    expect(within(card).getByText("撤销时间").parentElement!.querySelector("time")).toHaveAttribute("datetime", historical.resolved_at!);
    expect(within(card).getByRole("link", { name: "查看订单：" + historical.merchant_order_no })).toHaveAttribute("href", "/orders/" + historical.order_id);
    expect(within(card).getByRole("link", { name: "核对使用的查账记录" })).toHaveAttribute("href", "/reconciliation/ledger/" + ledgerId + "?selected_site=remembered-site");
    expect(screen.queryByText("已关联订单", { exact: true })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["RESOLVED", "已处理", true], ["IGNORED", "已确认隔离", true],
    ["RESOLVED", "已处理", false], ["IGNORED", "已确认隔离", false],
  ] as const)("keeps %s conflicts as %s without inventing a pending action (consistent: %s)", async (status, statusText, consistent) => {
    const conflictId = "77777777-7777-4777-8777-777777777777";
    const fetchMock = mount({ ...detailFixture(), content_consistent: consistent, has_conflicts: true, conflicts: [{
      conflict_id: conflictId, conflict_type: "DUPLICATE_EXTERNAL_ID", status,
      existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: ledger.updated_at,
    }] });
    expect(await screen.findByRole("heading", { name: "账本冲突记录（1）" })).toBeVisible();
    const card = document.querySelector<HTMLElement>("[data-ledger-conflict]")!;
    expect(within(card).getByText(statusText, { exact: true })).toBeVisible();
    expect(within(card).queryByText("待处理", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/账本冲突待处理/)).not.toBeInTheDocument();
    expect(screen.queryByText("有查账记录需要核对", { exact: true })).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "查看冲突记录" })).toHaveAttribute("href", "/reconciliation/conflicts/" + conflictId + "?selected_site=remembered-site");
    expect(within(card).getByText(secondSourceId, { exact: true })).toBeVisible();
    if (consistent) expect(document.querySelector("[data-ledger-warning]")).toBeNull();
    else expect(screen.getByText("账单信息存在不同版本", { exact: true })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
