import type { AuditEventPage } from "../src/shared/audit";
import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import { settleOverlay } from "./overlay-fixtures";
import { detailSection, expectDetailRecordLayout, expectTechnicalPlacement, revealDetailSection } from "./detail-layout";

// Cover each responsive transition and both themes without multiplying every
// viewport by every font size, content-width mode and record state.
const layouts = [
  { width: 1440, height: 900, text: 100, theme: "light", mode: "compact" },
  { width: 1440, height: 900, text: 100, theme: "dark", mode: "full" },
  { width: 768, height: 900, text: 100, theme: "light", mode: "compact" },
  { width: 390, height: 844, text: 100, theme: "dark", mode: "compact" },
  { width: 320, height: 560, text: 100, theme: "light", mode: "compact" },
  { width: 1440, height: 480, text: 200, theme: "dark", mode: "compact" },
  { width: 768, height: 480, text: 200, theme: "dark", mode: "compact" },
  { width: 320, height: 560, text: 200, theme: "light", mode: "compact" },
] as const;

for (const layout of layouts) {
  test(`${layout.width}x${layout.height}, ${layout.text}% ${layout.theme}: four record details share readable fields and inline technical evidence`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
    await page.addInitScript(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, layout);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
    await login(page, manifest);
    const auditResponse = await page.request.get(manifest.origin + "/api/admin/v1/audit-events?source=core&limit=1");
    expect(auditResponse.status()).toBe(200);
    const savedAudit = (await auditResponse.json() as AuditEventPage).data[0];
    expect(savedAudit, "a saved local audit event supplies the real detail identity").toBeTruthy();
    const scenarios = [
      { name: "order", path: manifest.details.orderLong!, copy: "复制内部订单编号", technicalSelector: '[data-detail-section="history"] > .detail-section-content > [data-technical-information]', sections: ["overview", "payments", "notifications", "history"] },
      { name: "notification", path: manifest.details.notificationDns!, copy: "复制投递编号", technicalSelector: '[data-notification-information] > [data-slot="card-content"] > [data-technical-information]', sections: ["overview", "attempts"] },
      { name: "exception", path: manifest.details.exceptionOpen!, copy: "复制异常编号", technicalSelector: '[data-financial-exception] > [data-slot="card-content"] > [data-technical-information]', sections: [] },
      { name: "audit", path: `/audit/${savedAudit!.source}/${savedAudit!.event_id}`, copy: "复制日志编号", technicalSelector: '[data-detail-page] > [data-technical-information]', sections: [] },
    ];
    const writes: string[] = [], errors: string[] = [];
    page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    for (const scenario of scenarios) {
      await test.step(scenario.name, async () => {
        await page.goto(manifest.origin + "/admin" + scenario.path);
        const overlay = await settleOverlay(page);
        await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", layout.text);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(100);
        await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", layout.mode);
        const overview = await expectDetailRecordLayout(page);
        await expect(overlay.getByRole("tab")).toHaveCount(0);
        expect(await overlay.locator("[data-detail-section]").evaluateAll(sections => sections.map(section => section.getAttribute("data-detail-section")))).toEqual(scenario.sections);
        if (layout.width < 768) expect(overview.fields.every(group => group.columns === 1)).toBe(true);
        if (layout.width === 1440 && layout.text === 100) {
          expect(overview.fields.some(group => group.columns === 2 && group.fields.filter(field => !field.wide).length >= 2), "desktop space presents short facts in two real columns").toBe(true);
        }
        if (scenario.name === "notification") {
          await expect(detailSection(page, "overview").getByRole("heading", { level: 2 })).toHaveText(["通知信息", "关联订单"]);
        }
        const id = `${scenario.name}-${layout.width}-${layout.text}-${layout.theme}`;
        if (layout.width !== 320 || layout.text === 200) await screenshot(page, info, "detail-grid-" + id);
        if (scenario.name === "order") await revealDetailSection(page, "history");
        const technical = overlay.locator('[data-overlay-detail]').locator(scenario.technicalSelector);
        await expect(technical).toBeVisible();
        const placement = await expectTechnicalPlacement(technical);
        const trigger = technical.getByRole("button", { name: "技术信息", exact: true });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(technical.getByLabel("技术信息", { exact: true })).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        const expanded = await expectDetailRecordLayout(page);
        await page.keyboard.press("Tab");
        await expect(technical.getByRole("button", { name: /^复制/ }).first()).toBeFocused();
        await technical.getByRole("button", { name: scenario.copy, exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(scenario.path.split("/").at(-1));
        await record(page, info, { feature: "shared-detail-record-layout", scenario: scenario.name, layout,
          evidence: "named local domain records and saved local audit event; browser font and viewport simulation", overview, expanded, placement });
        if (layout.text === 200 || layout.width === 1440) await screenshot(page, info, "detail-grid-technical-" + id);
        if (layout.width === 320 && layout.text === 200) await audit(page, info, "detail-grid-" + id);
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(trigger).toBeFocused();
        await expect(technical.getByLabel("技术信息", { exact: true })).toHaveCount(0);
      });
    }
    expect(writes, "reading, resizing and copying never submit a business action").toEqual([]);
    expect(errors).toEqual([]);
  });
}
