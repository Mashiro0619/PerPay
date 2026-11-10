import { test, expect } from "@playwright/test";
import type { RuntimeSettings } from "../web/src/api/generated/types.gen";
import { createSettingsServer } from "./settings-server";
import { expectTouchTarget } from "./touch-targets";

for (const layout of [
  { width: 1440, height: 900, font: 100, theme: "dark" },
  { width: 1440, height: 900, font: 125, theme: "dark" },
  { width: 390, height: 844, font: 100, theme: "light" },
  { width: 320, height: 560, font: 200, theme: "light" },
  { width: 640, height: 280, font: 150, theme: "dark" },
] as const) {
  test.describe(`${layout.width}px ${layout.font}% display editing`, () => {
    test.use({ hasTouch: layout.width < 768, isMobile: layout.width < 768 });
    test("edits the summary chart default with aligned fields, explicit saving and retained browser preferences", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
        await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        await page.addInitScript(({ theme, font }) => {
          localStorage.setItem("perpay:theme", theme);
          const applyFont = () => { document.documentElement.style.fontSize = font + "%"; };
          if (document.documentElement) applyFont();
          else document.addEventListener("DOMContentLoaded", applyFont, { once: true });
        }, layout);
        await page.goto(fixture.origin + "/admin/settings/display");
        await expect(page.locator("html")).toHaveCSS("font-size", (16 * layout.font / 100) + "px");
        const read = async () => (await (await page.request.get(fixture.origin + "/api/admin/v1/settings")).json()).data as RuntimeSettings;
        const initial = await read();
        expect(initial.site_mode).toBe(true);
        const summary = page.locator("[data-settings-summary]");
        const defaultRow = summary.locator("dl > div").filter({ has: page.getByText("收款趋势默认图形", { exact: true }) });
        await expect(defaultRow.locator("dd")).toHaveText("面积图");
        await page.evaluate(() => localStorage.setItem("perpay:dashboard-chart-type", "LINE"));
        const writes: Array<{ path: string; body: unknown }> = [];
        page.on("request", request => {
          if (!["GET", "HEAD"].includes(request.method())) writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        });
        await summary.getByRole("link", { name: "编辑界面显示", exact: true }).click();
        const dialog = page.locator("[data-overlay-content]");
        const chart = dialog.getByRole("group", { name: "收款趋势默认图形", exact: true });
        const name = dialog.getByRole("textbox", { name: "支付系统名称", exact: true });
        await expect(name).toBeVisible();
        await expect(chart.getByRole("button", { name: "面积图", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(dialog.getByRole("textbox", { name: "商家帮助链接", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("switch", { name: "收银台显示商品名称", exact: true })).toHaveCount(0);
        const fields = await name.evaluate(element => {
          const input = element.getBoundingClientRect();
          const row = element.closest('[data-slot="field"]')!.getBoundingClientRect();
          const chart = element.closest("form")!.querySelector("[data-settings-chart-default]")!.getBoundingClientRect();
          return { input: { left: input.left, right: input.right }, row: { left: row.left, right: row.right }, chart: { left: chart.left, right: chart.right } };
        });
        expect(Math.abs(fields.input.left - fields.row.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(fields.input.right - fields.row.right)).toBeLessThanOrEqual(1);
        expect(Math.abs(fields.input.left - fields.chart.left)).toBeLessThanOrEqual(1);
        if (layout.width < 768) {
          expect(fields.chart.right).toBeLessThanOrEqual(fields.input.right + 1);
        } else {
          expect(Math.abs(fields.input.right - fields.chart.right)).toBeLessThanOrEqual(1);
        }
        const controls = [];
        for (const label of ["面积图", "柱状图", "折线图"]) {
          const option = chart.getByRole("button", { name: label, exact: true });
          await option.scrollIntoViewIfNeeded();
          const complete = await option.evaluate(element => {
            const box = element.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
          });
          expect(complete).toBe(true);
          controls.push({ label, ...(layout.width < 768 ? await expectTouchTarget(option) : {}) });
        }
        await chart.getByRole("button", { name: "面积图", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        await expect(chart.getByRole("button", { name: "柱状图", exact: true })).toBeFocused();
        await page.keyboard.press("Space");
        await expect(chart.getByRole("button", { name: "柱状图", exact: true })).toHaveAttribute("aria-pressed", "true");
        expect(writes).toEqual([]);
        expect((await read()).display.dashboard_chart_type).toBe("AREA");
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
        await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
        await expect(chart.getByRole("button", { name: "柱状图", exact: true })).toHaveAttribute("aria-pressed", "true");
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await guard.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(defaultRow.locator("dd")).toHaveText("面积图");
        expect(writes).toEqual([]);

        await summary.getByRole("link", { name: "编辑界面显示", exact: true }).click();
        await expect(chart.getByRole("button", { name: "面积图", exact: true })).toHaveAttribute("aria-pressed", "true");
        await chart.getByRole("button", { name: "柱状图", exact: true }).click();
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/settings/display" && response.request().method() === "PUT");
        await dialog.getByRole("button", { name: "保存", exact: true }).click();
        expect((await response).status()).toBe(200);
        await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeEnabled();
        await expect(page.locator('[data-slot="toast-title"]')).toHaveText("已保存");
        const close = dialog.getByRole("button", { name: "关闭", exact: true });
        const closeHit = await close.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        });
        expect(closeHit, "save feedback leaves the footer immediately clickable").toBe(true);
        await close.click({ timeout: 1000 });
        await expect(dialog).toHaveCount(0);
        await expect(defaultRow.locator("dd")).toHaveText("柱状图");
        expect((await read()).display.dashboard_chart_type).toBe("BAR");
        expect(writes).toEqual([{ path: "/api/admin/v1/settings/display", body: { revision: initial.revision,
          system_name: initial.display.system_name, dashboard_chart_type: "BAR" } }]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("display-summary.png") });
        await summary.getByRole("link", { name: "编辑界面显示", exact: true }).click();
        await expect(chart.getByRole("button", { name: "柱状图", exact: true })).toHaveAttribute("aria-pressed", "true");
        await name.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("display-editor.png") });
        await info.attach("display-settings-layout", { body: JSON.stringify({ layout, fields, controls, writes }), contentType: "application/json" });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();

        if (layout.width === 1440 && layout.font === 100) {
          fixture.seedPaidOrder();
          await page.goto(fixture.origin + "/admin/");
          await expect(page.locator(".trend-plot[data-chart-type]")).toHaveAttribute("data-chart-type", "LINE");
          await page.evaluate(() => localStorage.removeItem("perpay:dashboard-chart-type"));
          await page.reload();
          await expect(page.locator(".trend-plot[data-chart-type]")).toHaveAttribute("data-chart-type", "BAR");
        }
      } finally { await fixture.close(); }
    });
  });
}
