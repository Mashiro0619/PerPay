import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { recordAction } from "./menu-helper";
import { json, ledger, ledgerId, order, orderId } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";
import { groupedLedger } from "./ledger-fixtures";

const candidateId = "33333333-3333-4333-8333-333333333333";
const candidate = {
  candidate_id: candidateId,
  order_id: orderId,
  ledger_entry_id: ledgerId,
  status: "ELIGIBLE",
  rule_version: 73,
  evidence_type: "AMOUNT_INFERRED",
  evidence: {},
  created_at: order.created_at,
  decided_at: null,
};

describe("ordinary administrator views", () => {

  it("keeps refund actions, actor and history without showing order or mark versions", async () => {
    const mark = {
      marked: true,
      version: 37,
      note: "外部退款说明",
      updated_at: order.updated_at,
      updated_by: "admin",
    };
    mountOnboarding({
      stage: 4,
      path: "/orders/" + orderId,
      handle: (request) => {
        if (new URL(request.url).pathname === "/api/admin/v1/orders/" + orderId)
          return json({
            data: {
              ...order,
              version: 97,
              refund_mark: mark,
              refund_mark_history: [
                { ...mark, operation_id: "history-operation" },
              ],
            },
          });
        if (request.url.includes("webhook-deliveries"))
          return json({ data: [], page: { next_cursor: null } });
        return undefined;
      },
    });
    await screen.findByRole("button", { name: "更多操作，订单操作" });
    expect(await recordAction("撤销退款标记")).toBeEnabled();
    await userEvent.setup().click(screen.getByText("标记历史"));
    expect(screen.getAllByText(/admin ·/).length).toBeGreaterThan(0);
    expect(screen.queryByText("订单版本")).not.toBeInTheDocument();
    expect(screen.queryByText(/标记版本/)).not.toBeInTheDocument();
  });

  it("keeps matching evidence while hiding its internal rule version", async () => {
    mountOnboarding({
      stage: 4,
      path: "/reconciliation/candidates/" + candidateId,
      handle: (request) =>
        request.url.endsWith("/candidates/" + candidateId)
          ? json({ data: candidate })
          : undefined,
    });
    expect(
      await screen.findByRole("heading", { name: "可能匹配的记录" }),
    ).toBeVisible();
    expect(screen.getByText("匹配依据")).toBeVisible();
    expect(screen.queryByText(/规则版本/)).not.toBeInTheDocument();
  });

  it("does not repeat rule versions in the ledger candidate list", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: "/reconciliation/ledger/" + ledgerId,
      handle: (request) => {
        if (request.url.endsWith("/ledger/entries/" + ledgerId))
          return json({ data: { ...groupedLedger, active_match_count: 0, active_match: null, states: ["UNALLOCATED"], sources: [{ ...ledger, environment: "PRODUCTION", app_id: "app", raw_event_id: ledgerId }], matches: [], conflicts: [] } });
        if (request.url.endsWith("/ledger-entries/" + ledgerId + "/candidates"))
          return json({ data: [candidate] });
        if (request.url.endsWith("/orders/" + orderId))
          return json({ data: order });
        return undefined;
      },
    });
    const sources = await screen.findByRole("region", { name: /^采集记录/ });
    expect(
      await within(sources).findByRole("heading", { name: "可能匹配的订单" }),
    ).toBeVisible();
    expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toContain("/reconciliation/transactions/" + ledgerId);
    expect(within(sources).getByText("PerPay 记录状态")).toBeVisible();
    expect(screen.getByText("未分配", { exact: true })).toBeVisible();
    expect(screen.queryByText(/规则版本/)).not.toBeInTheDocument();
  });

  it("keeps the application release version for upgrades but hides configuration revision counters", async () => {
    mountOnboarding({ stage: 4, path: "/system" });
    expect(await screen.findByText("v0.1.0")).toBeVisible();
    expect(screen.queryByText(/配置版本|收款版本/)).not.toBeInTheDocument();
  });
});
