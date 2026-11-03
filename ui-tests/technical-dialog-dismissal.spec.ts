import { test, expect, login, record } from "./fixtures";
import { openTechnicalDialog, closeTechnicalDialog } from "./detail-layout";
import { settleOverlay } from "./overlay-fixtures";

for (const touch of [false, true]) {
  test.describe(touch ? "touch technical reader dismissal" : "mouse technical reader dismissal", () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    test("outside presses close only the secondary reader and never activate the parent", async ({ page, manifest }, info) => {
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin" + manifest.details.orderLong!);
      const parent = await settleOverlay(page);
      const technical = parent.locator('[data-detail-section="history"] > .detail-section-content > [data-technical-information]');
      const url = page.url();
      const writes: string[] = [];
      page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method()); });
      const dismissals = [];
      for (const target of ["parent-close", "page-background"] as const) {
        const session = await openTechnicalDialog(page, technical);
        await session.pre.click();
        await expect(session.dialog).toBeVisible();
        const corner = parent.locator('[data-overlay-primary] > [data-slot="dialog-header"] [data-slot="dialog-close"]');
        const bounds = (await corner.boundingBox())!;
        const point = target === "parent-close" ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: 8, y: 8 };
        const reader = (await session.dialog.boundingBox())!;
        expect(point.x < reader.x || point.x > reader.x + reader.width || point.y < reader.y || point.y > reader.y + reader.height).toBe(true);
        const hit = await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.getAttribute("data-slot"), point);
        expect(hit, "the secondary backdrop covers both the parent controls and page background").toBe("dialog-overlay");
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        await expect(session.dialog).toHaveCount(0);
        await expect(session.trigger).toBeFocused();
        await expect(parent).toBeVisible();
        expect(page.url()).toBe(url);
        const restored = await session.parentState.evaluate(state => ({ before: state.before, after: state.sample(), sameNodes: state.sameNodes() }));
        expect(restored.after).toEqual(restored.before);
        expect(Object.values(restored.sameNodes).every(Boolean)).toBe(true);
        await session.parentState.dispose();
        dismissals.push({ target, point, restored });
      }
      if (!touch) {
        const session = await openTechnicalDialog(page, technical);
        const inside = (await session.body.boundingBox())!;
        await page.mouse.move(inside.x + 12, inside.y + inside.height / 2);
        await page.mouse.down();
        await page.mouse.move(8, 8);
        await page.mouse.up();
        await expect(session.dialog, "dragging a selection from inside the reader does not dismiss it").toBeVisible();
        await closeTechnicalDialog(session);
      }
      expect(writes).toEqual([]);
      await record(page, info, { feature: "technical-dialog-outside-dismissal", touch, dismissals });
    });
  });
}
