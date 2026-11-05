// SPDX-License-Identifier: MIT
import { test, expect, type Locator } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

/** Check glyph bounds and hit testing, rather than treating DOM presence as readability. */
async function expectPaintedIdentity(locator: Locator, appId: string) {
  await locator.scrollIntoViewIfNeeded();
  const measured = await locator.evaluate((element, required) => {
    const bounds = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines = new Set<number>();
    let painted = 0;
    const failures: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, value = node.textContent ?? "";
      for (let index = 0; index < value.length; index++) {
        if (/\s/.test(value[index]!)) continue;
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
        const glyph = range.getBoundingClientRect();
        const hit = document.elementFromPoint(glyph.left + glyph.width / 2, glyph.top + glyph.height / 2);
        let visible = glyph.width > 0 && glyph.height > 0 && glyph.left >= 0 && glyph.right <= innerWidth + 1 &&
          glyph.top >= 0 && glyph.bottom <= innerHeight + 1 && glyph.left >= bounds.left - 1 && glyph.right <= bounds.right + 1 &&
          glyph.top >= bounds.top - 1 && glyph.bottom <= bounds.bottom + 1 && hit !== null && element.contains(hit);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
          if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) visible = false;
          if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (glyph.left < box.left - 1 || glyph.right > box.right + 1)) visible = false;
          if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (glyph.top < box.top - 1 || glyph.bottom > box.bottom + 1)) visible = false;
        }
        if (!visible) failures.push(value[index]!); else painted++;
        lines.add(Math.round(glyph.top));
      }
    }
    return { text: element.textContent, requiredPresent: element.textContent?.includes(required), painted, lines: lines.size, failures };
  }, appId);
  expect(measured.requiredPresent).toBe(true);
  expect(measured.painted).toBeGreaterThanOrEqual(appId.length);
  expect(measured.failures).toEqual([]);
  expect(measured.lines).toBeGreaterThan(1);
  return measured;
}

for (const width of [390, 320]) {
  test.describe(`${width}px same-name collection account choices`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light", reducedMotion: "reduce" });
    test("renders both full application identities and retains the selected identity without submitting synthetic accounts", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      const appIds = ["2026110500000101", "2026110500000202"], name = "重复名称的支付宝收款账号";
      const writes: string[] = [];
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.route("**/api/admin/v1/alipay-accounts", async route => {
          if (route.request().method() !== "GET") return route.abort("blockedbyclient");
          const response = await route.fetch();
          const body = await response.json();
          expect(response.ok()).toBe(true);
          const template = body.data[0];
          await route.fulfill({ response, json: { ...body, data: appIds.map((appId, index) => ({ ...template,
            id: `alipay_00000000-0000-4000-8000-00000000000${index + 1}`, name, app_id: appId, configured: true, enabled: true, environment: "PRODUCTION" })) } });
        });
        page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
        await page.context().addCookies(fixture.cookies);
        await page.goto(fixture.origin + "/admin/sites");
        await page.getByRole("link", { name: "创建业务网站", exact: true }).click();
        const overlay = page.locator("[data-overlay-content]"), selector = overlay.getByRole("combobox", { name: "支付宝账号", exact: true });
        await selector.click();
        const measurements = [];
        for (const appId of appIds) measurements.push(await expectPaintedIdentity(page.getByRole("option", { name: `${name} · App ID ${appId}`, exact: true }), appId));
        await page.screenshot({ path: info.outputPath("same-name-fixed-options.png") });
        await page.getByRole("option", { name: `${name} · App ID ${appIds[1]}`, exact: true }).click();
        measurements.push(await expectPaintedIdentity(selector.locator('[data-slot="select-value"]'), appIds[1]!));
        await page.screenshot({ path: info.outputPath("same-name-fixed-selected.png") });
        await overlay.getByRole("button", { name: "随机", exact: true }).click();
        for (const appId of appIds) {
          const checkbox = overlay.getByRole("checkbox", { name: `${name} · App ID ${appId}`, exact: true });
          await expect(checkbox).toBeVisible();
          measurements.push(await expectPaintedIdentity(overlay.getByText(`${name} · App ID ${appId}`, { exact: true }), appId));
        }
        await page.screenshot({ path: info.outputPath("same-name-random-options.png") });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(writes).toEqual([]);
        await info.attach("painted-account-identities", { body: Buffer.from(JSON.stringify({ width, mockedReadOnlyAccountCatalog: true, writes, measurements }, null, 2)), contentType: "application/json" });
      } finally { await fixture.close(); }
    });
  });
}
