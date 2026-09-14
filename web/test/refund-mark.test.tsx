import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { queryClient, type AdminOrderDetail } from "../src/api/client";
import { OrderTable } from "../src/components/OrderTable";
import { RefundMarkDialog, RefundMarkPanel } from "../src/pages/RefundMark";
import Reconciliation from "../src/pages/Reconciliation";
import EvidenceDetail from "../src/pages/ReconciliationDetail";
import { apiError, json, ledger, order, orderId } from "./fixtures";

function wrap(children: ReactNode) { return <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>; }
const paid: AdminOrderDetail = { ...order, received_amount_cents: 101, payment: { status: "CONFIRMED", basis: "INFERRED", received_amount_cents: 101 } };

describe("administrator-only refund marks", () => {
  it.each([true, false])("saves marked=%s without ledger selection, a mandatory note or financial writes", async (marked) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request.clone()); return json({ data: {} }); }));
    const user = userEvent.setup(); const onSuccess = vi.fn();
    render(wrap(<RefundMarkDialog orderId={orderId} version={marked ? 0 : 3} marked={marked} onClose={vi.fn()} onSuccess={onSuccess} />));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("仅记录管理员已在外部完成退款，PerPay 不执行转账，也未验证退款。");
    expect(within(dialog).getByLabelText("备注（可选）")).not.toBeRequired();
    expect(within(dialog).queryByLabelText(/流水编号/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/不会通知业务网站/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: marked ? "确认标记已退款" : "确认撤销标记" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PUT");
    expect(new URL(requests[0]!.url).pathname).toBe("/api/admin/v1/orders/" + orderId + "/refund-mark");
    expect(await requests[0]!.json()).toEqual({ operation_id: expect.any(String), version: marked ? 0 : 3, marked });
  });

  it("counts Unicode characters and accepts 500 emoji but rejects a longer note", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request.clone()); return json({ data: {} }); }));
    const user = userEvent.setup(); render(wrap(<RefundMarkDialog orderId={orderId} version={0} marked onClose={vi.fn()} onSuccess={vi.fn()} />));
    const note = screen.getByLabelText("备注（可选）");
    fireEvent.change(note, { target: { value: "🙂".repeat(501) } });
    expect(screen.getByText("备注最多 500 字。")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认标记已退款" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "🙂".repeat(500) } });
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect((await requests[0]!.json()).note).toBe("🙂".repeat(500));
  });

  it("uses the same operation UUID on retry and retains the note", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { bodies.push(await request.json()); return bodies.length === 1 ? apiError("internal_error", "lost response", 500) : json({ data: {} }); }));
    const user = userEvent.setup(); const onSuccess = vi.fn();
    render(wrap(<RefundMarkDialog orderId={orderId} version={0} marked onClose={vi.fn()} onSuccess={onSuccess} />));
    await user.type(screen.getByLabelText("备注（可选）"), "已在外部处理");
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await screen.findByText(/服务处理失败/);
    expect(screen.getByLabelText("备注（可选）")).toHaveValue("已在外部处理");
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  });

  it("does not silently rebase a dialog when another request updates the mark", async () => {
    const bodies: Array<{ version: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { bodies.push(await request.json()); return apiError("refund_mark_version_conflict", "version changed"); }));
    const user = userEvent.setup();
    const view = render(wrap(<RefundMarkPanel order={paid} />));
    await user.click(screen.getByRole("button", { name: "标记已退款" }));
    view.rerender(wrap(<RefundMarkPanel order={{ ...paid, refund_mark: { marked: true, version: 1, note: "other request", updated_at: "2026-09-07T12:00:00Z", updated_by: "admin" } }} />));
    await user.click(screen.getByRole("button", { name: "确认标记已退款" }));
    await screen.findByText(/当前修改未覆盖已有记录/);
    expect(bodies[0]?.version).toBe(0);
    expect(screen.getByRole("button", { name: "关闭并刷新订单" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "确认标记已退款" })).not.toBeInTheDocument();
  });

  it.each(["OPEN", "CLOSED", "EXPIRED"] as const)("hides the entire refund panel for an unpaid %s checkout", (status) => {
    const view = render(wrap(<RefundMarkPanel order={{ ...order, checkout: { ...order.checkout, status } }} />));
    expect(view.container).toBeEmptyDOMElement();
  });

  it.each(["CONFIRMED", "DISPUTED"] as const)("shows refund marking for a received %s order", (status) => {
    render(wrap(<RefundMarkPanel order={{ ...paid, payment: { ...paid.payment, status } }} />));
    expect(screen.getByRole("heading", { name: "管理员退款标记" })).toBeVisible();
    expect(screen.getByRole("button", { name: "标记已退款" })).toBeEnabled();
  });

  it.each([
    { status: "CONFIRMED", amount: null }, { status: "CONFIRMED", amount: 0 },
    { status: "DISPUTED", amount: null }, { status: "DISPUTED", amount: 0 },
  ] as const)("hides an unused refund panel for $status with received amount $amount", ({ status, amount }) => {
    const view = render(wrap(<RefundMarkPanel order={{ ...order, payment: { ...order.payment, status, received_amount_cents: amount }, received_amount_cents: amount }} />));
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows the refund panel after an unpaid order receives payment", () => {
    const view = render(wrap(<RefundMarkPanel order={order} />));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(wrap(<RefundMarkPanel order={paid} />));
    expect(screen.getByRole("button", { name: "标记已退款" })).toBeEnabled();
  });

  it.each([true, false])("preserves existing refund history when no longer eligible with marked=%s", async (marked) => {
    const original = { marked: true, version: 1, note: "外部退款记录", updated_at: "2026-09-07T12:00:00Z", updated_by: "admin" };
    const current = marked ? original : { ...original, marked: false, version: 2, note: "撤销错误标记" };
    const history = [{ ...original, operation_id: "original-mark" }];
    if (!marked) history.unshift({ ...current, operation_id: "reverted-mark" });
    render(wrap(<RefundMarkPanel order={{ ...order, payment: { ...order.payment, status: "DISPUTED" }, refund_mark: current, refund_mark_history: history }} />));
    expect(screen.getByRole("heading", { name: "管理员退款标记" })).toBeVisible();
    const button = screen.getByRole("button", { name: marked ? "撤销退款标记" : "标记已退款" });
    if (marked) expect(button).toBeEnabled(); else expect(button).toBeDisabled();
    await userEvent.setup().click(screen.getByText("查看标记修改历史"));
    expect(screen.getAllByText("外部退款记录").length).toBeGreaterThan(0);
    expect(screen.getAllByText("操作人 admin").length).toBeGreaterThan(0);
  });

  it("displays the mark separately from payment state and preserves actor, time and history", async () => {
    const mark = { marked: true, version: 2, note: "外部退款说明", updated_at: "2026-09-07T12:00:00Z", updated_by: "admin" };
    const marked = { ...paid, refund_mark: mark, refund_mark_history: [{ ...mark, operation_id: "1" }] };
    render(wrap(<><OrderTable orders={[marked]} /><RefundMarkPanel order={marked} /></>));
    expect(screen.getByRole("cell", { name: /已确认/ })).toBeVisible();
    expect(screen.getAllByText("已退款（管理员标记）")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "撤销退款标记" })).toBeVisible();
    await userEvent.setup().click(screen.getByText("查看标记修改历史"));
    expect(screen.getByText("操作人 admin")).toBeVisible();
    expect(screen.queryByText(/标记版本/)).not.toBeInTheDocument();
    expect(screen.getAllByText("外部退款说明")).toHaveLength(2);
  });

  it("removes refund recording from reconciliation without removing manual income association", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], page: { next_cursor: null } })));
    render(wrap(<Reconciliation />));
    expect(screen.getByRole("button", { name: "人工关联收款" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /退款/ })).not.toBeInTheDocument();
    await screen.findByText("暂无符合条件的记录");
  });

  it("does not suggest collection matching or offer refund recording for debit ledger details", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request); return json({ data: { ...ledger, direction: "DEBIT" } }); }));
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/reconciliation/ledger/" + ledger.ledger_entry_id]}><Routes><Route path="/reconciliation/:kind/:resourceId" element={<EvidenceDetail />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(/支出不参与自动收款匹配/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "匹配候选" })).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /退款/ })).not.toBeInTheDocument();
  });

});
