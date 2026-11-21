import { test, expect } from "@playwright/test";
import { APP_VERSION } from "../src/version";
import { MaintenanceController } from "../src/maintenance/controller";
import { SelfUpdateService, type UpdaterClient } from "../src/update/self-update";
import type { UpdateExecutionJob } from "../src/update/updater-core";
import { createSettingsServer } from "./settings-server";

function mockUpdate(version: string, epoch: number) {
  return {
    status: "update_available" as const,
    current_version: APP_VERSION,
    latest_version: version,
    release_url: `https://github.com/Mashiro0619/PerPay/releases/tag/v${version}`,
    published_at: new Date(epoch - 86_400_000).toISOString(),
    checked_at: new Date(epoch).toISOString(),
  };
}

test("Track 1 (desktop 1440 light): confirms one-click update, survives restart outage, and finishes", async ({ page }, info) => {
  const epoch = Date.now();
  let remoteJob: UpdateExecutionJob | null = null;
  let statusPollCount = 0;

  const updaterClient: UpdaterClient = {
    status: async () => ({ active: remoteJob?.status === "RUNNING" ? remoteJob : null, latest: remoteJob }),
    apply: async (request) => {
      remoteJob = {
        id: request.operation_id,
        target_version: request.target_version,
        previous_version: request.previous_version,
        status: "RUNNING",
        stage: "pulling",
        message: `正在拉取官方镜像 ghcr.io/mashiro0619/perpay:${request.target_version}…`,
        backup_name: request.backup_name ?? null,
        rolled_back: false,
        started_at: epoch,
        finished_at: null,
        error: null,
      };
      return remoteJob;
    },
  };
  const maintenance = new MaintenanceController({
    pause: async () => {},
    resume: async () => {},
    run: async () => ({ backup_name: "perpay-e2e-pre-update.sqlite3" }),
  });
  const selfUpdate = new SelfUpdateService({ updaterClient, maintenance });
  const fixture = await createSettingsServer(epoch, {
    updateChecker: { check: async () => mockUpdate("1.1.0", epoch) },
    maintenance,
    selfUpdate,
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.context().addCookies(fixture.cookies);

    // Intercept status polls AFTER apply to simulate container restart (503) -> new version ready
    await page.route(fixture.origin + "/api/admin/v1/system/update/status", async (route) => {
      if (remoteJob !== null) {
        statusPollCount += 1;
        if (statusPollCount === 1) {
          await route.fulfill({ status: 503, contentType: "text/plain", body: "Service Unavailable" });
          return;
        }
        remoteJob = {
          ...remoteJob,
          status: "SUCCEEDED",
          stage: "completed",
          message: "已成功更新至 v1.1.0",
          finished_at: epoch + 15_000,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              unavailable_reason: null,
              current_version: "1.1.0",
              can_backup: true,
              active_job: null,
              latest_job: remoteJob,
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(fixture.origin + "/admin/system");

    // 1. Click "立即更新" from the "发现新版本" dialog
    const announcement = page.getByRole("dialog", { name: "发现新版本", exact: true });
    await expect(announcement).toBeVisible();
    await announcement.getByRole("button", { name: "立即更新", exact: true }).click();

    // 2. Confirm screen appears with checked backup checkbox
    const selfDialog = page.getByRole("dialog", { name: "更新至 v1.1.0", exact: true });
    await expect(selfDialog).toBeVisible();
    await expect(selfDialog.getByRole("checkbox", { name: /更新前自动备份数据库/ })).toBeChecked();
    await page.screenshot({ path: info.outputPath("self-update-track1-confirm.png"), animations: "disabled" });

    // 3. Start update -> progresses through restart reconnect -> completes
    await selfDialog.getByRole("button", { name: "确认开始更新", exact: true }).click();
    const completedDialog = page.getByRole("dialog", { name: "更新完成", exact: true });
    await expect(completedDialog).toBeVisible({ timeout: 15_000 });
    await expect(completedDialog).toContainText("已成功更新至 v1.1.0");
    await expect(completedDialog).toContainText("perpay-e2e-pre-update.sqlite3");
    await expect(completedDialog.getByRole("button", { name: "刷新页面", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("self-update-track1-completed.png"), animations: "disabled" });
  } finally {
    await fixture.close();
  }
});

test("Track 2 (mobile 390 dark): opens Upgrade Assistant, completes inline backup, and reveals sidecar command", async ({ page }, info) => {
  const epoch = Date.now();
  const maintenance = new MaintenanceController({
    pause: async () => {},
    resume: async () => {},
    run: async () => ({ backup_name: "perpay-e2e-assistant.sqlite3" }),
  });
  const fixture = await createSettingsServer(epoch, {
    updateChecker: { check: async () => mockUpdate("1.2.0", epoch) },
    maintenance,
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("perpay:theme", "dark"));
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/system");

    // Dismiss initial announcement dialog and click "立即更新" from the "官方更新" panel
    const announcement = page.getByRole("dialog", { name: "发现新版本", exact: true });
    await expect(announcement).toBeVisible();
    await announcement.getByRole("button", { name: "知道了", exact: true }).click();
    await expect(announcement).not.toBeVisible();

    const updatePanel = page.getByRole("region", { name: "官方更新", exact: true });
    await updatePanel.getByRole("button", { name: "立即更新", exact: true }).click();

    const assistant = page.getByRole("dialog", { name: "升级助手 · v1.2.0", exact: true });
    await expect(assistant).toBeVisible();
    await expect(assistant).toContainText("ghcr.io/mashiro0619/perpay:1.2.0");
    await expect(assistant).toContainText("docker compose pull && docker compose up -d");

    // Run Step 1 inline database backup
    await assistant.getByRole("button", { name: "立即备份数据库", exact: true }).click();
    await expect(assistant).toContainText("perpay-e2e-assistant.sqlite3", { timeout: 10_000 });

    // Expand sidecar setup instructions
    await assistant.getByText("如何启用后台一键更新？").click();
    await expect(assistant).toContainText("docker-compose.updater.yml");
    await page.screenshot({ path: info.outputPath("self-update-track2-assistant-mobile-dark.png"), animations: "disabled" });

    // Confirm zero horizontal overflow on 390px mobile
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await fixture.close();
  }
});
