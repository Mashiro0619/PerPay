import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("a late website deletion preserves the administrator's selected page and refreshes shared websites", async ({ page }) => {
  const fixture = await createSettingsServer(Date.now());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/sites/default/settings/basic");
    const siteUrl = fixture.origin + "/api/admin/v1/sites/default";
    let deleted = false;
    let deleteRequests = 0;
    await page.route(siteUrl, async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteRequests++;
      // The real SQLite delete commits; only its browser response is delayed.
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      deleted = true;
      await held;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "删除空业务网站", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(() => deleted).toBe(true);
    await page.getByRole("link", { name: /运行状态/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "运行状态", exact: true })).toBeVisible();
    const destination = page.url();
    expect(new URL(destination).pathname).toBe("/admin/system");
    const refreshedSites = page.waitForResponse(response => response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/admin/v1/sites");
    release();
    const refreshed = await refreshedSites;
    expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).data).toEqual([]);
    await expect(page).toHaveURL(destination);
    await expect(page.getByRole("heading", { level: 1, name: "运行状态", exact: true })).toBeVisible();
    expect((await page.request.get(siteUrl)).status()).toBe(404);
    expect(deleteRequests).toBe(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await fixture.close();
  }
});
