import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

async function pressScrollKey(page: Page, scroll: Locator, key: "PageDown" | "ArrowDown" | "Home") {
  const cleanup = await scroll.evaluateHandle(element => {
    element.setAttribute("data-keyboard-scroll-ended", "false");
    const ended = () => element.setAttribute("data-keyboard-scroll-ended", "true");
    element.addEventListener("scrollend", ended, { once: true });
    return () => {
      element.removeEventListener("scrollend", ended);
      element.removeAttribute("data-keyboard-scroll-ended");
    };
  });
  try {
    await page.keyboard.press(key);
    // A positive scrollTop can still be the previous key's animation. Sending
    // Home on its final frame can be ignored by Chromium's native scroller.
    await expect(scroll, `${key} must finish native keyboard scrolling`).toHaveAttribute("data-keyboard-scroll-ended", "true");
  } finally {
    await cleanup.evaluate(dispose => dispose()).catch(() => {});
    await cleanup.dispose();
  }
}

async function readWithKeyboard(page: Page, dialog: Locator) {
  const scroll = dialog.locator("[data-admin-dialog-scroll]");
  await expect(scroll).toHaveAttribute("data-scrollable", "true");
  await expect(scroll).toBeFocused();
  await expect(scroll).toHaveAttribute("tabindex", "0");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
  const geometry = await scroll.evaluate(element => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    outline: getComputedStyle(element).outline,
  }));
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.height + 1);
  await expect(scroll).toHaveCSS("outline-style", "solid");
  await expect(scroll).toHaveCSS("outline-width", "2px");
  await expect(scroll).toHaveCSS("outline-offset", "-2px");

  // Use the browser's keyboard scrolling. No scripted scrolling or focus
  // rescue is allowed: both previously failed at the popup's initial focus.
  await pressScrollKey(page, scroll, "PageDown");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const pageDown = await scroll.evaluate(element => element.scrollTop);
  await expect(scroll).toBeFocused();
  await pressScrollKey(page, scroll, "Home");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
  await pressScrollKey(page, scroll, "ArrowDown");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const arrowDown = await scroll.evaluate(element => element.scrollTop);
  await pressScrollKey(page, scroll, "Home");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);

  await page.keyboard.press("Tab");
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  await expect(cancel).toBeFocused();
  const bounds = (await cancel.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  return { ...geometry, pageDown, arrowDown };
}

for (const size of [
  { name: "phone", width: 320, height: 560, hasTouch: true, isMobile: true },
  { name: "short desktop", width: 1280, height: 280, hasTouch: false, isMobile: false },
] as const) {
  test.describe(`${size.name}: long dialogs have a keyboard reading entry`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.hasTouch,
      isMobile: size.isMobile,
      reducedMotion: "reduce",
    });

    for (const theme of ["light", "dark"] as const) {
      test(`${theme}, 200% text: confirmation and alert scroll with real keys and restore focus`, async ({ page, manifest }, info) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
        const writes: string[] = [];
        await page.route("**/api/admin/v1/**", async route => {
          if (route.request().method() === "GET") return route.continue();
          writes.push(route.request().url());
          await route.fulfill({ status: 403, json: { error: { code: "keyboard_test_read_only", message: "只验证键盘阅读与取消" } } });
        });
        await login(page, manifest);
        await page.goto(manifest.origin + "/admin/settings/security");
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        const rules = page.getByRole("textbox", { name: "允许的 IP / 网段", exact: true });
        const initialRules = await rules.inputValue();
        await rules.fill(Array.from({ length: 30 }, (_, index) => `192.0.2.${index + 1}`).join("\n"));
        const save = page.getByRole("button", { name: "保存白名单", exact: true });
        await save.press("Enter");
        const confirmation = page.getByRole("dialog", { name: "确认保存访问规则？", exact: true });
        await expect(confirmation).toBeVisible();
        if (!size.isMobile) {
          const scroll = confirmation.locator("[data-admin-dialog-scroll]");
          await expect(scroll).toBeFocused();
          await expect(scroll).toHaveAttribute("tabindex", "0");
          await page.setViewportSize({ width: size.width, height: 900 });
          await page.clock.runFor(100);
          await expect(scroll).toHaveAttribute("data-scrollable", "false");
          await expect(scroll).toHaveAttribute("tabindex", "-1");
          await page.setViewportSize({ width: size.width, height: size.height });
          await page.clock.runFor(100);
          await expect(scroll).toHaveAttribute("data-scrollable", "true");
          await expect(scroll).toHaveAttribute("tabindex", "0");
        }
        const confirmationKeys = await readWithKeyboard(page, confirmation);
        await page.keyboard.press("Escape");
        await expect(confirmation).toHaveCount(0);
        await expect(save).toBeFocused();
        await rules.fill(initialRules);

        await page.goto(manifest.origin + "/admin/work-items");
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await expect(page.locator("[data-business-row]").first()).toBeVisible();
        await page.clock.runFor(100);
        const ignoreName = "忽略全部筛选结果（跨页）";
        const menuTrigger = page.getByRole("button", { name: "更多提醒操作", exact: true });
        const inMenu = await menuTrigger.isVisible();
        const trigger = inMenu
          ? menuTrigger
          : page.getByRole("button", { name: ignoreName, exact: true });
        await expect(trigger).toBeEnabled();
        await trigger.press("Enter");
        if (inMenu) {
          const ignore = page.getByRole("menuitem", { name: ignoreName, exact: true });
          await expect(ignore).toBeEnabled();
          await ignore.press("Enter");
        }
        const alert = page.getByRole("alertdialog", { name: /^忽略全部筛选结果（跨页）/ });
        await expect(alert).toBeVisible();
        const alertKeys = await readWithKeyboard(page, alert);
        await page.keyboard.press("Escape");
        await expect(alert).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(writes, "keyboard reading and cancellation never save settings or ignore reminders").toEqual([]);
        await record(page, info, { evidence: "real keyboard scrolling in unchanged synthetic confirmation flows", theme, text: 200, confirmationKeys, alertKeys });
      });
    }
  });
}
