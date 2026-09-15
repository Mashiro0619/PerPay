import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { dateTime } from "../src/lib/format";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import { json, ledger, ledgerId, order, orderId, settings } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const candidateId = "33333333-3333-4333-8333-333333333333";
const candidate = { candidate_id: candidateId, order_id: orderId, ledger_entry_id: ledgerId, status: "ELIGIBLE", rule_version: 73,
  evidence_type: "AMOUNT_INFERRED", evidence: {}, created_at: order.created_at, decided_at: null };

describe("ordinary administrator views", () => {
  it("shows key configuration and update time instead of technical key versions and fingerprints", () => {
    const updatedAt = Date.UTC(2026, 8, 13, 12);
    const configured = { ...settings, secrets: { ...settings.secrets, provider_private_key: { ...settings.secrets.provider_private_key, configured: true, version: 777, updatedAt, fingerprint: "f".repeat(64) } } };
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SecuritySettings settings={configured} onSaved={vi.fn()} /></MemoryRouter></QueryClientProvider>);
    const row = screen.getByRole("button", { name: "显示应用私钥" }).closest("li")!;
    expect(within(row).getByText("已配置")).toBeVisible();
    expect(within(row).getByText("更新于 " + dateTime(updatedAt))).toBeVisible();
    expect(row).not.toHaveTextContent(/版本|指纹|777/);
  });

  it("keeps refund actions, actor and history without showing order or mark versions", async () => {
    const mark = { marked: true, version: 37, note: "外部退款说明", updated_at: order.updated_at, updated_by: "admin" };
    mountOnboarding({ stage: 4, path: "/orders/" + orderId, handle: (request) => {
      if (new URL(request.url).pathname === "/api/admin/v1/orders/" + orderId) return json({ data: { ...order, version: 97, refund_mark: mark, refund_mark_history: [{ ...mark, operation_id: "history-operation" }] } });
      if (request.url.includes("webhook-deliveries")) return json({ data: [], page: { next_cursor: null } });
      return undefined;
    } });
    await screen.findByRole("button", { name: "撤销退款标记" });
    await userEvent.setup().click(screen.getByText("查看标记修改历史"));
    expect(screen.getByText("操作人 admin")).toBeVisible();
    expect(screen.queryByText("订单版本")).not.toBeInTheDocument();
    expect(screen.queryByText(/标记版本/)).not.toBeInTheDocument();
  });

  it("keeps matching evidence while hiding its internal rule version", async () => {
    mountOnboarding({ stage: 4, path: "/reconciliation/candidates/" + candidateId, handle: (request) => request.url.endsWith("/candidates/" + candidateId) ? json({ data: candidate }) : undefined });
    expect(await screen.findByRole("heading", { name: "金额推断候选" })).toBeVisible();
    expect(screen.getByText("查看推断规则与证据")).toBeVisible();
    expect(screen.queryByText(/规则版本/)).not.toBeInTheDocument();
  });

  it("does not repeat rule versions in the ledger candidate list", async () => {
    mountOnboarding({ stage: 4, path: "/reconciliation/ledger/" + ledgerId, handle: (request) => {
      if (request.url.endsWith("/ledger-entries/" + ledgerId)) return json({ data: ledger });
      if (request.url.endsWith("/ledger-entries/" + ledgerId + "/candidates")) return json({ data: [candidate] });
      return undefined;
    } });
    expect(await screen.findByRole("heading", { name: "金额推断候选" })).toBeVisible();
    expect(screen.queryByText(/规则版本/)).not.toBeInTheDocument();
  });

  it("keeps the application release version for upgrades but hides configuration revision counters", async () => {
    mountOnboarding({ stage: 4, path: "/system" });
    expect(await screen.findByText("应用版本")).toBeVisible();
    expect(screen.getByText("v0.1.0")).toBeVisible();
    expect(screen.queryByText(/配置版本|收款版本/)).not.toBeInTheDocument();
  });
});
