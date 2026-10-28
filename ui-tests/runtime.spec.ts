import { test, expect, login, record } from "./fixtures";
test("runtime keeps healthy diagnostics collapsed and version check failures concise", async ({ page, manifest }, info) => {
  let updateRequests = 0;
  await page.route("**/api/admin/v1/system/update*", async route => {
    updateRequests++;
    await route.continue();
  });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/system");
  const healthy = page.getByRole("table", { name: "运行环节" });
  await expect(healthy).toBeVisible();
  await expect(page.locator(".runtime-service-row[data-attention]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "官方更新", exact: true })).toContainText("暂时无法检查更新。");
  await expect(page.locator("body")).not.toContainText(/只读演示|演示模式/);
  const update = page.getByRole("button", { name: "检查更新", exact: true });
  await expect(update).toBeDisabled();
  await manifest.setTime(manifest.epoch + 3_000);
  await page.clock.setFixedTime(new Date(manifest.epoch + 3_000));
  await page.clock.fastForward(3_000);
  await expect(update).toBeDisabled();
  expect(updateRequests).toBe(2);
  await page.route("**/api/admin/v1/system/status", async route => {
    const response = await route.fetch(), data = await response.json();
    data.data.status = "degraded";
    data.data.reconciliation.last_error_code = "reconciliation_storage_error";
    data.data.reconciliation.consecutive_failures = 2;
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.getByText(/自动确认收款记录暂时无法读取或保存，请检查数据库和运行诊断。/)).toBeVisible();
  const diagnose = page.getByRole("button", { name: "自动确认收款运行诊断" });
  await diagnose.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(diagnose).toBeFocused();
  expect(updateRequests).toBe(3);
  await record(page, info, { runtime: "confirmation failure", updateMode: "isolated demo" });
});
