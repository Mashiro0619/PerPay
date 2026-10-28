import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { LedgerManualScanRequest, LedgerManualScanUnavailableReason } from "../src/shared/ledger-manual-scan";
import { createSettingsServer } from "./settings-server";

/** Real authenticated HTTP routes and SQLite; the provider work is controlled and entirely offline. */
async function createManualScanFixture(epoch: number, demoMode = false) {
  let now = epoch;
  let requests = 0;
  let manual: LedgerManualScanRequest | null = null;
  let unavailable: LedgerManualScanUnavailableReason | null = null;
  let recovered = false;
  const fixture = await createSettingsServer(epoch, {
    clock: () => now,
    demoMode,
    runtime: services => {
      const snapshot = services.settings.instanceSnapshot();
      return {
        runtimeStatus: () => ({
          configured: unavailable !== "not_configured", transitioning: unavailable === "transitioning",
          paymentRevision: snapshot.paymentRevision, activeProviderAccountKey: snapshot.activeProviderAccountKey,
          scanIntervalMilliseconds: 60_000, maximumSuccessAgeMilliseconds: 120_000,
        }),
        ledgerHealth: () => ({
          enabled: unavailable !== "stopped" && unavailable !== "not_configured",
          paymentRevision: snapshot.paymentRevision,
          state: unavailable === "stopped" ? "stopped" : manual?.state === "RUNNING" ? "running" : recovered ? "healthy" : "degraded",
          inFlight: manual?.state === "RUNNING", lastAttemptAt: manual?.started_at ? Date.parse(manual.started_at) : epoch - 1000,
          lastSuccessAt: recovered ? now : null, lastErrorCode: recovered ? null : "transport_network",
          consecutiveFailures: recovered ? 0 : 1,
        }),
        ledgerNextRunAt: () => manual?.next_attempt_at ? Date.parse(manual.next_attempt_at) : now + 60_000,
        ledgerManualScan: () => ({ available: unavailable === null, unavailable_reason: unavailable, request: manual ? { ...manual } : null }),
        requestLedgerScan: () => {
          requests++;
          if (manual && ["WAITING", "RUNNING"].includes(manual.state)) return { ...manual };
          manual = {
            id: randomUUID(), state: "WAITING", requested_at: new Date(now).toISOString(),
            started_at: null, finished_at: null, next_attempt_at: new Date(now + 8000).toISOString(),
            outcome: null, error_code: null, ingest_run_id: null,
          };
          return { ...manual };
        },
      };
    },
  });
  return {
    ...fixture,
    requestCount: () => requests,
    advance(milliseconds: number) { now += milliseconds; },
    unavailable(reason: LedgerManualScanUnavailableReason | null) { unavailable = reason; },
    start() {
      if (!manual) throw new Error("No accepted scan");
      manual = { ...manual, state: "RUNNING", started_at: new Date(now).toISOString(), next_attempt_at: null };
    },
    finish(outcome: "COMPLETED" | "PARTIAL" | "FAILED") {
      if (!manual) throw new Error("No accepted scan");
      recovered = outcome === "COMPLETED";
      manual = { ...manual, state: outcome === "FAILED" ? "FAILED" : "COMPLETED", outcome,
        finished_at: new Date(now).toISOString(), next_attempt_at: null,
        error_code: outcome === "FAILED" ? "transport_network" : null, ingest_run_id: randomUUID() };
    },
  };
}

async function enter(page: Page, fixture: Awaited<ReturnType<typeof createManualScanFixture>>) {
  await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
  await page.addInitScript(() => localStorage.setItem("perpay:update-preferences", JSON.stringify({ automatic: false, channel: "prerelease" })));
  await page.context().addCookies(fixture.cookies);
  await page.goto(fixture.origin + "/admin/system");
  await expect(page.getByRole("table", { name: "运行环节" })).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`${width}: a failed ledger scan can be requested, observed across reload, and retried without duplicate submissions`, async ({ page }, info) => {
    const epoch = Date.now();
    const fixture = await createManualScanFixture(epoch);
    try {
      await page.setViewportSize({ width, height: 960 });
      await page.clock.install({ time: new Date(epoch) });
      await enter(page, fixture);
      const ledgerRow = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "查账", exact: true }) });
      const button = ledgerRow.getByRole("button", { name: "手动查账", exact: true });
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(fixture.requestCount).toBe(1);
      await expect(ledgerRow).toContainText(/等待|排队/);
      await expect(button).toBeDisabled();
      await page.clock.runFor(2100);
      expect(fixture.requestCount()).toBe(1);

      await page.reload();
      await expect(ledgerRow).toContainText(/等待|排队/);
      expect(fixture.requestCount()).toBe(1);
      fixture.advance(8000);
      fixture.start();
      await page.clock.runFor(2100);
      await expect(ledgerRow).toContainText(/正在查账/);
      fixture.finish("FAILED");
      await page.clock.runFor(2100);
      await expect(ledgerRow).toContainText(/失败|未完成/);
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(fixture.requestCount).toBe(2);
      fixture.advance(8000);
      fixture.start();
      await page.clock.runFor(2100);
      await expect(ledgerRow).toContainText(/正在查账/);
      fixture.finish("COMPLETED");
      await page.clock.runFor(2100);
      await expect(ledgerRow).toContainText(/本轮.*完成|本次.*完成|查账.*完成/);
      await expect(button).toBeEnabled();
      expect(fixture.requestCount()).toBe(2);
      await page.reload();
      await expect(ledgerRow).toContainText(/本轮.*完成|本次.*完成|查账.*完成/);
      expect(fixture.requestCount()).toBe(2);

      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 960 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      }
      await expect(button).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`manual-scan-${width}.png`), fullPage: true });
    } finally { await fixture.close(); }
  });
}

test("manual scan availability explains failures and keeps the demo action disabled without mode copy", async ({ page }) => {
  const epoch = Date.now();
  const fixture = await createManualScanFixture(epoch);
  try {
    await enter(page, fixture);
    const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "查账", exact: true }) });
    for (const [reason, message] of [
      ["stopped", /停止|停用|未运行|不可用/], ["transitioning", /切换|变更/],
      ["not_configured", /配置|接入/], ["storage_unavailable", /存储|保存|恢复|进度暂不可用/],
    ] as const) {
      fixture.unavailable(reason);
      await page.reload();
      await expect(row.getByRole("button", { name: "手动查账", exact: true })).toBeDisabled();
      await expect(row).toContainText(message);
    }
    expect(fixture.requestCount()).toBe(0);
  } finally { await fixture.close(); }
  await page.unrouteAll({ behavior: "wait" });
  const demo = await createManualScanFixture(epoch, true);
  try {
    await enter(page, demo);
    const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "查账", exact: true }) });
    await expect(row.getByRole("button", { name: "手动查账", exact: true })).toBeDisabled();
    await expect(row).not.toContainText(/演示/);
    await expect(row.getByRole("button", { name: "手动查账", exact: true })).not.toHaveAttribute("aria-describedby");
    expect(demo.requestCount()).toBe(0);
  } finally { await demo.close(); }
});

test("a failed manual request can recover without automatic POST retries", async ({ page }) => {
  const epoch = Date.now();
  const fixture = await createManualScanFixture(epoch);
  try {
    await page.clock.install({ time: new Date(epoch) });
    await enter(page, fixture);
    let posts = 0;
    await page.route("**/api/admin/v1/system/ledger/scan", async route => {
      posts++;
      if (posts === 1) return route.fulfill({ status: 503, contentType: "application/json",
        headers: { "retry-after": "3" }, body: JSON.stringify({ error: { code: "ledger_scan_unavailable", message: "查账暂时不可用，请稍后重试。" } }) });
      return route.continue();
    });
    const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "查账", exact: true }) });
    const button = row.getByRole("button", { name: "手动查账", exact: true });
    await button.click();
    await expect(page.getByText(/查账暂时不可用|查账请求失败/).first()).toBeVisible();
    expect(fixture.requestCount()).toBe(0);
    await page.clock.runFor(3100);
    expect(posts).toBe(1);
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(fixture.requestCount).toBe(1);
    expect(posts).toBe(2);
    await expect(row).toContainText(/等待|排队/);
  } finally { await fixture.close(); }
});
