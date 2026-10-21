import { test, expect, login, record } from "./fixtures";

for (const { width, hiddenOrder } of [{ width: 1440, hiddenOrder: false }, { width: 1440, hiddenOrder: true }, { width: 390, hiddenOrder: false }]) {
  test(`${width}${hiddenOrder ? " hidden order column" : ""}: related orders have separate usable targets and preserve record navigation`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, manifest);
    await page.evaluate(hiddenOrder => {
      localStorage.setItem("perpay:content-width", "full");
      if (hiddenOrder) localStorage.setItem("perpay.table-columns.v2.administrator-ledger", JSON.stringify({ order: false }));
    }, hiddenOrder);
    const listUrl = manifest.origin + "/admin/reconciliation?association_status=MATCHED";
    await page.goto(listUrl);
    // Multiple active associations deliberately have no single order target.
    const linkedRows = page.locator("[data-business-row]").filter({ has: page.getByRole("link", { name: /^查看订单：/ }) });
    const row = linkedRows.first();
    const relatedOrder = row.getByRole("link", { name: /^查看订单：/ });
    const recordLink = row.locator("a[data-row-link]");
    await expect(relatedOrder).toBeVisible();
    const orderText = await relatedOrder.innerText();
    if (hiddenOrder) await expect(row.locator(".list-identity-meta")).toContainText(orderText);
    else if (width === 1440) await expect(row.locator('[data-column-id="order"]')).toContainText(orderText);
    else await expect(row.locator(".business-summary-field").filter({ has: page.locator("dt", { hasText: "当前关联订单" }) })).toContainText(orderText);

    const orderHref = await relatedOrder.getAttribute("href");
    const recordHref = await recordLink.getAttribute("href");
    expect(orderHref).toMatch(/^\/admin\/orders\//);
    expect(recordHref).toMatch(/^\/admin\/reconciliation\/transactions\//);
    expect(orderHref).not.toBe(recordHref);

    const targets = await linkedRows.evaluateAll(rows => rows.map(element => {
      const order = element.querySelector('a[aria-label^="查看订单："]')!.getBoundingClientRect();
      const record = element.querySelector("a[data-row-link]")!.getBoundingClientRect();
      return { width: order.width, height: order.height,
        gap: Math.max(order.top - record.bottom, record.top - order.bottom, order.left - record.right, record.left - order.right) };
    }));
    await record(page, info, { hiddenOrder, targets });
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
