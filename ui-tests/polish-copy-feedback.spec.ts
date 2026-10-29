import { test, expect, login, record } from "./fixtures";

test("copy success, failure and retry keep one focused control with only icon feedback", async ({ page, manifest }, info) => {
  await page.addInitScript(() => {
    const state = window as Window & { __copyOutcome?: "success" | "failure" | "pending"; __finishCopy?: () => void };
    state.__copyOutcome = "success";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => {
      if (state.__copyOutcome === "failure") return Promise.reject(new Error("synthetic denied clipboard"));
      if (state.__copyOutcome === "pending") return new Promise<void>(resolve => { state.__finishCopy = resolve; });
      return Promise.resolve();
    } } });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin" + manifest.details.orderLong!);
  const copy = page.locator('button[data-copy-state]').first();
  await expect(copy).toBeVisible();
  const original = await copy.elementHandle();
  const before = await copy.boundingBox();
  await copy.click();
  await expect(copy).toHaveAttribute("data-copy-state", "success");
  const animated = await copy.locator("[data-copy-feedback]").evaluate(node => ({
    name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration,
  }));
  expect(animated.name).toBe("copy-confirm");
  expect(animated.duration).toBe("0.14s");
  await page.evaluate(() => (window as Window & { __copyOutcome?: string }).__copyOutcome = "failure");
  await copy.click();
  await expect(copy).toHaveAttribute("data-copy-state", "error");
  await expect(copy.locator("[data-copy-feedback]")).toHaveCount(0);
  await expect(page.getByText("复制失败，请选中文本手动复制。", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as Window & { __copyOutcome?: string }).__copyOutcome = "pending");
  await copy.click();
  await expect(copy).toHaveAttribute("data-copy-state", "idle");
  await expect(page.getByText("复制失败，请选中文本手动复制。", { exact: true })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => (window as Window & { __finishCopy?: () => void }).__finishCopy?.());
  await expect(copy).toHaveAttribute("data-copy-state", "success");
  expect(await copy.locator("[data-copy-feedback]").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  expect(await copy.evaluate((node, original) => node === original, original)).toBe(true);
  await expect(copy).toBeFocused();
  const after = await copy.boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
  await record(page, info, { feature: "copy-feedback", animated, before, after, syntheticClipboard: true, controlsRetained: true });
});
