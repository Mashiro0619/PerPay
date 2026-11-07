import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { WebhookDeliveryPageEnvelope } from "../web/src/api/generated/types.gen";

test("mobile notifications retain distinct order identities, amounts and dates at enlarged text", async ({ page }, info) => {
  const fixture = await createSettingsServer(Date.now());
  const merchantIds = ["ORDER-A-" + "1234567890".repeat(5), "ORDER-B-" + "1234567890".repeat(5)];
  const orderIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const response: WebhookDeliveryPageEnvelope = { data: merchantIds.map((merchant, index) => {
    const id = orderIds[index]!;
    const createdAt = `2026-11-0${index + 1}T04:00:00.000Z`;
    return {
      delivery_id: id, event_id: id, target_id: id, request_key: id, generation: 1,
      predecessor_delivery_id: null, requested_by_type: "SYSTEM", requested_by_actor_id: null, reason: null,
      status: "ACKNOWLEDGED", attempt_count: 1, next_attempt_at: null, lease_expires_at: null,
      acknowledged_at: createdAt, dead_lettered_at: null, last_error_code: null, created_at: createdAt, updated_at: createdAt,
      event: { event_type: "PAYMENT_CONFIRMED", order_id: id },
      target: { format: "NATIVE_JSON_V1", url_fingerprint: "a".repeat(64) },
      order_summary: { order_id: id, api_client_id: "default", site_name: "同一网站", product_name: "同名商品",
        merchant_order_no: merchant, requested_amount_cents: (index + 1) * 1000 - 1,
        payable_amount_cents: (index + 1) * 1000, received_amount_cents: (index + 1) * 1000, payment_confirmed_at: createdAt },
    };
  }), page: { next_cursor: null } };
  try {
    await page.context().addCookies(fixture.cookies);
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    await page.route("**/api/admin/v1/webhooks/deliveries?**", route => route.fulfill({ json: response }));
    for (const [width, height, scale] of [[390, 844, 100], [320, 560, 200]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(fixture.origin + "/admin/notifications");
      await page.evaluate(scale => document.documentElement.style.fontSize = scale + "%", scale);
      const rows = page.getByRole("list", { name: "通知列表", exact: true }).getByRole("listitem");
      await expect(rows).toHaveCount(2);
      for (const [index, merchant] of merchantIds.entries()) {
        const row = rows.nth(index);
        const link = row.getByRole("link", { name: merchant, exact: true });
        await expect(link).toHaveAttribute("href", "/admin/notifications?overlay=%2Forders%2F" + orderIds[index]);
        await expect(row.getByText("商户订单号", { exact: true })).toBeVisible();
        await expect(row.getByText("创建时间", { exact: true })).toBeVisible();
        await expect(row.getByText(index ? "¥20.00" : "¥10.00", { exact: true })).toBeVisible();
        await expect(row.locator("time")).toHaveAttribute("datetime", `2026-11-0${index + 1}T04:00:00.000Z`);
        await link.scrollIntoViewIfNeeded();
        const bounds = await link.evaluate(element => {
          const box = element.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(element);
          return { width: innerWidth, box: box.toJSON(), text: [...range.getClientRects()].map(rect => rect.toJSON()) };
        });
        expect(bounds.box.left).toBeGreaterThanOrEqual(0);
        expect(bounds.box.right).toBeLessThanOrEqual(bounds.width);
        for (const rect of bounds.text) {
          expect(rect.left).toBeGreaterThanOrEqual(bounds.box.left - 1);
          expect(rect.right).toBeLessThanOrEqual(bounds.box.right + 1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: info.outputPath(`notifications-${width}-${scale}.png`), fullPage: true });
    }
  } finally { await fixture.close(); }
});
