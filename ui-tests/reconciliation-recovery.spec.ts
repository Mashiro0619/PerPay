import { test, expect, login, record } from "./fixtures";
test("unknown record links have global and site recovery without losing source filters", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const siteBase = manifest.routes.find(route => /^\/sites\/[^/]+\/work-items$/.test(route))!.replace(/\/work-items$/, "");
  for (const [path, fallback] of [["/reconciliation/unknown/record", "/reconciliation"], [siteBase + "/reconciliation/unknown/record", siteBase + "/work-items"]]) {
    await page.goto(manifest.origin + "/admin" + path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("未找到这条对账记录");
    await expect(page.locator('#main-content a[href$="' + fallback + '"]')).toBeVisible();
    await record(page, info);
  }
});
