import { test, expect, login, record } from "./fixtures";

test("website category tabs reveal keyboard focus without moving the page or navigating before Enter", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  const settingsRoute = manifest.routes.find(route => /^\/sites\/[^/]+\/settings$/.test(route));
  expect(settingsRoute).toBeTruthy();
  await page.goto(manifest.origin + "/admin" + settingsRoute + "/basic");
  const tabs = page.getByRole("tablist", { name: "网站设置分组", exact: true });
  const choices = tabs.getByRole("tab");
  await expect(choices).toHaveCount(5);
  await choices.first().focus();
  const sourceUrl = page.url(), sourceScroll = await page.evaluate(() => window.scrollY);
  const evidence = [];
  for (let index = 1; index < 5; index++) {
    await page.keyboard.press("ArrowRight");
    const choice = choices.nth(index);
    await expect(choice).toBeFocused();
    expect(page.url()).toBe(sourceUrl);
    const geometry = await choice.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const viewport = element.closest("[data-settings-tabs-scroll]")!.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { label: element.textContent, left: bounds.left, right: bounds.right, viewportLeft: viewport.left, viewportRight: viewport.right,
        unobscured: hit === element || element.contains(hit), pageScroll: window.scrollY };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.viewportLeft - 1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportRight + 1);
    expect(geometry.unobscured).toBe(true);
    expect(geometry.pageScroll).toBe(sourceScroll);
    evidence.push(geometry);
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + "/admin" + settingsRoute + "/display");
  await expect(choices.last()).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 360, height: 844 });
  await expect.poll(() => choices.last().evaluate(element => {
    const bounds = element.getBoundingClientRect(), viewport = element.closest("[data-settings-tabs-scroll]")!.getBoundingClientRect();
    return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
  })).toBe(true);
  await record(page, info, { feature: "website-tabs-keyboard-reveal", evidence, enterNavigated: true, selectedRevealedAfterResize: true });
});

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
  await page.getByRole("link", { name: "编辑界面显示", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑界面显示", exact: true });
  const name = page.getByRole("textbox", { name: "支付系统名称" });
  await name.fill("手机草稿保留");
  await editor.locator("[data-overlay-actions]").getByRole("button", { name: "关闭", exact: true }).click();
  const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑" }).click();
  await expect(name).toHaveValue("手机草稿保留");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(name).toHaveValue("手机草稿保留");
  expect((await editor.boundingBox())!.width).toBeLessThanOrEqual(896);
  await editor.locator("[data-overlay-actions]").getByRole("button", { name: "关闭", exact: true }).click();
  await guard.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("tablist", { name: "设置分类" })).toBeVisible();
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
  const stableEdit = await page.getByRole("link", { name: "编辑界面显示", exact: true }).elementHandle();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator).toHaveAttribute("data-selection-mode", "static");
  expect(await stableEdit!.evaluate(element => element.isConnected)).toBe(true);
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
    const name = accounts.locator('a[data-row-link]').first();
    expect(await name.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    const href = await name.getAttribute("href");
    await record(page, info, { feature: "account-list-polish", width, theme });
    await name.click();
    await expect(page).toHaveURL(manifest.origin + href);
    await page.getByRole("tab", { name: "应用密钥", exact: true }).click();
    await expect(page.locator("[data-account-key-card]")).toBeVisible();
    await expect(page.getByLabel("密钥内容", { exact: true })).toHaveCount(0);
    await record(page, info, { feature: "account-detail-polish", width, theme, keysRemainHidden: true });
  }
});
