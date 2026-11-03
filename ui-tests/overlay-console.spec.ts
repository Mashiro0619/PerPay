import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectOverlayFits, openRecord } from "./overlay-fixtures";
import { revealDetailSection } from "./detail-layout";

for (const width of [320, 390, 768, 1280, 1440, 1680]) {
  test(`${width}: compact workspaces and record overlays in both themes`, async ({ page, manifest }, info) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, manifest);
    const order = manifest.details.orderPaid ?? manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route))!;
    const notification = manifest.routes.find(route => /^\/notifications\/[^/]+$/.test(route))!;
    const ledger = manifest.routes.find(route => /^\/(ledger|reconciliation\/transactions)\/[^/]+$/.test(route))!;
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
      for (const path of ["/audit", "/orders", "/notifications", "/work-items", "/reconciliation", "/sites", "/settings/accounts"]) {
        await page.goto(manifest.origin + "/admin" + path);
        await expect(page.locator("#main-content")).toBeVisible();
        await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
        await record(page, info, { feature: "compact-workspace-matrix", path, width, theme });
        if (path === "/audit") {
          await expect(page.getByRole("tab", { name: "操作审计", exact: true })).toHaveAttribute("aria-selected", "true");
          if (width === 1440) {
            const rows = await page.locator('[data-business-table="audit"] [data-business-row]').evaluateAll(items => items.filter(item => item.getBoundingClientRect().top >= 0 && item.getBoundingClientRect().bottom <= innerHeight).length);
            expect(rows).toBeGreaterThanOrEqual(10);
            const table = page.getByRole("table", { name: "审计日志列表" });
            expect(await table.getByRole("columnheader").allTextContents()).toEqual(["时间", "事件", "执行者", "网站", "IP", "客户端", "结果", "详情"]);
            expect(await table.evaluate(node => node.scrollWidth <= node.parentElement!.clientWidth + 1)).toBe(true);
          }
          await screenshot(page, info, `audit-${width}-${theme}`);
          await page.locator('[data-business-table="audit"] [data-row-link]').first().click();
          await expectOverlayFits(page);
          await expect(page.getByRole("dialog")).toHaveCount(1);
          await screenshot(page, info, `audit-detail-${width}-${theme}`);
          if (width === 320 || width === 1440) await audit(page, info, `audit-detail-${width}-${theme}`);
        }
      }
      for (const path of [order, notification, ledger]) {
        const dialog = await openRecord(page, manifest, path);
        await expect(dialog.getByRole("tablist")).toHaveCount(0);
        await expect(dialog.getByRole("tabpanel")).toHaveCount(0);
        const sections = await dialog.locator("[data-detail-section]").evaluateAll(items => items.map(item => item.getAttribute("data-detail-section")!));
        expect(sections.length).toBeGreaterThan(0);
        await expectOverlayFits(page);
        await record(page, info, { feature: "record-overlay-matrix", path, width, theme });
        for (const section of sections) {
          await revealDetailSection(page, section);
          await expectOverlayFits(page);
        }
        if (width === 390 && theme === "dark") await screenshot(page, info, "record-" + path.split("/")[1]);
      }
    }
    expect(errors).toEqual([]);
  });
}

test("200% text and a reduced visual viewport keep the focused form and footer reachable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/settings/display/edit");
  const field = page.getByLabel("支付系统名称", { exact: true });
  await expect(field).toBeVisible();
  await field.fill("软键盘下保留的设置草稿");
  await field.focus();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await expectOverlayFits(page);
  await expect(field).toHaveValue("软键盘下保留的设置草稿");
  await page.evaluate(() => {
    const visible = window.visualViewport!;
    Object.defineProperties(visible, { height: { configurable: true, get: () => 420 }, offsetTop: { configurable: true, get: () => 32 } });
    visible.dispatchEvent(new Event("resize"));
  });
  await page.clock.runFor(100);
  const keyboard = await expectOverlayFits(page);
  await expect(page.getByRole("dialog").getByRole("button", { name: "保存", exact: true })).toBeVisible();
  await expect(field).toHaveValue("软键盘下保留的设置草稿");
  await record(page, info, { feature: "simulated-soft-keyboard-and-text-zoom", geometry: keyboard, simulation: true });
  await screenshot(page, info, "keyboard-390-200pct");
});
