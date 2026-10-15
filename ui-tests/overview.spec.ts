import { test, expect, login, record } from "./fixtures";
test("overview grids use container widths and preserve complete identifiers and time groups", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const width of [320, 390, 1024, 1366, 1920, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/");
    await expect(page.locator(".overview-work-fields").first()).toBeVisible();
    const geometry = await page.evaluate(() => {
      const main = document.querySelector("[data-content-width]")!;
      const records = document.querySelector(".overview-records")!;
      const siteContainer = document.querySelector(".site-overview-section")!;
      const grid = siteContainer.querySelector(".site-overview-grid")!;
      return { main: main.getBoundingClientRect().width, recordColumns: getComputedStyle(records).gridTemplateColumns.split(" ").map(parseFloat),
        siteWidth: siteContainer.getBoundingClientRect().width, siteColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        gap: getComputedStyle(document.querySelector("[data-overview-kpis]")!).gap,
        fields: [...document.querySelectorAll(".overview-work-fields dd")].map(e => ({ text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })) };
    });
    expect(geometry.gap).toBe("16px");
    expect(geometry.fields.every(field => !field.clipped)).toBe(true);
    expect(geometry.recordColumns).toHaveLength(geometry.main >= 1088 ? 2 : 1);
    if (geometry.main >= 1088) { expect(geometry.recordColumns[0]).toBeGreaterThanOrEqual(352); expect(geometry.recordColumns[0]).toBeLessThanOrEqual(448); }
    expect(geometry.siteColumns).toBe(geometry.siteWidth >= 1216 ? 4 : geometry.siteWidth >= 992 ? 3 : geometry.siteWidth >= 656 ? 2 : 1);
    await record(page, info, geometry);
    await info.attach(`overview-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("button", { name: "切换为全屏布局", exact: true }).click();
  expect(await page.locator(".site-overview-grid").evaluate(e => getComputedStyle(e).gridTemplateColumns.split(" ").length)).toBe(4);
});
