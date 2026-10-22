import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";
import type { AdminLedgerPageEnvelope } from "../web/src/api/generated/types.gen";

const endpoint = "/api/admin/v1/ledger/entries";
const shortOrder = { product_name: "收纳盒", merchant_order_no: "ORDER-SHORT", site_name: "示例站" };

for (const scenario of [
  { name: "Chinese product", product: "完整商品名称".repeat(30) },
  { name: "unbroken product", product: "A".repeat(200) },
]) {
  test(`${scenario.name}: long current-order identities stay inside the ledger table`, async ({ page, manifest }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, manifest);
    const response = await page.request.get(manifest.origin + endpoint + "?association_status=MATCHED&limit=20");
    expect(response.status()).toBe(200);
    const source = await response.json() as AdminLedgerPageEnvelope;
    const entries = source.data.filter(entry => entry.active_match_count === 1 && entry.active_match).slice(0, 2);
    expect(entries).toHaveLength(2);
    const longOrder = {
      product_name: scenario.product,
      merchant_order_no: "ORDER012".repeat(8),
      site_name: "网站名称".repeat(10),
    };
    const data = entries.map((entry, index) => ({
      ...entry,
      active_match: { ...entry.active_match!, ...(index === 0 ? shortOrder : longOrder) },
    }));
    // Only display fields are synthetic. The two records and their order targets
    // come from the isolated fixture; no financial write is performed.
    await page.route(manifest.origin + endpoint + "?**", route => route.fulfill({
      status: 200,
      json: { ...source, data, page: { next_cursor: null } },
    }));

    for (const width of [1440, 1600]) for (const mode of ["compact", "full"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(mode => localStorage.setItem("perpay:content-width", mode), mode);
      await page.goto(manifest.origin + "/admin/reconciliation?association_status=MATCHED");
      const table = page.getByRole("table", { name: "支付宝流水", exact: true });
      const cells = table.locator('td[data-column-id="order"]');
      await expect(cells).toHaveCount(2);
      await expect(cells.nth(1).getByText(longOrder.product_name, { exact: true })).toHaveAttribute("title", longOrder.product_name);
      await expect(cells.nth(1).getByRole("link", { name: "查看订单：" + longOrder.merchant_order_no })).toHaveAttribute("href", "/admin/orders/" + data[1]!.active_match.order_id);
      await page.evaluate(() => document.fonts.ready);

      const measured = await table.evaluate(table => {
        const container = table.parentElement!;
        return {
          tableWidth: table.getBoundingClientRect().width,
          containerWidth: container.clientWidth,
          containerScrollWidth: container.scrollWidth,
          cells: [...table.querySelectorAll('td[data-column-id="order"]')].map(cell => ({
            width: cell.getBoundingClientRect().width,
            lines: [...cell.querySelectorAll(".ledger-order-line")].map(line => {
              const style = getComputedStyle(line);
              return {
                height: line.getBoundingClientRect().height,
                width: line.getBoundingClientRect().width,
                lineHeight: Number.parseFloat(style.lineHeight),
                padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
                scrollWidth: line.scrollWidth,
                clientWidth: line.clientWidth,
              };
            }),
          })),
        };
      });
      // A page-level overflow assertion misses a wide table inside its scroller.
      expect(measured.tableWidth).toBeLessThanOrEqual(measured.containerWidth + 1);
      expect(measured.containerScrollWidth).toBeLessThanOrEqual(measured.containerWidth + 1);
      expect(measured.cells).toHaveLength(2);
      for (const cell of measured.cells) {
        expect(cell.lines).toHaveLength(3);
        for (const line of cell.lines) {
          expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth + 1);
          expect(line.height).toBeLessThanOrEqual(2 * line.lineHeight + line.padding + 1);
        }
        // Keep the order link usable even when its identifier is clamped.
        expect(cell.lines[1]!.width).toBeGreaterThanOrEqual(24);
        expect(cell.lines[1]!.height).toBeGreaterThanOrEqual(24);
      }
      expect(measured.cells[0]!.lines[0]!.height).toBeLessThanOrEqual(measured.cells[0]!.lines[0]!.lineHeight + 1);
      expect(measured.cells[1]!.lines[0]!.height).toBeGreaterThan(measured.cells[1]!.lines[0]!.lineHeight);
      await record(page, info, { feature: "ledger-order-long-identity", scenario: scenario.name, width, mode, measured, evidence: "synthetic-display-fields-on-isolated-records" });
      await screenshot(page, info, `ledger-order-${scenario.name.split(" ")[0]}-${width}-${mode}`);
    }

    const orderLink = page.getByRole("link", { name: "查看订单：" + longOrder.merchant_order_no });
    await orderLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + data[1]!.active_match.order_id);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("订单详情");
  });
}
