import { test, expect, login, record } from "./fixtures";
test("density changes preserve search drafts and geometry across the five business lists", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const route of ["/orders", "/notifications", "/work-items", "/reconciliation", "/ledger"]) {
    await page.goto(manifest.origin + "/admin" + route);
    const table = page.locator("[data-business-table]").first();
    await expect(table).toBeVisible();
    const search = page.getByRole("searchbox").first();
    await search.fill("未提交搜索");
    const url = page.url();
    const trigger = page.getByRole("button", { name: "列表密度", exact: true });
    const menu = page.getByRole("menu", { name: "列表密度", exact: true, includeHidden: true });
    const choose = async (name: string, density: "compact" | "comfortable") => {
      // Base UI keeps the exiting popup mounted. Finish one menu lifecycle
      // before opening another so a click cannot hit its old positioning.
      await expect(menu).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute("data-open", "");
      await menu.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
      });
      await expect(menu).toBeInViewport({ ratio: 1 });
      await menu.getByRole("menuitemradio", { name, exact: true }).click();
      await expect(table).toHaveAttribute("data-density", density);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    };
    await choose("紧凑", "compact");
    const first = table.locator("tbody tr").first();
    const compact = (await first.boundingBox())!.height;
    await choose("舒适", "comfortable");
    await expect(table).toHaveAttribute("data-density", "comfortable");
    const comfortable = (await first.boundingBox())!.height;
    expect(compact).toBeGreaterThan(0);
    expect(comfortable - compact).toBeGreaterThanOrEqual(7);
    await expect(search).toHaveValue("未提交搜索");
    expect(page.url()).toBe(url);
    await expect(page.getByRole("button", { name: "列表密度", exact: true })).toBeFocused();
    await record(page, info, { route, compact, comfortable });
    if (route === "/orders") {
      await trigger.evaluate(element => element.blur());
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      const path = info.outputPath("list-icon-toolbar.png");
      await page.locator("[data-list-query-toolbar]").screenshot({ path, animations: "disabled" });
      await info.attach("list-icon-toolbar", { path, contentType: "image/png" });
    }
  }
  const other = await page.context().newPage();
  await other.goto(manifest.origin + "/admin/orders");
  await other.evaluate(() => localStorage.setItem("perpay:list-density", "compact"));
  await expect(page.locator("[data-business-table]").first()).toHaveAttribute("data-density", "compact");
  await other.close();
  await page.goto(manifest.origin + "/admin/orders?q=UI");
  const search = page.getByRole("searchbox").first();
  await expect(search).toHaveValue("UI");
  const clearToolbarPath = info.outputPath("list-icon-toolbar-applied-search.png");
  await page.locator("[data-list-query-toolbar]").screenshot({ path: clearToolbarPath, animations: "disabled" });
  await info.attach("list-icon-toolbar-applied-search", { path: clearToolbarPath, contentType: "image/png" });
  await page.getByRole("button", { name: "清除搜索", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await page.keyboard.type("继续搜索");
  await expect(search).toHaveValue("继续搜索");
});
