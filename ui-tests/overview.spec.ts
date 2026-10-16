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
      const workPanel = document.querySelector(".overview-work-panel")!;
      const panelBounds = workPanel.getBoundingClientRect();
      const headerBounds = workPanel.querySelector('[data-slot="card-header"]')!.getBoundingClientRect();
      const contentBounds = workPanel.querySelector('[data-slot="card-content"]')!.getBoundingClientRect();
      const titleBounds = workPanel.querySelector('[data-slot="card-title"]')!.getBoundingClientRect();
      const actionBounds = workPanel.querySelector('[data-slot="card-action"]')!.getBoundingClientRect();
      return { main: main.getBoundingClientRect().width, recordColumns: getComputedStyle(records).gridTemplateColumns.split(" ").map(parseFloat),
        siteWidth: siteContainer.getBoundingClientRect().width, siteColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        gap: getComputedStyle(document.querySelector("[data-overview-kpis]")!).gap,
        fields: [...document.querySelectorAll(".overview-work-fields dd")].map(e => ({ text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })),
        work: { headerGap: contentBounds.top - headerBounds.bottom,
          headerAlignment: Math.abs(titleBounds.top + titleBounds.height / 2 - actionBounds.top - actionBounds.height / 2),
          titleInset: titleBounds.left - panelBounds.left,
          rows: [...workPanel.querySelectorAll(".overview-work-item")].map(row => {
            const bounds = row.getBoundingClientRect();
            const body = row.querySelector(".overview-work-content")!.getBoundingClientRect();
            return { inset: body.left - panelBounds.left, hoverInset: body.left - bounds.left,
              inlineFields: [...row.querySelectorAll(".overview-work-fields > div")].every(field =>
                Math.abs(field.querySelector("dt")!.getBoundingClientRect().top - field.querySelector("dd")!.getBoundingClientRect().top) < 1) };
          }),
          separators: [...workPanel.querySelectorAll('[data-slot="item-separator"]')].map(separator => {
            const bounds = separator.getBoundingClientRect();
            return { leftInset: bounds.left - panelBounds.left, rightInset: panelBounds.right - bounds.right };
          }),
        } };
    });
    expect(geometry.gap).toBe("16px");
    expect(geometry.fields.every(field => !field.clipped)).toBe(true);
    expect(geometry.work.headerGap).toBe(8);
    expect(geometry.work.headerAlignment).toBeLessThan(1);
    expect(geometry.work.titleInset).toBe(16);
    expect(geometry.work.rows.every(row => row.inset === 16 && row.hoverInset === 12 && row.inlineFields)).toBe(true);
    expect(geometry.work.separators).toHaveLength(geometry.work.rows.length - 1);
    expect(geometry.work.separators.every(separator => separator.leftInset === 16 && separator.rightInset === 16)).toBe(true);
    expect(geometry.recordColumns).toHaveLength(geometry.main >= 1088 ? 2 : 1);
    if (geometry.main >= 1088) { expect(geometry.recordColumns[0]).toBeGreaterThanOrEqual(352); expect(geometry.recordColumns[0]).toBeLessThanOrEqual(448); }
    expect(geometry.siteColumns).toBe(geometry.siteWidth >= 1216 ? 4 : geometry.siteWidth >= 992 ? 3 : geometry.siteWidth >= 656 ? 2 : 1);
    await record(page, info, geometry);
    await info.attach(`overview-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("button", { name: "切换为全屏布局", exact: true }).click();
  expect(await page.locator(".site-overview-grid").evaluate(e => getComputedStyle(e).gridTemplateColumns.split(" ").length)).toBe(4);
});

test("overview container breakpoints switch at 68rem and 76rem in both width preferences", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const mode of ["compact", "full"]) for (const target of [1087, 1088, 1089, 1215, 1216, 1217]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(mode => localStorage.setItem("perpay:content-width", mode), mode);
    await page.goto(manifest.origin + "/admin/");
    await expect(page.locator(".overview-records")).toBeVisible();
    const measured = await page.locator("[data-content-width]").evaluate(element => element.getBoundingClientRect().width);
    await page.setViewportSize({ width: 1280 + target - measured, height: 900 });
    await expect.poll(() => page.locator("[data-content-width]").evaluate(element => element.getBoundingClientRect().width)).toBe(target);
    const columns = await page.evaluate(() => ({
      records: getComputedStyle(document.querySelector(".overview-records")!).gridTemplateColumns.split(" ").length,
      sites: getComputedStyle(document.querySelector(".site-overview-grid")!).gridTemplateColumns.split(" ").length,
      siteWidth: document.querySelector(".site-overview-section")!.getBoundingClientRect().width,
    }));
    expect(columns.records).toBe(target >= 1088 ? 2 : 1);
    expect(columns.siteWidth).toBe(target);
    expect(columns.sites).toBe(target >= 1216 ? 4 : 3);
    await record(page, info, { requested: { containerWidth: target, mode }, columns });
  }
});
