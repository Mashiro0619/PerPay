import { test, expect, login } from "./fixtures";

test("mobile reconciliation keeps the associated order and collection account identifiable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/reconciliation");
  const row = page.locator('[data-business-table="administrator-ledger"] [data-business-row]')
    .filter({ has: page.getByRole("link", { name: /^查看订单：/ }) }).first();
  await expect(row).toBeVisible();
  for (const [width, font] of [[390, 100], [320, 200]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(font => { document.documentElement.style.fontSize = font + "%"; }, font);
    await page.clock.runFor(100);
    for (const name of ["订单", "账号"]) {
      const term = row.getByText(name, { exact: true });
      await expect(term).toBeVisible();
      expect(await term.evaluate(element => getComputedStyle(element).clipPath)).toBe("none");
    }
    await expect(row.getByRole("link", { name: /^查看订单：/ })).toBeVisible();
    await expect(row.getByText("演示收款账号", { exact: true })).toBeVisible();
    expect(await row.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: info.outputPath(`ledger-order-account-${width}-${font}.png`) });
  }
});

test("settings summaries expose account identity and stored allowlist without editing", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const path = manifest.extendedRoutes.find(route => route.endsWith("/settings/collection"))!;
  expect(path).toBeTruthy();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin" + path);
    const summary = page.locator("[data-site-collection-summary]");
    await expect(summary.getByText("演示收款账号", { exact: true })).toBeVisible();
    await expect(summary.getByText(/^账号 ID：/)).toBeVisible();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.screenshot({ path: info.outputPath(`collection-summary-${width}.png`) });
  }
  // Read-only response fixture: never changes the server's access policy.
  await page.route("**/api/admin/v1/settings", async route => {
    const response = await route.fetch(); const body = await response.json();
    body.data.admin_access = { enabled: false, cidrs: ["203.0.113.15/32", "2001:db8::/64"] };
    await route.fulfill({ response, json: body });
  });
  await page.goto(manifest.origin + "/admin/settings/security");
  const rules = page.getByRole("list", { name: "已保存的白名单规则" });
  await expect(rules.getByText("203.0.113.15/32", { exact: true })).toBeVisible();
  await expect(rules.getByText("2001:db8::/64", { exact: true })).toBeVisible();
  expect(await page.getByRole("dialog").count()).toBe(0);
  await page.screenshot({ path: info.outputPath("allowlist-summary-mobile.png") });
});

test("mobile website rows explain metrics and enter the selected workspace directly", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/sites");
  const row = page.locator('[data-business-table="sites"] [data-business-row]').first();
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-business-row");
  const label = row.getByText("待处理", { exact: true });
  await expect(label).toBeVisible();
  const painted = await label.evaluate(element => ({ width: element.getBoundingClientRect().width, clip: getComputedStyle(element).clipPath }));
  expect(painted.width).toBeGreaterThan(20);
  expect(painted.clip).toBe("none");
  await expect(row.getByText(/近 30 天实收/)).toBeVisible();
  await expect(row.getByRole("link", { name: /^网站设置：/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile-website-actions.png") });
  await row.getByRole("link", { name: "进入后台", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/sites/" + id);
  expect(new URL(page.url()).searchParams.has("overlay")).toBe(false);
});

test("confirmation and dispute notifications keep distinct event identities on desktop and mobile", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const response = await page.request.get(manifest.origin + "/api/admin/v1/webhooks/deliveries?limit=100&sort_by=created_at&sort_order=desc");
  expect(response.ok()).toBe(true);
  const { data } = await response.json() as { data: Array<{ delivery_id: string; event: { order_id: string; event_type: string } }> };
  const disputed = data.find(item => item.event.event_type === "PAYMENT_DISPUTED")!;
  const confirmed = data.find(item => item.event.order_id === disputed.event.order_id && item.event.event_type === "PAYMENT_CONFIRMED")!;
  expect(disputed).toBeTruthy(); expect(confirmed).toBeTruthy();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/notifications");
    for (const [item, text] of [[confirmed, "收款已确认"], [disputed, "收款有争议"]] as const) {
      const row = page.locator('[data-business-row="' + item.delivery_id + '"]');
      await expect(row.getByText(text, { exact: true })).toBeVisible();
      await expect(row.getByText("通知已确认", { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`notification-identities-${width}.png`) });
  }
});
