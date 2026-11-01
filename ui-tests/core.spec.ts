import { test, expect, login, record } from "./fixtures";
import { waitForAdminRoute } from "./admin-route-readiness";
test("isolated admin routes expose actual records and preserve access boundaries", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const route of ["/orders", "/notifications", ...manifest.routes.filter(path => path.startsWith("/reconciliation/"))]) {
    await page.goto(manifest.origin + "/admin" + route);
    await waitForAdminRoute(page, route);
    await record(page, info);
  }
  const denied = await page.request.post(manifest.origin + "/api/v1/orders", { data: {} });
  expect(denied.status()).toBe(403);
});
test("live payment fixture renders a QR and terminal fixture renders confirmation", async ({ page, manifest }, info) => {
  await page.goto(manifest.origin + manifest.checkouts.open!);
  await expect(page.locator("[data-qr-image]")).toBeVisible();
  await expect(page.locator("[data-countdown]")).toBeVisible();
  await record(page, info);
  await page.goto(manifest.origin + manifest.checkouts.fullEvidence!);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("收款已确认");
});
