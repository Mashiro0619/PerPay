import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, sessionKey, type SelfUpdateStatus, type UpdateExecutionJob } from "../src/api/client";
import { buildOneLineUpgradeCommand, clearActiveSelfUpdateHint } from "../src/api/self-update";
import { SelfUpdateDialog } from "../src/components/self-update-dialog";
import { json } from "./fixtures";

function makeStatus(overrides: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus {
  return {
    enabled: true,
    unavailable_reason: null,
    current_version: "1.0.0-rc.5",
    can_backup: true,
    active_job: null,
    latest_job: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<UpdateExecutionJob> = {}): UpdateExecutionJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    target_version: "1.0.0",
    previous_version: "1.0.0-rc.5",
    status: "RUNNING",
    stage: "backing_up",
    message: "正在创建更新前数据库备份…",
    backup_name: null,
    rolled_back: false,
    started_at: 1_700_000_000_000,
    finished_at: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  clearActiveSelfUpdateHint();
  queryClient.setQueryData(sessionKey, { authenticated: true });
  document.cookie = "perpay_csrf=test-csrf-token";
});

afterEach(() => {
  clearActiveSelfUpdateHint();
  vi.restoreAllMocks();
});

describe("SelfUpdateDialog dual-track experience", () => {
  it("Track 1: confirms upgrade with backup, survives 502/network restart disconnects, and reaches completion", async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    let statusCalls = 0;
    const applyPayloads: unknown[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;

      if (path === "/api/admin/v1/system/update/status") {
        statusCalls += 1;
        if (statusCalls === 1) return json({ data: makeStatus() });
        if (statusCalls === 2) {
          return json({
            data: makeStatus({
              active_job: makeJob({
                stage: "pulling",
                message: "正在拉取官方镜像 ghcr.io/mashiro0619/perpay:1.0.0…",
                backup_name: "perpay-2026-11-22.sqlite3",
              }),
            }),
          });
        }
        if (statusCalls === 3) {
          // Simulate reverse proxy 502 during container restart
          return new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/html" } });
        }
        if (statusCalls === 4) {
          // Simulate socket drop during container restart
          throw new TypeError("Failed to fetch");
        }
        // New container back online on target version!
        return json({
          data: makeStatus({
            current_version: "1.0.0",
            active_job: null,
            latest_job: makeJob({
              status: "SUCCEEDED",
              stage: "completed",
              message: "已成功更新至 v1.0.0",
              backup_name: "perpay-2026-11-22.sqlite3",
              finished_at: 1_700_000_030_000,
            }),
          }),
        });
      }

      if (path === "/api/admin/v1/system/update/apply" && request.method === "POST") {
        applyPayloads.push(await request.json());
        return json({ data: makeJob() }, 202);
      }

      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.0.0"
          currentVersion="1.0.0-rc.5"
          releaseUrl="https://github.com/Mashiro0619/PerPay/releases/tag/v1.0.0"
          pollIntervalMs={30}
          onReload={reloadSpy}
        />
      </QueryClientProvider>,
    );

    // Confirm screen with default checked backup checkbox
    const backupCheckbox = await screen.findByRole("checkbox", { name: /更新前自动备份数据库/ });
    expect(backupCheckbox).toBeChecked();
    expect(screen.getByText("ghcr.io/mashiro0619/perpay:1.0.0")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "确认开始更新" }));

    expect(applyPayloads).toHaveLength(1);
    expect(applyPayloads[0]).toMatchObject({ target_version: "1.0.0", create_backup: true });

    // Reconnecting message during 502/network outage, then smooth completion
    expect(await screen.findByText("已成功更新至 v1.0.0", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByText(/perpay-2026-11-22\.sqlite3/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "刷新页面" }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("Track 1: surfaces automatic rollback state clearly when the new container fails health verification", async () => {
    const user = userEvent.setup();
    let statusCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/system/update/status") {
        statusCalls += 1;
        if (statusCalls === 1) return json({ data: makeStatus() });
        return json({
          data: makeStatus({
            active_job: null,
            latest_job: makeJob({
              status: "FAILED",
              stage: "failed",
              rolled_back: true,
              message: "更新至 v1.0.0 失败，已自动回滚至 v1.0.0-rc.5",
              error: "新版本容器启动后异常退出（exit 1）；已自动回滚至 v1.0.0-rc.5。",
              finished_at: 1_700_000_020_000,
            }),
          }),
        });
      }
      if (path === "/api/admin/v1/system/update/apply") {
        return json({ data: makeJob({ stage: "pulling", message: "正在拉取官方镜像…" }) }, 202);
      }
      return new Response(null, { status: 404 });
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.0.0"
          currentVersion="1.0.0-rc.5"
          pollIntervalMs={20}
        />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "确认开始更新" }));
    expect(await screen.findByText("新版本启动异常，已自动回滚至 v1.0.0-rc.5")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/exit 1/);
  });

  it("Track 2: renders Upgrade Assistant with one-click online backup and copyable one-line upgrade command", async () => {
    const user = userEvent.setup();
    let maintenanceStarted = false;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;

      if (path === "/api/admin/v1/system/update/status") {
        return json({
          data: makeStatus({
            enabled: false,
            unavailable_reason: "not_configured",
            can_backup: true,
          }),
        });
      }
      if (path === "/api/admin/v1/maintenance/jobs" && request.method === "POST") {
        maintenanceStarted = true;
        return json({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "BACKUP",
            status: "RUNNING",
            stage: "backing_up",
            message: "正在生成备份文件…",
            started_at: 1_700_000_000_000,
            finished_at: null,
            error: null,
            result: null,
          },
        }, 202);
      }
      if (path === "/api/admin/v1/maintenance/jobs/22222222-2222-4222-8222-222222222222") {
        return json({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "BACKUP",
            status: "SUCCEEDED",
            stage: "completed",
            message: "操作已完成",
            started_at: 1_700_000_000_000,
            finished_at: 1_700_000_001_000,
            error: null,
            result: { backup_name: "perpay-assistant-backup.sqlite3" },
          },
        });
      }
      return new Response(null, { status: 404 });
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.2.0"
          currentVersion="1.0.0-rc.5"
          pollIntervalMs={20}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("升级助手 · v1.2.0")).toBeVisible();
    expect(screen.getByText("ghcr.io/mashiro0619/perpay:1.2.0")).toBeVisible();
    expect(screen.getByText(/docker compose pull && docker compose up -d/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "立即备份数据库" }));
    expect(maintenanceStarted).toBe(true);
    await waitFor(() => {
      expect(screen.getByText(/perpay-assistant-backup\.sqlite3/)).toBeVisible();
    });

    // Expand sidecar enablement tip
    await user.click(screen.getByText("如何启用后台一键更新？"));
    expect(screen.getByText(/docker-compose\.updater\.yml/)).toBeVisible();
  });

  it("Track 2: disables inline backup cleanly in read-only demo mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      data: makeStatus({
        enabled: false,
        unavailable_reason: "demo_read_only",
        can_backup: false,
      }),
    })));

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.2.0"
          currentVersion="1.0.0-rc.5"
        />
      </QueryClientProvider>,
    );

    const backupButton = await screen.findByRole("button", { name: "立即备份数据库" });
    expect(backupButton).toBeDisabled();
    expect(screen.getByText("演示环境为只读模式，不执行数据库写入操作。")).toBeVisible();
  });

  it("Track 1: does not mask a recreating_backup failure when current_version already reached targetVersion", async () => {
    const user = userEvent.setup();
    let statusCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/system/update/status") {
        statusCalls += 1;
        if (statusCalls === 1) return json({ data: makeStatus() });
        if (statusCalls === 2) {
          // App already restarted on target 1.0.0, but updater is still recreating backup!
          return json({
            data: makeStatus({
              current_version: "1.0.0",
              active_job: makeJob({
                status: "RUNNING",
                stage: "recreating_backup",
                message: "核心服务已就绪，正在同步更新备份服务至 v1.0.0…",
              }),
            }),
          });
        }
        return json({
          data: makeStatus({
            current_version: "1.0.0",
            active_job: null,
            latest_job: makeJob({
              status: "FAILED",
              stage: "failed",
              rolled_back: false,
              message: "核心服务已切换至 v1.0.0，但备份服务更新失败",
              error: "创建 backup 容器失败；核心服务已运行在新版本，原备份容器已恢复。",
              finished_at: 1_700_000_020_000,
            }),
          }),
        });
      }
      if (path === "/api/admin/v1/system/update/apply") {
        return json({ data: makeJob({ stage: "pulling", message: "正在拉取官方镜像…" }) }, 202);
      }
      return new Response(null, { status: 404 });
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.0.0"
          currentVersion="1.0.0-rc.5"
          pollIntervalMs={20}
        />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "确认开始更新" }));
    expect(await screen.findByText("核心服务已切换至 v1.0.0，但备份服务更新未完成")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/创建 backup 容器失败/);
    expect(screen.queryByText("已成功更新至 v1.0.0")).not.toBeInTheDocument();
  });

  it("Track 1: surfaces a clear warning instead of spinning forever when updater becomes unreachable", async () => {
    const user = userEvent.setup();
    let statusCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/system/update/status") {
        statusCalls += 1;
        if (statusCalls === 1) return json({ data: makeStatus() });
        return json({
          data: makeStatus({
            enabled: false,
            unavailable_reason: "unreachable",
            active_job: null,
            latest_job: null,
          }),
        });
      }
      if (path === "/api/admin/v1/system/update/apply") {
        return json({ data: makeJob({ stage: "pulling", message: "正在拉取官方镜像…" }) }, 202);
      }
      return new Response(null, { status: 404 });
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <SelfUpdateDialog
          open
          onOpenChange={() => {}}
          targetVersion="1.0.0"
          currentVersion="1.0.0-rc.5"
          pollIntervalMs={10}
        />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "确认开始更新" }));
    expect(await screen.findByText(/持续无法连接到伴生更新器/, {}, { timeout: 3000 })).toBeVisible();
  });

  it("rejects non-canonical version strings in buildOneLineUpgradeCommand", () => {
    expect(() => buildOneLineUpgradeCommand("1.0.0; rm -rf /")).toThrow(RangeError);
    expect(buildOneLineUpgradeCommand("1.2.3")).toContain("ghcr.io/mashiro0619/perpay:1.2.3");
  });
});
