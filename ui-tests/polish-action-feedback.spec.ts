import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("save and refresh feedback keep dimensions, stop decorative loops and recover from failure", async ({ page }, info) => {
  const fixture = await createSettingsServer(Date.now());
  page.setDefaultTimeout(10_000);
  const gate: { release?: (() => void) | undefined } = {};
  function releaseGate() { gate.release?.(); gate.release = undefined; }
  let writeMode: "hold" | "fail" | "success" = "hold";
  let holdRead = false;
  let writes = 0;
  const geometry: unknown[] = [];
  try {
    await page.context().addCookies(fixture.cookies);
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    await page.route("**/api/admin/v1/settings/display", async route => {
      writes++;
      if (writeMode === "hold") await new Promise<void>(resolve => { gate.release = resolve; });
      if (writeMode === "fail") return route.fulfill({ status: 503, json: { error: { code: "synthetic_save_failure", message: "设置暂时无法保存" } } });
      await route.continue();
    });
    await page.route("**/api/admin/v1/settings", async route => {
      if (holdRead) await new Promise<void>(resolve => { gate.release = resolve; });
      await route.continue();
    });
    await page.goto(fixture.origin + "/admin/settings/display");
    const name = page.getByRole("textbox", { name: "支付系统名称", exact: true });
    await name.fill("反馈验收名称");
    const save = page.getByRole("button", { name: "保存", exact: true });
    const before = await save.boundingBox();
    await save.click();
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).toBeDisabled();
    await expect(name).toBeDisabled();
    const spinner = save.locator('[data-slot="spinner"]');
    expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe("spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    expect(await spinner.evaluate(node => node.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
    const during = await save.boundingBox();
    expect(during!.width).toBe(before!.width);
    expect(during!.height).toBe(before!.height);
    await expect.poll(() => Boolean(gate.release)).toBe(true);
    releaseGate();
    const toast = page.getByRole("dialog", { name: "已保存", exact: true });
    await expect(toast).toBeVisible();
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(1);
    await toast.hover();
    await toast.focus();
    await toast.getByRole("button", { name: "关闭提示" }).click();
    await expect(toast).toHaveCount(0);
    geometry.push({ phase: "save-success", before, during, writes });

    writeMode = "fail";
    await name.fill("失败后保留的草稿");
    await save.click();
    await expect(page.getByText("设置暂时无法保存", { exact: true })).toBeVisible();
    await expect(name).toHaveValue("失败后保留的草稿");
    await expect(save).toBeEnabled();
    await expect(save).toHaveAttribute("aria-busy", "false");
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
    writeMode = "success";
    await save.click();
    await expect(toast).toBeVisible();
    await expect(page.getByText("设置暂时无法保存", { exact: true })).toHaveCount(0);
    expect(writes).toBe(3);
    await toast.hover();
    await toast.focus();
    await toast.getByRole("button", { name: "关闭提示" }).click();

    holdRead = true;
    const refresh = page.getByRole("button", { name: "刷新", exact: true });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    expect(await refresh.locator('[data-slot="spinner"]').evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    await expect.poll(() => Boolean(gate.release)).toBe(true);
    holdRead = false; releaseGate();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh).toBeEnabled();
    await expect(name).toHaveValue("失败后保留的草稿");

    // A fresh page holds settings to exercise the shared loading skeleton.
    holdRead = true;
    await page.reload();
    await expect(page.locator('#main-content [data-slot="skeleton"]').first()).toBeVisible();
    const skeletons = await page.locator('#main-content [data-slot="skeleton"]').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
    expect(skeletons.every(name => name === "none")).toBe(true);
    holdRead = false; releaseGate();
    await expect(name).toBeVisible();
    await info.attach("feedback-evidence", { body: JSON.stringify({ geometry, writes, skeletons, realTemporarySettingsServer: true }), contentType: "application/json" });
    await info.attach("settings-feedback", { body: await page.screenshot(), contentType: "image/png" });
  } finally { holdRead = false; releaseGate(); await page.unrouteAll({ behavior: "ignoreErrors" }); await fixture.close(); }
});
