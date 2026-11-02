import { readFileSync } from "node:fs";
import type { AuditEventDetail, AuditEventPage, AuditMetadata } from "../src/shared/audit";
import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";
import { expectDetailRecordLayout } from "./detail-layout";
import { aggregateEvent, auditDetail, auditEvent, auditMetadata, auditPage } from "../web/test/audit-fixtures";

test("audit reads actual saved events, opens a detail, and exports the matching filtered CSV", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const response = await page.request.get(manifest.origin + "/api/admin/v1/audit-events?source=core&limit=20");
  expect(response.status()).toBe(200);
  const saved = await response.json() as AuditEventPage;
  expect(saved.data.length).toBeGreaterThan(0);
  const first = saved.data[0]!;
  const metadataResponse = await page.request.get(manifest.origin + "/api/admin/v1/audit-events/meta");
  expect(metadataResponse.status()).toBe(200);
  const metadata = await metadataResponse.json() as { data: AuditMetadata };
  const selectedSite = metadata.data.sites[0]?.site_id;
  const selection = selectedSite ? "&selected_site=" + encodeURIComponent(selectedSite) : "";
  await page.goto(manifest.origin + "/admin/audit?source=core" + selection);
  await expect(page.getByRole("heading", { level: 1, name: "审计日志", exact: true })).toBeVisible();
  await expect(page.locator('[data-business-list="audit"]')).toBeVisible();
  await expect(page.locator("a[data-row-link]").first()).toBeVisible();
  await expect(page.locator("[data-audit-retention]")).toHaveCount(0);
  await page.locator("[data-audit-status-trigger]").click();
  const status = page.locator("[data-overlay-content]");
  await expect(page.getByRole("heading", { level: 1, name: "审计采集状态" })).toBeVisible();
  await expect(status.locator("[data-audit-retention]")).toContainText("活动记录保留 30 天");
  await expect(status).toContainText("列表读取时间");
  await status.locator('[data-slot="dialog-close"]').click();
  // Select by the real API identity, independent of translated action labels.
  await page.locator(`a[data-row-link][href*="${first.event_id}"]`).click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "审计日志详情" })).toBeVisible();
  await expect(page.getByRole("group", { name: "日志概况", exact: true })).toBeVisible();
  await overlay.locator('[data-slot="dialog-close"]').click();
  await expect(page).toHaveURL(/\/admin\/audit\?source=core/);
  if (selectedSite) expect(new URL(page.url()).searchParams.get("selected_site")).toBe(selectedSite);
  const date = new Date(new Date(first.occurred_at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  await page.goto(manifest.origin + `/admin/audit?source=core&created_from=${date}&created_to=${date}${selection}`);
  await expect(page.locator('a[data-row-link]').first()).toBeVisible();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const download = await downloadReady;
  await expect(page.locator("[data-list-toolbar]").getByRole("status").filter({ hasText: "文件已生成" })).toHaveText("文件已生成");
  expect(download.suggestedFilename()).toBe(`audit-${date}-${date}.csv`);
  const file = await download.path();
  expect(file).not.toBeNull();
  const bytes = readFileSync(file!);
  expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
  expect(bytes.toString("utf8")).toContain(first.event_id);
  await record(page, info, { auditSource: "real Hono/SQLite", exportedDate: date });
  await screenshot(page, info, "audit-real-list");
});

test("narrow audit views keep direct selections and keyboard focus fully visible at 200% text", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const width of [320, 390]) for (const zoom of [100, 200]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(manifest.origin + "/admin/audit?view=all");
    await page.evaluate(value => { document.documentElement.style.fontSize = value + "%"; }, zoom);
    const tabs = page.getByRole("tablist", { name: "审计视图" });
    const fits = async (label: string) => {
      await expect.poll(() => tabs.getByRole("tab", { name: label, exact: true }).evaluate(tab => {
        const box = tab.getBoundingClientRect(), clip = tab.closest(".audit-view-scroll")!.getBoundingClientRect();
        return box.left >= clip.left - 1 && box.right <= clip.right + 1;
      })).toBe(true);
    };
    await expect(tabs.getByRole("tab", { name: "全部记录", exact: true })).toHaveAttribute("aria-selected", "true");
    await fits("全部记录");
    const scrollY = await page.evaluate(() => window.scrollY);
    await tabs.getByRole("tab", { name: "全部记录", exact: true }).focus();
    await page.keyboard.press("Home");
    const labels = ["操作审计", "接口访问", "后台任务", "维护活动", "全部记录"];
    for (const [index, label] of labels.entries()) {
      if (index) await page.keyboard.press("ArrowRight");
      await expect(tabs.getByRole("tab", { name: label, exact: true })).toBeFocused();
      await fits(label);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await record(page, info, { auditViews: "direct link and keyboard", width, textPercent: zoom });
  }
});

test("audit summaries, source details and configuration changes stay readable across viewport sizes", async ({ page, manifest }, info) => {
  const at = (offset: number) => new Date(manifest.epoch + offset).toISOString();
  const core = { ...auditEvent, occurred_at: at(-5000), first_occurred_at: at(-5000), last_occurred_at: at(-5000), subject_id: "site-settings-" + "long-identifier-".repeat(10) };
  const aggregate = { ...aggregateEvent, occurred_at: at(-45_000), first_occurred_at: at(-50_000), last_occurred_at: at(-1000) };
  const detail: AuditEventDetail = { ...auditDetail(core), user_agent: auditEvent.user_agent + " additional-client-information".repeat(30), changes: [
    { field: "display.system_name", kind: "value", before: "原系统名称", after: "供审计验证的长系统名称与业务说明".repeat(7) },
    { field: "private_key", kind: "redacted_change", configured_before: true, configured_after: true },
  ], related_events: [{ source: "activity", event_id: aggregate.event_id, action: aggregate.action, occurred_at: aggregate.occurred_at, outcome: "SUCCESS" }] };
  await page.route("**/api/admin/v1/audit-events**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/meta")) return route.fulfill({ json: { data: auditMetadata } });
    if (path.endsWith("/" + core.event_id)) return route.fulfill({ json: { data: detail } });
    if (path.endsWith("/" + aggregate.event_id)) return route.fulfill({ json: { data: auditDetail(aggregate) } });
    return route.fulfill({ json: auditPage([core, aggregate]) });
  });
  await login(page, manifest);
  for (const [width, theme] of [[320, "light"], [390, "dark"], [1280, "light"], [1680, "dark"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { localStorage.setItem("perpay:theme", value); }, theme);
    await page.goto(manifest.origin + "/admin/audit?view=all");
    await expect(page.getByText("5 次", { exact: true })).toBeVisible();
    await record(page, info, { auditSource: "synthetic edge cases", width, theme, view: "list" });
    if (width < 768) {
      await expect(page.getByRole("button", { name: "更多审计日志操作" })).toBeVisible();
      await page.getByRole("button", { name: "筛选", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "筛选", exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "排序字段" })).toHaveCount(0);
      await page.getByRole("dialog", { name: "筛选", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
    }
    const link = page.locator(`a[data-row-link][href*="${core.event_id}"]`);
    await link.click();
    const overlay = page.locator("[data-overlay-content]");
    await expect(overlay).toBeVisible();
    await expect(page.getByRole("group", { name: "配置变更", exact: true })).toBeVisible();
    await expect(page.getByText("已更换（值不记录）", { exact: true })).toBeVisible();
    const closedLayout = await expectDetailRecordLayout(page);
    await record(page, info, { auditSource: "synthetic edge cases", width, theme, view: "detail", layout: closedLayout });
    if (width === 390 || width === 1680) await screenshot(page, info, `audit-detail-${width}-${theme}`);
    await page.getByRole("button", { name: "技术信息", exact: true }).click();
    await expect(overlay.getByLabel("技术信息", { exact: true })).toBeVisible();
    const openLayout = await expectDetailRecordLayout(page);
    await record(page, info, { auditSource: "synthetic edge cases", width, theme, view: "expanded technical information", layout: openLayout });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(overlay).not.toBeVisible();
    await expect(link).toBeFocused();
  }
});

test("audit export failures remain visible beside the sticky action after scrolling", async ({ page, manifest }, info) => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...auditEvent, event_id: `audit-scroll-${index}`, sequence: index + 1 }));
  await page.route("**/api/admin/v1/audit-events**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/meta")) return route.fulfill({ json: { data: auditMetadata } });
    if (path.endsWith("/export")) return route.fulfill({ status: 422, json: { error: { code: "validation_failed", message: "导出结果超过 10,000 行，请缩小筛选范围" } } });
    return route.fulfill({ json: auditPage(rows) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/audit?created_from=2026-11-01&created_to=2026-11-01");
  await expect(page.locator("a[data-row-link]")).toHaveCount(20);
  await expect(page.locator("[data-list-advanced-filters]")).toHaveCount(0);
  const tableSurface = page.locator('[data-business-table="audit"] .business-table-surface');
  await expect.poll(() => tableSurface.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const visibleRows = await page.locator('[data-business-table="audit"] [data-business-row]').evaluateAll(rows => rows.filter(row => {
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
  }).length);
  expect(visibleRows).toBeGreaterThanOrEqual(10);
  await record(page, info, { auditSource: "synthetic dense list", visibleRows });
  await screenshot(page, info, "audit-dense-first-screen");
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(180);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const error = page.getByText("导出结果超过 10,000 行，请缩小筛选范围", { exact: true });
  await expect(error).toBeVisible();
  await expect(error).toBeInViewport();
  await expect(page.locator("[data-list-toolbar]")).toContainText("导出结果超过 10,000 行");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(180);
  await record(page, info, { auditSource: "synthetic export limit", scrolled: true });
  await screenshot(page, info, "audit-export-sticky-error");
});
