import { mkdir } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit } from "./audit";

const summarySelector = "[data-security-summary]";
const cardLabels = ["管理员 IP 白名单", "登录密码", "密钥", "登录会话"];
const evidenceDirectory = ".ui-audit/security-card-flow-20261021";

async function configure(page: Page, theme: "light" | "dark", mode: "compact" | "full") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}

async function storageWidth(page: Page, mode: "compact" | "full") {
  // Notify the existing preference store without stealing focus from a draft
  // or clicking behind an open menu or dialog.
  await page.evaluate(mode => {
    const key = "perpay:content-width", oldValue = localStorage.getItem(key);
    localStorage.setItem(key, mode);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: mode, storageArea: localStorage, url: location.href }));
  }, mode);
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
}

async function openSecurity(page: Page, manifest: Manifest) {
  await page.goto(manifest.origin + "/admin/settings/security");
  await expect(page.locator('.admin-settings-layout[data-settings-section="security"]')).toBeVisible();
  await expect(page.locator(summarySelector)).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "编辑管理员 IP 白名单", exact: true })).toBeVisible();
  await expect(page.getByLabel("允许的 IP / 网段", { exact: true })).toHaveCount(0);
}

async function settledSummary(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(50);
  const geometry = await page.locator(summarySelector).evaluate(summary => {
    const bounds = summary.getBoundingClientRect();
    const items = [...summary.querySelectorAll<HTMLElement>(':scope > [data-slot="card"]')].map(card => {
      const box = card.getBoundingClientRect();
      return { label: card.querySelector('[data-slot="card-title"]')?.textContent,
        top: box.top - bounds.top, left: box.left - bounds.left, width: box.width, height: box.height,
        clipped: card.scrollWidth > card.clientWidth + 1 };
    });
    return { width: bounds.width, items };
  });
  expect(geometry.items.map(item => item.label)).toEqual(cardLabels);
  for (const [index, item] of geometry.items.entries()) {
    expect(item.clipped).toBe(false);
    expect(Math.abs(item.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(item.width - geometry.width)).toBeLessThanOrEqual(1);
    if (index) expect(item.top).toBeGreaterThanOrEqual(geometry.items[index - 1]!.top + geometry.items[index - 1]!.height + 15);
  }
  return geometry;
}

async function editorGeometry(page: Page, maximum = 896) {
  const editor = page.locator('[data-overlay-content]');
  const viewport = page.viewportSize()!.width;
  await expect(editor).toHaveCSS("width", (viewport < 768 ? viewport : Math.min(maximum, viewport - 48)) + "px");
  const geometry = await editor.evaluate(editor => {
    const bounds = editor.getBoundingClientRect();
    const footer = editor.querySelector('[data-overlay-footer]')!.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top,
      viewport: innerWidth, viewportHeight: innerHeight, footerBottom: footer.bottom, bottom: bounds.bottom };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.bottom + 1);
  if (geometry.viewport < 768) {
    expect(geometry.width).toBeCloseTo(geometry.viewport, 0);
    expect(geometry.height).toBeCloseTo(geometry.viewportHeight, 0);
  } else expect(geometry.width).toBeLessThanOrEqual(maximum);
  return geometry;
}

async function retainItems(page: Page) {
  return page.locator(summarySelector + ' > [data-slot="card"]').evaluateAll(items => items.map((item, index) => {
    const marker = "security-original-" + index;
    item.setAttribute("data-security-flow-retained", marker);
    return marker;
  }));
}

async function expectRetained(page: Page, markers: string[]) {
  expect(await page.locator(summarySelector + ' > [data-slot="card"]').evaluateAll(items => items.map(item => item.getAttribute("data-security-flow-retained")))).toEqual(markers);
}

async function blockMutations(page: Page) {
  const attemptedWrites: string[] = [];
  await page.route("**/api/admin/v1/**", route => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    attemptedWrites.push(request.method() + " " + new URL(request.url()).pathname);
    return route.abort("blockedbyclient");
  });
  return attemptedWrites;
}

async function capture(page: Page, info: TestInfo, id: string) {
  await mkdir(evidenceDirectory, { recursive: true });
  const path = evidenceDirectory + "/" + id + ".png";
  await page.screenshot({ path, fullPage: true });
  await info.attach(id, { path, contentType: "image/png" });
}

test("security summaries keep their reading order and compact sessions across themes and widths", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  const writes = await blockMutations(page), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page, manifest);
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await configure(page, theme, mode);
    await openSecurity(page, manifest);
    const geometry = await settledSummary(page);
    await expect(page.getByLabel("新密码", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "修改登录密码", exact: true })).toBeVisible();
    await expect(page.locator('[data-business-table="administrator-sessions"]')).toHaveAttribute("data-density", "compact");
    await record(page, info, { feature: "security-summaries-and-session-table", width, theme, mode, geometry,
      evidence: "isolated-synthetic-settings-fixture" });
    await capture(page, info, `security-flow-${width}-${theme}-${mode}`);
    if (width === 320 && mode === "compact") await audit(page, info, "security-flow-" + theme);
  }
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test("security overlay drafts and validation survive resize and content-width changes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "compact");
  await openSecurity(page, manifest);
  const retained = await retainItems(page);
  await page.getByRole("link", { name: "编辑管理员 IP 白名单", exact: true }).click();
  const whitelist = page.getByLabel("允许的 IP / 网段", { exact: true });
  const draft = Array.from({ length: 35 }, (_, index) => `192.0.2.${index + 1}`).join("\n");
  await whitelist.fill(draft);
  await whitelist.focus();
  await whitelist.evaluate(element => element.setAttribute("data-security-flow-draft", "whitelist"));
  const draftScroll = await whitelist.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return { height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight) };
  });
  expect(draftScroll.scrollHeight).toBeGreaterThan(draftScroll.height);
  expect(draftScroll.scrollTop).toBeGreaterThan(0);
  expect(draftScroll.height).toBeLessThanOrEqual(draftScroll.maxHeight + 1);
  for (const [width, mode] of [[320, "compact"], [390, "full"], [1440, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(whitelist).toHaveAttribute("data-security-flow-draft", "whitelist");
    await expect(whitelist).toHaveValue(draft);
    await expect(whitelist).toBeFocused();
    await expectRetained(page, retained);
    await record(page, info, { feature: "security-whitelist-overlay-draft", width, mode, geometry: await editorGeometry(page), draftLines: 35 });
  }
  const close = page.locator('[data-overlay-actions]').getByRole("button", { name: "关闭", exact: true });
  await close.click();
  const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(whitelist).toHaveValue(draft);
  await close.click();
  await guard.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await expect(page.locator('[data-overlay-content]')).toBeHidden();
  await page.getByRole("link", { name: "修改登录密码", exact: true }).click();
  const password = page.getByLabel("新密码", { exact: true });
  const confirmation = page.getByLabel("再次输入新密码", { exact: true });
  await password.fill("tiny");
  await confirmation.fill("different-unsubmitted-confirmation");
  await page.getByRole("button", { name: "修改并重新登录", exact: true }).click();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("密码至少需要 6 个字符。", { exact: true })).toBeVisible();
  await password.evaluate(element => element.setAttribute("data-security-flow-draft", "password"));
  for (const [width, mode] of [[390, "full"], [2190, "full"], [1440, "compact"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(password).toHaveValue("tiny");
    await expect(confirmation).toHaveValue("different-unsubmitted-confirmation");
    await expect(password).toHaveAttribute("data-security-flow-draft", "password");
    await expect(password).toBeFocused();
    await expectRetained(page, retained);
    await editorGeometry(page, 640);
  }
  await record(page, info, { feature: "security-password-overlay-validation", evidence: "local-validation-only-no-password-or-whitelist-submission" });
  await capture(page, info, "security-drafts-and-local-validation");
  expect(writes).toEqual([]);
});

test("security session cancellation keeps focus through card reflow without writes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "full");
  await openSecurity(page, manifest);
  await settledSummary(page);
  const retained = await retainItems(page);
  const session = page.getByRole("button", { name: "会话操作", exact: true });
  await session.evaluate(element => element.setAttribute("data-security-flow-session", "original"));
  await session.click();
  const menu = page.getByRole("menu", { includeHidden: true });
  const revoke = menu.getByRole("menuitem", { name: "注销全部会话", exact: true });
  await menu.evaluate(element => element.setAttribute("data-security-flow-menu", "original"));
  await revoke.focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await storageWidth(page, "compact");
  await settledSummary(page);
  await expect(menu).toHaveAttribute("data-security-flow-menu", "original");
  await expect(revoke).toBeFocused();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", { name: "注销全部会话？", exact: true });
  await expect(confirmation).toBeVisible();
  await page.setViewportSize({ width: 2190, height: 900 });
  await storageWidth(page, "full");
  await settledSummary(page);
  await expect(confirmation).toBeVisible();
  await expectRetained(page, retained);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(session).toBeFocused();
  await expect(session).toHaveAttribute("data-security-flow-session", "original");
  expect(writes).toEqual([]);
  await record(page, info, { feature: "security-session-modal-focus-retained", writes });
  await capture(page, info, "security-modal-focus-restored");
});

test("account key content, drafts and confirmation focus survive content-width changes without writes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
      (window as Window & { __copiedText?: string }).__copiedText = value;
    } } });
  });
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "full");
  await openSecurity(page, manifest);
  const accountEntry = page.getByRole("link", { name: "在支付宝账号中管理应用密钥", exact: true });
  await accountEntry.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + "/admin/settings/accounts");
  const response = await page.request.get(manifest.origin + "/api/admin/v1/alipay-accounts");
  expect(response.ok()).toBe(true);
  const accounts = await response.json() as { data: { id: string; name: string; application_public_key: string | null }[] };
  const account = accounts.data.find(item => item.application_public_key);
  expect(account, "the isolated fixture has a configured account with a public key").toBeTruthy();
  await page.getByRole("link", { name: "配置" + account!.name, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe("/settings/accounts/" + account!.id);
  const keyCard = page.locator("[data-account-key-card]");
  const publicKey = keyCard.getByText(account!.application_public_key!, { exact: true });
  await expect(publicKey).toHaveText(account!.application_public_key!);
  await keyCard.evaluate(element => element.setAttribute("data-security-flow-key-card", "original"));
  const name = page.getByLabel("账号名称", { exact: true });
  const draft = account!.name + " · 未保存的宽度验证";
  await name.fill(draft);
  await name.evaluate(element => element.setAttribute("data-security-flow-draft", "account"));
  for (const [width, mode] of [[390, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(name).toHaveValue(draft);
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("data-security-flow-draft", "account");
    await expect(keyCard).toHaveAttribute("data-security-flow-key-card", "original");
    await expect(publicKey).toHaveText(account!.application_public_key!);
  }
  await name.fill(account!.name);
  await page.getByRole("tab", { name: "应用密钥", exact: true }).click();
  const copy = keyCard.getByRole("button", { name: "复制应用公钥", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(account!.application_public_key);
  await expect(copy).toBeFocused();
  const regenerate = page.getByRole("button", { name: "更换应用密钥", exact: true });
  await expect(regenerate).toBeEnabled();
  await regenerate.evaluate(element => element.setAttribute("data-security-flow-view", "original"));
  await regenerate.focus();
  await page.keyboard.press("Enter");
  const keyDialog = page.getByRole("alertdialog", { name: "生成新的应用密钥？", exact: true });
  await keyDialog.evaluate(element => element.setAttribute("data-security-flow-dialog", "key-confirmation"));
  const cancel = keyDialog.getByRole("button", { name: "取消", exact: true });
  await cancel.focus();
  for (const [width, mode] of [[390, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(keyDialog).toHaveAttribute("data-security-flow-dialog", "key-confirmation");
    await expect(cancel).toBeFocused();
    await expect(keyCard).toHaveAttribute("data-security-flow-key-card", "original");
    await expect(name).toHaveAttribute("data-security-flow-draft", "account");
    await expect(name).toHaveValue(account!.name);
  }
  await cancel.click();
  await expect(keyDialog).toHaveCount(0);
  await expect(regenerate).toBeFocused();
  await expect(regenerate).toHaveAttribute("data-security-flow-view", "original");
  await expect(publicKey).toHaveText(account!.application_public_key!);
  expect(writes).toEqual([]);
  await record(page, info, { feature: "account-key-content-and-modal-focus-retained", keyCharacters: account!.application_public_key!.length, writes, evidence: "real account reads from the isolated synthetic fixture; no secret reveal or key change" });
  await capture(page, info, "account-key-modal-focus-restored");
});

test("other settings sections retain their existing 56rem maximum width", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  for (const mode of ["compact", "full"] as const) {
    await configure(page, "light", mode);
    for (const section of ["accounts", "collection-policy", "backup", "display", "advanced", "provider", "collection"]) {
      await page.goto(manifest.origin + "/admin/settings/" + section);
      const currentSection = ["provider", "collection"].includes(section) ? "accounts" : section;
      await expect(page).toHaveURL(manifest.origin + "/admin/settings/" + currentSection);
      const layout = page.locator('.admin-settings-layout[data-settings-section="' + currentSection + '"]');
      await expect(layout).toBeVisible();
      await expect(page.locator(summarySelector)).toHaveCount(0);
      const geometry = await layout.evaluate(element => ({ width: element.getBoundingClientRect().width,
        maxWidth: getComputedStyle(element).maxWidth, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) }));
      expect(geometry.maxWidth).toBe(56 * geometry.rem + "px");
      expect(geometry.width).toBeLessThanOrEqual(56 * geometry.rem + 1);
      await record(page, info, { feature: "non-security-settings-width-retained", section, currentSection, mode, geometry });
    }
  }
  expect(writes).toEqual([]);
});
