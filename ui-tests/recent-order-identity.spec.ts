import { test, expect, login } from "./fixtures";

test("recent order identity stays readable beside long statuses at narrow widths and enlarged text", async ({ page, manifest }) => {
  await page.route("**/api/admin/v1/orders?*", async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (new URL(route.request().url()).searchParams.get("limit") === "5") {
      body.data[0].notification_summary = { status: "NOT_CONFIGURED", total_events: 0, acknowledged_events: 0 };
    }
    await route.fulfill({ response, json: body });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  for (const [width, scale] of [[320, 1], [390, 2]]) {
    await page.setViewportSize({ width: width!, height: 900 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = 16 * scale! + "px"; }, scale);
    const row = page.locator(".overview-order-summary").first();
    await expect(row.getByText("此订单未设置通知地址")).toBeVisible();
    await page.clock.runFor(100);
    const geometry = await row.evaluate(element => {
      const title = element.querySelector(".list-identity-title")!;
      const box = title.getBoundingClientRect(), parent = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(title);
      return { width: box.width, bounds: parent.width, text: [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ left: rect.left - parent.left, right: rect.right - parent.left })), overflow: element.scrollWidth > element.clientWidth + 1 };
    });
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.text.length).toBeGreaterThan(0);
    expect(geometry.text.every(rect => rect.left >= -1 && rect.right <= geometry.bounds + 1)).toBe(true);
    expect(geometry.overflow).toBe(false);
  }
});
