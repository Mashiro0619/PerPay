import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { expect } from "./fixtures";
import { measureAxisContrast, resolveSvgContrast } from "./contrast-evidence";
import { resolveDialogDescriptionContrast } from "./dialog-contrast-evidence";
export async function audit(page: Page, info: TestInfo, id: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const axes = [];
  for (const axis of await page.locator("text.recharts-cartesian-axis-tick, .recharts-cartesian-axis-tick text, text.recharts-cartesian-axis-tick-value").all()) {
    if (await axis.isVisible()) axes.push(await axis.evaluate(measureAxisContrast));
  }
  const svgReviews = await resolveSvgContrast(page, result);
  const descriptionReviews = await resolveDialogDescriptionContrast(page, result);
  const contrastReviews = svgReviews.map(review => {
    const description = !review.resolved && descriptionReviews.find(item => JSON.stringify(item.target) === JSON.stringify(review.target));
    return description ? { ...review, resolved: description.resolved, htmlDescription: description.measurement } : review;
  });
  const unresolvedContrast = contrastReviews.filter(review => !review.resolved);
  const path = info.outputPath(id + "-accessibility.json");
  writeFileSync(path, JSON.stringify({ url: page.url(),
    passed: result.passes.map(rule => ({ id: rule.id, nodes: rule.nodes.length })), failed: result.violations,
    undetermined: result.incomplete, excluded: result.inapplicable.map(rule => rule.id), manualReviewEvidence: { svgAxes: axes,
      colorContrastIncomplete: { nodeCount: contrastReviews.length, resolvedCount: contrastReviews.length - unresolvedContrast.length,
        unresolvedCount: unresolvedContrast.length, nodes: contrastReviews },
      note: "Raw axe incomplete results are retained. SVG imgNode cases use axis paint/geometry evidence. Plain HTML dialog descriptions with elmPartiallyObscuring use separate opaque-color, per-character hit and clipping evidence. Other uncertain nodes remain unresolved." } }, null, 2));
  await info.attach(id + "-accessibility", { path, contentType: "application/json" });
  expect.soft(result.violations, page.url()).toEqual([]);
  if (await page.locator(".recharts-surface").count()) expect.soft(axes.length, "SVG tick labels were measured").toBeGreaterThan(0);
  expect.soft(axes.filter(axis => axis === null || axis.contrast === null || axis.contrast < 4.5), "SVG axis contrast against its actual background").toEqual([]);
  expect.soft(axes.filter(axis => !axis?.passed), "SVG tick labels remain readable and unclipped").toEqual([]);
  expect.soft(unresolvedContrast, "every axe color-contrast incomplete node has explicit resolution evidence").toEqual([]);
}
export async function screenshot(page: Page, info: TestInfo, id: string) {
  const path = info.outputPath(id + ".png");
  await page.screenshot({ path, fullPage: true });
  await info.attach(id, { path, contentType: "image/png" });
}
