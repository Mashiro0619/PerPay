import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AdminOrderDetail } from "../src/api/client";
import { FinancialDialog } from "../src/pages/FinancialDialog";
import { disputeState } from "../src/components/detail/disputed-order-actions";
import { OrderExceptionRecord } from "../src/components/detail/OrderPaymentRecords";
import { apiError, json, ledger, ledgerId, order, orderId } from "./fixtures";

const disputed = (): AdminOrderDetail => ({ ...order, payment: { ...order.payment, status: "DISPUTED", basis: "MANUAL" } });
const mount = (element: React.ReactNode) => render(<QueryClientProvider client={queryClient}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>);

describe("disputed order review", () => {
  it("requires the review reason before reconfirmation and sends the original selected evidence", async () => {
    const writes: any[] = [];
    const onSuccess = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/settlements/manual")) { writes.push(await request.json()); return json({ data: {} }); }
      if (path.endsWith("/orders/" + orderId)) return json({ data: disputed() });
      if (path.endsWith("/ledger-entries/" + ledgerId)) return json({ data: { ...ledger, state: "CONFLICT" } });
      return apiError("route_not_found", "unexpected test request", 404);
    }));
    mount(<FinancialDialog initialOrderId={orderId} initialLedgerId={ledgerId} lockContext onClose={vi.fn()} onSuccess={onSuccess} />);
    const confirm = await screen.findByRole("button", { name: "重新确认收款" });
    await userEvent.click(confirm);
    expect(writes).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "核对理由" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "核对理由" }), { target: { value: "核对付款人与交易凭证后重新确认" } });
    await userEvent.click(confirm);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ order_id: orderId, ledger_entry_id: ledgerId, reason: "核对付款人与交易凭证后重新确认" });
  });

  it("disables reconfirmation when evidence reread contains a refund mark", async () => {
    const writes = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method !== "GET") writes();
      const path = new URL(request.url).pathname;
      if (path.endsWith("/orders/" + orderId)) return json({ data: { ...disputed(), refund_mark: { ...order.refund_mark, marked: true } } });
      if (path.endsWith("/ledger-entries/" + ledgerId)) return json({ data: { ...ledger, state: "CONFLICT" } });
      return apiError("route_not_found", "unexpected test request", 404);
    }));
    mount(<FinancialDialog initialOrderId={orderId} initialLedgerId={ledgerId} lockContext onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "重新确认收款" })).toBeDisabled();
    expect(screen.getByText(/本订单已有退款记录/)).toBeVisible();
    expect(writes).not.toHaveBeenCalled();
  });

  it("dismisses a refunded dispute by its exact resource ID and preserves other reminders", async () => {
    const exceptionId = "99999999-9999-4999-8999-999999999999";
    const writes: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      writes.push(await request.json());
      return json({ data: { ...writes.at(-1), ignored_count: 1 } });
    }));
    const data: AdminOrderDetail = { ...disputed(), refund_mark: { ...order.refund_mark, marked: true }, reconciliation: { ...order.reconciliation,
      exceptions: [{ exception_id: exceptionId, status: "OPEN", reminder_ignored: false, exception_type: "RECONCILIATION_CONFLICT",
        provider_account_key: "primary", ledger_entry_id: ledgerId, order_id: orderId, candidate_id: null,
        context_key: "reversal", exception_fingerprint: "a".repeat(64), resolution_operation_id: null,
        resolution: null, resolved_at: null,
        created_at: order.created_at, details: { reason: "settlement_reversed" } }],
    } };
    const state = disputeState(data);
    expect(state.refunded).toBe(true);
    expect([...state.dismissible]).toEqual([exceptionId]);
    const exception = data.reconciliation.exceptions[0]!;
    mount(<OrderExceptionRecord exception={exception} order={data} ledger={{ ...ledger, state: "CONFLICT" }} dismissible={state.dismissible.has(exception.exception_id)} />);
    expect(document.getElementById("exception-" + exceptionId)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重新核对并确认收款" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "用此流水重新确认" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "忽略此提醒" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "已忽略" })).toBeDisabled());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: "FINANCIAL_EXCEPTION", resource_id: exceptionId });
    expect(writes[0]).not.toHaveProperty("q");
  });

  it("offers reminders for dismissal only after a refund, and released entries for reassignment only before one", () => {
    const reversal = { exception_id: "99999999-9999-4999-8999-999999999999", status: "OPEN" as const, reminder_ignored: false, exception_type: "RECONCILIATION_CONFLICT" as const,
      provider_account_key: "primary", ledger_entry_id: ledgerId, order_id: orderId, candidate_id: null,
      context_key: "reversal", exception_fingerprint: "a".repeat(64), resolution_operation_id: null,
      resolution: null, resolved_at: null, created_at: order.created_at, details: { reason: "settlement_reversed" } };
    const match = { payment_match_id: "33333333-3333-4333-8333-333333333333", ledger_entry_id: ledgerId, status: "REVERSED", ledger_entry: { ...ledger, state: "UNALLOCATED" } };
    const open: AdminOrderDetail = { ...disputed(), reconciliation: { exceptions: [reversal, { ...reversal, exception_id: "ignored", reminder_ignored: true }],
      matches: [match, { ...match, payment_match_id: "still-allocated", ledger_entry_id: "other", ledger_entry: { ...ledger, state: "ALLOCATED" } }] as AdminOrderDetail["reconciliation"]["matches"] } };
    const before = disputeState(open);
    expect(before.refunded).toBe(false);
    expect(before.dismissible.size).toBe(0);
    expect([...before.released]).toEqual([match.payment_match_id]);
    const after = disputeState({ ...open, refund_mark: { ...order.refund_mark, marked: true } });
    expect([...after.dismissible]).toEqual([reversal.exception_id]);
    expect(after.released.size).toBe(0);
    expect(after.guidance).not.toBe(before.guidance);
  });
});
