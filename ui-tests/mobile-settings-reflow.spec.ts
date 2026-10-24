import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function completeSelectValue(trigger: Locator, page: Page) {
  await trigger.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  const touch = await expectTouchTarget(trigger);
  const text = await trigger.locator('[data-slot="select-value"]').evaluate(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return { text: element.textContent, width: box.width, height: box.height,
      lines: [...range.getClientRects()].filter(line => line.width && line.height).map(line => ({
        left: line.left - box.left, right: line.right - box.left,
        top: line.top - box.top, bottom: line.bottom - box.top,
      })) };
  });
  expect(text.lines.length).toBeGreaterThan(0);
  expect(text.lines.every(line => line.left >= -1 && line.right <= text.width + 1), `complete selected value: ${JSON.stringify(text)}`).toBe(true);
  expect(text.lines.every(line => line.top >= -1 && line.bottom <= text.height + 1), `selected value has no vertical clipping: ${JSON.stringify(text)}`).toBe(true);
  return { touch, text };
}

async function completeButtonLabel(button: Locator, page: Page) {
  await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  const touch = await expectTouchTarget(button);
  const text = await button.evaluate(element => {
    const box = element.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(element);
    const lines = [...range.getClientRects()].filter(line => line.width && line.height);
    const ancestorClipping = [];
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (["hidden", "clip"].includes(style.overflowX) && lines.some(line => line.left < bounds.left - 1 || line.right > bounds.right + 1))
        ancestorClipping.push({ tag: parent.tagName, slot: parent.getAttribute("data-slot"), bounds: bounds.toJSON() });
    }
    return { width: box.width, height: box.height, ancestorClipping, lines: lines.map(line => ({
      left: line.left - box.left, right: line.right - box.left,
      top: line.top - box.top, bottom: line.bottom - box.top,
    })) };
  });
  expect(text.lines.every(line => line.left >= -1 && line.right <= text.width + 1 && line.top >= -1 && line.bottom <= text.height + 1), "the complete disclosure label fits its control").toBe(true);
  expect(text.ancestorClipping, "Card ancestors do not clip the disclosure label").toEqual([]);
  return { touch, text };
}

test.describe("narrow settings controls preserve their selected labels", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  test("the provider environment keeps both complete choices at 200% text", async ({ page, manifest }, info) => {
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/settings/provider");
    const environment = page.getByRole("combobox", { name: "支付宝环境", exact: true });
    await expect(environment).toBeVisible();
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const disclosure = page.getByRole("button", { name: "导入已有应用私钥（可选）", exact: true });
    const disclosureGeometry = await completeButtonLabel(disclosure, page);
    await disclosure.tap();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("textbox", { name: "应用私钥", exact: true })).toBeVisible();
    await disclosure.tap();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    const values = [];
    for (const name of ["沙箱环境", "生产环境"]) {
      await environment.click();
      await page.getByRole("option", { name, exact: true }).click();
      await expect(environment.locator('[data-slot="select-value"]')).toHaveText(name);
      values.push(await completeSelectValue(environment, page));
    }
    await record(page, info, { evidence: "desktop browser touch emulation", rootFont: 200, providerEnvironmentValues: values, disclosureGeometry });
  });

  for (const font of [100, 200]) {
    test(`chart style choices preserve complete labels and keyboard selection at ${font}% text`, async ({ page, manifest }, info) => {
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/settings/display");
      const group = page.getByRole("group", { name: "首页图表样式", exact: true });
      await expect(group).toBeVisible();
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      const values = [];
      for (const [name, value] of [["面积图", "AREA"], ["柱状图", "BAR"], ["折线图", "LINE"]] as const) {
        const choice = group.getByRole("button", { name, exact: true });
        const geometry = await completeButtonLabel(choice, page);
        await choice.tap();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator('input[name="dashboard_chart_type"]')).toHaveValue(value);
        values.push({ name, value, geometry });
      }
      const layout = await group.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, scrollWidth: element.scrollWidth,
          choices: [...element.querySelectorAll('button')].map(choice => {
            const rect = choice.getBoundingClientRect();
            return { left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top };
          }) };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.choices.every(choice => choice.left >= -1 && choice.right <= layout.width + 1)).toBe(true);
      expect(new Set(layout.choices.map(choice => Math.round(choice.top))).size, "the joined group keeps a horizontal row").toBe(1);
      await expect(group).toHaveAttribute("data-spacing", "0");
      await expect(group).toHaveAttribute("data-orientation", "horizontal");
      const first = group.getByRole("button", { name: "面积图", exact: true });
      await first.tap();
      await first.focus();
      await page.keyboard.press("ArrowRight");
      const next = group.getByRole("button", { name: "柱状图", exact: true });
      await expect(next).toBeFocused();
      await page.keyboard.press("Space");
      await expect(next).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('input[name="dashboard_chart_type"]')).toHaveValue("BAR");
      await record(page, info, { evidence: "desktop browser touch emulation", rootFont: font, chartStyleChoices: values, layout });
    });
  }

  for (const [font, textSpacing] of [[200, false], [100, true]] as const) {
    test(`backup units remain complete and preserve the interval at ${font}% text, spacing=${textSpacing}`, async ({ page, manifest }, info) => {
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/settings/backup");
      const units = page.getByRole("combobox", { name: "备份间隔单位", exact: true });
      const amount = page.getByRole("spinbutton", { name: "备份间隔", exact: true });
      await expect(units).toBeVisible();
      const initialAmount = Number(await amount.inputValue());
      const initialUnit = await units.locator('[data-slot="select-value"]').innerText();
      const seconds = initialAmount * new Map([["秒", 1], ["小时", 3600], ["天", 86400]]).get(initialUnit)!;
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      if (textSpacing) await page.evaluate(() => {
        for (const element of document.querySelectorAll<HTMLElement | SVGElement>("*")) {
          element.style.setProperty("line-height", "1.5", "important");
          element.style.setProperty("letter-spacing", ".12em", "important");
          element.style.setProperty("word-spacing", ".16em", "important");
          if (element.tagName === "P") element.style.setProperty("margin-bottom", "2em", "important");
        }
      });
      const values = [];
      for (const [name, scale] of [["天", 86400], ["小时", 3600], ["秒", 1]] as const) {
        await units.click();
        await page.getByRole("option", { name, exact: true }).click();
        await expect(units.locator('[data-slot="select-value"]')).toHaveText(name);
        expect(Number(await amount.inputValue()) * scale).toBe(seconds);
        const geometry = await completeSelectValue(units, page);
        const layout = await units.evaluate(element => {
          const input = element.parentElement!.querySelector('input[type="number"]')!;
          const unit = element.getBoundingClientRect(), number = input.getBoundingClientRect();
          const group = element.parentElement!.getBoundingClientRect();
          return { width: group.width, scrollWidth: element.parentElement!.scrollWidth,
            overlap: Math.min(unit.right, number.right) - Math.max(unit.left, number.left) > 1 &&
              Math.min(unit.bottom, number.bottom) - Math.max(unit.top, number.top) > 1 };
        });
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.overlap).toBe(false);
        values.push({ name, geometry, layout });
      }
      await record(page, info, { evidence: "desktop browser touch emulation", rootFont: font, textSpacing, backupUnitValues: values, unchangedIntervalSeconds: seconds });
    });
  }
});
