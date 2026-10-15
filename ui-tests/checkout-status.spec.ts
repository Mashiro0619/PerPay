import { test, expect, record } from "./fixtures";
for (const theme of ["light", "dark"] as const) test(`${theme}: checkout status uses semantic badges with a single heading`, async ({ page, manifest }, info) => {
  await page.emulateMedia({ colorScheme: theme });
  for (const [scenario, title, variant] of [["open", "支付宝付款", "secondary"], ["fullEvidence", "收款已确认", "success"], ["disputed", "需核对", "destructive"], ["expired", "订单已过期", "secondary"], ["closed", "订单已关闭", "secondary"]]) {
    expect(manifest.checkouts[scenario!], `missing generated ${scenario} fixture`).toBeTruthy();
    await page.goto(manifest.origin + manifest.checkouts[scenario!]!);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title!);
    await expect(page.locator('[data-checkout-payment] [data-slot="badge"]').first()).toHaveAttribute("data-variant", variant!);
    if (scenario !== "open") await expect(page.locator("[data-qr-image]")).toHaveCount(0);
    await record(page, info, { scenario, variant });
  }
});
