import { test, expect, record } from "./fixtures";
test("rejection pages use the real response nonce, preserve admission boundaries and provide a reload action", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const response = await page.goto(manifest.origin + "/checkout/invalid-do-not-echo");
    expect(response!.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("收银台不存在");
    await expect(page.getByText(/请向商家获取新的付款链接/)).toBeVisible();
    expect(await page.locator("style[nonce]").evaluate(e => (e as HTMLStyleElement).nonce)).toBeTruthy();
    expect(await page.locator("body").evaluate(e => getComputedStyle(e).display)).toBe("grid");
    await record(page, info, { theme, status: 404, csp: response!.headers()["content-security-policy"] });
  }
  for (let i = 0; i < 120; i++) await page.request.get(manifest.origin + "/checkout/bad");
  const limited = await page.goto(manifest.origin + "/checkout/bad");
  expect(limited!.status()).toBe(429);
  expect(Number(limited!.headers()["retry-after"])).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "重新加载页面" })).toBeVisible();
  await record(page, info, { status: 429 });
});
