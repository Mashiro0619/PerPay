import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { ExceptionCard, LedgerFacts } from "../src/components/detail/PaymentEvidence";
import { Toaster } from "../src/components/ui/toast";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { WorkspaceProvider } from "../src/workspace";
import { candidate, candidateId, detailLedger, exceptionId, financialException, paidOrder } from "./detail-fixtures";
import { apiError, json, ledgerId, order, orderId } from "./fixtures";
import { recordAction } from "./menu-helper";

const availableLedger = { ...detailLedger, state: "UNALLOCATED" as const, merchant_order_no: "2026102200012345678901234567890123456789", memo: "保留原始交易备注\n第二行完整内容" };
function mount(children: ReactNode) {
  return render(<QueryClientProvider client={queryClient}><Toaster><MemoryRouter>{children}</MemoryRouter></Toaster></QueryClientProvider>);
}
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
function mockPage(scope = "", failure?: "order" | "ledger" | "candidate") {
  const requests: Request[] = [];
  const state = { failure };
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/sites/shop") return json({ data: { client_id: "shop", deleted_at: null, configuration: { name: "测试网站" } } });
    if (path === "/api/admin/v1" + scope + "/reconciliation/exceptions/" + exceptionId) return json({ data: financialException });
    if (path === "/api/admin/v1" + scope + "/orders/" + orderId) return state.failure === "order" ? apiError("order_unavailable", "订单读取暂时失败", 503) : json({ data: { ...order, api_client_id: scope ? "shop" : order.api_client_id } });
    if (path === "/api/admin/v1" + scope + "/reconciliation/ledger-entries/" + ledgerId) return state.failure === "ledger" ? apiError("ledger_unavailable", "流水读取暂时失败", 503) : json({ data: availableLedger });
    if (path === "/api/admin/v1" + scope + "/reconciliation/candidates/" + candidateId) return state.failure === "candidate" ? apiError("candidate_unavailable", "匹配依据读取暂时失败", 503) : json({ data: candidate });
    throw new Error("unexpected request " + path);
  }));
  return { requests, state };
}
function knownCard(exception = financialException) {
  return <ExceptionCard exception={exception} ledger={availableLedger} order={order} candidate={candidate} density="comfortable" />;
}

describe("readable financial exception detail", () => {
  it.each(["", "/sites/shop"])("keeps the scoped record and all evidence readable at %s", async scope => {
    const { requests } = mockPage(scope);
    mountPage(scope);
    const card = await screen.findByRole("group", { name: "账务异常记录" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^账务异常详情$/);
    expect(card).toHaveAttribute("data-size", "default");
    expect(card.querySelector('[data-slot="card-header"] .record-list-meta')).toBeNull();
    const orderLink = await within(card).findByRole("link", { name: order.product_name });
    expect(orderLink).toHaveAttribute("href", scope + "/orders/" + orderId);
    expect(screen.getByRole("link", { name: /对账/ })).toHaveAttribute("href", scope + "/reconciliation?tab=exceptions&q=book&cursor=next&page=2");
    const credentials = await within(card).findByRole("region", { name: "核对凭据" });
    expect(within(card).getByRole("heading", { name: "支付宝流水与 PerPay 记录" })).toBeVisible();
    expect(within(credentials).getByRole("heading", { name: "核对凭据", level: 4 })).toBeVisible();
    expect(within(credentials).getAllByRole("term").map(term => term.textContent)).toEqual(["支付宝订单号", "支付宝商户单号", "内部流水编号（PerPay）"]);
    expect(credentials.querySelector("[data-detail-fields]")).toHaveAttribute("data-layout", "columns");
    for (const value of [availableLedger.provider_order_no, availableLedger.merchant_order_no, ledgerId]) expect(within(credentials).getByText(value, { exact: true })).toBeVisible();
    expect(within(card).getByText("保留原始交易备注 第二行完整内容").closest("[data-field-wide]")).toHaveAttribute("data-field-wide", "true");
    expect(within(card).getByText("发现时间")).toBeVisible();
    expect(within(card).getByRole("heading", { name: "匹配依据" })).toBeVisible();
    const associate = within(card).getByRole("button", { name: "人工关联收款" });
    const tools = within(card).getByRole("button", { name: "更多操作，异常记录操作" });
    expect(associate.closest('[data-slot="card-action"]')).not.toBeNull();
    expect(tools.closest('[data-slot="card-action"]')).not.toBeNull();
    expect(card.querySelector('[data-slot="card-footer"]')).toBeNull();
    expect(within(card).queryByText(exceptionId, { exact: true })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await recordAction("技术详情", "异常记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "技术详情" });
    for (const [label, value] of [["异常编号", exceptionId], ["客户端 ID", scope ? "shop" : order.api_client_id], ["内部流水编号（PerPay）", ledgerId], ["内部订单编号", orderId], ["可能匹配记录编号", candidateId]]) {
      await user.click(within(dialog).getByRole("button", { name: "复制" + label }));
      expect(await navigator.clipboard.readText()).toBe(value);
    }
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(tools).toHaveFocus());
    expect(requests).toHaveLength(scope ? 5 : 4);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("keeps a receipt with no order available for review without inventing order reads", () => {
    const fetch = vi.fn(() => { throw new Error("unexpected request"); });
    vi.stubGlobal("fetch", fetch);
    mount(<ExceptionCard exception={{ ...financialException, exception_type: "UNMATCHED_CREDIT", order_id: null, candidate_id: null }} ledger={availableLedger} density="comfortable" />);
    const card = screen.getByRole("group", { name: "账务异常记录" });
    expect(within(card).getByText("尚未关联订单")).toBeVisible();
    expect(within(card).getByRole("region", { name: "核对凭据" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "人工关联收款" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "匹配依据" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { type: "UNMATCHED_DEBIT", status: "OPEN", ignored: false, state: "历史记录", associate: false },
    { type: "UNLINKED_REFUND", status: "OPEN", ignored: false, state: "历史记录", associate: false },
    { type: "AMOUNT_MISMATCH", status: "RESOLVED", ignored: false, state: "已处理", associate: false },
    { type: "AMOUNT_MISMATCH", status: "OPEN", ignored: true, state: "未处理 · 已忽略", associate: true },
  ] as const)("preserves $type/$status/reminderIgnored=$ignored semantics", ({ type, status, ignored, state, associate }) => {
    const resolved = status === "RESOLVED";
    mount(knownCard({ ...financialException, exception_type: type, status, reminder_ignored: ignored,
      resolved_at: resolved ? financialException.created_at : null,
      resolution: resolved ? { resolution: "manually_settled" } : null,
    }));
    const card = screen.getByRole("group", { name: "账务异常记录" });
    expect(within(card).getByText(state, { exact: true })).toBeVisible();
    expect(within(card).queryByRole("button", { name: "人工关联收款" }) !== null).toBe(associate);
    expect(within(card).getByText("发现时间")).toBeVisible();
    if (resolved) {
      const result = within(card).getByText("已由管理员建立收款关联。", { exact: true });
      expect(result).toBeVisible();
      expect(result.closest("[data-field-wide]")).toHaveAttribute("data-field-wide", "true");
      expect(within(card).getByText("处理时间")).toBeVisible();
    }
    if (type === "UNMATCHED_DEBIT" || type === "UNLINKED_REFUND") expect(within(card).getByText("旧版支出提示，不再提醒。")).toBeVisible();
  });

  it.each(["order", "ledger", "candidate"] as const)("recovers an unavailable %s read without discarding the exception", async resource => {
    const { requests, state } = mockPage("", resource);
    mountPage();
    const card = await screen.findByRole("group", { name: "账务异常记录" });
    const failure = await within(card).findByRole("alert");
    expect(within(card).getByText("发现时间")).toBeVisible();
    expect(within(card).getByRole("button", { name: "更多操作，异常记录操作" })).toBeVisible();
    state.failure = undefined;
    await userEvent.setup().click(within(failure).getByRole("button", { name: "重试" }));
    if (resource === "order") expect(await within(card).findByRole("link", { name: order.product_name })).toBeVisible();
    if (resource === "ledger") expect(await within(card).findByRole("region", { name: "核对凭据" })).toBeVisible();
    if (resource === "candidate") expect(await within(card).findByRole("heading", { name: "匹配依据" })).toBeVisible();
    await waitFor(() => expect(within(card).queryByRole("alert")).not.toBeInTheDocument());
    const suffixes = { order: "/orders/" + orderId, ledger: "/ledger-entries/" + ledgerId, candidate: "/candidates/" + candidateId };
    for (const [name, suffix] of Object.entries(suffixes)) expect(requests.filter(request => new URL(request.url).pathname.endsWith(suffix))).toHaveLength(name === resource ? 2 : 1);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("keeps a known paid order from acquiring a manual action", () => {
    mount(<ExceptionCard exception={financialException} ledger={availableLedger} order={paidOrder} candidate={candidate} density="comfortable" />);
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: paidOrder.product_name })).toBeVisible();
  });

  it("restores the manual association trigger after cancelling the unchanged dialog", async () => {
    const { requests } = mockPage();
    mount(knownCard());
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "人工关联收款" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "人工关联收款" });
    expect(await within(dialog).findByRole("button", { name: "确认关联收款" })).toBeEnabled();
    await user.type(within(dialog).getByLabelText("操作理由（可选）"), "核对凭据但取消本次操作");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it.each([
    { embedded: false, density: undefined },
    { embedded: true, density: undefined },
    { embedded: true, density: "comfortable" },
  ] as const)("preserves the previous default evidence layout (embedded=$embedded, density=$density)", async ({ embedded, density }) => {
    const { container } = mount(<ExceptionCard exception={financialException} ledger={availableLedger} order={order} candidate={candidate} embedded={embedded} {...(density ? { density } : {})} />);
    const card = screen.getByRole("group", { name: "账务异常记录" });
    expect(container.querySelector("[data-financial-exception]")).toBeNull();
    expect(screen.queryByRole("region", { name: "核对凭据" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-layout="flow"]')).toBeNull();
    expect(within(card).getByRole("button", { name: "人工关联收款" }).closest('[data-slot="card-footer"]')).not.toBeNull();
    expect(within(card).getByRole("button", { name: "更多操作，异常记录操作" }).closest('[data-slot="card-content"]')).not.toBeNull();
    if (embedded) expect(await recordAction("单独打开", "异常记录操作")).toHaveAttribute("href", "/reconciliation/exceptions/" + exceptionId);
  });

  it("does not group the identifiers in unrelated LedgerFacts callers", () => {
    const { rerender } = mount(<LedgerFacts entry={availableLedger} density="comfortable" layout="flow" />);
    expect(screen.queryByRole("region", { name: "核对凭据" })).not.toBeInTheDocument();
    expect(screen.getByText(availableLedger.provider_order_no)).toBeVisible();
    rerender(<LedgerFacts entry={availableLedger} groupIdentifiers />);
    expect(screen.queryByRole("region", { name: "核对凭据" })).not.toBeInTheDocument();
  });
});
