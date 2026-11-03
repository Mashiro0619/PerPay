import { test, expect } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { measureDetailTextContrast, resolveDetailTextContrast, resolveScrollingTabContrast } from "./detail-contrast-evidence";

const incomplete = { incomplete: [{ id: "color-contrast", nodes: [{ target: ["#target"],
  any: [{ data: { messageKey: "elmPartiallyObscuring" } }], all: [], none: [] }] }] } as unknown as AxeResults;

const markup = `<style>
  body { margin: 0; font: 14px/1.5 Arial, sans-serif; }
  [data-overlay-content] { position: fixed; inset: 10px auto auto 10px; width: 400px; height: 220px; padding: 12px; background: white; color: #444; }
  [data-overlay-detail] { height: 196px; overflow: auto; }
  p { margin: 0; }
</style><div data-overlay-content role="dialog" aria-label="记录详情"><div data-overlay-detail><p id="target">审计记录 <time>2026/11/02</time> 已保存</p></div></div>`;

test("detail contrast evidence measures each text run and rejects low contrast, clipping and overlapping paint", async ({ page }) => {
  await page.setContent(markup);
  const target = page.locator("#target");
  const original = await target.evaluate(measureDetailTextContrast);
  expect(original?.passed).toBe(true);
  expect(original?.runs).toHaveLength(3);
  expect(original?.runs.every(run => run.characters.every(character => character.hits.length === 5))).toBe(true);

  await target.evaluate(node => {
    const heading = document.createElement("h2"); heading.id = node.id;
    heading.style.cssText = "margin:0;font-size:16px;font-weight:600";
    while (node.firstChild) heading.append(node.firstChild);
    node.replaceWith(heading);
  });
  expect((await target.evaluate(measureDetailTextContrast))?.passed).toBe(true);

  await target.evaluate(node => { (node as HTMLElement).style.color = "#bbb"; });
  expect((await target.evaluate(measureDetailTextContrast))?.passed).toBe(false);
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await target.evaluate(node => { (node as HTMLElement).style.color = "#444"; (node as HTMLElement).style.height = "9px"; (node as HTMLElement).style.overflow = "hidden"; });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  expect(await target.evaluate(node => node.scrollTop)).toBe(0);

  await target.evaluate(node => { (node as HTMLElement).style.removeProperty("height"); (node as HTMLElement).style.removeProperty("overflow"); });
  await page.evaluate(() => {
    const target = document.querySelector("#target")!, box = target.getBoundingClientRect();
    const covering = document.createElement("div"); covering.id = "cover";
    Object.assign(covering.style, { position: "fixed", left: box.left + "px", top: box.top + "px", width: "80px", height: "22px", background: "#fff", zIndex: "1" });
    target.parentElement!.append(covering);
  });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await page.locator("#cover").evaluate(node => { (node as HTMLElement).style.pointerEvents = "none"; });
  const transparentHitTarget = await target.evaluate(measureDetailTextContrast);
  expect(transparentHitTarget?.runs.some(run => run.characters.some(character => character.overlappingPaint.length > 0))).toBe(true);
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
});

test("scrolling tab evidence reveals complete text without changing selection, focus or vertical position", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 0; background: white; color: #444; font: 14px/1.5 Arial, sans-serif; }
    [data-settings-tabs-scroll] { margin: 20px; padding: 4px; width: 180px; overflow: auto; }
    [role=tablist] { display: flex; width: max-content; gap: 6px; padding: 4px; }
    [role=tab] { position: relative; padding: 4px 8px; border: 0; background: transparent; white-space: nowrap; color: rgb(0 0 0 / 65%); font: inherit; }
    #target::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 2px; background: #111; }
  </style><div data-settings-tabs-scroll><div role="tablist" aria-label="分类">
    <button role="tab" data-slot="tabs-trigger" aria-selected="true">基本信息</button>
    <button role="tab" data-slot="tabs-trigger" aria-selected="false">订单设置</button>
    <button id="target" role="tab" data-slot="tabs-trigger" aria-selected="false" tabindex="-1">接入与通知</button>
  </div></div>`);
  const scroller = page.locator("[data-settings-tabs-scroll]");
  const target = page.locator("#target");
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, focused: document.activeElement?.outerHTML }));
  const review = (await resolveScrollingTabContrast(page, incomplete))[0];
  expect(review?.measurement.initial.passed).toBe(false);
  expect(review?.measurement.revealed?.passed).toBe(true);
  expect(review?.measurement.revealed?.runs[0]?.pseudoPaints).toHaveLength(1);
  expect(review?.resolved).toBe(true);
  expect(await scroller.evaluate(node => node.scrollLeft)).toBe(0);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY, focused: document.activeElement?.outerHTML }))).toEqual(before);
  await expect(target).toHaveAttribute("aria-selected", "false");
  await page.addStyleTag({ content: "#target::after { top: 0; bottom: auto; height: 20px; }" });
  expect((await resolveScrollingTabContrast(page, incomplete))[0]?.resolved).toBe(false);
  await page.addStyleTag({ content: "#target::after { display: none; } [data-settings-tabs-scroll] { overflow: hidden; }" });
  expect((await resolveScrollingTabContrast(page, incomplete))[0]?.resolved).toBe(false);
});

test("detail contrast evidence proves scroll reachability and restores the original scroll position", async ({ page }) => {
  await page.setContent(markup);
  await page.locator("#target").evaluate(node => {
    const spacer = document.createElement("div"); spacer.style.height = "300px"; node.before(spacer);
  });
  const target = page.locator("#target");
  expect((await target.evaluate(measureDetailTextContrast))?.passed).toBe(false);
  const review = (await resolveDetailTextContrast(page, incomplete))[0];
  expect(review?.resolved).toBe(true);
  expect(review?.measurement.initial.passed).toBe(false);
  expect(review?.measurement.revealed?.passed).toBe(true);
  expect(review?.measurement.scrollChanges.some(change => change.after.top > change.before.top)).toBe(true);
  expect(await page.locator("[data-overlay-detail]").evaluate(node => node.scrollTop)).toBe(0);
  await target.evaluate(node => { node.setAttribute("inert", ""); });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
});

test("record header evidence verifies wrapped title glyphs and rejects obscured or clipped titles", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 560 });
  await page.setContent(`<style>
    body { margin: 0; background: white; color: #222; font: 14px/1.5 Arial, sans-serif; }
    [data-overlay-content] { position: fixed; inset: 0; padding: 24px 32px; background: white; }
    [data-slot=dialog-header] { display: grid; grid-template-columns: minmax(0, 1fr) 64px 64px; align-items: center; gap: 8px; }
    h1 { margin: 0; font-size: 40px; line-height: 1.4; overflow: hidden; overflow-wrap: anywhere; }
    button { height: 64px; }
  </style><div data-overlay-content data-overlay-record="true"><div data-overlay-primary>
    <div data-slot="dialog-header"><h1 id="target">通知详情</h1><button>刷新</button><button>关闭</button></div>
  </div></div>`);
  const target = page.locator("#target");
  const readable = (await resolveDetailTextContrast(page, incomplete))[0];
  expect(readable?.resolved).toBe(true);
  expect(readable?.measurement.initial.runs[0]?.characters).toHaveLength(4);
  expect(readable?.measurement.initial.runs[0]?.contrast).toBeGreaterThanOrEqual(4.5);

  await target.evaluate(node => {
    const blocker = document.createElement("div");
    blocker.id = "title-cover";
    const box = node.getBoundingClientRect();
    blocker.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:40px;height:56px;background:white;pointer-events:none`;
    node.parentElement!.append(blocker);
  });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await page.locator("#title-cover").evaluate(node => node.remove());
  await target.evaluate(node => { (node as HTMLElement).style.height = "30px"; });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await target.evaluate(node => { (node as HTMLElement).style.removeProperty("height"); (node as HTMLElement).style.color = "#bbb"; });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await page.locator("[data-overlay-record]").evaluate(node => node.removeAttribute("data-overlay-record"));
  expect(await target.evaluate(measureDetailTextContrast)).toBeNull();
});

test("technical reader contrast evidence verifies its own scrollable text and rejects hidden or low-contrast values", async ({ page }) => {
  await page.setContent(`<style>
    body { margin: 0; font: 14px/1.5 Arial, sans-serif; }
    [data-technical-dialog] { padding: 12px; width: 300px; background: white; color: #444; }
    [data-admin-dialog-body] { height: 100px; overflow: auto; }
    .spacer { height: 180px; }
    p { margin: 0; }
  </style><div data-technical-dialog role="dialog" aria-label="技术信息"><h2>技术信息</h2>
    <div data-admin-dialog-body><div class="spacer"></div><p id="target">完整内部编号</p></div>
  </div>`);
  const target = page.locator("#target");
  const review = (await resolveDetailTextContrast(page, incomplete))[0];
  expect(review?.resolved).toBe(true);
  expect(review?.measurement.initial.passed).toBe(false);
  expect(review?.measurement.revealed?.passed).toBe(true);
  expect(await page.locator("[data-admin-dialog-body]").evaluate(node => node.scrollTop)).toBe(0);
  await target.evaluate(node => { (node as HTMLElement).style.color = "#bbb"; });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
  await target.evaluate(node => { (node as HTMLElement).style.color = "#444"; node.setAttribute("inert", ""); });
  expect((await resolveDetailTextContrast(page, incomplete))[0]?.resolved).toBe(false);
});
