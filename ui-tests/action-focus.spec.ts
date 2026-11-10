import { test, expect, login, record } from "./fixtures";
import { randomUUID } from "node:crypto";
import type { LedgerConflictDetail, WebhookDeliveryDetail, WebhookRedeliveryEnvelope, WebhookRedeliveryRequest } from "../web/src/api/generated/types.gen";
import { expectOverlayTarget, openRecord } from "./overlay-fixtures";

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
    const newDeliveryId = randomUUID();
    const newApiPath = `/api/admin/v1/webhooks/deliveries/${newDeliveryId}`;
    let newDetail: WebhookDeliveryDetail | null = null;
    if (kind === "conflict") {
      (completed as LedgerConflictDetail).conflict.status = "RESOLVED";
      (completed as LedgerConflictDetail).conflict.resolved_at = new Date(manifest.epoch).toISOString();
    } else {
      (completed as WebhookDeliveryDetail).is_latest = false;
      (completed as WebhookDeliveryDetail).latest_delivery_id = newDeliveryId;
    }
    let saved = false;
    const intercepted: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
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
        if (kind === "notification") {
          const requestBody = request.postDataJSON() as WebhookRedeliveryRequest;
          const original = before as WebhookDeliveryDetail;
          const now = new Date(manifest.epoch).toISOString();
          newDetail = { ...structuredClone(original), is_latest: true, latest_delivery_id: newDeliveryId,
            delivery: { ...original.delivery, delivery_id: newDeliveryId, generation: original.delivery.generation + 1,
              predecessor_delivery_id: id, request_key: requestBody.redelivery_id,
              requested_by_type: "ADMIN", requested_by_actor_id: "admin", reason: requestBody.reason,
              status: "PENDING", attempt_count: 0, next_attempt_at: now, lease_expires_at: null,
              acknowledged_at: null, dead_lettered_at: null, last_error_code: null, created_at: now, updated_at: now } };
          const body = { data: { delivery: newDetail.delivery, replayed: false } } satisfies WebhookRedeliveryEnvelope;
          await route.fulfill({ status: 201, json: body });
        } else await route.fulfill({ status: 200, json: { data: {} } });
        return;
      }
      if (saved && pathname === apiPath) await route.fulfill({ status: 200, json: { data: completed } });
      else if (newDetail && pathname === newApiPath) await route.fulfill({ status: 200, json: { data: newDetail } });
      else if (newDetail && pathname === newApiPath + "/attempts") await route.fulfill({ status: 200, json: { data: [] } });
      else await route.continue();
    });
    const recordDialog = await openRecord(page, manifest, path);
    const actionName = kind === "conflict" ? "保留已有流水" : "重新发送";
    const submitName = kind === "conflict" ? "确认处理冲突" : "确认重新发送";
    const action = recordDialog.getByRole("button", { name: actionName, exact: true });
    await expect(action).toBeVisible();
    await action.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("[data-overlay-step]:visible");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(recordDialog).toBeVisible();
    await expect(action).toBeFocused();
    expect(intercepted).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("操作理由", { exact: true }).fill("合成成功响应，仅核对键盘焦点，不发送实际操作。");
    await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
    await dialog.getByRole("button", { name: submitName, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    if (kind === "notification") {
      await expectOverlayTarget(page, "/notifications/" + newDeliveryId);
      await expect(recordDialog.getByText("等待投递", { exact: true })).toBeVisible();
      await expect(recordDialog.getByText("已尝试 0 次", { exact: true })).toBeVisible();
      await expect(recordDialog.getByRole("link", { name: "查看原投递", exact: true })).toHaveAttribute("href", new RegExp(encodeURIComponent("/notifications/" + id)));
      await expect(recordDialog.locator("[data-overlay-heading]")).toBeFocused();
    }
    await expect(action).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const focused = document.activeElement;
      return focused instanceof HTMLElement && !!focused.closest("[data-overlay-content]");
    })).toBe(true);
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-overlay-content]"))).toBe(true);
    expect(intercepted).toEqual([actionPath]);
    // APIRequest bypasses page interception and proves the actual record did
    // not change while the browser displayed a completed synthetic response.
    const unchanged = await page.request.get(manifest.origin + apiPath);
    expect(unchanged.status()).toBe(200);
    expect((await unchanged.json()).data).toEqual(before);
    expect(errors).toEqual([]);
    await record(page, info, { feature: "completed-action-focus", kind, intercepted, evidence: "synthetic-success-no-server-writes" });
  });
}
