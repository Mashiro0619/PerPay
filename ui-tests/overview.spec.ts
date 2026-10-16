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
              contained: body.right <= bounds.right && bounds.right <= panelBounds.right,
              inlineFields: [...row.querySelectorAll(".overview-work-fields > div")].every(field =>
                Math.abs(field.querySelector("dt")!.getBoundingClientRect().top - field.querySelector("dd")!.getBoundingClientRect().top) < 1) };
          }),
        } };
    });
    expect(geometry.gap).toBe("16px");
    expect(geometry.fields.every(field => !field.clipped)).toBe(true);
    expect(geometry.work.headerGap).toBe(8);
    expect(geometry.work.headerAlignment).toBeLessThan(1);
    expect(geometry.work.titleInset).toBe(16);
    expect(geometry.work.rows.every(row => row.inset >= 16 && row.hoverInset >= 8 && row.contained && row.inlineFields)).toBe(true);
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

test("recent orders keep compact summaries and header geometry across themes and workspaces", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const sitePath = manifest.routes.find(path => /^\/sites\/[^/]+$/.test(path) && !["/sites/new", "/sites/defaults"].includes(path))!;
  const panel = page.getByRole("region", { name: "最近订单", exact: true });
  for (const width of [320, 390, 560]) for (const theme of ["light", "dark"]) for (const mode of ["compact", "full"]) for (const scoped of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, { theme, mode });
    await page.goto(manifest.origin + "/admin" + (scoped ? sitePath : "/"));
    await expect(panel.locator(".overview-order-summary")).toHaveCount(5);
    await expect(panel.locator('[data-slot="card-description"]')).toBeHidden();
    const geometry = await panel.evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      const header = panel.querySelector('[data-slot="card-header"]')!.getBoundingClientRect();
      const content = panel.querySelector('[data-slot="card-content"]')!.getBoundingClientRect();
      const title = panel.querySelector('[data-slot="card-title"]')!.getBoundingClientRect();
      const action = panel.querySelector('[data-slot="card-action"]')!.getBoundingClientRect();
      return { width: bounds.width, headerGap: content.top - header.bottom,
        headerAlignment: Math.abs(title.top + title.height / 2 - action.top - action.height / 2),
        titleInset: title.left - bounds.left,
        rows: [...panel.querySelectorAll('[data-business-row]')].map(row => {
          const body = row.querySelector('.overview-order-summary')!.getBoundingClientRect();
          const product = row.querySelector('a[data-row-link]')!.closest('[data-slot="item-title"]')!.getBoundingClientRect();
          const amount = row.querySelector('.overview-order-summary-amount')!.getBoundingClientRect();
          return { inset: body.left - bounds.left, hoverInset: body.left - row.getBoundingClientRect().left,
            amountInset: amount.left - body.left, amountAfterProduct: amount.top >= product.bottom - 1,
            productContained: product.left >= body.left && product.right <= body.right,
            fieldsClipped: [...row.querySelectorAll('.list-code, .list-money, time')].some(element => element.scrollWidth > element.clientWidth + 1),
            payment: row.querySelector('[role="group"][aria-label="收款状态"]')?.textContent,
            notification: row.querySelector('[role="group"][aria-label="通知状态"]')?.textContent };
        }),
      };
    });
    await record(page, info, { width, theme, mode, scoped, recentOrders: geometry });
    expect(geometry.headerGap).toBe(8);
    expect(geometry.headerAlignment).toBeLessThan(1);
    expect(geometry.titleInset).toBe(16);
    expect(geometry.rows.every(row => row.inset >= 12 && row.hoverInset >= 8 && !row.fieldsClipped && row.payment && row.notification), JSON.stringify(geometry.rows)).toBe(true);
    expect(geometry.rows.every(row => row.amountInset === 0 && row.amountAfterProduct && row.productContained), JSON.stringify(geometry.rows)).toBe(true);
    expect(await panel.locator(".list-site-identity").count()).toBe(scoped ? 0 : 5);
  }
});

test("recent order headers and tables switch at the same measured container boundaries", async ({ page, manifest }, info) => {
  await login(page, manifest);
  await page.evaluate(() => localStorage.setItem("perpay:content-width", "full"));
  const panel = page.getByRole("region", { name: "最近订单", exact: true });
  const list = panel.locator('[data-business-table="overview-recent-orders"]');
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto(manifest.origin + "/admin/");
  await expect(list.locator('[data-business-row]')).toHaveCount(5);
  for (const target of [639, 640, 767, 768, 639, 640]) {
    // Constrain the real card container: resizing the viewport can also switch
    // the surrounding overview between one and two columns.
    await page.locator(".overview-orders-container").evaluate((element, target) => {
      (element as HTMLElement).style.width = `${target + 24}px`;
    }, target);
    await expect.poll(() => list.evaluate(element => element.getBoundingClientRect().width)).toBe(target);
    await expect(list).toHaveAttribute("data-list-layout", target < 640 ? "summary" : "table");
    if (target < 640) {
      await expect(panel.locator('[data-slot="card-description"]')).toBeHidden();
      await expect(panel.getByRole("list", { name: "最近订单", exact: true })).toBeVisible();
    } else {
      await expect(panel.locator('[data-slot="card-description"]')).toBeVisible();
      await expect(panel.getByRole("columnheader")).toHaveCount(target < 768 ? 4 : 5);
    }
    await expect(panel.locator('[data-business-row]').first().locator("time")).toHaveCount(2);
    await record(page, info, { recentOrdersContainer: target });
  }
});
