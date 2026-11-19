import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSource, type MatchCandidate, type PaymentMatchDetail } from "../src/api/client";
import LedgerDetail from "../src/pages/LedgerDetail";
import { json, ledger, ledgerId, order, orderId } from "./fixtures";
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
/** A transaction PerPay holds one copy of. */
function single(entry: Partial<AdminLedgerDetail> = {}, copy: Partial<AdminLedgerSource> = {}): AdminLedgerDetail {
  return { ...detailFixture(), source_record_count: 1, sources: [{ ...source(ledgerId), ...copy }], ...entry };
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
function mount(detail = detailFixture(), options: { failedMatch?: () => boolean; candidates?: readonly MatchCandidate[]; hash?: string } = {}) {
  const fetchMock = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/ledger/entries/" + ledgerId) return json({ data: detail });
    if (path.endsWith("/candidates")) return json({ data: (options.candidates ?? []).filter(item => path.endsWith("/ledger-entries/" + item.ledger_entry_id + "/candidates")) });
    if (path.endsWith("/orders/" + orderId)) return json({ data: order });
    const match = detail.matches.find(item => path.endsWith("/matches/" + item.payment_match_id));
    if (match) return options.failedMatch?.() ? json({ error: { code: "unavailable", message: "关联依据读取失败" } }, 503) : json({ data: fullMatch(match, detail) });
    throw new Error("Unexpected request: " + path);
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ path: "/reconciliation/transactions/:ledgerEntryId", element: <LedgerDetail /> }], { initialEntries: ["/reconciliation/transactions/" + ledgerId + "?selected_site=remembered-site" + (options.hash ?? "")] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return fetchMock;
}
const section = (id: string) => document.querySelector<HTMLElement>('[data-detail-section="' + id + '"]')!;
const record = (id: string) => document.getElementById(id)!;
const terms = (element: HTMLElement) => within(element).getAllByRole("term").map(item => item.textContent);
const value = (element: HTMLElement, name: string) => within(element).getByText(name, { exact: true }).nextElementSibling;
const settle = async () => {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
};

describe("unified transaction detail", () => {
  it("shows identical facts once, every source with complete copyable identifiers, and one association for copies that agree", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    // The amount, the time and the account stand in the summary; the section adds what identifies the transaction.
    const facts = section("transaction");
    expect(terms(facts)).toEqual(["对方", "支付宝备注", "支付宝流水号", "支付宝订单号", "支付宝商户单号"]);
    expect(value(facts, "对方")).toHaveTextContent(/^未提供$/);
    for (const [name, text] of [["支付宝流水号", externalEventId], ["支付宝订单号", providerOrder], ["支付宝商户单号", merchantOrder]] as const) {
      expect(screen.getAllByText(text, { exact: true })).toHaveLength(1);
      await user.click(within(facts).getByRole("button", { name: "复制" + name }));
      expect(writeText).toHaveBeenLastCalledWith(text);
    }
    expect(screen.getAllByText(memo, { normalizer: text => text })).toHaveLength(1);

    const sources = section("sources");
    expect(within(sources).getByRole("heading", { level: 2 })).toHaveTextContent(/^采集记录，共 ?2 ?项$/);
    expect(within(sources).getByText("多份采集记录对应同一笔交易。")).toBeVisible();
    for (const [index, id] of [ledgerId, secondSourceId].entries()) {
      const card = record("source-" + id);
      expect(sources).toContainElement(card);
      expect(within(card).getByRole("heading", { name: "采集记录 " + (index + 1), level: 3 })).toBeVisible();
      expect(within(card).getByText("未分配", { exact: true })).toBeVisible();
      // Identical sources repeat none of the transaction's facts.
      expect(terms(card)).toEqual(["内部流水编号（PerPay）", "保存时间"]);
      // Copies that agree stand for one another: none of them asks to be chosen.
      expect(within(card).queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "复制内部流水编号（PerPay）" }));
      expect(writeText).toHaveBeenLastCalledWith(id);
    }
    expect(screen.getByRole("button", { name: "人工关联收款" }).closest("[data-overlay-actions]")).not.toBeNull();
    const orders = screen.getByRole("region", { name: "对应订单" });
    await waitFor(() => expect(orders).toHaveAttribute("data-section-empty", "true"));
    expect(orders).toHaveTextContent("尚未关联收款订单。");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it.each([true, false])("keeps a single source identifiable and actionable when content_consistent is %s", async consistent => {
    // A single copy is inconsistent only with a version PerPay declined to store: a duplicate conflict.
    const detail = single({
      provider_order_no: consistent ? "20261103" : null, merchant_order_no: null,
      ...(consistent ? {} : { amount_cents: null, content_consistent: false, has_conflicts: true, conflicts: [{
        conflict_id: "conflict-id", conflict_type: "DUPLICATE_EXTERNAL_ID" as const, status: "OPEN" as const,
        existing_ledger_entry_id: ledgerId, created_at: ledger.created_at, resolved_at: null,
      }] }),
    }, { provider_order_no: "20261103", merchant_order_no: null });
    const fetchMock = mount(detail);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    const sources = section("sources");
    expect(within(sources).getByRole("heading", { level: 2 })).toHaveTextContent(/^采集记录，共 ?1 ?项$/);
    // The only source is the record itself: there is nothing to tell apart, and nothing for a bookmark to single out.
    expect(sources.querySelector("[data-sub-record]")).toBeNull();
    expect(document.getElementById("source-" + ledgerId)).toBeNull();
    expect(value(sources, "PerPay 记录状态")).toHaveTextContent(/^未分配$/);
    await user.click(within(sources).getByRole("button", { name: "复制内部流水编号（PerPay）" }));
    expect(writeText).toHaveBeenLastCalledWith(ledgerId);
    const associate = screen.getByRole("button", { name: "人工关联收款" });
    expect(associate.closest("[data-overlay-actions]")).not.toBeNull();

    const facts = section("transaction");
    expect(within(facts).queryByText("支付宝商户单号")).not.toBeInTheDocument();
    if (consistent) {
      await user.click(within(facts).getByRole("button", { name: "复制支付宝订单号" }));
      expect(writeText).toHaveBeenLastCalledWith("20261103");
      expect(terms(sources)).toEqual(["PerPay 记录状态", "内部流水编号（PerPay）", "保存时间"]);
      expect(document.querySelector("[data-record-notice]")).toBeNull();
    } else {
      // The stored copy states for itself what the transaction as a whole no longer can.
      expect(value(facts, "支付宝订单号")).toHaveTextContent(/^有争议$/);
      expect(within(facts).queryByRole("button", { name: "复制支付宝订单号" })).not.toBeInTheDocument();
      expect(screen.getByRole("group", { name: "流水概况" })).toHaveTextContent("金额有争议");
      expect(terms(sources)).toEqual(["PerPay 记录状态", "交易金额", "支付宝订单号", "内部流水编号（PerPay）", "保存时间"]);
      expect(value(sources, "交易金额")).toHaveTextContent(/^¥1\.01$/);
      await user.click(within(sources).getByRole("button", { name: "复制支付宝订单号" }));
      expect(writeText).toHaveBeenLastCalledWith("20261103");
      expect(within(sources).getByText("这是 PerPay 保存的版本，与它不一致的版本见账本冲突。")).toBeVisible();
      expect(document.querySelector("[data-record-notice]")).toHaveAttribute("data-record-notice", "danger");
      expect(screen.getByText("账单信息存在不同版本", { exact: true })).toBeVisible();
      expect(screen.getByText("有 1 条账本冲突待处理。")).toBeVisible();
      // The conflict is about another version of this very record, so it does not point back at it.
      expect(terms(record("conflict-conflict-id"))).toEqual(["发现时间"]);
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("copies technical evidence from the record's menu and returns focus to it without writing", async () => {
    const fetchMock = mount();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    expect(screen.queryByText("raw-" + secondSourceId)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /技术信息|技术详情/ })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "更多操作，流水操作" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["流水技术信息", "采集记录 1 技术信息", "采集记录 2 技术信息"]);
    await user.click(screen.getByRole("menuitem", { name: "采集记录 2 技术信息" }));
    const dialog = await screen.findByRole("dialog", { name: "采集记录 2 技术信息" });
    for (const [name, text] of [["内部流水编号（PerPay）", secondSourceId], ["原始事件编号", "raw-" + secondSourceId], ["支付宝 App ID", "2026000000000001"], ["采集来源标识", "historical-account"], ["语义指纹", ledger.semantic_fingerprint]] as const) {
      await user.click(within(dialog).getByRole("button", { name: "复制" + name }));
      expect(writeText).toHaveBeenLastCalledWith(text);
    }
    await user.click(within(dialog).getByRole("button", { name: "关闭采集记录 2 技术信息" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("leaves a single-source record at its top for a source bookmark, with that source's identifiers among its own", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const match = { ...matchSummary("44444444-4444-4444-8444-444444444444", "SETTLED"), status: "SETTLED" as const };
    const fetchMock = mount(single({ states: ["ALLOCATED"], active_match_count: 1, active_match: match, matches: [match] }, { state: "ALLOCATED" }), { hash: "#source-" + ledgerId });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    await settle();
    expect(scroll).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
    // Identifiers are in view at once, not behind a disclosure.
    await user.click(within(section("transaction")).getByRole("button", { name: "复制支付宝订单号" }));
    expect(writeText).toHaveBeenLastCalledWith(providerOrder);
    await user.click(screen.getByRole("button", { name: "更多操作，流水操作" }));
    expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["流水技术信息", "收款关联技术信息"]);
    await user.click(screen.getByRole("menuitem", { name: "流水技术信息" }));
    const dialog = await screen.findByRole("dialog", { name: "流水技术信息" });
    for (const name of ["内部流水编号（PerPay）", "支付宝流水号", "原始事件编号", "支付宝 App ID", "采集来源标识", "语义指纹"]) {
      expect(within(dialog).getByRole("button", { name: "复制" + name })).toBeVisible();
    }
    expect(fetchMock.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("keeps every disputed version, multiple live associations, full reasons and reversals on one page", async () => {
    const history = matchSummary("44444444-4444-4444-8444-444444444441", "REVERSED");
    const first = matchSummary("44444444-4444-4444-8444-444444444442", "SETTLED");
    const second = matchSummary("44444444-4444-4444-8444-444444444443", "SETTLED", secondSourceId);
    mount({ ...detailFixture(), amount_cents: null, content_consistent: false, has_conflicts: true, active_match_count: 2, reversed_match_count: 1,
      sources: [{ ...source(ledgerId), state: "CONFLICT" }, { ...source(secondSourceId), state: "CONFLICT", amount_cents: 102, semantic_fingerprint: "b".repeat(64) }],
      matches: [history, first, second], conflicts: [{ conflict_id: "conflict-id", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "OPEN", existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: null }] });
    const user = userEvent.setup();
    await screen.findByText("同一笔流水关联了多个订单");
    expect(document.querySelector("[data-record-notice]")).toHaveAttribute("data-record-notice", "danger");
    expect(screen.getByText(/金额不可相加/)).toBeVisible();
    expect(screen.getByText("有 1 条账本冲突待处理。")).toBeVisible();
    await settle();
    expect(screen.getAllByText("存在多条关联")).toHaveLength(2);
    // A payment is settled once: with an association in effect, no copy offers another.
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^已撤销的关联，共 ?1 ?项$/ }));
    for (const match of [history, first, second]) {
      const card = record("match-" + match.payment_match_id);
      await waitFor(() => expect(card).toBeVisible());
      expect(within(card).getByRole("heading", { name: match.product_name, level: 3 })).toBeVisible();
      expect(value(card, "商户订单号")).toHaveTextContent(match.merchant_order_no);
      expect(value(card, "关联理由")).toHaveTextContent("已核对收款凭据");
      expect(within(card).getByRole("link", { name: "采集记录 " + (match.ledger_entry_id === ledgerId ? 1 : 2) }).getAttribute("href")).toContain("#source-" + match.ledger_entry_id);
      expect(within(card).queryByRole("link", { name: "查看收款关联" })).not.toBeInTheDocument();
      expect(within(card).queryByText("支付宝交易金额")).not.toBeInTheDocument();
      if (match.status === "REVERSED") {
        expect(value(card, "撤销操作人")).toHaveTextContent("reviewer");
        expect(value(card, "撤销理由")).toHaveTextContent("原订单归属错误");
        expect(within(card).queryByRole("button", { name: "撤销错误关联" })).not.toBeInTheDocument();
      } else expect(within(card).getByRole("button", { name: "撤销错误关联" })).toBeVisible();
    }
    // Each order is compared with the copy it is tied to.
    expect(value(record("match-" + first.payment_match_id), "应付金额")).toHaveTextContent(/^¥1\.01$/);
    expect(value(record("match-" + second.payment_match_id), "应付金额")).toHaveTextContent("¥1.01（流水多 ¥0.01）");
    const conflict = record("conflict-conflict-id");
    expect(within(conflict).getByRole("link", { name: "查看冲突记录" })).toHaveAttribute("href", "/reconciliation/conflicts/conflict-id?selected_site=remembered-site");
    expect(value(conflict, "涉及的采集记录")).toHaveTextContent("采集记录 2");
    for (const [id, amount] of [[ledgerId, "¥1.01"], [secondSourceId, "¥1.02"]] as const) {
      expect(value(record("source-" + id), "交易金额")).toHaveTextContent(amount);
    }
  });

  it("leaves the choice of copy to the administrator when unassociated copies differ", async () => {
    const eligible: MatchCandidate = { ...candidate, ledger_entry_id: secondSourceId, status: "ELIGIBLE", decided_by_operation_id: null, decided_at: null };
    const copies = [source(ledgerId), { ...source(secondSourceId), amount_cents: 102, semantic_fingerprint: "b".repeat(64) }];
    const view = (settled: boolean): AdminLedgerDetail => {
      const match = { ...matchSummary("44444444-4444-4444-8444-444444444444", "SETTLED"), status: "SETTLED" as const };
      return { ...detailFixture(), amount_cents: null, content_consistent: false, has_conflicts: true, sources: settled ? [{ ...copies[0]!, state: "ALLOCATED" }, copies[1]!] : copies,
        ...(settled ? { states: ["UNALLOCATED", "ALLOCATED"], active_match_count: 1, active_match: match, matches: [match] } : {}) };
    };
    const first = mount(view(false));
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    await waitFor(() => expect(section("payments")).toHaveTextContent("尚未关联收款订单，可在要采用的采集记录上人工关联。"));
    for (const id of [ledgerId, secondSourceId]) expect(within(record("source-" + id)).getByRole("button", { name: "人工关联收款" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "人工关联收款" })).toHaveLength(2);
    expect(first).toHaveBeenCalledTimes(3);
    cleanup();
    queryClient.clear();

    // Once one copy holds the association, the other has nothing left to take: neither on its own nor through a suggestion made for it earlier.
    mount(view(true), { candidates: [eligible] });
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    await settle();
    const suggestion = record("candidate-" + eligible.candidate_id);
    expect(within(suggestion).getByText("订单或流水当前不可人工关联。")).toBeVisible();
    expect(within(suggestion).getByRole("link", { name: "采集记录 2" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /人工关联收款|关联到此订单/ })).not.toBeInTheDocument();
  });

  it.each(["AMOUNT_INFERRED", "MANUAL"] as const)("shows %s evidence without repeating the transaction", async evidence => {
    const match = { ...matchSummary("44444444-4444-4444-8444-444444444444", "SETTLED", secondSourceId), evidence_type: evidence, status: "SETTLED" as const };
    mount({ ...detailFixture(), active_match_count: 1, active_match: match, matches: [match] });
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    await settle();
    const card = record("match-" + match.payment_match_id);
    expect(card).toHaveTextContent(evidence === "MANUAL" ? "管理员人工关联 · admin · " : "PerPay 按金额和付款时间推断 · ");
    expect(card).not.toHaveTextContent(/支付宝交易金额|匹配金额|支付宝交易时间/);
    const basis = within(card).queryByRole("button", { name: /^匹配依据/ });
    if (evidence === "MANUAL") expect(basis).not.toBeInTheDocument();
    else {
      // Only what the entry does not state itself is listed, and only on request.
      expect(basis).toHaveAttribute("aria-expanded", "false");
      const evidencePanel = record("candidate-" + candidate.candidate_id);
      expect(card).toContainElement(evidencePanel);
      expect(within(evidencePanel).getAllByRole("term", { hidden: true }).map(item => item.textContent)).toEqual(["金额占用时间"]);
    }
    expect(section("payments")).not.toHaveTextContent("尚未关联收款订单。");
  });

  it("keeps an association in place when its own read fails, and recovers on refresh", async () => {
    let failed = true;
    const match = matchSummary("44444444-4444-4444-8444-444444444444", "REVERSED");
    const fetchMock = mount({ ...detailFixture(), matches: [match], reversed_match_count: 1 }, { failedMatch: () => failed });
    expect(await screen.findByText("关联依据读取失败")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    // With no association in effect, what was reversed is shown without asking.
    expect(screen.getByRole("button", { name: /^已撤销的关联，共 ?1 ?项$/ })).toHaveAttribute("aria-expanded", "true");
    expect(section("payments")).toHaveTextContent("原关联已撤销，当前没有对应的收款订单。");
    // What the entry itself knows of the association stays readable.
    const card = record("match-" + match.payment_match_id);
    expect(within(card).getByRole("heading", { name: match.product_name, level: 3 })).toBeVisible();
    expect(value(card, "商户订单号")).toHaveTextContent(match.merchant_order_no);
    expect(within(card).queryByText("关联理由")).not.toBeInTheDocument();
    failed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(await within(card).findByText("关联理由")).toBeVisible();
    expect(screen.queryByText("关联依据读取失败")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname.endsWith("/matches/" + match.payment_match_id))).toHaveLength(2);
  });

  it("explains expenses without offering receipt association", async () => {
    const fetchMock = mount(single({ direction: "DEBIT" }, { direction: "DEBIT" }));
    expect(await screen.findByText("支出流水不关联收款订单。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "支付宝支出", level: 1 })).toBeVisible();
    const summary = screen.getByRole("group", { name: "流水概况" });
    expect(summary).toHaveTextContent("−¥1.01");
    // An expense is never matched to an order, so it is not called unassociated either.
    expect(within(summary).queryByText("未关联")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
    expect(within(section("sources")).getByRole("button", { name: "复制内部流水编号（PerPay）" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更多操作，流水操作" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([["RESOLVED", secondSourceId], ["IGNORED", "99999999-9999-4999-8999-999999999999"]] as const)("keeps a %s conflict without inventing a pending issue", async (status, existing) => {
    mount({ ...detailFixture(), has_conflicts: true, conflicts: [{ conflict_id: "conflict-id", conflict_type: "DUPLICATE_EXTERNAL_ID", status, existing_ledger_entry_id: existing, created_at: ledger.created_at, resolved_at: ledger.updated_at }] });
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    expect(within(section("conflicts")).getByRole("heading", { level: 2 })).toHaveTextContent(/^账本冲突，共 ?1 ?项$/);
    const card = record("conflict-conflict-id");
    expect(within(card).getByText(status === "RESOLVED" ? "已处理" : "已确认隔离", { exact: true })).toBeVisible();
    if (existing === secondSourceId) {
      expect(terms(card)).toEqual(["发现时间", "处理时间", "涉及的采集记录"]);
      expect(within(card).getByRole("link", { name: "采集记录 2" }).getAttribute("href")).toContain("#source-" + secondSourceId);
    } else {
      // An entry that is not one of this transaction's copies can only be named.
      expect(terms(card)).toEqual(["发现时间", "处理时间", "关联内部流水编号（PerPay）"]);
      expect(within(card).getByRole("button", { name: "复制关联内部流水编号（PerPay）" })).toBeVisible();
    }
    expect(document.querySelector("[data-record-notice]")).toBeNull();
    expect(within(screen.getByRole("group", { name: "流水概况" })).queryByText("需要核查")).not.toBeInTheDocument();
  });

  it("lists a suggested order among the orders with its own association, and sets a replaced suggestion aside", async () => {
    const eligible: MatchCandidate = { ...candidate, status: "ELIGIBLE", decided_by_operation_id: null, decided_at: null };
    const replaced: MatchCandidate = { ...candidate, candidate_id: "99999999-9999-4999-8999-999999999999", status: "SUPERSEDED" };
    const fetchMock = mount(single({ states: ["CANDIDATE"] }, { state: "CANDIDATE" }), { candidates: [eligible, replaced], hash: "#candidate-" + replaced.candidate_id });
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    await settle();
    const orders = section("payments");
    expect(orders).not.toHaveAttribute("data-section-empty");
    const suggestion = record("candidate-" + eligible.candidate_id);
    expect(orders).toContainElement(suggestion);
    expect(within(suggestion).getByRole("heading", { name: order.product_name, level: 3 })).toBeVisible();
    expect(within(suggestion).getByText("可匹配", { exact: true })).toBeVisible();
    expect(within(suggestion).getByText("仅为匹配建议，核对订单与流水后可人工关联，尚未确认收款。")).toBeVisible();
    expect(within(suggestion).getByRole("link", { name: "查看订单" }).getAttribute("href")).toContain("/orders/" + orderId);
    expect(terms(suggestion)).toEqual(["商户订单号", "业务网站", "应付金额", "订单收款状态", "金额占用时间", "形成时间"]);
    expect(value(suggestion, "商户订单号")).toHaveTextContent(order.merchant_order_no);
    expect(within(suggestion).getByRole("button", { name: "关联到此订单" })).toBeVisible();
    // The record's own action stays beside it: it lets the administrator choose any other order.
    expect(screen.getByRole("button", { name: "人工关联收款" }).closest("[data-overlay-actions]")).not.toBeNull();
    // A replaced suggestion is history; a link to it opens what holds it.
    const history = record("candidate-" + replaced.candidate_id);
    await waitFor(() => expect(history).toHaveFocus());
    expect(history).toBeVisible();
    expect(screen.getByRole("button", { name: /^已替代的匹配建议，共 ?1 ?项$/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(history).getByText("已被替代，仅供查阅。")).toBeVisible();
    expect(within(history).queryByRole("button", { name: "关联到此订单" })).not.toBeInTheDocument();
    // One read of the entry, one of its suggestions, and one of the order both of them name.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
