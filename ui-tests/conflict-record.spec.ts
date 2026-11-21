import type { Page } from "@playwright/test";
import type { LedgerConflictDetail } from "../web/src/api/generated/types.gen";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { settleOverlay } from "./overlay-fixtures";
import { closeTechnicalDialog, detailSection, expectDetailRecordLayout, expectTechnicalDialogLayout, openTechnicalDialog, revealDetailSection } from "./detail-layout";

// Ledger conflicts span three distinct visual shapes:
// 1. two-sided comparison (table on wide drawers, stacked cards on narrow/zoomed drawers),
// 2. single-sided isolated event with an invalid-field marker,
// 3. raw-page variant with only poll summary and history.
const layouts = [
  { width: 1440, height: 900, text: 100, theme: "light", compactComparison: false },
  { width: 390, height: 844, text: 100, theme: "dark", compactComparison: true },
  { width: 320, height: 560, text: 200, theme: "light", compactComparison: true },
] as const;

const primaryScenarios = [
  {
    key: "conflictDuplicateOpen",
    title: "支付宝流水号重复",
    statusLabel: "待处理",
    explanation: "同一支付宝流水号对应不同交易内容，已有流水未被覆盖。",
    actionLabel: "保留已有流水",
    twoSided: true,
  },
  {
    key: "conflictIsolated",
    title: "支付宝交易金额无法解析",
    statusLabel: "未处理 · 已忽略",
    explanation: "交易金额格式无效，已隔离，不计入收款。",
    actionLabel: "确认隔离记录",
    twoSided: false,
  },
] as const;

const secondaryScenarios = [
  {
    key: "conflictDuplicateResolved",
    title: "支付宝流水号重复",
    statusLabel: "已处理",
    explanation: "同一支付宝流水号对应不同交易内容，已有流水未被覆盖。",
    sections: ["comparison", "collection", "history"],
    layout: { width: 1440, height: 900, text: 100, theme: "light" as const, compactComparison: false },
  },
  {
    key: "conflictRawPage",
    title: "账单原始页发生变化",
    statusLabel: "待处理",
    explanation: "同一查账窗口返回了不同内容。",
    sections: ["collection", "history"],
    layout: { width: 320, height: 560, text: 200, theme: "dark" as const, compactComparison: true },
  },
] as const;

async function readConflict(page: Page, manifest: Manifest, routePath: string) {
  const id = routePath.split("/").at(-1)!;
  const response = await page.request.get(manifest.origin + "/api/admin/v1/ledger/conflicts/" + id);
  expect(response.status(), routePath).toBe(200);
  return (await response.json() as { data: LedgerConflictDetail }).data;
}

function overlayTarget(manifest: Manifest, href: string | null) {
  const target = new URL(href!, manifest.origin).searchParams.get("overlay");
  expect(target, "record links keep an explicit overlay resource").toBeTruthy();
  return new URL(target!, manifest.origin);
}

async function expectComparisonLayout(page: Page, compact: boolean) {
  const comparison = detailSection(page, "comparison").locator("[data-conflict-comparison]");
  await expect(comparison).toBeVisible();
  if (compact) {
    await expect(comparison.locator("[data-comparison-mobile]").first()).toBeVisible();
    await expect(comparison.locator("[data-comparison-desktop]")).toHaveCount(0);
  } else {
    await expect(comparison.locator("[data-comparison-desktop]").first()).toBeVisible();
    await expect(comparison.locator("[data-comparison-mobile]")).toHaveCount(0);
  }
  const metrics = await comparison.evaluate((root, isCompact) => {
    const box = root.getBoundingClientRect();
    const overflowing: Array<{ text: string; scrollWidth: number; clientWidth: number; left: number; right: number; boxLeft: number; boxRight: number }> = [];
    const surfaces = [...root.querySelectorAll<HTMLElement>(isCompact ? "[data-comparison-mobile]" : "[data-comparison-desktop]")];
    const items = isCompact
      ? [...surfaces, ...root.querySelectorAll<HTMLElement>("[data-comparison-field], [data-comparison-field] dd, [data-comparison-field] dt")]
      : [...surfaces, ...root.querySelectorAll<HTMLElement>("table, th, td")];
    for (const element of items) {
      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) continue;
      if (element.scrollWidth > element.clientWidth + 1 || bounds.left < box.left - 1 || bounds.right > box.right + 1) {
        overflowing.push({
          text: (element.textContent ?? "").trim().slice(0, 40),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          left: bounds.left,
          right: bounds.right,
          boxLeft: box.left,
          boxRight: box.right,
        });
      }
    }
    return { surfaceCount: surfaces.filter(node => node.getBoundingClientRect().height > 0).length, itemCount: items.length, overflowing };
  }, compact);
  expect(metrics.surfaceCount, "comparison renders visible comparison surfaces").toBeGreaterThan(0);
  expect(metrics.itemCount, "comparison renders visible rows").toBeGreaterThan(0);
  expect(metrics.overflowing, "comparison tables and cards fit cleanly within the drawer without clipping").toEqual([]);
  return metrics;
}

for (const layout of layouts) for (const scenario of primaryScenarios) {
  test(`${layout.width}x${layout.height}, ${layout.text}% ${layout.theme}: conflict record ${scenario.key} keeps clear layout and evidence`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), layout.theme);
    await login(page, manifest);

    const routePath = manifest.details[scenario.key]!;
    const detail = await readConflict(page, manifest, routePath);
    const writes: string[] = [], errors: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
        writes.push(request.method() + " " + new URL(request.url()).pathname);
      }
    });
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(manifest.origin + "/admin" + routePath);
    const overlay = await settleOverlay(page);
    await expect(detailSection(page, "comparison")).toBeVisible();
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", layout.text);
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);

    await expect(overlay.getByRole("heading", { level: 1 })).toHaveText(scenario.title);
    await expect(overlay.locator("[data-overlay-eyebrow-text]")).toHaveText("对账详情");
    const summary = overlay.getByRole("group", { name: "冲突概况", exact: true });
    await expect(summary.getByText(scenario.statusLabel, { exact: true })).toBeVisible();
    await expect(summary).toContainText(scenario.explanation);

    expect(await overlay.locator("[data-detail-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-detail-section"))))
      .toEqual(["comparison", "collection", "history"]);
    const navigation = overlay.getByRole("navigation", { name: "分区导航", exact: true });
    if (await navigation.isVisible()) {
      await expect(navigation.getByRole("button")).toHaveCount(3);
    }

    const comparison = await revealDetailSection(page, "comparison");
    let comparisonMetrics: unknown = null;
    if (scenario.twoSided) {
      expect(detail.existing_ledger_entry, "duplicate fixture has existing entry").not.toBeNull();
      const existingLink = comparison.getByRole("link", { name: "查看已有流水", exact: true });
      await expect(existingLink).toBeVisible();
      expect(overlayTarget(manifest, await existingLink.getAttribute("href")).pathname)
        .toBe("/reconciliation/ledger/" + detail.existing_ledger_entry!.ledger_entry_id);
      await expect(comparison.locator("[data-comparison-summary]")).toContainText("项需核对");
      comparisonMetrics = await expectComparisonLayout(page, layout.compactComparison);

      // Expand matching fields and verify they also fit without overflow at this viewport and zoom.
      const matchingToggle = comparison.getByRole("button", { name: /^相同字段/ });
      await expect(matchingToggle).toBeVisible();
      await matchingToggle.click();
      await expect(matchingToggle).toHaveAttribute("aria-expanded", "true");
      await expectComparisonLayout(page, layout.compactComparison);
    } else {
      await expect(comparison.getByRole("link", { name: "查看已有流水" })).toHaveCount(0);
      await expect(comparison).toContainText("无可对照流水");
      await expect(comparison.locator("[data-comparison-invalid]")).toContainText("异常");
    }

    const collection = await revealDetailSection(page, "collection");
    await expect(collection.locator("dt")).toHaveText(["查账时间", "支付宝响应验签", "查账窗口", "HTTP 响应"]);
    const history = await revealDetailSection(page, "history");
    await expect(history).toContainText("发现冲突");

    const measured = await expectDetailRecordLayout(page);
    const id = `${scenario.key}-${layout.width}-${layout.text}-${layout.theme}`;
    await screenshot(page, info, "conflict-" + id);
    await audit(page, info, "conflict-" + id);

    const footer = overlay.locator("[data-overlay-footer]");
    await expect(footer.getByRole("button", { name: scenario.actionLabel, exact: true })).toBeVisible();
    const session = await openTechnicalDialog(page, footer.locator('button[aria-label="更多操作，冲突记录操作"]'), "冲突记录技术信息");
    await expect(session.body.getByRole("button", { name: "复制冲突编号", exact: true })).toBeVisible();
    if (detail.existing_ledger_entry) {
      await expect(session.body.getByRole("button", { name: "复制关联内部流水编号", exact: true })).toBeVisible();
    }
    const technical = await expectTechnicalDialogLayout(session);
    await closeTechnicalDialog(session);

    await record(page, info, { feature: "conflict-record-layout", scenario: scenario.key, layout, comparisonMetrics, measured, technical });
    expect(writes, "reading a conflict record never submits writes").toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const scenario of secondaryScenarios) {
  test(`${scenario.layout.width}x${scenario.layout.height}, ${scenario.layout.text}% ${scenario.layout.theme}: conflict record ${scenario.key} renders its terminal or page-only shape`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: scenario.layout.width, height: scenario.layout.height });
    await page.emulateMedia({ colorScheme: scenario.layout.theme, reducedMotion: "reduce" });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), scenario.layout.theme);
    await login(page, manifest);

    const routePath = manifest.details[scenario.key]!;
    const detail = await readConflict(page, manifest, routePath);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(manifest.origin + "/admin" + routePath);
    const overlay = await settleOverlay(page);
    await expect(detailSection(page, "collection")).toBeVisible();
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", scenario.layout.text);
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);

    await expect(overlay.getByRole("heading", { level: 1 })).toHaveText(scenario.title);
    const summary = overlay.getByRole("group", { name: "冲突概况", exact: true });
    await expect(summary.getByText(scenario.statusLabel, { exact: true })).toBeVisible();
    await expect(summary).toContainText(scenario.explanation);
    expect(await overlay.locator("[data-detail-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-detail-section"))))
      .toEqual(scenario.sections);

    if ((scenario.sections as readonly string[]).includes("comparison")) {
      await revealDetailSection(page, "comparison");
      await expectComparisonLayout(page, scenario.layout.compactComparison);
    }
    const history = await revealDetailSection(page, "history");
    await expect(history).toContainText("发现冲突");
    if (detail.resolution_operation) {
      await expect(history).toContainText(detail.resolution_operation.reason);
    }

    const measured = await expectDetailRecordLayout(page);
    const footer = overlay.locator("[data-overlay-footer]");
    await expect(footer.getByRole("button", { name: /保留已有流水|确认隔离记录/ })).toHaveCount(0);
    const session = await openTechnicalDialog(page, footer.locator('button[aria-label="更多操作，冲突记录操作"]'), "冲突记录技术信息");
    const technical = await expectTechnicalDialogLayout(session);
    await closeTechnicalDialog(session);

    const id = `${scenario.key}-${scenario.layout.width}-${scenario.layout.text}-${scenario.layout.theme}`;
    await screenshot(page, info, "conflict-" + id);
    await audit(page, info, "conflict-" + id);
    await record(page, info, { feature: "conflict-record-layout", scenario: scenario.key, layout: scenario.layout, measured, technical });
    expect(errors).toEqual([]);
  });
}
