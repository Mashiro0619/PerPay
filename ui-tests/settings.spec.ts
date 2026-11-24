import { selectSettingsSection, expectSettingsSections } from "./settings-sections";
import { test, expect, login, record } from "./fixtures";
import { test as isolatedTest } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { AdminAccessView } from "../web/src/api/generated/types.gen";

isolatedTest("IP 白名单在真实版本冲突后保留草稿并可继续保存", async ({ page }, info) => {
  const fixture = await createSettingsServer(Date.now());
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.context().addCookies(fixture.cookies);
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    const endpoint = fixture.origin + "/api/admin/v1/settings/admin-access";
    const headers = { origin: fixture.origin, "x-csrf-token": fixture.cookies.find(cookie => cookie.name.includes("csrf"))!.value };
    const read = async () => {
      const response = await page.request.get(endpoint);
      expect(response.status()).toBe(200);
      return (await response.json()).data as AdminAccessView;
    };
    const writeElsewhere = async (enabled: boolean, cidrs: string[]) => {
      const current = await read();
      const response = await page.request.put(endpoint, { headers, data: { revision: current.revision, enabled, cidrs } });
      expect(response.status()).toBe(200);
      return read();
    };
    const initial = await writeElsewhere(false, ["127.0.0.1"]);
    await page.goto(fixture.origin + "/admin/settings/security");
    await page.getByRole("link", { name: "编辑管理员 IP 白名单", exact: true }).click();
    const editor = page.locator("[data-overlay-content]");
    const rules = editor.getByRole("textbox", { name: "允许的 IP / 网段", exact: true });
    const save = editor.getByRole("button", { name: "保存白名单", exact: true });
    const submitted: { status: number; revision: number; enabled: boolean; cidrs: string[] }[] = [];
    async function submit(status: number, revision: number) {
      await save.click();
      const dialog = page.getByRole("alertdialog", { name: "确认保存 IP 白名单？", exact: true });
      const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "PUT");
      await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(status);
      const body = response.request().postDataJSON() as { revision: number; enabled: boolean; cidrs: string[] };
      expect(body.revision).toBe(revision);
      submitted.push({ status, ...body });
      await expect(dialog).toBeHidden();
    }
    const firstDraft = "127.0.0.1\n192.0.2.10";
    await expect(rules).toHaveValue("127.0.0.1");
    await rules.fill(firstDraft);
    const remoteSwitch = await writeElsewhere(true, ["127.0.0.1"]);
    await submit(409, initial.revision);
    await expect(rules).toHaveValue(firstDraft);
    await expect(save).toBeDisabled();
    await editor.getByRole("button", { name: "重新读取配置", exact: true }).click();
    await expect(rules).toBeEnabled();
    await expect(rules).toHaveValue(firstDraft);
    await expect(editor.getByRole("switch", { name: "启用 IP 白名单", exact: true })).toBeChecked();
    await submit(200, remoteSwitch.revision);
    const firstSaved = await read();
    expect(firstSaved.enabled).toBe(true);
    expect(firstSaved.cidrs).toEqual(["127.0.0.1", "192.0.2.10"]);
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    const secondDraft = firstDraft + "\n198.51.100.11";
    await rules.fill(secondDraft);
    const remoteRules = await writeElsewhere(true, ["127.0.0.1", "203.0.113.12"]);
    await submit(409, firstSaved.revision);
    await expect(rules).toHaveValue(secondDraft);
    await editor.getByRole("button", { name: "重新读取配置", exact: true }).click();
    const conflict = editor.getByRole("alert").filter({ hasText: "IP 白名单存在不同修改" });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("203.0.113.12");
    await expect(conflict).toContainText("198.51.100.11");
    await expect(save).toBeDisabled();
    const apply = conflict.getByRole("button", { name: "应用核对结果", exact: true });
    await expect(apply).toBeDisabled();
    await conflict.locator('[data-slot="alert-title"]').scrollIntoViewIfNeeded();
    const geometry = await editor.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { viewport: innerWidth, document: document.documentElement.scrollWidth,
        left: box.left, right: box.right, width: element.clientWidth, content: element.scrollWidth };
    });
    expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
    for (const button of await conflict.getByRole("button").all()) {
      const bounds = await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
    }
    await page.screenshot({ path: info.outputPath("access-conflict-320-200.png") });
    await apply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("access-conflict-actions-320-200.png") });
    await conflict.getByRole("button", { name: "保留我的修改", exact: true }).click();
    await apply.click();
    await expect(rules).toBeEnabled();
    await expect(rules).toHaveValue(secondDraft);
    await submit(200, remoteRules.revision);
    const secondSaved = await read();
    expect(secondSaved.enabled).toBe(true);
    expect(secondSaved.cidrs).toEqual(["127.0.0.1", "192.0.2.10", "198.51.100.11"]);
    await expect(save).toBeDisabled();
    const toast = page.locator('[data-slot="toast"]');
    await expect(toast.locator('[data-slot="toast-title"]')).toHaveText("IP 白名单已保存");
    await expect.poll(() => toast.evaluate(element => {
      const title = element.querySelector<HTMLElement>('[data-slot="toast-title"]')!;
      const content = element.querySelector<HTMLElement>('[data-slot="toast-content"]')!;
      const titleBounds = title.getBoundingClientRect(), contentBounds = content.getBoundingClientRect();
      return titleBounds.width >= parseFloat(getComputedStyle(title).fontSize) * 4
        && titleBounds.top >= contentBounds.top && titleBounds.bottom <= contentBounds.bottom + 1
        && content.scrollHeight <= content.clientHeight + 1;
    }), { message: "放大文字后的完整成功提示可直接阅读" }).toBe(true);
    await page.screenshot({ path: info.outputPath("access-saved-320-200.png") });
    await info.attach("access-recovery", { body: JSON.stringify({ submitted, firstSaved, secondSaved, geometry }), contentType: "application/json" });
  } finally { await fixture.close(); }
});

test("website categories preserve keyboard activation across desktop tabs and the phone selector", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { label: element.textContent, left: bounds.left, right: bounds.right,
        unobscured: hit === element || element.contains(hit), pageScroll: window.scrollY };
    });
    expect(geometry.unobscured).toBe(true);
    expect(geometry.pageScroll).toBe(sourceScroll);
    evidence.push(geometry);
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + "/admin" + settingsRoute + "/display");
  await expect(choices.last()).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 360, height: 844 });
  const category = page.getByRole("combobox", { name: "网站设置分组", exact: true });
  const selectedLabel = category.locator('[data-slot="select-value"]');
  await expect(category).toBeVisible();
  await expect(selectedLabel).toHaveText("收银台展示");
  await expect(tabs).toHaveCount(0);
  const phoneUrl = page.url(), phoneScroll = await page.evaluate(() => window.scrollY);
  await category.focus();
  await page.keyboard.press("Enter");
  const options = page.getByRole("option");
  await expect(options).toHaveText(["基本信息", "收款账号", "订单设置", "接入与通知", "收银台展示"]);
  await expect(page.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  expect(page.url()).toBe(phoneUrl);
  expect(await page.evaluate(() => window.scrollY)).toBe(phoneScroll);
  await expect(selectedLabel).toHaveText("收银台展示");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + "/admin" + settingsRoute + "/collection");
  await expect(selectedLabel).toHaveText("收款账号");
  await expect(category).toBeFocused();
  await record(page, info, { feature: "website-category-keyboard-activation", evidence, desktopEnterNavigated: true, selectedPreservedAfterResize: true, phoneEnterNavigated: true });
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
  const name = page.getByRole("textbox", { name: "系统名称" });
  await name.fill("手机草稿保留");
  await page.getByRole("combobox", { name: "设置分类" }).click();
  await page.getByRole("option", { name: "查账设置" }).click();
  const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑" }).click();
  await expect(name).toHaveValue("手机草稿保留");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(name).toHaveValue("手机草稿保留");
  await expect(page.getByRole("tablist", { name: "设置分类" })).toBeVisible();
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.goto(manifest.origin + "/admin/settings/provider");
  const list = page.getByRole("tablist", { name: "设置分类" });
  await expect(list).toBeVisible();
  const selected = list.locator('[aria-selected="true"]');
  await selected.focus();
  const before = page.url();
  await page.keyboard.press("ArrowRight");
  expect(page.url()).toBe(before);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(manifest.origin + "/admin/settings/display");
  const layoutBounds = await page.locator(".admin-settings-layout").boundingBox();
  expect(layoutBounds!.width).toBeGreaterThan(896);
  await page.clock.runFor(250);
  const indicator = list.locator('[aria-selected="true"] [data-selection-indicator]');
  await expect(list.locator("[data-selection-indicator]")).toHaveCount(1);
  const pill = await indicator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const tab = element.parentElement!.getBoundingClientRect();
    return { box: box.toJSON(), tab: tab.toJSON() };
  });
  expect(Math.abs(pill.box.left - pill.tab.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(pill.box.width - pill.tab.width)).toBeLessThanOrEqual(2);
  const stableInput = await page.getByRole("textbox", { name: "系统名称" }).elementHandle();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator).toHaveAttribute("data-selection-mode", "static");
  expect(await stableInput!.evaluate(element => element.isConnected)).toBe(true);
  await record(page, info, { feature: "settings-selection-motion", pill, reducedMotion: true });
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
    await selectSettingsSection(page, page, "支付宝账号配置分组", "应用信息");
    await expect(page.locator("[data-account-public-key]")).toHaveCount(1);
    await expectSettingsSections(page, page, "支付宝账号配置分组", ["基本信息", "应用信息", "收款码", "使用情况"]);
    await expect(page.getByLabel("密钥内容", { exact: true })).toHaveCount(0);
    await record(page, info, { feature: "account-detail-polish", width, theme, keysRemainHidden: true });
  }
});
