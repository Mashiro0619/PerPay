import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { BackupOverview, BackupStatus } from "../src/components/backup-status";
import { RuntimeErrorDetails } from "../src/components/runtime-error-details";
import { backupFailureStageName, runtimeErrorMessage } from "../src/lib/runtime-copy";
import { json, settings } from "./fixtures";
import { createMemoryRouter, RouterProvider } from "react-router";
import { systemStatus } from "./onboarding-fixture";

describe("runtime failure explanations", () => {
  it("shows a disabled task and existing recoverable copy without opening the policy editor", async () => {
    const status = systemStatus();
    Object.assign(status.backup, { enabled: false, backup_available: true, backup_name: "perpay-verified.sqlite3", retained_count: 2, last_success_at: 1_794_268_800_000 });
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: status })));
    const router = createMemoryRouter([{ path: "/settings/backup", element: <BackupOverview settings={settings} /> }], { initialEntries: ["/settings/backup"] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    expect(await screen.findByText("2 份")).toBeVisible();
    expect(screen.getByText("perpay-verified.sqlite3")).toBeVisible();
    expect(screen.getByText(/备份未启用/)).toBeVisible();
    expect(screen.getByRole("link", { name: "恢复说明" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each([
    [{ recovery_required: true }, "备份任务需要恢复"],
    [{ clock_moved_backwards: true }, "系统时钟发生回退"],
    [{ instance_matches: false }, "备份与当前实例不匹配"],
    [{ backup_required: true }, "当前数据需要重新备份"],
    [{}, "当前备份未通过健康检查"],
  ])("explains an unhealthy backup even when an older snapshot exists (%j)", async (flags, message) => {
    const status = systemStatus();
    Object.assign(status.backup, { enabled: true, ok: false, backup_available: true, backup_required: false }, flags);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: status })));
    render(<QueryClientProvider client={queryClient}><BackupStatus /></QueryClientProvider>);
    expect(await screen.findByText(new RegExp(message as string))).toBeVisible();
    expect(screen.queryByText("备份任务已启用")).not.toBeInTheDocument();
  });

  it.each([null, "verification"] as const)("shows a running backup before missing snapshots or earlier failures (%s)", async stage => {
    const status = systemStatus();
    status.backup.enabled = true;
    status.backup.backup_in_progress = true;
    status.backup.backup_available = false;
    status.backup.last_error_stage = stage;
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: status })));
    render(<QueryClientProvider client={queryClient}><BackupStatus /></QueryClientProvider>);
    expect(await screen.findByText("正在备份")).toBeVisible();
    expect(screen.queryByText(/请先完成一次备份验证|最近备份失败/)).not.toBeInTheDocument();
    if (stage) {
      await userEvent.setup().click(screen.getByRole("button", { name: "备份错误诊断" }));
      expect(screen.getByText(stage)).toBeVisible();
    }
  });

  it("distinguishes credentials, permission, network and local storage failures", () => {
    expect(runtimeErrorMessage("查账", "provider_authentication_failed")).toContain("应用和密钥");
    expect(runtimeErrorMessage("查账", "remote_authorization_failed")).toContain("查询权限不足");
    expect(runtimeErrorMessage("查账", "transport_timeout")).toContain("连接失败或超时");
    expect(runtimeErrorMessage("查账", "ledger_schedule_storage_error")).toContain("进度暂时无法读取或保存");
    expect(runtimeErrorMessage("自动确认收款", "reconciliation_storage_error")).toContain("记录暂时无法读取或保存");
    expect(runtimeErrorMessage("通知", "webhook_delivery_failed")).toContain("通知发送失败");
  });

  it("keeps unknown codes out of ordinary text and names the failed task", () => {
    const code = "future_internal_failure_001";
    for (const task of ["查账", "自动确认收款", "通知"] as const) {
      const message = runtimeErrorMessage(task, code);
      expect(message).toContain(task);
      expect(message).not.toContain(code);
      expect(message).toContain("运行诊断");
    }
    expect(backupFailureStageName("future_stage")).toBe("未确定的阶段");
    expect(backupFailureStageName("database_backup")).toBe("数据库备份");
    expect(backupFailureStageName("verification")).toBe("备份校验");
    expect(backupFailureStageName("retention")).toBe("旧备份清理");
  });

  it("preserves complete diagnostic values behind a keyboard-operable disclosure", async () => {
    const code = "synthetic_failure_" + "A".repeat(180);
    render(<RuntimeErrorDetails title="备份错误诊断" items={[["原始失败阶段", code], ["无错误", null]]} />);
    const trigger = screen.getByRole("button", { name: "备份错误诊断" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(code)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(code)).toBeVisible();
    expect(screen.getByText(code)).toHaveClass("wrap-anywhere");
    expect(screen.queryByText("无错误")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("explains a backup failure without losing the stage needed to inspect its logs", async () => {
    const status = systemStatus();
    status.backup.enabled = true;
    status.backup.last_error_stage = "verification";
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: status })));
    render(<QueryClientProvider client={queryClient}><BackupStatus /></QueryClientProvider>);
    expect(await screen.findByText("最近备份失败（备份校验），请查看备份日志。")).toBeVisible();
    expect(screen.queryByText("verification")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "备份错误诊断" }));
    expect(screen.getByText("verification")).toBeVisible();
    expect(screen.getByRole("link", { name: "启用与验证备份" })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
