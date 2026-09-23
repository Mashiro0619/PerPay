import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryClient } from "../src/api/client";
import { presentSystemStatus } from "../src/lib/system-status";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";
import { apiError, json } from "./fixtures";
function ready() {
  const data = systemStatus();
  data.ledger.conflicts = {
    provider_account_key: "test",
    open: 0,
    resolved: 0,
    ignored: 0,
    total: 0,
    by_type: [],
  };
  data.reconciliation.exceptions = {
    provider_account_key: "test",
    open: 0,
    resolved: 0,
    total: 0,
  };
  return data;
}
describe("shared runtime presentation", () => {
  it("treats incomplete successful status responses as unavailable without crashing protected forms", async () => {
    mountOnboarding({stage:4,path:"/settings/collection",handle:r=>r.url.endsWith("/system/status") ? json({data:{status:"ready",configured:true,database:{ok:true}}}) : undefined});
    expect(await screen.findByLabelText("收银台有效期（秒）")).toBeVisible();
    expect(await screen.findByText("状态未知")).toBeVisible();
    expect(screen.queryByText("页面未能正常加载")).not.toBeInTheDocument();
  });
  it("does not label business backlog as a failed collection or confirmation worker", () => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 5;
    data.reconciliation.exceptions!.open = 3;
    data.webhook.dead_letters = 2;
    expect(presentSystemStatus(data)).toMatchObject({
      canReceive: true,
      runtimeWarning: false,
      businessPending: true,
      ledgerHealthy: true,
      reconciliationHealthy: true,
      webhookHealthy: true,
      notice: "有待处理事项",
    });
  });
  it.each(["ledger", "reconciliation", "webhook"] as const)(
    "keeps real %s failures distinct even alongside backlog",
    (kind) => {
      const data = ready();
      data.status = "degraded";
      data.ledger.conflicts!.open = 4;
      data[kind].last_error_code = "failure";
      data[kind].consecutive_failures = 1;
      expect(presentSystemStatus(data)).toMatchObject({
        canReceive: true,
        runtimeWarning: true,
        businessPending: true,
        notice: "有运行告警",
      });
    },
  );
  it("keeps unknown degraded causes and backup recovery visible, but adds no normal decoration", () => {
    expect(presentSystemStatus(ready()).notice).toBeNull();
    const data = ready();
    data.status = "degraded";
    expect(presentSystemStatus(data).notice).toBe("有运行告警");
    data.status = "ready";
    data.backup.enabled = false;
    data.backup.recovery_required = true;
    expect(presentSystemStatus(data).runtimeWarning).toBe(true);
  });
  it("keeps the readiness gate regardless of whether workers have recent errors", () => {
    for (const field of ["database", "ledger", "reconciliation"]) {
      const data = ready();
      if (field === "database") data.database.ok = false;
      else if (field === "ledger") data.ledger.collection_ready = false;
      else data.reconciliation.confirmation_ready = false;
      expect(presentSystemStatus(data)).toMatchObject({
        canReceive: false,
        notice: "收款已暂停",
      });
    }
  });
  it("shows non-blocking backlog only in navigation without adding a homepage banner", async () => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 2;
    const view = mountOnboarding({ stage: 4, path: "/", status: () => data });
    expect(
      await screen.findByText("待处理", { selector: "[data-runtime-notice]" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "运行状态" }),
    ).toHaveAccessibleDescription("待处理");
    expect(screen.queryByText("可以收款，有运行告警")).not.toBeInTheDocument();
    expect(screen.queryByText("当前暂停新收款")).not.toBeInTheDocument();
    const reads = () =>
      view.fetchMock.mock.calls.filter(([r]) =>
        r.url.endsWith("/system/status"),
      ).length;
    expect(reads()).toBe(1);
    await userEvent
      .setup()
      .click(screen.getByRole("link", { name: "运行状态" }));
    await screen.findByRole("heading", { name: "运行环节" });
    expect(reads()).toBe(2);
    await userEvent
      .setup()
      .click(screen.getByRole("link", { name: "收款概览" }));
    await screen.findByRole("heading", { name: "收款趋势" });
    await waitFor(() => expect(reads()).toBe(3));
  });
  it("removes a previously normal system panel after a failed refresh rather than presenting it as current", async () => {
    let failed = false;
    mountOnboarding({
      stage: 4,
      path: "/system",
      status: () => ready(),
      handle: (r) =>
        failed && r.url.endsWith("/system/status")
          ? apiError("unavailable", "状态读取失败", 503)
          : undefined,
    });
    await screen.findByRole("heading", { name: "可以收款" });
    expect(document.querySelector("[data-runtime-notice]")).toBeNull();
    failed = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["status", "shared"] });
    });
    expect(await screen.findByText("暂时无法确认运行状态")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "可以收款" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "运行环节" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "运行状态" }),
    ).toHaveAccessibleDescription("状态未知");
  });
});
