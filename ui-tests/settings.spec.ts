import { test, expect, login, record } from "./fixtures";
test("settings use guarded category selection on phones and scrolling tabs on desktop", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  for (const route of manifest.routes.filter(route => /^\/settings\/[^/]+$/.test(route))) {
    await page.goto(manifest.origin + "/admin" + route);
    const category = page.getByRole("combobox", { name: "设置分类" });
    await expect(category).toBeVisible();
    await expect(page.getByRole("tablist", { name: "设置分类" })).toHaveCount(0);
    await category.click();
    const selected = page.getByRole("option", { selected: true });
    await expect(selected).toBeVisible();
    const selectedText = await selected.textContent();
    await page.keyboard.press("Escape");
    await expect(category).toBeFocused();
    await record(page, info, { route, selected: selectedText });
  }
  await page.goto(manifest.origin + "/admin/settings/display");
  const name = page.getByRole("textbox", { name: "支付系统名称" });
  await name.fill("手机草稿保留");
  await page.getByRole("combobox", { name: "设置分类" }).click();
  await page.getByRole("option", { name: "查账设置" }).click();
  const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑" }).click();
  await expect(name).toHaveValue("手机草稿保留");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("tablist", { name: "设置分类" })).toBeVisible();
  await expect(name).toHaveValue("手机草稿保留");
  await page.reload();
  await page.goto(manifest.origin + "/admin/settings/provider");
  const list = page.getByRole("tablist", { name: "设置分类" });
  await expect(list).toBeVisible();
  const selected = list.locator('[aria-selected="true"]');
  await selected.focus();
  const before = page.url();
  await page.keyboard.press("ArrowRight");
  expect(page.url()).toBe(before);
  const next = page.getByRole("button", { name: "向后滚动设置分类" });
  const scroll = page.locator("[data-settings-tabs-scroll]");
  const overflows = await scroll.evaluate(element => element.scrollWidth > element.clientWidth + 1);
  if (overflows) {
    await expect(next).toBeVisible();
    await next.click();
    await expect.poll(() => scroll.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
  } else await expect(next).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(manifest.origin + "/admin/settings/display");
  const width = (await page.locator(".admin-settings-layout").boundingBox())!.width;
  expect(width).toBeLessThanOrEqual(896);
  await expect(page.getByRole("button", { name: "向后滚动设置分类" })).toBeHidden();
  await page.clock.runFor(250);
  const indicator = list.locator('[aria-selected="true"] [data-selection-indicator]');
  await expect(list.locator("[data-selection-indicator]")).toHaveCount(1);
  const underline = await indicator.evaluate(element => {
    const line = element.getBoundingClientRect();
    const tab = element.parentElement!.getBoundingClientRect();
    const viewport = element.closest("[data-settings-tabs-scroll]")!.getBoundingClientRect();
    return { line: line.toJSON(), tab: tab.toJSON(), viewport: viewport.toJSON() };
  });
  expect(Math.abs(underline.line.left - underline.tab.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(underline.line.width - underline.tab.width)).toBeLessThanOrEqual(2);
  expect(underline.line.bottom).toBeLessThanOrEqual(underline.viewport.bottom);
  const stableName = await name.elementHandle();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator).toHaveAttribute("data-selection-mode", "static");
  expect(await stableName!.evaluate(element => element.isConnected)).toBe(true);
  await record(page, info, { feature: "settings-selection-motion", underline, reducedMotion: true });
});

test("account list and detail retain their console hierarchy across themes and widths", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
    await page.goto(manifest.origin + "/admin/settings/accounts");
    const accounts = page.locator("[data-account-list]");
    await expect(accounts).toBeVisible();
    const name = accounts.locator('a[href^="/admin/settings/accounts/"]').first();
    expect(await name.evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
    const href = await name.getAttribute("href");
    await record(page, info, { feature: "account-list-polish", width, theme });
    await name.click();
    await expect(page).toHaveURL(manifest.origin + href);
    await expect(page.locator("[data-account-key-card]")).toBeVisible();
    await expect(page.getByLabel("密钥内容", { exact: true })).toHaveCount(0);
    await record(page, info, { feature: "account-detail-polish", width, theme, keysRemainHidden: true });
  }
});
