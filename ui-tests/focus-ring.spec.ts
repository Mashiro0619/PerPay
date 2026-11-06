import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import { waitForControlAnimations } from "./touch-targets";

async function editorGeometry(dialog: Locator) {
  await waitForControlAnimations(dialog);
  return dialog.evaluate(element => {
    const surface = element.querySelector<HTMLElement>("[data-overlay-step-host] [data-overlay-step]") ?? element;
    const body = surface.querySelector<HTMLElement>("[data-overlay-step-scroll], [data-overlay-detail]")!;
    return {
      dialog: element.getBoundingClientRect().toJSON(),
      header: surface.querySelector('[data-slot="dialog-header"]')!.getBoundingClientRect().toJSON(),
      footer: surface.querySelector('[data-overlay-footer], [data-slot="dialog-footer"]')!.getBoundingClientRect().toJSON(),
      body: body.getBoundingClientRect().toJSON(),
      scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      scrollbarWidth: body.offsetWidth - body.clientWidth,
      bodyOverflow: body.scrollWidth > body.clientWidth + 1,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      windowScroll: { x: scrollX, y: scrollY },
    };
  });
}

async function focusGeometry(control: Locator) {
  return control.evaluate(element => {
    const indicator = element.closest<HTMLElement>('[data-slot="input-group"]') ?? element as HTMLElement;
    const style = getComputedStyle(indicator);
    const box = indicator.getBoundingClientRect();
    const shadows = style.boxShadow.split(/,(?![^(]*\))/).map(shadow => {
      const dimensions = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
      return { inset: shadow.includes("inset"), x: dimensions[0], y: dimensions[1], blur: dimensions[2], spread: dimensions[3] };
    });
    const ring = shadows.find(shadow => !shadow.inset && shadow.x === 0 && shadow.y === 0 && shadow.blur === 0 && shadow.spread === 3);
    const extent = ring?.spread ?? 0;
    const bounds = { left: box.left - extent, top: box.top - extent, right: box.right + extent, bottom: box.bottom + extent };
    const clips = [];
    for (let ancestor = indicator.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const paint = getComputedStyle(ancestor);
      const clipX = ["hidden", "clip", "auto", "scroll"].includes(paint.overflowX);
      const clipY = ["hidden", "clip", "auto", "scroll"].includes(paint.overflowY);
      if (!clipX && !clipY) continue;
      const rect = ancestor.getBoundingClientRect();
      const clip = { left: rect.left + ancestor.clientLeft, top: rect.top + ancestor.clientTop,
        right: rect.left + ancestor.clientLeft + ancestor.clientWidth,
        bottom: rect.top + ancestor.clientTop + ancestor.clientHeight };
      clips.push({ slot: ancestor.getAttribute("data-slot"), tag: ancestor.tagName,
        overlayBody: ancestor.hasAttribute("data-overlay-detail"), clipX, clipY, clip,
        space: { left: box.left - clip.left, right: clip.right - box.right, top: box.top - clip.top, bottom: clip.bottom - box.bottom } });
    }
    const canvas = document.createElement("canvas").getContext("2d")!;
    const color = (value: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = value;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    const overlay = indicator.closest<HTMLElement>("[data-overlay-content]")!;
    const overlayBox = overlay.getBoundingClientRect(), overlayStyle = getComputedStyle(overlay);
    const body = indicator.closest<HTMLElement>("[data-overlay-step-scroll], [data-overlay-detail]")!;
    const bodyStyle = getComputedStyle(body);
    const scrollbarWidth = Math.max(0, body.offsetWidth - body.clientWidth - parseFloat(bodyStyle.borderLeftWidth) - parseFloat(bodyStyle.borderRightWidth));
    const fieldBox = indicator.closest('[data-slot="field"]')!.getBoundingClientRect();
    const viewport = visualViewport;
    const controlBox = element.getBoundingClientRect();
    const hit = document.elementFromPoint(controlBox.left + controlBox.width / 2, controlBox.top + controlBox.height / 2);
    return {
      focused: element === document.activeElement, focusVisible: element.matches(":focus-visible"),
      indicatorSlot: indicator.getAttribute("data-slot"), shadow: style.boxShadow, extent, box: box.toJSON(), bounds, clips,
      ringColor: color(style.getPropertyValue("--tw-ring-color")),
      inputRingToken: getComputedStyle(document.documentElement).getPropertyValue("--input-ring").trim(),
      scrollbarWidth,
      field: { left: fieldBox.left, right: fieldBox.right },
      content: { left: overlayBox.left + parseFloat(overlayStyle.borderLeftWidth) + parseFloat(overlayStyle.paddingLeft),
        right: overlayBox.right - parseFloat(overlayStyle.borderRightWidth) - parseFloat(overlayStyle.paddingRight) - scrollbarWidth },
      viewport: { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
        bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) },
      expectedColor: color(document.documentElement.classList.contains("dark") ? "oklch(0.556 0 0 / 0.5)" : "oklch(0.708 0 0 / 0.5)"),
      centerHit: element === hit || element.contains(hit),
    };
  });
}

async function checkControl(page: Page, dialog: Locator, control: Locator, name: string, info: TestInfo) {
  await expect(control).toBeVisible();
  const before = await editorGeometry(dialog);
  // Center the real control within its normal scroll container, then use a
  // keyboard round trip so focus-visible is exercised independently of clicks.
  await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await control.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(control).toBeFocused();
  await expect.poll(async () => (await focusGeometry(control)).extent).toBe(3);
  const geometry = await focusGeometry(control);
  expect(geometry.focusVisible).toBe(true);
  expect(geometry.centerHit).toBe(true);
  expect(geometry.ringColor).toEqual(geometry.expectedColor);
  expect(geometry.inputRingToken).not.toBe("");
  for (const clip of geometry.clips) {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      if ((side === "left" || side === "right") ? clip.clipX : clip.clipY) {
        expect(clip.space[side], `${name} ${side} ring space at ${clip.tag}[${clip.slot ?? "overlay"}]`).toBeGreaterThanOrEqual(2.5);
      }
    }
  }
  expect(geometry.bounds.left).toBeGreaterThanOrEqual(geometry.viewport.left - .5);
  expect(geometry.bounds.top).toBeGreaterThanOrEqual(geometry.viewport.top - .5);
  expect(geometry.bounds.right).toBeLessThanOrEqual(geometry.viewport.right + .5);
  expect(geometry.bounds.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + .5);
  // Full-width fields keep the original content edges while their ancestors
  // provide exterior space for the ring.
  for (const side of ["left", "right"] as const) {
    expect(Math.abs(geometry.box[side] - geometry.field[side]), `${name} fills its field`).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.box[side] - geometry.content[side]), `${name} keeps the editor content width`).toBeLessThanOrEqual(1);
  }
  const after = await editorGeometry(dialog);
  expect(after.header).toEqual(before.header);
  expect(after.footer).toEqual(before.footer);
  expect(after.dialog).toEqual(before.dialog);
  expect(after.windowScroll).toEqual(before.windowScroll);
  expect(after.bodyOverflow).toBe(false);
  expect(after.pageOverflow).toBe(false);
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  await info.attach(name + "-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
}

async function checkIndependentScroll(page: Page, dialog: Locator) {
  const body = dialog.locator("[data-overlay-detail]");
  // The center can land in a textarea with its own native scroll position.
  // Use the body's exterior gutter to exercise the overlay scroll container.
  await body.hover({ position: { x: 2, y: 10 } });
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
  const before = await editorGeometry(dialog);
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => body.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
  const after = await editorGeometry(dialog);
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
  expect(after.header).toEqual(before.header);
  expect(after.footer).toEqual(before.footer);
  expect(after.dialog).toEqual(before.dialog);
  expect(after.windowScroll).toEqual(before.windowScroll);
  expect(after.bodyOverflow).toBe(false);
  expect(after.pageOverflow).toBe(false);
}

const layouts = [
  { width: 1440, height: 900, font: 100, theme: "light" },
  { width: 1440, height: 900, font: 100, theme: "dark" },
  { width: 390, height: 844, font: 100, theme: "light" },
  { width: 390, height: 844, font: 100, theme: "dark" },
  { width: 1440, height: 520, font: 200, theme: "light" },
] as const;

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

for (const layout of layouts) {
  test.describe(`${layout.width}x${layout.height} ${layout.font}% ${layout.theme} editor focus`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, isMobile: layout.width < 768,
      hasTouch: layout.width < 768, colorScheme: layout.theme, reducedMotion: "reduce" });
    test("preserves three-pixel rings, full-width content and independent overlay scrolling", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        await page.addInitScript(({ theme, font }) => {
          localStorage.setItem("perpay:theme", theme);
          addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = font + "%"; });
        }, layout);
        const writes: string[] = [];
        page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url()); });
        await page.goto(fixture.origin + "/admin/sites/default/settings/display");
        await expect(page.locator("html")).toHaveCSS("font-size", (16 * layout.font / 100) + "px");
        await page.getByRole("link", { name: "编辑收银台展示", exact: true }).click();
        const dialog = page.locator("[data-overlay-content]");
        await expect(dialog.getByRole("textbox", { name: "收银台名称", exact: true })).toBeVisible();
        if (layout.font === 100) {
          const shortForm = await editorGeometry(dialog);
          expect(shortForm.scrollHeight, "a short editor does not acquire a scrollbar from extended touch targets").toBeLessThanOrEqual(shortForm.clientHeight + 1);
          expect(shortForm.scrollbarWidth).toBe(0);
        }
        await checkControl(page, dialog, dialog.getByRole("textbox", { name: "收银台名称", exact: true }), "full-width-input", info);
        await checkControl(page, dialog, dialog.getByRole("textbox", { name: "帮助链接", exact: true }), "help-url-input", info);
        if (layout.font === 200) await checkIndependentScroll(page, dialog);
        await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
        await expect(dialog).toHaveCount(0);

        if (layout.font === 100) {
          await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
          await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
          await dialog.getByRole("button", { name: "更换客户端 ID", exact: true }).click();
          const step = page.getByRole("dialog", { name: "更换客户端 ID", exact: true });
          await checkControl(page, dialog, step.getByRole("textbox", { name: "新客户端 ID", exact: true }), "client-id-step-input", info);
          await step.getByRole("button", { name: "取消", exact: true }).click();
          await expect(step).toHaveCount(0);
          await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
          await expect(dialog).toHaveCount(0);

          const response = await page.request.get(fixture.origin + "/api/admin/v1/alipay-accounts");
          expect(response.status()).toBe(200);
          const account = (await response.json()).data[0] as { name: string };
          await page.goto(fixture.origin + "/admin/settings/accounts");
          await page.getByRole("link", { name: "配置" + account.name, exact: true }).click();
          await dialog.getByRole("tab", { name: "应用信息", exact: true }).click();
          if (layout.width === 1440) {
            expect((await editorGeometry(dialog)).scrollbarWidth, "desktop long forms exercise a space-consuming native scrollbar").toBeGreaterThan(0);
          }
          await checkControl(page, dialog, dialog.getByRole("textbox", { name: "应用公钥", exact: true }), "public-key-input-group", info);
          await checkControl(page, dialog, dialog.getByRole("textbox", { name: "支付宝公钥", exact: true }), "platform-key-textarea", info);
          await checkIndependentScroll(page, dialog);
          await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        }
        if (layout.width === 1440 && layout.font === 100 && layout.theme === "dark") {
          await page.goto(fixture.origin + "/admin/sites/defaults");
          await dialog.getByRole("tab", { name: "收银台展示", exact: true }).click();
          const help = dialog.getByRole("textbox", { name: "帮助链接", exact: true });
          await expect(help).toBeVisible();
          const shortForm = await editorGeometry(dialog);
          expect(shortForm.scrollHeight).toBeLessThanOrEqual(shortForm.clientHeight + 1);
          expect(shortForm.scrollbarWidth).toBe(0);
          expect(await help.evaluate(element => element.closest('[data-slot="card"]') === null)).toBe(true);
          await checkControl(page, dialog, help, "default-template-help-url", info);
        }
        expect(writes).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}
