import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} ${viewport.width}: all valid admin routes`, async ({ page, manifest }, info) => {
    test.setTimeout(600_000);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
    await login(page, manifest);
    for (const route of manifest.routes) {
      await page.goto(manifest.origin + "/admin" + route);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
      await expect(page.locator('#main-content h1, #main-content [role="heading"][aria-level="1"]')).toHaveCount(1);
      await expect(page.locator("#main-content")).not.toContainText("未找到这条对账记录");
      await record(page, info, { route });
      const id = route.replaceAll(/[^\w-]/g, "_") || "overview";
      await screenshot(page, info, id);
      await audit(page, info, id);
    }
  });
}

for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} ${viewport.width}: all checkout visual states`, async ({ page, manifest }, info) => {
    test.setTimeout(300_000);
    await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: theme });
    const cases = [
      { id: "open", heading: "支付宝付款" }, { id: "fullEvidence", heading: "收款已确认" },
      { id: "expired", heading: "订单已过期" }, { id: "closed", heading: "订单已关闭" },
      { id: "disputed", heading: "付款待核实" }, { id: "missing", heading: "找不到这个订单" },
      { id: "limited", heading: "请求过于频繁", error: 429 as const }, { id: "unavailable", heading: "暂时无法确认付款", error: 503 as const },
    ];
    for (const item of cases) {
      await manifest.setCheckoutFailure(item.error ?? null);
      const path = item.id === "missing" ? "/checkout/pct1_" + Buffer.alloc(32, 7).toString("base64url") : manifest.checkouts[item.id] ?? manifest.checkouts.open!;
      await page.goto(manifest.origin + path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(item.heading);
      if (item.id === "open") await expect(page.locator("[data-qr-image]")).toBeVisible();
      else await expect(page.locator("[data-qr-image]")).toHaveCount(0);
      await record(page, info, { scenario: item.id, syntheticError: item.error ?? null });
      await screenshot(page, info, "checkout-" + item.id);
      await audit(page, info, "checkout-" + item.id);
    }
  });
}

test("expanded admin geometry: widths, themes, sidebar, content width and density", async ({ page, manifest }, info) => {
  test.setTimeout(600_000); await login(page, manifest);
  for (const [width, height] of [[320, 720], [390, 664], [639, 720], [640, 720], [767, 768], [768, 768], [1024, 768], [1280, 800], [1366, 768], [1920, 1080], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"]) for (const density of ["compact", "comfortable"]) for (const expectedSidebar of width >= 1024 ? ["expanded", "collapsed"] : ["drawer"]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(({ theme, mode, density }) => {
        localStorage.setItem("perpay:theme", theme); localStorage.setItem("perpay:content-width", mode); localStorage.setItem("perpay:list-density", density);
      }, { theme, mode, density });
      for (const route of ["/orders", "/work-items", "/notifications", "/reconciliation"]) {
        await page.goto(manifest.origin + "/admin" + route);
        await expect(page.locator("[data-business-table]")).toBeVisible();
        await expect(page.locator("[data-business-row]").first()).toBeVisible();
        const sidebar = width >= 1024 ? page.locator('[data-slot="sidebar"][data-state]') : null;
        if (sidebar) {
          if (await sidebar.getAttribute("data-state") !== expectedSidebar) await page.getByRole("button", { name: "切换导航", exact: true }).click();
          await expect(sidebar).toHaveAttribute("data-state", expectedSidebar);
        }
        await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
        await expect(page.locator("[data-business-table]")).toHaveAttribute("data-density", density);
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
        const alignment = await page.locator(".business-table").evaluateAll(tables => tables.flatMap(table => [...table.querySelectorAll('th[data-column-align="center"]')].flatMap(header => {
          const column = header.getAttribute("data-column-id");
          const center = (r: DOMRect) => r.x + r.width / 2;
          const origin = center(header.getBoundingClientRect());
          const cell = table.querySelector(`tbody td[data-column-id="${column}"]`);
          if (!cell) return [];
          // A labelled secondary amount is one content group; its numeric suffix
          // is not a separately centred column within that line.
          return [...cell.querySelectorAll(":scope > .list-money,.business-cell-stack > .list-money,.business-cell-stack > .list-meta,[data-slot=badge],:scope > .list-time")].filter(e => e.getBoundingClientRect().width > 0).map(e => ({ column, difference: Math.abs(center(e.getBoundingClientRect()) - origin) }));
        })));
        await record(page, info, { route, requested: { width, mode, density, theme, sidebar: sidebar ? expectedSidebar : "drawer" }, alignment });
        expect(alignment.filter(value => value.difference >= 1)).toEqual([]);
      }
    }
  }
});
