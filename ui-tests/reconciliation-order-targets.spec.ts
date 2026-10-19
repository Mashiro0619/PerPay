import { test, expect, login, record } from "./fixtures";

for (const width of [1440, 390]) {
  test(`${width}: related orders have separate usable targets and preserve record navigation`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, manifest);
    const listUrl = manifest.origin + "/admin/reconciliation";
    await page.goto(listUrl);
    const row = page.locator("[data-business-row]").first();
    const relatedOrder = row.getByRole("link", { name: /^查看订单：/ });
    const recordLink = row.locator("a[data-row-link]");
    await expect(relatedOrder).toBeVisible();
    await expect(row.locator(".list-identity-meta")).toContainText(await relatedOrder.innerText());

    const orderHref = await relatedOrder.getAttribute("href");
    const recordHref = await recordLink.getAttribute("href");
    expect(orderHref).toMatch(/^\/admin\/orders\//);
    expect(recordHref).toMatch(/^\/admin\/reconciliation\/matches\//);
    expect(orderHref).not.toBe(recordHref);

    const targets = await page.locator("[data-business-row]").evaluateAll(rows => rows.map(element => {
      const order = element.querySelector('a[aria-label^="查看订单："]')!.getBoundingClientRect();
      const record = element.querySelector("a[data-row-link]")!.getBoundingClientRect();
      return { width: order.width, height: order.height, gap: order.top - record.bottom };
    }));
    await record(page, info, { targets });
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(target => target.width >= 24 && target.height >= 24)).toBe(true);
    expect(targets.every(target => target.gap >= 4)).toBe(true);

    // The padded edge belongs to the order link, not the row's different action.
    await relatedOrder.click({ position: { x: 4, y: 1 } });
    await expect(page).toHaveURL(manifest.origin + orderHref);
    await page.goto(listUrl);
    await expect(relatedOrder).toBeVisible();
    await relatedOrder.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + orderHref);

    await page.goto(listUrl);
    await expect(recordLink).toBeVisible();
    await recordLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + recordHref);

    await page.goto(listUrl);
    await expect(row).toBeVisible();
    const bounds = (await row.boundingBox())!;
    await row.click({ position: { x: bounds.width - 3, y: bounds.height / 2 } });
    await expect(page).toHaveURL(manifest.origin + recordHref);
  });
}
