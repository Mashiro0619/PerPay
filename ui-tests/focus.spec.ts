import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";

async function expectInputRing(control: Locator, indicator = control, alpha = 128) {
  await expect(control).toBeFocused();
  expect(await control.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  await expect.poll(() => indicator.evaluate(element => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = style.getPropertyValue("--tw-ring-color");
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  })).toBe(alpha);
  await expect.poll(() => indicator.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/\s3px(?:,|$)/);
}

for (const theme of ["light", "dark"] as const) test(`${theme}: form controls retain the official translucent focus and invalid states`, async ({ page, manifest }, info) => {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
  const writes: string[] = [];
  page.on("request", request => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  await page.route("**/admin/", async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(/(name="perpay-initialized" content=")true/, "$1false")
      .replace(/(name="perpay-setup-token-required" content=")(true|false)/, "$1true");
    await route.fulfill({ response, body });
  });
  await page.goto(manifest.origin + "/admin/");
  // Supply the prerequisite so these local password checks reach their intended fields.
  await page.getByLabel("一次性初始化令牌", { exact: true }).fill("a".repeat(64));
  const password = page.getByLabel("设置管理员密码", { exact: true });
  const confirmation = page.getByLabel("再次输入密码", { exact: true });
  const group = page.locator('[data-slot="input-group"]');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await password.click();
    await expectInputRing(password, group);
    expect(await password.evaluate(element => getComputedStyle(element).boxShadow)).not.toMatch(/\s3px(?:,|$)/);
    await page.keyboard.press("Tab");
    const visibility = page.getByRole("button", { name: "显示密码", exact: true });
    await expect(visibility).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(password).toHaveAttribute("type", "text");
    await page.keyboard.press("Tab");
    await expectInputRing(confirmation);
    await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
    await confirmation.click();
    await expectInputRing(confirmation);
    await record(page, info, { state: "synthetic initialization focus", viewportWidth: width, focusAlpha: 0.5 });
  }
  await password.fill("123456");
  await confirmation.fill("different");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(confirmation).toHaveAttribute("aria-invalid", "true");
  await expectInputRing(confirmation, confirmation, theme === "dark" ? 102 : 51);
  await screenshot(page, info, "input-invalid-" + theme);
  await password.fill("12345");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expectInputRing(password, group, theme === "dark" ? 102 : 51);
  await screenshot(page, info, "input-group-invalid-" + theme);
  await page.unroute("**/admin/");
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/settings/security");
  const textarea = page.getByLabel("允许的 IP / 网段", { exact: true });
  const addCurrentIp = page.getByRole("button", { name: "加入当前 IP", exact: true });
  // Loading the client IP enables the next tab stop. Wait for that real read
  // before checking a round trip through a stable keyboard order.
  await expect(addCurrentIp).toBeEnabled();
  await textarea.click();
  await expectInputRing(textarea);
  await textarea.press("Tab");
  await expect(addCurrentIp).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expectInputRing(textarea);
  await screenshot(page, info, "textarea-focus-" + theme);
  await record(page, info, { state: "textarea keyboard focus", focusAlpha: 0.5, writes });
  expect(writes).toEqual([]);
});

for (const theme of ["light", "dark"] as const) test(`${theme}: keyboard focus is opaque and distinct from adjacent surfaces`, async ({ page, manifest }, info) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
  await login(page, manifest);
  await page.keyboard.press("Tab");
  const trigger = page.getByRole("button", { name: "切换导航", exact: true });
  await trigger.focus();
  // Read the painted ring after its normal transition, not an intermediate
  // transparent animation frame immediately after focus moves.
  await expect.poll(() => trigger.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/\s3px(?:,|$)/);
  const focus = await trigger.evaluate(element => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    function luminance(value: string) {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
    }
    const ring = luminance(root.getPropertyValue("--ring"));
    const contrasts = ["--background", "--card", "--sidebar", "--sidebar-accent"].map(token => {
      const surface = luminance(root.getPropertyValue(token));
      return (Math.max(ring, surface) + .05) / (Math.min(ring, surface) + .05);
    });
    return { visible: element.matches(":focus-visible"), shadow: style.boxShadow, ringColor: style.getPropertyValue("--tw-ring-color"), contrasts };
  });
  expect(focus.visible).toBe(true);
  expect(focus.shadow).not.toBe("none");
  expect(focus.shadow).toMatch(/\s3px(?:,|$)/);
  expect(focus.shadow).not.toMatch(/\/\s*0\.\d+\)/);
  expect(Math.min(...focus.contrasts)).toBeGreaterThanOrEqual(3);
  await record(page, info, { focus });

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/");
    const orders = page.getByRole("region", { name: "最近订单", exact: true }).locator("a[data-row-link]");
    const links = [
      { name: "work-item", link: page.locator(".overview-work-content [data-row-link]").first() },
      { name: "recent-order", link: orders.nth(0) },
      { name: "long-order", link: orders.nth(1) },
    ];
    for (const { name, link } of links) {
      await link.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(link).toBeFocused();
      const indicator = await link.evaluate(element => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const width = parseFloat(style.outlineWidth);
        const extent = Math.max(0, width + parseFloat(style.outlineOffset));
        const ring = { left: bounds.left - extent, top: bounds.top - extent, right: bounds.right + extent, bottom: bounds.bottom + extent };
        const clippedBy = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const clip = parent.getBoundingClientRect();
          const overflow = getComputedStyle(parent);
          const clippedX = overflow.overflowX !== "visible" && (ring.left < clip.left - 1 || ring.right > clip.right + 1);
          const clippedY = overflow.overflowY !== "visible" && (ring.top < clip.top - 1 || ring.bottom > clip.bottom + 1);
          if (clippedX || clippedY) clippedBy.push({ slot: parent.getAttribute("data-slot"), clippedX, clippedY });
        }
        return { visible: element.matches(":focus-visible"), style: style.outlineStyle, width, clippedBy };
      });
      expect(indicator.visible).toBe(true);
      expect(indicator.style).toBe("solid");
      expect(indicator.width).toBeGreaterThanOrEqual(2);
      expect(indicator.clippedBy).toEqual([]);
      await record(page, info, { viewportWidth: width, target: name, overviewLinkFocus: indicator });
      await screenshot(page, info, `overview-keyboard-${width}-${name}`);
    }
  }
});
