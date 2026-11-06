import { test, expect, login, record } from "./fixtures";
test("unknown record links have global and site recovery without losing source filters", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const siteBase = manifest.routes.find(route => /^\/sites\/[^/]+\/work-items$/.test(route))!.replace(/\/work-items$/, "");
  for (const [path, fallback] of [["/reconciliation/unknown/record", "/reconciliation"], [siteBase + "/reconciliation/unknown/record", siteBase + "/work-items"]] as const) {
    await page.goto(manifest.origin + "/admin" + path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("未找到这条对账记录");
    const back = page.locator('#main-content a[href$="' + fallback + '"]');
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(manifest.origin + "/admin" + fallback);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fallback.endsWith("work-items") ? "本站待处理" : "对账");
    await record(page, info);
  }
});
