import { test, expect, login, record } from "./fixtures";
import type { LedgerConflictDetail, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

for (const kind of ["conflict", "notification"] as const) {
  test(`${kind}: cancelling restores the action and success preserves keyboard position after it disappears`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, manifest);
    const path = kind === "conflict"
      ? manifest.routes.find(route => route.startsWith("/reconciliation/conflicts/"))!
      : manifest.details.notificationDead!;
    const id = path.split("/").at(-1)!;
    const apiPath = kind === "conflict"
      ? `/api/admin/v1/ledger/conflicts/${id}`
      : `/api/admin/v1/webhooks/deliveries/${id}`;
    const actionPath = apiPath + (kind === "conflict" ? "/actions/resolve" : "/actions/redeliver");
    const beforeResponse = await page.request.get(manifest.origin + apiPath);
    expect(beforeResponse.status()).toBe(200);
    const before = (await beforeResponse.json()).data as LedgerConflictDetail | WebhookDeliveryDetail;
    if (kind === "conflict") expect((before as LedgerConflictDetail).conflict.status).toBe("OPEN");
    else {
      expect((before as WebhookDeliveryDetail).is_latest).toBe(true);
      expect((before as WebhookDeliveryDetail).delivery.status).toBe("DEAD_LETTER");
    }
    const completed = structuredClone(before);
    if (kind === "conflict") {
      (completed as LedgerConflictDetail).conflict.status = "RESOLVED";
      (completed as LedgerConflictDetail).conflict.resolved_at = new Date(manifest.epoch).toISOString();
    } else (completed as WebhookDeliveryDetail).is_latest = false;
    let saved = false;
    const intercepted: string[] = [];
    // Only the disposable fixture receives reads. All writes are intercepted
    // before removing the client-side demo hint to exercise success handling.
    await page.route("**/api/admin/v1/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (!["GET", "HEAD"].includes(request.method())) {
        intercepted.push(pathname);
        if (request.method() !== "POST" || pathname !== actionPath) {
          await route.abort("blockedbyclient");
          return;
        }
        saved = true;
        await route.fulfill({ status: 200, json: { data: {} } });
        return;
      }
      if (saved && pathname === apiPath) await route.fulfill({ status: 200, json: { data: completed } });
      else await route.continue();
    });
    await page.goto(manifest.origin + "/admin" + path);
    const actionName = kind === "conflict" ? "保留已有流水" : "重新发送";
    const submitName = kind === "conflict" ? "确认处理冲突" : "确认重新发送";
    const action = page.getByRole("button", { name: actionName, exact: true });
    await expect(action).toBeVisible();
    await action.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(action).toBeFocused();
    expect(intercepted).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("操作理由", { exact: true }).fill("合成成功响应，仅核对键盘焦点，不发送实际操作。");
    await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
    await dialog.getByRole("button", { name: submitName, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(action).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const focused = document.activeElement;
      return focused instanceof HTMLElement && focused !== document.body && !!focused.closest("#main-content");
    })).toBe(true);
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("#main-content"))).toBe(true);
    expect(intercepted).toEqual([actionPath]);
    // APIRequest bypasses page interception and proves the actual record did
    // not change while the browser displayed a completed synthetic response.
    const unchanged = await page.request.get(manifest.origin + apiPath);
    expect(unchanged.status()).toBe(200);
    expect((await unchanged.json()).data).toEqual(before);
    await record(page, info, { feature: "completed-action-focus", kind, intercepted, evidence: "synthetic-success-no-server-writes" });
  });
}
