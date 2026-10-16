import { test, expect, login, record } from "./fixtures";
test("density changes preserve search drafts and geometry across the four primary lists", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const route of ["/orders", "/notifications", "/work-items", "/reconciliation"]) {
    await page.goto(manifest.origin + "/admin" + route);
    const table = page.locator("[data-business-table]").first();
    await expect(table).toBeVisible();
    const search = page.getByRole("searchbox").first();
    await search.fill("未提交搜索");
    const url = page.url();
    const choose = async (name: string) => { await page.getByRole("button", { name: "列表密度", exact: true }).click(); await page.getByRole("menuitemradio", { name, exact: true }).click(); };
    await choose("紧凑");
    const first = table.locator("tbody tr").first();
    const compact = (await first.boundingBox())!.height;
    await choose("舒适");
    await expect(table).toHaveAttribute("data-density", "comfortable");
    const comfortable = (await first.boundingBox())!.height;
    expect(compact).toBeGreaterThan(0);
    expect(comfortable - compact).toBeGreaterThanOrEqual(7);
    await expect(search).toHaveValue("未提交搜索");
    expect(page.url()).toBe(url);
    await expect(page.getByRole("button", { name: "列表密度", exact: true })).toBeFocused();
    await record(page, info, { route, compact, comfortable });
  }
  const other = await page.context().newPage();
  await other.goto(manifest.origin + "/admin/orders");
  await other.evaluate(() => localStorage.setItem("perpay:list-density", "compact"));
  await expect(page.locator("[data-business-table]").first()).toHaveAttribute("data-density", "compact");
  await other.close();
});
