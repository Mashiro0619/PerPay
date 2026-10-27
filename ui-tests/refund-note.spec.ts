import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("refund notes accept 500 emoji and reject 501 ordinary Chinese characters", async ({ page }) => {
  const fixture = await createSettingsServer(Date.now());
  try {
    const orderId = fixture.seedPaidOrder();
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/orders/" + orderId);
    await page.getByRole("button", { name: "更多操作，订单操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "标记已退款", exact: true }).click();
    const note = page.getByLabel("备注（可选）", { exact: true });
    await expect(note).toHaveAttribute("maxlength", "1000");
    await note.fill("汉".repeat(501));
    await expect(page.getByText("备注最多 500 字。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认标记已退款" })).toBeDisabled();
    const emoji = "🙂".repeat(500);
    await note.fill(emoji);
    await expect(note).toHaveValue(emoji);
    await expect(page.getByRole("button", { name: "确认标记已退款" })).toBeEnabled();
    const response = page.waitForResponse(result => result.url().endsWith("/refund-mark") && result.request().method() === "PUT");
    await page.getByRole("button", { name: "确认标记已退款" }).click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect((await saved.json()).data.refund_mark.note).toBe(emoji);
    await expect(page.getByText("本次退款标记已保存", { exact: true })).toBeVisible();
  } finally { await fixture.close(); }
});
