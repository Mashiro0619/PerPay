import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  queryClient,
  type LedgerConflictDetail,
  type WebhookAttempt,
} from "../src/api/client";
import { attemptEntries } from "../src/components/detail/NotificationEvidence";
import { ConflictRecord } from "../src/components/detail/ConflictEvidence";
import { ConflictComparison } from "../src/components/detail/ConflictComparison";
import { CandidateRecord } from "../src/components/detail/CandidateRecord";
import { candidate, failedAttempt, detailLedger, paidOrder } from "./detail-fixtures";
import { mobileMedia } from "./mobile-media";
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
function mountConflict(existing: boolean, detail: LedgerConflictDetail = conflict(existing)) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConflictRecord detail={detail} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("always-visible detail evidence", () => {
  it("orders attempts newest-first without changing source evidence", () => {
    const attempts: WebhookAttempt[] = Array.from({ length: 21 }, (_, i) => ({
      ...failedAttempt,
      attempt_id: String(i + 1),
      attempt_number: i + 1,
      started_at: new Date(Date.parse(time) + i * 1000).toISOString(),
    }));
    const original = structuredClone(attempts);
    for (const attempt of attempts) Object.freeze(attempt);
    Object.freeze(attempts);
    const entries = attemptEntries(attempts);
    expect(entries.map(entry => entry.id)).toEqual(Array.from({ length: 21 }, (_, i) => String(21 - i)));
    expect(entries[0]).toMatchObject({ title: "第 21 次 · HTTP 200 · 对方的确认回执无效", time: attempts[20]!.started_at, tone: "danger" });
    expect(attempts).toEqual(original);
  });
  it("orders equal attempt times deterministically, by attempt number", () => {
    const attempts = Array.from({ length: 12 }, (_, i) => ({
      ...failedAttempt,
      attempt_id: String(i),
      attempt_number: i + 1,
      started_at: time,
    }));
    expect(attemptEntries([...attempts.slice(6), ...attempts.slice(0, 6)]).map(entry => entry.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(11 - i)));
  });
  it.each([false, true])(
    "uses a three-column table with an existing entry and a field list without one (existing=%s), preserving invalid raw amounts",
    (existing) => {
      mountConflict(existing);
      const summary = screen.getByRole("group", { name: "冲突概况" });
      expect(within(summary).getByText("待处理", { exact: true })).toBeVisible();
      expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
        existing ? "交易对照，共 3 项" : "交易对照",
        "查账摘要",
        "处理记录",
      ]);
      if (existing) {
        const table = screen.getByRole("table", { name: "交易对照" });
        expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
          "字段",
          "本次收到（新值）",
          "已有流水（旧值）",
        ]);
        expect(within(table).getByText("1.001")).toBeVisible();
        const amount = within(table)
          .getByRole("rowheader", { name: /^支付宝交易金额$/ })
          .closest("tr")!;
        expect(amount).toHaveAttribute("data-different", "true");
        expect(amount).toHaveAttribute("data-invalid", "true");
        expect(within(amount).getByText("（异常）")).toBeVisible();
        expect(screen.getByRole("link", { name: /^查看已有流水/ })).toHaveAttribute("href", "/reconciliation/ledger/" + id);
        expect(screen.getByRole("button", { name: "保留已有流水" }).closest("[data-overlay-actions]")).not.toBeNull();
      } else {
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        expect(screen.getByText("无可对照流水")).toBeVisible();
        const amount = screen.getByText("支付宝交易金额", { selector: "dt" }).parentElement!;
        expect(within(amount).getByText("1.001")).toBeVisible();
        expect(within(amount).getByText("异常")).toBeVisible();
        expect(screen.queryByRole("link", { name: /^查看已有流水/ })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "确认隔离并关闭冲突" }).closest("[data-overlay-actions]")).not.toBeNull();
      }
      expect(screen.getByRole("heading", { name: "查账摘要" })).toBeVisible();
      expect(screen.getByText("验签通过")).toBeVisible();
      expect(screen.getByText("发现冲突")).toBeVisible();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    },
  );
  it("shows resolution history in the timeline and hides the resolve action once handled", () => {
    const resolved = conflict(true);
    resolved.conflict.status = "RESOLVED";
    resolved.conflict.resolved_at = "2026-09-23T01:00:00.000Z";
    resolved.resolution_operation = {
      conflict_operation_id: id,
      operation_key: "key-1",
      conflict_id: id,
      request_fingerprint: "a".repeat(64),
      action: "KEEP_EXISTING",
      actor_type: "ADMIN",
      actor_id: "核对管理员",
      reason: "已核对支付宝账单，保留原记录",
      created_at: "2026-09-23T01:00:00.000Z",
    };
    mountConflict(true, resolved);
    expect(within(screen.getByRole("group", { name: "冲突概况" })).getByText("已处理", { exact: true })).toBeVisible();
    const items = within(screen.getByRole("list", { name: "处理记录" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("保留已有流水");
    expect(items[0]).toHaveTextContent("核对管理员：已核对支付宝账单，保留原记录");
    expect(items[1]).toHaveTextContent("发现冲突");
    expect(screen.queryByRole("button", { name: "保留已有流水" })).not.toBeInTheDocument();
  });
  it("keeps raw technical evidence behind the footer menu rather than expanding it with the summary", async () => {
    mountConflict(false);
    const user = userEvent.setup();
    expect(
      screen.queryByText("仅在技术详情查看的原始证据"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多操作，冲突记录操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "冲突记录技术信息" }));
    expect(
      await screen.findByRole("dialog", { name: "冲突记录技术信息" }),
    ).toHaveTextContent("仅在技术详情查看的原始证据");
  });
  it("exposes matching facts immediately while keeping redundant ledger facts out", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CandidateRecord candidate={candidate} ledger={detailLedger} order={paidOrder} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const evidence = document.querySelector<HTMLElement>('[data-detail-section="evidence"]')!;
    expect(within(evidence).getByRole("heading", { name: "匹配依据" })).toBeVisible();
    expect(within(evidence).getByText("金额占用时间")).toBeVisible();
    expect(within(evidence).queryByText("交易金额")).not.toBeInTheDocument();
    expect(within(evidence).queryByRole("button", { name: "匹配依据" })).not.toBeInTheDocument();
  });
  it("highlights differing incoming values without a separate difference column", () => {
    const detail = conflict(true);
    detail.incoming_event!.amount_text = "2.50";
    render(<ConflictComparison detail={detail} />);
    const table = screen.getByRole("table", { name: "交易对照" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    const row = within(table)
      .getByRole("rowheader", { name: "支付宝交易金额" })
      .closest("tr")!;
    expect(within(row).getByRole("rowheader")).toHaveTextContent(/^支付宝交易金额$/);
    expect(within(row).getByText("¥2.50")).toHaveClass("text-destructive");
    expect(within(row).getByText("¥1.00")).toBeVisible();
    expect(within(row).queryByText("不同")).not.toBeInTheDocument();
    expect(
      within(table).queryByRole("rowheader", { name: "支付宝商户单号" }),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "keeps mobile values paired field-by-field when comparing and single-column without an existing ledger (existing=%s)",
    (existing) => {
      mobileMedia(390);
      const detail = conflict(existing);
      detail.incoming_event!.trans_memo = "第一行\n第二行 <原始文字>";
      const { container } = render(<ConflictComparison detail={detail} />);
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      if (existing) {
        const mobile = container.querySelector(
          "[data-comparison-mobile]",
        )! as HTMLElement;
        const amount = within(mobile).getByRole("group", { name: "支付宝交易金额" });
        expect(mobile).toHaveAttribute("role", "group");
        expect(mobile).toHaveAccessibleName("逐字段交易对照");
        expect(within(amount).getByText("异常")).toBeVisible();
        expect(
          [...amount.querySelectorAll("dt")].map((e) => e.textContent),
        ).toEqual(["本次收到（新值）", "已有流水（旧值）"]);
        expect(
          [...amount.querySelectorAll("dd")].map((e) => e.textContent),
        ).toEqual(["1.001", "¥1.00"]);
        const memo = within(mobile).getByRole("group", { name: "支付宝备注" });
        expect(memo.querySelector("dd")?.textContent).toBe(
          detail.incoming_event!.trans_memo,
        );
      } else {
        expect(screen.getByText("无可对照流水")).toBeVisible();
        const amount = screen.getByText("支付宝交易金额", { selector: "dt" }).parentElement!;
        expect(within(amount).getByText("1.001")).toBeVisible();
        expect(within(amount).getByText("异常")).toBeVisible();
        const memo = screen.getByText("支付宝备注", { selector: "dt" }).parentElement!;
        expect(memo.querySelector("dd")?.textContent).toBe(detail.incoming_event!.trans_memo);
      }
      expect(container.querySelector("[data-conflict-comparison]")).toHaveClass("w-full", "min-w-0");
    },
  );
  it("does not invent a comparison when no transaction evidence is available", () => {
    const detail = conflict(false);
    detail.incoming_event = null;
    const { container } = render(<ConflictComparison detail={detail} />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each([390, 1280])("shows differing fields first and reveals matching evidence on demand at %s px", async (width) => {
    mobileMedia(width);
    const detail = conflict(true);
    detail.incoming_event!.amount_text = "1.0";
    detail.incoming_event!.alipay_order_no = null;
    const original = structuredClone(detail);
    const user = userEvent.setup();
    render(<ConflictComparison detail={detail} />);

    expect(screen.getByText("1 项需核对 · 8 项相同")).toBeVisible();
    expect(screen.getByText("支付宝备注")).toBeVisible();
    const toggle = screen.getByRole("button", { name: /^相同字段，共 ?8 ?项$/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("支付宝交易金额")).not.toBeVisible();

    await user.click(toggle);
    const same = screen.getByRole(width < 512 ? "group" : "table", { name: "相同字段对照" });
    expect(same).toBeVisible();
    expect(within(same).getByText("支付宝交易金额")).toBeVisible();
    expect(within(same).getAllByText("¥1.00")).toHaveLength(2);
    expect(within(same).getAllByText("本次收到（新值）").length).toBeGreaterThan(0);
    expect(within(same).getAllByText("已有流水（旧值）").length).toBeGreaterThan(0);

    await user.click(toggle);
    await waitFor(() => expect(screen.getByText("支付宝交易金额")).not.toBeVisible());
    expect(screen.getByText("支付宝备注")).toBeVisible();
    expect(detail).toEqual(original);
  });
  it("keeps an invalid field visible even when its normalized value matches", () => {
    const detail = conflict(true);
    detail.conflict.conflict_type = "INVALID_AMOUNT";
    detail.incoming_event!.amount_text = "1";
    render(<ConflictComparison detail={detail} />);
    const row = within(screen.getByRole("table", { name: "交易对照" }))
      .getByRole("rowheader", { name: "支付宝交易金额" }).closest("tr")!;
    expect(within(row).getByText("（异常）")).toBeVisible();
    expect(within(row).getByText("1")).toBeVisible();
  });
  it("promotes newly differing values out of the collapsed matching fields after refresh", () => {
    const detail = conflict(true);
    detail.incoming_event!.amount_text = "1.00";
    detail.incoming_event!.alipay_order_no = null;
    const { rerender } = render(<ConflictComparison detail={detail} />);
    expect(screen.getByText("收支方向")).not.toBeVisible();
    rerender(<ConflictComparison detail={{ ...detail, incoming_event: { ...detail.incoming_event!, direction_text: "支出" } }} />);
    expect(screen.getByText("收支方向")).toBeVisible();
    expect(screen.getByText("2 项需核对 · 7 项相同")).toBeVisible();
    expect(screen.getByRole("button", { name: /^相同字段，共 ?7 ?项$/ })).toHaveAttribute("aria-expanded", "false");
  });
  it.each([false, true])("keeps all available fields expanded when one comparison source is missing (existing=%s)", (existing) => {
    const detail = conflict(existing);
    if (existing) detail.incoming_event = null;
    render(<ConflictComparison detail={detail} />);
    expect(screen.queryByRole("button", { name: /相同字段/ })).not.toBeInTheDocument();
    expect(screen.getByText("支付宝商户单号", { selector: "dt" })).toBeVisible();
    expect(screen.getByText("支付宝备注", { selector: "dt" })).toBeVisible();
  });
});
