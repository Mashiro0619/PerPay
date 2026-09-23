import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  queryClient,
  type LedgerConflictDetail,
  type WebhookAttempt,
} from "../src/api/client";
import { DeliveryAttempts } from "../src/components/detail/DeliveryAttempts";
import { ConflictCard } from "../src/components/detail/ConflictEvidence";
import { CandidateEvidence } from "../src/components/detail/PaymentEvidence";
import { candidate, failedAttempt, detailLedger } from "./detail-fixtures";
const id = "11111111-1111-4111-8111-111111111111";
const time = "2026-09-23T00:00:00.000Z";
function conflict(existing: boolean): LedgerConflictDetail {
  return {
    conflict: {
      conflict_id: id,
      provider_account_key: "test",
      conflict_type: existing ? "DUPLICATE_EXTERNAL_ID" : "INVALID_AMOUNT",
      reminder_ignored: false,
      raw_page_id: id,
      raw_event_id: id,
      existing_ledger_entry_id: existing ? id : null,
      external_event_id: "测试外部流水",
      existing_semantic_fingerprint: existing ? "a".repeat(64) : null,
      incoming_semantic_fingerprint: null,
      details: { raw_marker: "仅在技术详情查看的原始证据" },
      status: "OPEN",
      resolution: null,
      resolution_action: null,
      resolution_operation_id: null,
      resolution_fingerprint: null,
      conflict_fingerprint: "a".repeat(64),
      created_at: time,
      resolved_at: null,
    },
    incoming_event: {
      raw_event_id: id,
      raw_page_id: id,
      provider_account_key: "test",
      ordinal: 1,
      external_event_id: "测试外部流水",
      occurred_at_text: "2026-09-23 08:00:00",
      amount_text: "1.001",
      direction_text: "收入",
      alipay_order_no: "长编号_".repeat(50),
      merchant_order_no: null,
      trans_memo: "传入的备注",
      other_account: null,
      payload_fingerprint: "a".repeat(64),
      observed_at: time,
    },
    raw_page: {
      raw_page_id: id,
      ingest_run_id: id,
      provider_account_key: "test",
      window_start: "2026-09-23 07:00:00",
      window_end: "2026-09-23 09:00:00",
      page_no: 1,
      page_size: 1,
      total_size: 1,
      has_more: false,
      request_fingerprint: "a".repeat(64),
      response_fingerprint: "b".repeat(64),
      http_status: 200,
      signature_verified: true,
      trace_id: null,
      received_at: time,
    },
    existing_ledger_entry: existing
      ? {
          ledger_entry_id: id,
          provider_account_key: "test",
          raw_event_id: id,
          external_event_id: "测试外部流水",
          semantic_fingerprint: "a".repeat(64),
          occurred_at: time,
          occurred_at_precision_milliseconds: 1000,
          amount_cents: 100,
          direction: "CREDIT",
          currency: "CNY",
          alipay_order_no: null,
          merchant_order_no: null,
          trans_memo: "原备注",
          other_account: null,
          state: "CONFLICT",
          created_at: time,
          updated_at: time,
        }
      : null,
    resolution_operation: null,
  };
}
function mountConflict(existing: boolean) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConflictCard detail={conflict(existing)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("always-visible detail evidence", () => {
  it("shows all attempts newest-first in pages of ten without changing source evidence", async () => {
    const attempts: WebhookAttempt[] = Array.from({ length: 21 }, (_, i) => ({
      ...failedAttempt,
      attempt_id: String(i + 1),
      attempt_number: i + 1,
      started_at: new Date(Date.parse(time) + i * 1000).toISOString(),
    }));
    const original = structuredClone(attempts);
    const user = userEvent.setup();
    render(<DeliveryAttempts attempts={attempts} available />);
    const table = screen.getByRole("table", { name: "投递尝试（21）" });
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("第 21 次");
    expect(
      screen.queryByRole("button", { name: "投递尝试（21）" }),
    ).not.toBeInTheDocument();
    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      seen.push(
        ...within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => Number(/第 (\d+) 次/.exec(row.textContent!)![1])),
      );
      if (page < 3)
        await user.click(
          screen.getByRole("button", { name: "投递尝试下一页" }),
        );
    }
    expect(seen).toEqual(Array.from({ length: 21 }, (_, i) => 21 - i));
    expect(
      screen.getByRole("button", { name: "投递尝试下一页" }),
    ).toBeDisabled();
    expect(attempts).toEqual(original);
    await user.click(screen.getByRole("button", { name: "投递尝试上一页" }));
    expect(screen.getByRole("status")).toHaveTextContent("第 2 / 3 页");
  });
  it("orders equal attempt times deterministically and clamps a shortened read", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) => ({
      ...failedAttempt,
      attempt_id: String(i),
      attempt_number: i + 1,
      started_at: time,
    }));
    const user = userEvent.setup();
    const { rerender } = render(
      <DeliveryAttempts attempts={attempts} available />,
    );
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("第 12 次");
    await user.click(screen.getByRole("button", { name: "投递尝试下一页" }));
    rerender(<DeliveryAttempts attempts={attempts.slice(0, 1)} available />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("第 1 次");
  });
  it("does not turn an unavailable attempt read into an empty history", () => {
    const { rerender } = render(
      <DeliveryAttempts attempts={[]} available={false} />,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无尝试明细")).not.toBeInTheDocument();
    expect(screen.getByText(/不能据此判断未曾投递/)).toBeVisible();
    rerender(<DeliveryAttempts attempts={[]} available />);
    expect(screen.getByRole("table", { name: "投递尝试（0）" })).toBeVisible();
    expect(screen.getByText("暂无尝试明细")).toBeVisible();
  });
  it.each([false, true])(
    "uses only meaningful comparison columns (existing=%s), preserving invalid raw amounts",
    (existing) => {
      mountConflict(existing);
      const table = screen.getByRole("table", { name: "交易对照" });
      expect(within(table).getAllByRole("columnheader")).toHaveLength(
        existing ? 3 : 2,
      );
      expect(within(table).getByText("1.001")).toBeVisible();
      expect(screen.queryByText("无已有记录")).not.toBeInTheDocument();
      expect(screen.queryAllByText("无可对照流水")).toHaveLength(
        existing ? 0 : 1,
      );
      const amount = within(table)
        .getByRole("rowheader", { name: /交易金额/ })
        .closest("tr")!;
      expect(amount).toHaveAttribute("data-different", "true");
      expect(
        within(amount).getByText(existing ? "不同" : "异常"),
      ).toBeVisible();
      expect(screen.getByRole("heading", { name: "采集摘要" })).toBeVisible();
      expect(screen.getByText("已通过")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "采集信息" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    },
  );
  it("keeps raw technical evidence on demand rather than expanding it with the summary", async () => {
    mountConflict(false);
    const user = userEvent.setup();
    expect(
      screen.queryByText("仅在技术详情查看的原始证据"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "冲突记录操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "技术详情" }));
    expect(
      await screen.findByRole("dialog", { name: "技术详情" }),
    ).toHaveTextContent("仅在技术详情查看的原始证据");
  });
  it("exposes matching facts immediately while keeping redundant ledger facts out", () => {
    render(<CandidateEvidence candidate={candidate} ledger={detailLedger} />);
    expect(screen.getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(screen.getByText("金额占用窗口")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "匹配依据" }),
    ).not.toBeInTheDocument();
  });
});
