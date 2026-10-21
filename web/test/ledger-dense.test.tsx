import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource, type PaymentMatchDetail } from "../src/api/client";
import LedgerDetail from "../src/pages/LedgerDetail";
import { json, ledger, ledgerId } from "./fixtures";
import { candidate, paymentMatch } from "./detail-fixtures";

const secondSourceId = "33333333-3333-4333-8333-333333333333";
const externalEventId = "202610212200101235120001187";
const providerOrder = "202610212001" + "0".repeat(60);
const merchantOrder = "merchant-complete-identifier-".repeat(8);
const memo = "第一行完整备注\n第二行完整备注";
function source(id: string): AdminLedgerSource {
  return { ...ledger, ledger_entry_id: id, external_event_id: externalEventId, app_id: "2026000000000001", environment: "PRODUCTION", provider_account_key: "historical-account", raw_event_id: "raw-" + id, provider_order_no: providerOrder, merchant_order_no: merchantOrder, memo };
}
function detailFixture(): AdminLedgerDetail {
  return { ...ledger, external_event_id: externalEventId, provider_order_no: providerOrder, merchant_order_no: merchantOrder, memo, environment: "PRODUCTION", states: ["UNALLOCATED"], source_record_count: 2, content_consistent: true, has_conflicts: false, active_match_count: 0, reversed_match_count: 0, last_associated_at: null, last_handled_at: null, active_match: null, sources: [source(ledgerId), source(secondSourceId)], matches: [], conflicts: [] };
}
function matchSummary(id: string, status: "SETTLED" | "REVERSED", sourceId = ledgerId): AdminLedgerMatch {
  return { payment_match_id: id, ledger_entry_id: sourceId, order_id: id, merchant_order_no: "web-" + id, product_name: "商品-" + id, api_client_id: "shop", site_name: "业务网站", evidence_type: "MANUAL", status, created_at: ledger.created_at, resolved_at: status === "REVERSED" ? ledger.updated_at : null };
}
function fullMatch(match: AdminLedgerMatch, detail: AdminLedgerDetail): PaymentMatchDetail {
  return { ...paymentMatch, ...match, ledger_entry: detail.sources.find(item => item.ledger_entry_id === match.ledger_entry_id)!, candidate: match.evidence_type === "AMOUNT_INFERRED" ? candidate : null,
    order: { ...paymentMatch.order, order_id: match.order_id, product_name: match.product_name, merchant_order_no: match.merchant_order_no, api_client_id: match.api_client_id, site_name: match.site_name },
    creation_operation: { ...paymentMatch.creation_operation, actor_id: "admin", reason: "已核对收款凭据", created_at: match.created_at },
    resolution_operation: match.status === "REVERSED" ? { ...paymentMatch.creation_operation, actor_id: "reviewer", reason: "原订单归属错误", created_at: match.resolved_at! } : null };
}
function mount(detail = detailFixture(), failedMatch: boolean | (() => boolean) = false) {
  const fetchMock = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/ledger/entries/" + ledgerId) return json({ data: detail });
    if (path.endsWith("/candidates")) return json({ data: [] });
    const match = detail.matches.find(item => path.endsWith("/matches/" + item.payment_match_id));
    if (match) return (typeof failedMatch === "function" ? failedMatch() : failedMatch) ? json({ error: { code: "unavailable", message: "关联依据读取失败" } }, 503) : json({ data: fullMatch(match, detail) });
    throw new Error("Unexpected request: " + path);
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ path: "/reconciliation/transactions/:ledgerEntryId", element: <LedgerDetail /> }], { initialEntries: ["/reconciliation/transactions/" + ledgerId + "?selected_site=remembered-site"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return fetchMock;
}

describe("unified transaction detail", () => {
  it("shows identical facts once and all real sources with complete copyable credentials and inline actions", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "查账记录（2）" });
    const summary = document.querySelector<HTMLElement>("[data-ledger-summary]")!;
    expect(screen.getByRole("heading", { name: "流水与对账详情" })).toBeVisible();
    expect(within(summary).getAllByRole("term").map(item => item.textContent)).toEqual(["交易金额", "收支方向", "交易时间", "对方", "支付宝备注", "支付宝流水号", "支付宝订单号", "支付宝商户单号"]);
    for (const [name, value] of [["支付宝流水号", externalEventId], ["支付宝订单号", providerOrder], ["支付宝商户单号", merchantOrder]]) {
      expect(screen.getAllByText(value!, { exact: true })).toHaveLength(1);
      await user.click(within(summary).getByRole("button", { name: "复制" + name }));
      expect(writeText).toHaveBeenLastCalledWith(value);
    }
    expect(screen.getAllByText(memo, { normalizer: value => value })).toHaveLength(1);
    for (const id of [ledgerId, secondSourceId]) {
      const card = document.querySelector<HTMLElement>('[data-ledger-source="' + id + '"]')!;
      expect(card).toHaveAttribute("id", "source-" + id);
      expect(within(card).getByRole("button", { name: "人工关联收款" })).toBeVisible();
      expect(within(card).queryByRole("link", { name: "查看记录与处理" })).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "复制内部流水编号（PerPay）" }));
      expect(writeText).toHaveBeenLastCalledWith(id);
    }
    expect(document.querySelector("#ledger-matches-heading")!.compareDocumentPosition(document.querySelector("#ledger-sources-heading")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("copies technical evidence and restores focus without writing", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "查账记录（2）" });
    expect(screen.queryByText("raw-" + secondSourceId)).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "查账记录 2 操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    for (const [name, value] of [["原始事件编号", "raw-" + secondSourceId], ["支付宝 App ID", "2026000000000001"], ["采集来源标识", "historical-account"], ["语义指纹", ledger.semantic_fingerprint]]) {
      await user.click(within(dialog).getByRole("button", { name: "复制" + name }));
      expect(writeText).toHaveBeenLastCalledWith(value);
    }
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("keeps every disputed version, multiple live associations, full reasons and reversals on one page", async () => {
    const history = matchSummary("44444444-4444-4444-8444-444444444441", "REVERSED");
    const first = matchSummary("44444444-4444-4444-8444-444444444442", "SETTLED");
    const second = matchSummary("44444444-4444-4444-8444-444444444443", "SETTLED", secondSourceId);
    mount({ ...detailFixture(), amount_cents: null, content_consistent: false, has_conflicts: true, active_match_count: 2, reversed_match_count: 1,
      sources: [{ ...source(ledgerId), state: "CONFLICT" }, { ...source(secondSourceId), state: "CONFLICT", amount_cents: 102, semantic_fingerprint: "b".repeat(64) }],
      matches: [history, first, second], conflicts: [{ conflict_id: "conflict-id", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "OPEN", existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: null }] });
    await screen.findByText("同一笔流水关联了多个订单");
    expect(screen.getAllByText("仍生效 · 存在多条关联")).toHaveLength(2);
    expect(screen.getByText(/不能相加金额/)).toBeVisible();
    for (const match of [history, first, second]) {
      await screen.findByRole("link", { name: match.product_name });
      const card = document.querySelector<HTMLElement>('[data-ledger-match="' + match.payment_match_id + '"]')!;
      expect(within(card).getByText(match.merchant_order_no)).toBeVisible();
      expect(within(card).getByText("已核对收款凭据")).toBeVisible();
      expect(within(card).getByRole("link", { name: "核对这份记录" }).getAttribute("href")).toContain("#source-" + match.ledger_entry_id);
      expect(within(card).queryByRole("link", { name: "查看收款关联" })).not.toBeInTheDocument();
      expect(within(card).queryByText("支付宝交易金额")).not.toBeInTheDocument();
      if (match.status === "REVERSED") expect(within(card).getByText("原订单归属错误")).toBeVisible();
    }
    expect(screen.getByRole("link", { name: "查看冲突记录" })).toHaveAttribute("href", "/reconciliation/conflicts/conflict-id?selected_site=remembered-site");
    for (const [id, amount] of [[ledgerId, "¥1.01"], [secondSourceId, "¥1.02"]]) {
      const card = document.querySelector<HTMLElement>('[data-ledger-source="' + id + '"]')!;
      expect(within(card).getByText("交易金额").parentElement).toHaveTextContent(amount!);
    }
  });

  it.each(["AMOUNT_INFERRED", "MANUAL"] as const)("shows %s evidence without repeating the transaction", async evidence => {
    const match = { ...matchSummary("44444444-4444-4444-8444-444444444444", "SETTLED", secondSourceId), evidence_type: evidence, status: "SETTLED" as const };
    mount({ ...detailFixture(), active_match_count: 1, active_match: match, matches: [match] });
    await screen.findByRole("link", { name: match.product_name });
    const card = document.querySelector<HTMLElement>("[data-ledger-match]")!;
    expect(card).toHaveTextContent(evidence === "MANUAL" ? "管理员人工关联" : "PerPay 按金额和付款时间推断");
    expect(within(card).queryByText("支付宝交易金额")).not.toBeInTheDocument();
    expect(document.querySelector("[data-ledger-unmatched]")).toBeNull();
  });

  it("shows a recoverable evidence read failure", async () => {
    let failed = true;
    const match = matchSummary("44444444-4444-4444-8444-444444444444", "REVERSED");
    const fetchMock = mount({ ...detailFixture(), matches: [match], reversed_match_count: 1 }, () => failed);
    expect(await screen.findByText("关联依据读取失败")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "已撤销的历史关联（1）" })).toBeVisible();
    failed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("link", { name: match.product_name })).toBeVisible();
    expect(screen.queryByText("关联依据读取失败")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith("/matches/" + match.payment_match_id))).toHaveLength(2);
  });

  it("explains expenses without offering receipt association", async () => {
    const fetchMock = mount({ ...detailFixture(), direction: "DEBIT", sources: [{ ...source(ledgerId), direction: "DEBIT" }] });
    expect(await screen.findByText("这是支付宝支出流水，不对应收款订单。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["RESOLVED", "IGNORED"] as const)("keeps a %s conflict without inventing a pending issue", async status => {
    mount({ ...detailFixture(), conflicts: [{ conflict_id: "conflict-id", conflict_type: "DUPLICATE_EXTERNAL_ID", status, existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: ledger.updated_at }] });
    await screen.findByRole("heading", { name: "账本冲突记录（1）" });
    const card = document.querySelector<HTMLElement>("[data-ledger-conflict]")!;
    expect(within(card).getByText(status === "RESOLVED" ? "已处理" : "已确认隔离")).toBeVisible();
    expect(within(card).getByText(secondSourceId)).toBeVisible();
    expect(document.querySelector("[data-ledger-warning]")).toBeNull();
  });
});
