import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { expect } from "./fixtures";
export async function audit(page: Page, info: TestInfo, id: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const axes = await page.locator("text.recharts-cartesian-axis-tick, .recharts-cartesian-axis-tick text, text.recharts-cartesian-axis-tick-value").evaluateAll(elements => {
    const context = document.createElement("canvas").getContext("2d")!;
    const rgb = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const luminance = (values: number[]) => values.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
    return elements.filter(e => e.getBoundingClientRect().width > 0).map(element => {
      const foreground = getComputedStyle(element).fill;
      const background = getComputedStyle(element.closest('[data-slot="card"]') ?? document.body).backgroundColor;
      const fg = rgb(foreground), bg = rgb(background), alpha = fg[3]! / 255;
      const ink = fg.slice(0, 3).map((value, index) => value * alpha + bg[index]! * (1 - alpha));
      const first = luminance(ink), second = luminance(bg);
      return { text: element.textContent, foreground, background, contrast: (Math.max(first, second) + .05) / (Math.min(first, second) + .05) };
    });
  });
  const path = info.outputPath(id + "-accessibility.json");
  writeFileSync(path, JSON.stringify({ url: page.url(),
    passed: result.passes.map(rule => ({ id: rule.id, nodes: rule.nodes.length })), failed: result.violations,
    undetermined: result.incomplete, excluded: result.inapplicable.map(rule => rule.id), manualReviewEvidence: { svgAxes: axes,
      note: "Axis foreground is sampled with browser canvas against the card. Confirm tick boxes have no chart image behind them from the screenshot; axe incomplete is retained." } }, null, 2));
  await info.attach(id + "-accessibility", { path, contentType: "application/json" });
  expect.soft(result.violations, page.url()).toEqual([]);
  if (await page.locator(".recharts-surface").count()) expect.soft(axes.length, "SVG tick labels were measured").toBeGreaterThan(0);
  expect.soft(axes.filter(axis => axis.contrast < 4.5), "SVG axis contrast against the card").toEqual([]);
}
export async function screenshot(page: Page, info: TestInfo, id: string) {
  const path = info.outputPath(id + ".png");
  await page.screenshot({ path, fullPage: true });
  await info.attach(id, { path, contentType: "image/png" });
}
