import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import { waitForControlAnimations } from "./touch-targets";
import { createOrderRequestSchema } from "../src/orders/model";
import { LedgerStore } from "../src/ledger/store";
import { ReconciliationStore } from "../src/reconciliation/store";
import { WebhookStore } from "../src/notifications/store";
import { recordLedgerEntry } from "../test/reconciliation-http-fixture";

async function createFixture() {
  let orderId = "";
  const epoch = Date.now();
  const server = await createSettingsServer(epoch, { runtime: services => {
    const order = services.orders.create(createOrderRequestSchema.parse({ idempotency_key: "detail-height", merchant_order_no: "DETAIL-HEIGHT",
      amount_cents: 1234, product_name: "详情高度验收", note: "仅用于隔离浏览器验收的长订单备注。".repeat(25) })).order;
    orderId = order.orderId;
    const ledger = new LedgerStore(services.database), reconciliation = new ReconciliationStore(services.database);
    const time = (value: number) => new Date(value + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    const occurredAt = Date.now() + 60_000;
    const entry = recordLedgerEntry(ledger, { start: time(epoch - 60_000), end: time(epoch + 180_000) },
      "detail-height-income", order.payableAmountCents + 25, occurredAt, epoch, "CREDIT", services.settings.instanceSnapshot().activeProviderAccountKey!);
    expect(reconciliation.reconcileEntry(entry.ledgerEntryId).kind).toBe("unmatched");
    return { ledger, reconciliation, webhookStore: new WebhookStore(services.database) };
  } });
  return { ...server, orderId };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => { const fixture = await createFixture(); try { await use(fixture); } finally { await fixture.close(); } },
  page: async ({ page, fixture }, use) => {
    page.setDefaultTimeout(15_000);
    await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await use(page);
  },
});
test.use({ reducedMotion: "reduce" });

async function reachable(control: Locator) {
  await expect(control).toBeVisible();
  const geometry = await control.evaluate(element => {
    const box = element.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { box: box.toJSON(), visible: box.left >= left - 1 && box.top >= top - 1 &&
      box.right <= left + (viewport?.width ?? innerWidth) + 1 && box.bottom <= top + (viewport?.height ?? innerHeight) + 1,
      hit: hit === element || element.contains(hit) };
  });
  expect(geometry.visible).toBe(true);
  expect(geometry.hit).toBe(true);
  return geometry;
}

async function measure(dialog: Locator) {
  await waitForControlAnimations(dialog);
  return dialog.evaluate(element => {
    const viewport = window.visualViewport;
    const header = element.querySelector<HTMLElement>('[data-slot="dialog-header"]')!;
    // Editors and tall record drawers scroll the detail. A record drawer too short for a fixed summary scrolls the box
    // around the summary and the detail; one too short for a fixed title and actions scrolls its whole column as a page.
    const boxes = { page: element.querySelector<HTMLElement>("[data-overlay-primary]")!, content: element.querySelector<HTMLElement>("[data-overlay-body]")!,
      detail: element.querySelector<HTMLElement>("[data-overlay-detail]")! };
    const mode = (["page", "content", "detail"] as const).find(name => {
      const style = getComputedStyle(boxes[name]);
      return style.display !== "contents" && /^(auto|scroll)$/.test(style.overflowY);
    })!;
    const body = boxes[mode];
    const footer = element.querySelector<HTMLElement>("[data-overlay-footer]")!;
    return { mode, viewport: { width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }, box: element.getBoundingClientRect().toJSON(),
      header: header.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON(),
      body: { box: body.getBoundingClientRect().toJSON(), height: body.clientHeight, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop },
      windowScroll: { x: scrollX, y: scrollY }, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
}

/** Phones fill the screen; records are a full-height drawer on the right; editors are a centred dialog of limited height. */
function bounded(geometry: Awaited<ReturnType<typeof measure>>, shape: "screen" | "drawer" | "dialog") {
  const { box, viewport } = geometry;
  expect(box.top).toBeGreaterThanOrEqual(viewport.top - 1);
  expect(box.bottom).toBeLessThanOrEqual(viewport.top + viewport.height + 1);
  expect(box.left).toBeGreaterThanOrEqual(viewport.left - 1);
  expect(box.right).toBeLessThanOrEqual(viewport.left + viewport.width + 1);
  expect(geometry.overflowX).toBe(false);
  expect(geometry.body.height).toBeGreaterThan(0);
  if (shape === "screen") {
    expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(1);
  } else if (shape === "drawer") {
    expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.right - (viewport.left + viewport.width))).toBeLessThanOrEqual(1);
    // An order drawer is 44rem wide, or the whole viewport when that is narrower.
    expect(Math.abs(box.width - Math.min(44 * geometry.rootFont, viewport.width))).toBeLessThanOrEqual(1);
  } else expect(box.height).toBeLessThanOrEqual(Math.min(viewport.height * .85, 900) + 1);
}

async function scrollBody(page: Page, dialog: Locator) {
  const before = await measure(dialog);
  expect(before.body.scrollHeight).toBeGreaterThan(before.body.height + 1);
  const body = dialog.locator({ page: "[data-overlay-primary]", content: "[data-overlay-body]", detail: "[data-overlay-detail]" }[before.mode]);
  await body.hover();
  await page.mouse.wheel(0, 10_000);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(before.body.scrollTop);
  await expect.poll(() => body.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
  const after = await measure(dialog);
  expect(after.mode).toBe(before.mode);
  if (before.mode === "page") {
    // Nothing is fixed: the title leaves with the content, and the actions arrive inside the drawer at the end.
    expect(after.header.bottom).toBeLessThan(before.header.bottom);
    expect(after.footer.top).toBeLessThan(before.footer.top);
    expect(after.footer.bottom).toBeLessThanOrEqual(after.box.bottom + 1);
  } else {
    expect(after.header).toEqual(before.header);
    expect(after.footer).toEqual(before.footer);
  }
  expect(after.box).toEqual(before.box);
  expect(after.windowScroll).toEqual(before.windowScroll);
  return { before, after };
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

const layouts = [
  { width: 1920, height: 1200, text: 100 }, { width: 1440, height: 900, text: 100 },
  { width: 1440, height: 520, text: 100 }, { width: 1440, height: 520, text: 200 },
  { width: 768, height: 480, text: 200 }, { width: 390, height: 844, text: 100 },
];
for (const layout of layouts) {
  test(`${layout.width}x${layout.height} at ${layout.text}%: long detail and editor keep independent scrolling and reachable chrome`, async ({ page, fixture }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.addInitScript(percent => { addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = percent + "%"; }); }, layout.text);
    await page.goto(fixture.origin + "/admin/orders/" + fixture.orderId);
    const dialog = page.locator("[data-overlay-content]");
    await expect(dialog.locator("[data-overlay-heading]")).toHaveText("详情高度验收");
    await expect(dialog.getByText("订单备注", { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-slot="skeleton"]')).toHaveCount(0);
    const initial = await measure(dialog);
    bounded(initial, layout.width < 768 ? "screen" : "drawer");
    expect(initial.rootFont).toBe(16 * layout.text / 100);
    // The drawer's height in rem decides how much stays fixed, so enlarged text counts as a shorter drawer.
    const drawerRem = initial.box.height / initial.rootFont;
    expect(initial.mode).toBe(drawerRem < 20 ? "page" : drawerRem < 36 ? "content" : "detail");
    expect(initial.body.height, "fixed parts never leave the record's content less than a third of the drawer").toBeGreaterThanOrEqual(initial.box.height / 3);
    await reachable(dialog.locator("[data-overlay-heading]"));
    await reachable(dialog.getByRole("button", { name: "关闭对话框", exact: true }));
    await screenshot(page, info, "long-detail-top");
    const detailScroll = await scrollBody(page, dialog);
    // At the end of the record its last section is in view, and the actions are within reach whether fixed or scrolled to.
    await expect(dialog.locator('[data-detail-section="history"]')).toBeInViewport();
    await reachable(dialog.locator("[data-overlay-footer]").getByRole("button", { name: "更多操作，订单操作", exact: true }));
    await screenshot(page, info, "long-detail-bottom");
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
    await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "高级设置", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "高级设置", exact: true }).click();
    const editor = await measure(dialog);
    bounded(editor, layout.width < 768 ? "screen" : "dialog");
    const footer = dialog.locator("[data-overlay-footer]");
    expect(editor.footer.height).toBeGreaterThan(0);
    await reachable(dialog.locator("[data-overlay-heading]"));
    const close = footer.getByRole("button", { name: "关闭", exact: true });
    await reachable(close);
    await reachable(footer.getByRole("button", { name: "保存业务网站", exact: true }));
    const editorScroll = await scrollBody(page, dialog);
    await screenshot(page, info, "editor-footer-after-scroll");
    await close.click();
    await expect(dialog).toHaveCount(0);
    if (layout.width === 768) {
      await page.goto(fixture.origin + "/admin/orders/" + fixture.orderId);
      const associate = dialog.locator("[data-overlay-footer] [data-record-primary-actions]").getByRole("button", { name: "人工关联收款", exact: true });
      await associate.click();
      const manual = page.getByRole("dialog", { name: "人工关联收款", exact: true });
      await manual.getByRole("searchbox", { name: "搜索收入流水", exact: true }).fill("detail-height-income");
      await manual.getByRole("button", { name: "搜索", exact: true }).click();
      await manual.getByRole("button", { name: /^选择收入流水：/ }).click();
      const reason = manual.getByRole("textbox", { name: "操作理由（可选）", exact: true });
      await expect(reason).toBeVisible();
      await reason.scrollIntoViewIfNeeded();
      const reasonPoint = await reason.evaluate(element => {
        const box = element.getBoundingClientRect(), scroll = element.closest("[data-overlay-step-scroll]")!;
        const region = scroll.getBoundingClientRect();
        const x = (Math.max(box.left, region.left) + Math.min(box.right, region.right)) / 2;
        const y = (Math.max(box.top, region.top) + Math.min(box.bottom, region.bottom)) / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, bodyHeight: region.height, visibleHeight: Math.min(box.bottom, region.bottom) - Math.max(box.top, region.top),
          hit: hit === element || element.contains(hit) };
      });
      expect(reasonPoint.bodyHeight).toBeGreaterThan(0);
      expect(reasonPoint.visibleHeight).toBeGreaterThan(0);
      expect(reasonPoint.hit).toBe(true);
      await page.mouse.click(reasonPoint.x, reasonPoint.y);
      await page.keyboard.insertText("隔离验收：核对理由输入和取消操作");
      await expect(reason).toHaveValue("隔离验收：核对理由输入和取消操作");
      const stepFrame = await dialog.boundingBox();
      for (const name of ["取消", "返回选择", "确认关联收款"]) {
        const action = manual.getByRole("button", { name, exact: true });
        await action.scrollIntoViewIfNeeded();
        await reachable(action);
        expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
        expect(await dialog.boundingBox()).toEqual(stepFrame);
        await reachable(manual.getByRole("button", { name: "关闭对话框", exact: true }));
      }
      const stepHeight = await dialog.evaluate(element => ({ height: element.getBoundingClientRect().height, visibleHeight: visualViewport?.height ?? innerHeight }));
      // A step replaces the drawer content in place: the drawer keeps its full height.
      expect(Math.abs(stepHeight.height - stepHeight.visibleHeight)).toBeLessThanOrEqual(1);
      await screenshot(page, info, "manual-association-short-viewport");
      await manual.getByRole("button", { name: "返回选择", exact: true }).click();
      await expect(manual.getByRole("searchbox", { name: "搜索收入流水", exact: true })).toBeVisible();
      await manual.getByRole("button", { name: "取消", exact: true }).click();
      await expect(manual).toHaveCount(0);
      await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await info.attach("manual-step-geometry", { body: Buffer.from(JSON.stringify({ reasonPoint, stepHeight }, null, 2)), contentType: "application/json" });
    }
    await info.attach("geometry", { body: Buffer.from(JSON.stringify({ layout, detailScroll, editorScroll }, null, 2)), contentType: "application/json" });
  });
}

test("short content keeps its natural height instead of filling the desktop limit", async ({ page, fixture }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture.origin + "/admin/sites/default");
  await page.getByRole("button", { name: "测试收款", exact: true }).click();
  const dialog = page.locator("[data-overlay-content]");
  await expect(dialog.getByRole("textbox", { name: "测试金额（元）", exact: true })).toBeVisible();
  const geometry = await measure(dialog);
  bounded(geometry, "dialog");
  expect(geometry.box.height).toBeLessThan(Math.min(geometry.viewport.height * .85, 900) - 80);
  expect(geometry.body.scrollHeight).toBeLessThanOrEqual(geometry.body.height + 1);
  const cancel = dialog.locator("[data-overlay-footer]").getByRole("button", { name: "取消", exact: true });
  await reachable(cancel);
  await screenshot(page, info, "short-content-natural-height");
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await info.attach("geometry", { body: Buffer.from(JSON.stringify(geometry, null, 2)), contentType: "application/json" });
});

test("a short step inside a tall drawer pins its flush transparent footer to the bottom edge", async ({ page, fixture }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("perpay:theme", "dark"));
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const) {
    await page.setViewportSize(size);
    await page.goto(fixture.origin + "/admin/orders/" + fixture.orderId);
    const drawer = page.locator('[data-overlay-content][data-overlay-presentation="drawer"]');
    const primaryChrome = await drawer.evaluate(shell => {
      const eyebrow = shell.querySelector<HTMLElement>('[data-overlay-primary] [data-overlay-eyebrow-text]')!;
      const heading = shell.querySelector<HTMLElement>('[data-overlay-primary] > [data-slot="dialog-header"] h1')!;
      const close = shell.querySelector<HTMLElement>('[data-overlay-primary] > [data-slot="dialog-header"] [data-slot="dialog-close"]')!;
      const eyebrowBox = eyebrow.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const headingStyle = getComputedStyle(heading);
      return {
        eyebrow: { text: eyebrow.textContent?.trim(), left: eyebrowBox.left, centerY: eyebrowBox.top + eyebrowBox.height / 2 },
        heading: { left: headingBox.left, top: headingBox.top, fontSize: headingStyle.fontSize, fontWeight: headingStyle.fontWeight },
        close: { right: closeBox.right, top: closeBox.top, width: closeBox.width, height: closeBox.height },
      };
    });
    await drawer.locator("[data-overlay-footer] [data-record-primary-actions]").getByRole("button", { name: "人工关联收款", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "人工关联收款", exact: true });
    await expect(manual.getByRole("button", { name: "取消", exact: true })).toBeVisible();
    const geometry = await drawer.evaluate(shell => {
      const eyebrow = shell.querySelector<HTMLElement>('[data-overlay-step] [data-overlay-step-bar] [data-overlay-eyebrow-text]')!;
      const close = shell.querySelector<HTMLElement>('[data-overlay-step] [data-overlay-step-bar] [data-slot="dialog-close"]')!;
      const header = shell.querySelector<HTMLElement>('[data-overlay-step] > [data-slot="dialog-header"]')!;
      const title = header.querySelector<HTMLElement>('[data-slot="dialog-title"]')!;
      const body = shell.querySelector<HTMLElement>('[data-overlay-step] [data-overlay-step-scroll]')!;
      const firstChild = body.firstElementChild as HTMLElement;
      const footer = shell.querySelector<HTMLElement>('[data-overlay-step] [data-slot="dialog-footer"]')!;
      const shellBox = shell.getBoundingClientRect();
      const eyebrowBox = eyebrow.getBoundingClientRect();
      const closeBox = close.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const firstBox = firstChild.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      const headerStyle = getComputedStyle(header);
      const style = getComputedStyle(footer);
      return {
        shell: { left: shellBox.left, right: shellBox.right, bottom: shellBox.bottom, height: shellBox.height },
        eyebrow: { text: eyebrow.textContent?.trim(), left: eyebrowBox.left, centerY: eyebrowBox.top + eyebrowBox.height / 2 },
        close: { right: closeBox.right, top: closeBox.top, width: closeBox.width, height: closeBox.height },
        title: { left: titleBox.left, top: titleBox.top, fontSize: titleStyle.fontSize, fontWeight: titleStyle.fontWeight },
        header: { left: headerBox.left, right: headerBox.right, bottom: headerBox.bottom, borderBottom: headerStyle.borderBottomWidth },
        firstTop: firstBox.top,
        footer: { left: footerBox.left, right: footerBox.right, bottom: footerBox.bottom, height: footerBox.height },
        background: style.backgroundColor,
        radius: style.borderBottomLeftRadius,
      };
    });
    expect(geometry.eyebrow.text, "step eyebrow names the parent record drawer").toBe(primaryChrome.eyebrow.text);
    expect(Math.abs(geometry.eyebrow.left - primaryChrome.eyebrow.left), "step eyebrow aligns horizontally with primary eyebrow").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.eyebrow.centerY - primaryChrome.eyebrow.centerY), "step eyebrow aligns vertically with primary eyebrow").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.close.right - primaryChrome.close.right), "step close aligns on the right with primary close").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.close.top - primaryChrome.close.top), "step close aligns on the top with primary close").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.close.width - primaryChrome.close.width), "step close matches primary close width").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.close.height - primaryChrome.close.height), "step close matches primary close height").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.title.left - primaryChrome.heading.left), "step title aligns horizontally with primary title").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.title.top - primaryChrome.heading.top), "step title aligns vertically with primary title").toBeLessThanOrEqual(1);
    expect(geometry.title.fontSize, "step title matches primary title font size").toBe(primaryChrome.heading.fontSize);
    expect(geometry.title.fontWeight, "step title matches primary title font weight").toBe(primaryChrome.heading.fontWeight);
    expect(Math.abs(geometry.header.left - geometry.shell.left), "step header divider spans to drawer left edge").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.header.right - geometry.shell.right), "step header divider spans to drawer right edge").toBeLessThanOrEqual(1);
    expect(geometry.header.borderBottom, "step header separates cleanly from scrolling body").toBe("1px");
    expect(geometry.firstTop - geometry.header.bottom, "body content has clear breathing room below header").toBeGreaterThanOrEqual(12);
    expect(Math.abs(geometry.footer.bottom - geometry.shell.bottom), "step footer sits flush at the drawer bottom").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.footer.left - geometry.shell.left), "step footer spans to the drawer left edge").toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.footer.right - geometry.shell.right), "step footer spans to the drawer right edge").toBeLessThanOrEqual(1);
    expect(geometry.radius, "step footer has no floating rounded corners").toBe("0px");
    expect(geometry.background, "step footer blends transparently with the drawer").toBe("rgba(0, 0, 0, 0)");
    await screenshot(page, info, `manual-step-drawer-footer-${size.width}`);
    if (size.width === 1440) {
      await manual.getByRole("searchbox", { name: "搜索收入流水", exact: true }).fill("detail-height-income");
      await manual.getByRole("button", { name: "搜索", exact: true }).click();
      await manual.getByRole("button", { name: /^选择收入流水：/ }).click();
      await expect(manual.getByText("订单收款账号", { exact: true })).toBeVisible();
      const previewGap = await drawer.evaluate(shell => {
        const header = shell.querySelector<HTMLElement>('[data-overlay-step] > [data-slot="dialog-header"]')!;
        const body = shell.querySelector<HTMLElement>('[data-overlay-step] [data-overlay-step-scroll]')!;
        const first = body.firstElementChild as HTMLElement;
        return first.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
      });
      expect(previewGap, "preview evidence starts cleanly below the fixed step header").toBeGreaterThanOrEqual(12);
      await screenshot(page, info, "manual-step-drawer-preview-1440");
    }
    await manual.getByRole("button", { name: "取消", exact: true }).click();
    await expect(manual).toHaveCount(0);
  }
});
