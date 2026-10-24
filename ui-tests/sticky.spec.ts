import { test, expect, login, record } from "./fixtures";
test("desktop keeps complete toolbars and mobile keeps its header, with one DOM and unobscured keyboard focus", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const route of ["/orders", "/notifications", "/work-items", "/reconciliation"]) {
    await page.goto(manifest.origin + "/admin" + route);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "显示列", exact: true })).toHaveCount(1);
    await page.evaluate(() => scrollTo(0, 600));
    const header = page.locator(".site-header"), toolbar = page.locator("[data-list-toolbar]");
    await expect.poll(async () => (await header.boundingBox())!.y).toBe(0);
    await expect.poll(async () => (await toolbar.boundingBox())!.y).toBe(48);
    await page.getByRole("searchbox").focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const bounds = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element?.closest("#main-content") || element.closest("[data-list-toolbar]")) return null;
        const rect = element.getBoundingClientRect();
        const toolbar = document.querySelector("[data-list-toolbar]")!.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top, covered: toolbar.bottom, height: innerHeight };
      });
      if (bounds) { expect(bounds.bottom).toBeGreaterThan(bounds.covered); expect(bounds.top).toBeLessThan(bounds.height); }
    }
    await page.keyboard.press("Shift+Tab");
    await page.getByRole("button", { name: "显示列", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await record(page, info, { mode: "desktop sticky header and complete toolbar", route, header: await header.boundingBox(), toolbar: await toolbar.boundingBox() });
  }
  const search = page.getByRole("searchbox");
  await search.fill("尚未提交的草稿");
  await search.focus();
  const original = await search.elementHandle();
  const measured = page.locator("[data-business-table]").first();
  const layout = await measured.getAttribute("data-list-layout");
  await measured.evaluate(element => { element.style.width = "0px"; });
  await expect.poll(async () => (await measured.boundingBox())!.width).toBe(0);
  await expect(measured).toHaveAttribute("data-list-layout", layout!);
  await measured.evaluate(element => { element.style.removeProperty("width"); });
  await expect.poll(async () => (await measured.boundingBox())!.width).toBeGreaterThan(0);
  expect(await original!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true);
  await expect(search).toHaveValue("尚未提交的草稿");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(manifest.origin + "/admin/orders");
  await expect(page.locator(".business-summary-row").first()).toBeVisible();
  await page.evaluate(() => scrollTo(0, 600));
  const mobileHeader = page.locator(".site-header"), mobileToolbar = page.locator("[data-list-toolbar]");
  await expect.poll(async () => (await mobileHeader.boundingBox())!.y).toBe(0);
  expect((await mobileToolbar.boundingBox())!.y).toBeLessThan(0);
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  const scrolled = { header: await mobileHeader.boundingBox(), toolbar: await mobileToolbar.boundingBox() };
  const mobileFocus = [];
  await page.getByRole("searchbox").focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const bounds = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element?.closest("#main-content") || element.closest("[data-list-toolbar]")) return null;
      const rect = element.getBoundingClientRect(), header = document.querySelector(".site-header")!.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 100),
        top: rect.top, bottom: rect.bottom, headerBottom: header.bottom, viewportHeight: innerHeight,
        hit: hit === element || hit !== null && element.contains(hit) };
    });
    if (bounds) {
      expect(bounds.top, "mobile keyboard focus stays below the fixed header").toBeGreaterThanOrEqual(bounds.headerBottom - 1);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
      expect(bounds.hit, "the focused control receives its centre hit").toBe(true);
      mobileFocus.push(bounds);
    }
  }
  expect(mobileFocus.length, "Tab reaches record controls outside the naturally scrolling toolbar").toBeGreaterThan(0);
  await record(page, info, { mode: "mobile pinned header and naturally scrolling toolbar", scrolled, mobileFocus });
});
