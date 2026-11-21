import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { AdminOrderDetail, FinancialException } from "../src/api/client";
import { queryClient } from "../src/api/client";
import { Toaster } from "../src/components/ui/toast";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { WorkspaceProvider } from "../src/workspace";
import { candidate, candidateId, detailLedger, exceptionId, financialException, paidOrder } from "./detail-fixtures";
import { apiError, json, ledgerId, order, orderId } from "./fixtures";
import { recordAction } from "./menu-helper";

// One cent more than the order asked for, with every nullable Alipay fact present.
const availableLedger = { ...detailLedger, state: "UNALLOCATED" as const, amount_cents: 102, merchant_order_no: "2026102200012345678901234567890123456789", memo: "保留原始交易备注\n第二行完整内容" };

function mountPage(scope = "") {
  return render(
    <QueryClientProvider client={queryClient}><Toaster>
      <MemoryRouter initialEntries={[{
        pathname: scope + "/reconciliation/exceptions/" + exceptionId,
        state: { listReturn: { to: scope + "/reconciliation?tab=exceptions&q=book&cursor=next&page=2", state: { pagination: { previous: [null] } } } },
      }]}>
        <WorkspaceProvider><Routes>
          <Route path={scope + "/reconciliation/:kind/:resourceId"} element={<EvidenceDetail />} />
        </Routes></WorkspaceProvider>
      </MemoryRouter>
    </Toaster></QueryClientProvider>,
  );
}
function mockPage({ scope = "", failure, exception = financialException, relatedOrder = order }: {
  scope?: string; failure?: "order" | "ledger" | "candidate"; exception?: FinancialException; relatedOrder?: AdminOrderDetail;
} = {}) {
  const requests: Request[] = [];
  const state = { failure };
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/sites/shop") return json({ data: { client_id: "shop", deleted_at: null, configuration: { name: "测试网站" } } });
    if (path === "/api/admin/v1" + scope + "/reconciliation/exceptions/" + exceptionId) return json({ data: exception });
    if (path === "/api/admin/v1" + scope + "/orders/" + orderId) return state.failure === "order" ? apiError("order_unavailable", "订单读取暂时失败", 503) : json({ data: { ...relatedOrder, api_client_id: scope ? "shop" : relatedOrder.api_client_id } });
    if (path === "/api/admin/v1" + scope + "/reconciliation/ledger-entries/" + ledgerId) return state.failure === "ledger" ? apiError("ledger_unavailable", "流水读取暂时失败", 503) : json({ data: availableLedger });
    if (path === "/api/admin/v1" + scope + "/reconciliation/candidates/" + candidateId) return state.failure === "candidate" ? apiError("candidate_unavailable", "匹配依据读取暂时失败", 503) : json({ data: candidate });
    throw new Error("unexpected request " + path);
  }));
  return { requests, state };
}
const section = (id: string) => document.querySelector<HTMLElement>('[data-detail-section="' + id + '"]')!;
const terms = (element: HTMLElement) => within(element).getAllByRole("term").map(item => item.textContent);
const settle = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));
/** The record once the exception has been read; its related reads may still be under way. */
const opened = () => screen.findByRole("group", { name: "异常概况" });

describe("readable financial exception detail", () => {
  it.each(["", "/sites/shop"])("names the exception, compares order and entry, and keeps all evidence readable at %s", async scope => {
    const { requests } = mockPage({ scope });
    mountPage(scope);
    const summary = await opened();
    await settle();
    // The record is named after what went wrong, with its state and one sentence of explanation under it.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^实收金额不符$/);
    expect(within(summary).getByText("待处理", { exact: true })).toBeVisible();
    expect(within(summary).getByText("支付宝交易金额 ¥1.02 与可能关联订单的应付 ¥1.01 不一致；此关联仅为推断。")).toBeVisible();
    // What was due beside what arrived, and when the checkout ends beside when the payment was made.
    const compared = Array.from(summary.querySelectorAll<HTMLElement>("[data-record-compare] > div"));
    expect(compared.map(row => row.querySelector("dt")!.textContent)).toEqual(["金额", "时间"]);
    expect(compared.map(row => row.hasAttribute("data-differs"))).toEqual([true, false]);
    expect(compared[0]).toHaveTextContent("应付 ¥1.01");
    expect(compared[0]).toHaveTextContent("流水 ¥1.02（多收 ¥0.01）");
    expect(compared[1]).toHaveTextContent(/^时间收银台有效期至 .+付款 /);
    expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["关联订单", "支付宝流水", "匹配依据", "处理记录"]);
    expect(screen.getByRole("link", { name: /对账/ })).toHaveAttribute("href", scope + "/reconciliation?tab=exceptions&q=book&cursor=next&page=2");

    const related = section("order");
    expect(within(related).getByRole("heading", { level: 3 })).toHaveTextContent(order.product_name);
    expect(within(related).getByRole("link", { name: /^查看订单/ })).toHaveAttribute("href", scope + "/orders/" + orderId);
    // No Alipay number stands beside it inside the order's own record, so the website's number needs no qualifier.
    expect(terms(related)).toEqual(["商户订单号", "业务网站", "应付金额", "创建时间", "收银台有效期至"]);

    const entry = section("ledger");
    expect(terms(entry)).toEqual(["交易金额", "交易时间", "交易对方", "支付宝备注", "支付宝流水号", "支付宝订单号", "支付宝商户单号", "内部流水编号"]);
    for (const value of [availableLedger.external_event_id, availableLedger.provider_order_no, availableLedger.merchant_order_no, ledgerId]) expect(within(entry).getByText(value, { exact: true })).toBeVisible();
    expect(within(entry).getByText(/保留原始交易备注\s+第二行完整内容/)).toBeVisible();
    expect(within(entry).getByRole("link", { name: /^查看流水/ })).toHaveAttribute("href", scope + "/reconciliation/ledger/" + ledgerId);
    // The evidence adds only what the entry does not state itself.
    expect(terms(section("evidence"))).toEqual(["交易金额", "金额占用时间"]);
    expect(within(section("history")).getAllByRole("listitem").map(item => item.querySelector("span:nth-of-type(2)")!.textContent)).toEqual(["发现异常"]);
    // The explanation is said once, in the summary.
    expect(screen.getAllByText("支付宝交易金额 ¥1.02 与可能关联订单的应付 ¥1.01 不一致；此关联仅为推断。")).toHaveLength(1);

    // One primary action in the footer; identifiers only in the technical information behind its menu.
    const associate = screen.getByRole("button", { name: "人工关联收款" });
    expect(associate.closest("[data-overlay-actions]")).not.toBeNull();
    expect(screen.queryByText(exceptionId, { exact: true })).not.toBeInTheDocument();
    const user = userEvent.setup();
    const tools = screen.getByRole("button", { name: "更多操作，异常记录操作" });
    await user.click(await recordAction("账务异常技术信息", "异常记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "账务异常技术信息" });
    for (const [label, value] of [["异常编号", exceptionId], ["网站 ID", scope ? "shop" : order.api_client_id], ["内部流水编号", ledgerId], ["内部订单编号", orderId], ["可能匹配记录编号", candidateId]]) {
      await user.click(within(dialog).getByRole("button", { name: "复制" + label }));
      expect(await navigator.clipboard.readText()).toBe(value);
    }
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(tools).toHaveFocus());
    expect(requests).toHaveLength(scope ? 5 : 4);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("keeps a receipt with no order available for review without inventing order reads", async () => {
    const { requests } = mockPage({ exception: { ...financialException, exception_type: "UNMATCHED_CREDIT", order_id: null, candidate_id: null } });
    mountPage();
    const summary = await opened();
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^收入尚未匹配订单$/);
    expect(section("order")).toHaveTextContent("尚未关联订单");
    expect(within(section("order")).queryByRole("article")).not.toBeInTheDocument();
    // With no order there is nothing to compare the entry with.
    expect(summary.querySelector("[data-record-compare]")).toBeNull();
    expect(within(section("ledger")).getByText(ledgerId, { exact: true })).toBeVisible();
    expect(document.querySelector('[data-detail-section="evidence"]')).toBeNull();
    expect(screen.getByRole("button", { name: "人工关联收款" })).toBeVisible();
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      "/api/admin/v1/reconciliation/exceptions/" + exceptionId, "/api/admin/v1/reconciliation/ledger-entries/" + ledgerId,
    ]);
  });

  it.each([
    { type: "UNMATCHED_DEBIT", status: "OPEN", ignored: false, state: "历史记录", associate: false },
    { type: "UNLINKED_REFUND", status: "OPEN", ignored: false, state: "历史记录", associate: false },
    { type: "AMOUNT_MISMATCH", status: "RESOLVED", ignored: false, state: "已处理", associate: false },
    { type: "AMOUNT_MISMATCH", status: "OPEN", ignored: true, state: "未处理 · 已忽略", associate: true },
  ] as const)("preserves $type/$status/reminderIgnored=$ignored semantics", async ({ type, status, ignored, state, associate }) => {
    const resolved = status === "RESOLVED";
    mockPage({ exception: { ...financialException, exception_type: type, status, reminder_ignored: ignored,
      resolved_at: resolved ? "2026-09-06T00:05:00.000Z" : null,
      resolution: resolved ? { resolution: "manually_settled" } : null,
    } });
    mountPage();
    const summary = await opened();
    await settle();
    expect(within(summary).getByText(state, { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "人工关联收款" }) !== null).toBe(associate);
    // What became of the exception reads newest first, with the outcome under its own entry.
    const history = within(section("history")).getAllByRole("listitem");
    expect(history.map(item => item.querySelector("span:nth-of-type(2)")!.textContent)).toEqual(resolved ? ["异常已处理", "发现异常"] : ["发现异常"]);
    if (resolved) expect(history[0]).toHaveTextContent("已由管理员建立收款关联。");
    if (type === "UNMATCHED_DEBIT" || type === "UNLINKED_REFUND") expect(within(summary).getByText("旧版支出提示，不再提醒。")).toBeVisible();
  });

  it.each(["order", "ledger", "candidate"] as const)("recovers an unavailable %s read without discarding the exception", async resource => {
    const { requests, state } = mockPage({ failure: resource });
    mountPage();
    await opened();
    const owner = section(resource === "candidate" ? "evidence" : resource);
    const failure = await within(owner).findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(section("history")).getByText("发现异常")).toBeVisible();
    expect(screen.getByRole("button", { name: "更多操作，异常记录操作" })).toBeVisible();
    state.failure = undefined;
    await userEvent.setup().click(within(failure).getByRole("button", { name: "重试" }));
    if (resource === "order") expect(await within(owner).findByRole("link", { name: /^查看订单/ })).toBeVisible();
    if (resource === "ledger") expect(await within(owner).findByText(ledgerId, { exact: true })).toBeVisible();
    if (resource === "candidate") expect(await within(owner).findByText("金额占用时间")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    const suffixes = { order: "/orders/" + orderId, ledger: "/ledger-entries/" + ledgerId, candidate: "/candidates/" + candidateId };
    for (const [name, suffix] of Object.entries(suffixes)) expect(requests.filter(request => new URL(request.url).pathname.endsWith(suffix))).toHaveLength(name === resource ? 2 : 1);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("keeps a paid order from acquiring a manual action", async () => {
    mockPage({ relatedOrder: paidOrder });
    mountPage();
    await opened();
    await settle();
    expect(within(section("order")).getByRole("heading", { level: 3 })).toHaveTextContent(paidOrder.product_name);
    expect(terms(section("order"))).toContain("实收金额");
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it("restores the manual association trigger after cancelling the unchanged dialog", async () => {
    const { requests } = mockPage();
    mountPage();
    await opened();
    await settle();
    const before = requests.length;
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "人工关联收款" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "人工关联收款" });
    expect(await within(dialog).findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    await user.type(within(dialog).getByLabelText("操作理由（可选）"), "核对凭据但取消本次操作");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    // The dialog confirms against a fresh read of the order and of the entry, and cancelling writes nothing.
    expect(requests.slice(before).map(request => new URL(request.url).pathname).sort()).toEqual([
      "/api/admin/v1/orders/" + orderId, "/api/admin/v1/reconciliation/ledger-entries/" + ledgerId,
    ]);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });
});
