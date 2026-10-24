import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type MatchCandidate } from "../src/api/client";
import { CandidateCard } from "../src/components/detail/PaymentEvidence";
import { candidate, detailLedger, paidOrder, paymentMatch } from "./detail-fixtures";
import { apiError, order } from "./fixtures";

const eligibleCandidate: MatchCandidate = {
  ...candidate,
  status: "ELIGIBLE",
  decided_at: null,
  decided_by_operation_id: null,
};

function mount(props: ComponentProps<typeof CandidateCard>) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CandidateCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("candidate guidance follows the current payment and ledger state", () => {
  it.each([
    { context: "administrator order", selectedOrder: paidOrder },
    { context: "reconciliation order", selectedOrder: paymentMatch.order },
  ])("describes an automatically selected and confirmed $context as complete", ({ selectedOrder }) => {
    mount({ candidate, ledger: detailLedger, order: selectedOrder });

    expect(screen.getByText(/已选用，订单收款已确认/)).toBeVisible();
    expect(screen.queryByText(/需要你确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it("describes a selected record with a disputed payment without claiming it is still confirmed", () => {
    mount({
      candidate,
      ledger: detailLedger,
      order: { ...paidOrder, payment: { ...paidOrder.payment, status: "DISPUTED" } },
    });

    expect(screen.getByText(/曾被选用，收款有争议/)).toBeVisible();
    expect(screen.queryByText(/订单收款已确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it("keeps a superseded record historical even when its order and ledger could otherwise be associated", () => {
    mount({
      candidate: { ...candidate, status: "SUPERSEDED" },
      ledger: { ...detailLedger, state: "UNALLOCATED" },
      order,
    });

    expect(screen.getByText(/已被替代，仅供查阅/)).toBeVisible();
    expect(screen.queryByText(/需要你确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it.each(["UNALLOCATED", "CANDIDATE", "CONFLICT"] as const)(
    "offers a manual association for an eligible credit in %s state and an unpaid order",
    (state) => {
      mount({ candidate: eligibleCandidate, ledger: { ...detailLedger, state }, order });

      expect(screen.getByText(/仅为匹配建议，核对订单与流水后可人工关联/)).toBeVisible();
      expect(screen.getByText(/尚未确认收款/)).toBeVisible();
      expect(screen.getByRole("button", { name: "人工关联收款" })).toBeEnabled();
    },
  );

  it.each([
    { reason: "allocated credit", entry: detailLedger },
    { reason: "debit", entry: { ...detailLedger, state: "UNALLOCATED", direction: "DEBIT" } as const },
  ])("does not invite association of an eligible $reason", ({ entry }) => {
    mount({ candidate: eligibleCandidate, ledger: entry, order });

    expect(screen.getByText(/订单或流水当前不可人工关联/)).toBeVisible();
    expect(screen.queryByText(/需要你确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it.each([
    { status: "CONFIRMED", guidance: /订单收款已确认，不能再次关联/ },
    { status: "DISPUTED", guidance: /收款有争议，请核对收款关联记录/ },
  ] as const)("does not invite association when an eligible candidate's payment is $status", ({ status, guidance }) => {
    mount({
      candidate: eligibleCandidate,
      ledger: { ...detailLedger, state: "UNALLOCATED" },
      order: { ...paidOrder, payment: { ...paidOrder.payment, status } },
    });

    expect(screen.getByText(guidance)).toBeVisible();
    expect(screen.queryByText(/需要你确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });

  it("keeps association unavailable when the related order and ledger cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiError("internal_error", "关联证据读取失败", 503)));
    mount({ candidate: eligibleCandidate });

    expect(await screen.findAllByRole("button", { name: "重试" })).toHaveLength(2);
    expect(screen.getByText(/订单或流水状态未知，暂不能人工关联/)).toBeVisible();
    expect(screen.queryByText(/需要你确认|核对订单与流水后可人工关联/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人工关联收款" })).not.toBeInTheDocument();
  });
});
