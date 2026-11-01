import { test, login } from "./fixtures";
import { auditAdminRoutes } from "./admin-route-readiness";

for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} ${viewport.width}: wizard, website settings and scoped details`, async ({ page, manifest }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
    await login(page, manifest);
    await auditAdminRoutes(page, manifest, info, manifest.extendedRoutes, "extended");
  });
}
