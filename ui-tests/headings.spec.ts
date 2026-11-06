import { test, expect, login, record } from "./fixtures";
import { expectOverlayTarget } from "./overlay-fixtures";

test("pages and detail overlays expose one foreground title while the mobile header stays on one 56px row", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  for (const route of ["/orders", "/notifications", "/settings/collection", "/system", "/unknown-page"]) {
    await page.goto(manifest.origin + "/admin" + route);
    const heading = page.locator('#main-content h1, #main-content [role="heading"][aria-level="1"]');
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible();
    await expect(page.getByRole("navigation", { name: "页面路径" })).toBeVisible();
    expect((await page.locator(".site-header").boundingBox())!.height).toBe(56);
    expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(56);
    await record(page, info, { route });
  }
  const route = manifest.routes.find(route => route.startsWith("/orders/"))!;
  await page.goto(manifest.origin + "/admin" + route);
  await expectOverlayTarget(page, route);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(dialog.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "页面路径" })).toHaveCount(0);
  await record(page, info, { route, foreground: "detail-overlay" });
});
