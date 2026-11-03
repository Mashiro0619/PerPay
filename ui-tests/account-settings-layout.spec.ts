import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function cardGeometry(card: Locator) {
  return card.evaluate(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    const header = element.querySelector<HTMLElement>(':scope > [data-slot="card-header"]')!;
    const content = element.querySelector<HTMLElement>(':scope > [data-slot="card-content"]')!;
    const title = header.querySelector<HTMLElement>('[data-slot="card-title"]')!;
    const headerBox = header.getBoundingClientRect(), contentBox = content.getBoundingClientRect();
    return { width: box.width, radius: style.borderRadius, shadow: style.boxShadow, background: style.backgroundColor,
      headerPadding: parseFloat(getComputedStyle(header).paddingLeft), contentPadding: parseFloat(getComputedStyle(content).paddingLeft),
      leftInset: title.getBoundingClientRect().left - box.left, topInset: title.getBoundingClientRect().top - box.top,
      sectionGap: contentBox.top - headerBox.bottom,
      contentOverflows: content.scrollWidth > content.clientWidth + 1 };
  });
}

async function completeLabel(control: Locator) {
  return control.evaluate(element => {
    const box = element.getBoundingClientRect(), text = element.querySelector("span") ?? element;
    const range = document.createRange(); range.selectNodeContents(text);
    const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height);
    return { width: box.width, height: box.height, whiteSpace: getComputedStyle(element).whiteSpace,
      lineCount: new Set(lines.map(rect => Math.round(rect.top))).size,
      complete: lines.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) };
  });
}

async function reachField(control: Locator, dialog: Locator) {
  const chrome = () => dialog.evaluate(element => {
    const header = element.querySelector('[data-slot="dialog-header"]')!.getBoundingClientRect();
    const footer = element.querySelector('[data-overlay-footer]')!.getBoundingClientRect();
    return { headerTop: header.top, headerBottom: header.bottom, footerTop: footer.top, footerBottom: footer.bottom };
  });
  const before = await chrome();
  await control.scrollIntoViewIfNeeded();
  const visible = await control.evaluate(element => {
    const box = element.getBoundingClientRect(), body = element.closest('[data-overlay-detail]')!.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { top: box.top, bottom: box.bottom, bodyTop: body.top, bodyBottom: body.bottom, unobscured: hit === element || element.contains(hit) };
  });
  expect(visible.top).toBeGreaterThanOrEqual(visible.bodyTop - 1);
  expect(visible.bottom).toBeLessThanOrEqual(visible.bodyBottom + 1);
  expect(visible.unobscured).toBe(true);
  expect(await chrome()).toEqual(before);
  return visible;
}

for (const layout of [{ width: 1440, height: 900, font: 100 }, { width: 390, height: 844, font: 100 }, { width: 768, height: 480, font: 200 }, { width: 320, height: 560, font: 200 }]) {
  test.describe(`${layout.width}px ${layout.font}% text`, () => {
  test.use({ hasTouch: layout.width < 768, isMobile: layout.width < 768 });
  test(`account settings card and five editor panels preserve alignment at ${layout.width}px and ${layout.font}% text`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/settings/display");
    await page.evaluate(font => document.documentElement.style.fontSize = font + "%", layout.font);
    await expect(page.locator("html")).toHaveCSS("font-size", (16 * layout.font / 100) + "px");
    const reference = await cardGeometry(page.locator("[data-settings-summary]").first());
    await page.goto(manifest.origin + "/admin/settings/accounts");
    await page.evaluate(font => document.documentElement.style.fontSize = font + "%", layout.font);
    await expect(page.locator("html")).toHaveCSS("font-size", (16 * layout.font / 100) + "px");
    const card = page.locator("[data-account-list]");
    await expect(card.getByRole("heading", { name: "支付宝账号", exact: true })).toBeVisible();
    await expect(card.locator("[data-business-table]")).toBeVisible();
    const geometry = await cardGeometry(card);
    expect(geometry.radius).toBe(reference.radius);
    expect(geometry.shadow).toBe(reference.shadow);
    expect(geometry.background).toBe(reference.background);
    expect(geometry.headerPadding).toBe(reference.headerPadding);
    expect(geometry.contentPadding).toBe(reference.contentPadding);
    expect(geometry.leftInset).toBeCloseTo(reference.leftInset, 0);
    expect(geometry.topInset).toBeCloseTo(reference.topInset, 0);
    expect(geometry.sectionGap).toBeGreaterThanOrEqual(10);
    expect(geometry.contentOverflows).toBe(false);
    const add = card.getByRole("link", { name: "添加支付宝账号", exact: true });
    await add.scrollIntoViewIfNeeded();
    const addGeometry = await completeLabel(add);
    expect(addGeometry.complete, "complete add-account label: " + JSON.stringify(addGeometry)).toBe(true);
    if (layout.width < 768) await expectTouchTarget(add);
    await page.screenshot({ path: info.outputPath("accounts-card.png"), fullPage: false });
    await record(page, info, { feature: "account-settings-card", layout, reference, geometry });

    await card.locator("a[data-row-link]").first().click();
    const dialog = page.locator("[data-overlay-content]");
    const editor = dialog.locator("[data-alipay-account-editor]");
    await expect(editor).toBeVisible();
    const accountPath = new URL(page.url()).searchParams.get("overlay")!;
    const accountResponse = await page.request.get(manifest.origin + "/api/admin/v1/alipay-accounts/" + accountPath.split("/").at(-1));
    expect(accountResponse.ok()).toBe(true);
    const account = (await accountResponse.json()).data as { application_public_key: string | null };
    const evidence = [];
    for (const [panel, name] of [["basic", "基本信息"], ["application", "应用信息"], ["collection", "收款码"], ["keys", "应用密钥"], ["usage", "使用情况"]] as const) {
      const tab = editor.getByRole("tab", { name, exact: true });
      await tab.scrollIntoViewIfNeeded(); await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const active = editor.locator(`[data-account-panel="${panel}"]`);
      await expect(active).toBeVisible();
      const body = dialog.locator("[data-overlay-detail]");
      const measures = await body.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight,
        emptyFooters: [...element.querySelectorAll('[data-slot="card-footer"]')].filter(footer => footer.getBoundingClientRect().height && !footer.textContent?.trim()).length }));
      expect(measures.scrollWidth).toBeLessThanOrEqual(measures.width + 1);
      expect(measures.height).toBeGreaterThan(100);
      expect(measures.emptyFooters).toBe(0);
      const actions = dialog.locator("[data-overlay-footer] [data-overlay-actions]");
      await expect(dialog.getByRole("button", { name: "关闭对话框", exact: true })).toBeVisible();
      const save = actions.getByRole("button", { name: "保存并检查", exact: true });
      await expect(save).toBeVisible();
      const saveGeometry = await completeLabel(save);
      expect(saveGeometry.complete).toBe(true);
      expect(saveGeometry.lineCount, "the primary action does not stack individual characters vertically").toBeLessThanOrEqual(2);
      if (layout.width === 1440) expect(saveGeometry.width).toBeLessThan(220);
      if (layout.width < 768) await expectTouchTarget(save);
      if (panel === "basic") {
        const reached = await reachField(active.getByRole("textbox", { name: "账号名称", exact: true }), dialog);
        const toggle = active.getByRole("switch", { name: "接收新订单", exact: true });
        await toggle.scrollIntoViewIfNeeded();
        const switchBox = await toggle.evaluate(element => {
          const box = element.getBoundingClientRect(), field = element.closest('[data-slot="field"]')!.getBoundingClientRect();
          return { rightInset: field.right - box.right, fieldWidth: field.width, switchCenter: box.top + box.height / 2, fieldCenter: field.top + field.height / 2 };
        });
        expect(Math.abs(switchBox.rightInset)).toBeLessThanOrEqual(1);
        expect(Math.abs(switchBox.switchCenter - switchBox.fieldCenter)).toBeLessThanOrEqual(1);
        evidence.push({ panel, measures, saveGeometry, switchBox, reached });
      } else if (panel === "application") {
        const reached = await reachField(active.getByRole("textbox", { name: "支付宝公钥", exact: true }), dialog);
        evidence.push({ panel, measures, saveGeometry, reached });
      } else evidence.push({ panel, measures, saveGeometry });
      if (panel === "keys") {
        const expectedKey = account.application_public_key;
        expect(expectedKey).toBeTruthy();
        const copy = active.getByRole("button", { name: "复制应用公钥", exact: true });
        await copy.scrollIntoViewIfNeeded(); await copy.click();
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedKey);
      }
      await page.mouse.move(0, 0);
      await page.screenshot({ path: info.outputPath(`account-${panel}.png`), fullPage: false });
    }
    await editor.getByRole("tab", { name: "基本信息", exact: true }).click();
    const accountName = editor.getByRole("textbox", { name: "账号名称", exact: true });
    await accountName.fill("待保存布局检查");
    await editor.getByRole("tab", { name: "应用信息", exact: true }).click();
    await editor.getByRole("tab", { name: "基本信息", exact: true }).click();
    await expect(accountName).toHaveValue("待保存布局检查");
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    const guard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(accountName).toHaveValue("待保存布局检查");
    await record(page, info, { feature: "account-editor-panels", layout, evidence, draftPreserved: true });
  });
  });
}
