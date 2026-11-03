import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { expectOverlayFits } from "./overlay-fixtures";
import { waitForControlAnimations } from "./touch-targets";

export function detailSection(page: Page, id: string) {
  return page.locator(`[data-overlay-content] [data-overlay-detail] [data-detail-section="${id}"]`);
}

/** Reveal a section in the existing detail scroller; reading does not navigate. */
export async function revealDetailSection(page: Page, id: string) {
  const section = detailSection(page, id);
  await expect(section).toBeVisible();
  await section.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(section).toBeInViewport();
  return section;
}

/** Measure content-sized fields and their actual wrapped rows. */
export async function expectDetailFields(containers: Locator) {
  const groups = await containers.evaluateAll(containers => containers.map(container => {
    const dl = container.querySelector("dl")!, bounds = container.getBoundingClientRect(), style = getComputedStyle(dl);
    const fields = Array.from(dl.children).map((field, index) => {
      const term = field.querySelector("dt")!, value = field.querySelector("dd")!;
      const box = field.getBoundingClientRect(), label = term.getBoundingClientRect(), definition = value.getBoundingClientRect();
      const fieldStyle = getComputedStyle(field), valueStyle = getComputedStyle(value);
      return {
        index, name: term.textContent, wide: field.getAttribute("data-field-wide") === "true",
        width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        display: fieldStyle.display, direction: fieldStyle.flexDirection, wrap: fieldStyle.flexWrap,
        grow: Number.parseFloat(fieldStyle.flexGrow), shrink: Number.parseFloat(fieldStyle.flexShrink), basis: fieldStyle.flexBasis,
        rowGap: Number.parseFloat(fieldStyle.rowGap), columnGap: Number.parseFloat(fieldStyle.columnGap),
        labelLeft: label.left, labelRight: label.right, labelTop: label.top, labelBottom: label.bottom, labelWidth: label.width,
        valueTop: definition.top, valueBottom: definition.bottom, valueLeft: definition.left, valueRight: definition.right,
        valueBoxWidth: definition.width, valueGrow: Number.parseFloat(valueStyle.flexGrow),
        inline: definition.left >= label.right - 1 && definition.top < label.bottom - 1,
        labelFont: Number.parseFloat(getComputedStyle(term).fontSize), valueFont: Number.parseFloat(valueStyle.fontSize),
        scrollWidth: value.scrollWidth, valueWidth: value.clientWidth, scrollHeight: value.scrollHeight, valueHeight: value.clientHeight,
        firstValue: (() => {
          const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            const start = node.textContent?.search(/\S/u) ?? -1;
            if (!parent || start < 0 || parent.closest('.sr-only, [hidden], [aria-hidden="true"]')) continue;
            const style = getComputedStyle(parent);
            if (style.visibility !== "visible" || style.display === "none") continue;
            const character = String.fromCodePoint(node.textContent!.codePointAt(start)!);
            range.setStart(node, start); range.setEnd(node, start + character.length);
            const glyph = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
            if (!glyph) continue;
            // A badge's deliberate padding belongs to its value surface.
            const badge = parent.closest('[data-slot="badge"]');
            return { text: node.textContent!.trim().slice(0, 40), left: badge?.getBoundingClientRect().left ?? glyph.left };
          }
          return null;
        })(),
        textBounds: (() => {
          const textElement = value.querySelector("span.break-all");
          if (!textElement) return null;
          const range = document.createRange(); range.selectNodeContents(textElement);
          const text = range.getBoundingClientRect(), box = textElement.getBoundingClientRect();
          return { textHeight: text.height, boxHeight: box.height, textRight: text.right, boxRight: box.right };
        })(),
      };
    });
    const rows: typeof fields[] = [];
    for (const field of [...fields].sort((a, b) => Math.abs(a.top - b.top) <= 1 ? a.left - b.left : a.top - b.top)) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0]!.top - field.top) <= 1) row.push(field);
      else rows.push([field]);
    }
    return {
      width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right, layout: container.getAttribute("data-layout"),
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      display: style.display, wrap: style.flexWrap,
      rowGap: Number.parseFloat(style.rowGap), columnGap: Number.parseFloat(style.columnGap),
      orderSummary: !!container.closest("[data-detail-order-summary]"), credentials: !!container.closest("[data-detail-credentials]"),
      fields, rows: rows.map(row => row.map(field => field.name)),
    };
  }));
  for (const group of groups) {
    expect(group.display, "detail facts wrap according to their content widths").toBe("flex");
    expect(group.wrap).toBe("wrap");
    expect(group.rowGap).toBeCloseTo(0.5 * group.rootFont, 3);
    expect(group.columnGap).toBeCloseTo(1.5 * group.rootFont, 3);
    expect(group.fields.length).toBeGreaterThan(0);
    const rows: typeof group.fields[] = [];
    for (const field of [...group.fields].sort((a, b) => Math.abs(a.top - b.top) <= 1 ? a.left - b.left : a.top - b.top)) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0]!.top - field.top) <= 1) row.push(field);
      else rows.push([field]);
      expect(field.labelFont, field.name ?? "field label").toBeGreaterThanOrEqual(0.8125 * group.rootFont);
      expect(field.valueFont, field.name ?? "field value").toBeGreaterThanOrEqual(0.875 * group.rootFont);
      expect(field.display).toBe("flex");
      expect(field.direction).toBe("row");
      expect(field.wrap).toBe("wrap");
      expect(field.grow, "short facts do not stretch into unused row space: " + field.name).toBe(0);
      expect(field.shrink).toBe(1);
      expect(field.basis).toBe(field.wide ? "100%" : "auto");
      expect(field.valueGrow, "values retain their own natural width: " + field.name).toBe(0);
      expect(field.rowGap).toBeCloseTo(0.125 * group.rootFont, 3);
      expect(field.columnGap).toBeCloseTo(0.5 * group.rootFont, 3);
      if (field.wide) expect(Math.abs(field.width - group.width), "wide values retain their own complete row: " + field.name).toBeLessThanOrEqual(1);
      expect(field.left, field.name ?? "field").toBeGreaterThanOrEqual(group.left - 1);
      expect(field.right, field.name ?? "field").toBeLessThanOrEqual(group.right + 1);
      expect(Math.abs(field.labelLeft - field.left), "labels start at their own field: " + field.name).toBeLessThanOrEqual(1);
      expect(field.labelRight, "the complete label stays inside its field: " + field.name).toBeLessThanOrEqual(field.right + 1);
      expect(field.valueLeft).toBeGreaterThanOrEqual(field.left - 1);
      expect(field.valueRight).toBeLessThanOrEqual(field.right + 1);
      expect(field.valueBottom).toBeLessThanOrEqual(field.bottom + 1);
      if (field.inline) {
        expect(Math.abs(field.valueLeft - field.labelRight - field.columnGap), "a short value follows its label on the same line: " + field.name).toBeLessThanOrEqual(1);
        if (!field.wide) expect(Math.abs(field.width - field.labelWidth - field.columnGap - field.valueBoxWidth), "a short field occupies only its content width: " + field.name).toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(field.valueLeft - field.left), "a wrapped value returns to its field edge: " + field.name).toBeLessThanOrEqual(1);
        expect(Math.abs(field.valueTop - field.labelBottom - field.rowGap), "long values wrap below their own label with a compact gap: " + field.name).toBeLessThanOrEqual(1);
        if (!field.wide) expect(Math.abs(field.width - group.width), "a constrained natural-width field uses its available row: " + field.name).toBeLessThanOrEqual(1);
      }
      expect(field.firstValue, "visible content exists for " + field.name).not.toBeNull();
      expect(Math.abs(field.firstValue!.left - field.valueLeft), "value content starts at its own value box: " + field.name).toBeLessThanOrEqual(1);
      expect(field.scrollWidth, "complete value fits: " + field.name).toBeLessThanOrEqual(field.valueWidth + 1);
      expect(field.scrollHeight, "complete value height is retained: " + field.name).toBeLessThanOrEqual(field.valueHeight + 1);
      if (field.textBounds) {
        expect(field.textBounds.textHeight).toBeLessThanOrEqual(field.textBounds.boxHeight + 1);
        expect(field.textBounds.textRight).toBeLessThanOrEqual(field.textBounds.boxRight + 1);
      }
    }
    for (const [index, row] of rows.entries()) {
      expect(Math.abs(row[0]!.left - group.left), "each row starts at the group edge").toBeLessThanOrEqual(1);
      if (row.some(field => field.wide)) expect(row).toHaveLength(1);
      for (let column = 1; column < row.length; column++) {
        expect(Math.abs(row[column]!.left - row[column - 1]!.right - group.columnGap), "DOM order is also left-to-right visual order").toBeLessThanOrEqual(1);
      }
      const previous = rows[index - 1];
      if (previous) {
        expect(Math.abs(row[0]!.top - Math.max(...previous.map(field => field.bottom)) - group.rowGap), "wrapped facts leave the next row below the tallest preceding value").toBeLessThanOrEqual(1);
      }
    }
    expect(rows.flat().map(field => field.index), "wrapped visual rows preserve the DOM reading order").toEqual(group.fields.map(field => field.index));
  }
  return groups;
}

export async function expectTechnicalPlacement(technical: Locator) {
  const placements = await technical.evaluateAll(items => items.map(element => {
    const owner = element.closest('[data-slot="card"], [data-ledger-source], [data-ledger-match], .detail-section, [data-detail-section], [data-detail-page]')!;
    const trigger = element.querySelector<HTMLElement>(':scope > button[aria-expanded]')!;
    const bounds = element.getBoundingClientRect(), triggerBounds = trigger.getBoundingClientRect(), triggerStyle = getComputedStyle(trigger);
    const content = document.createRange(), text = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT);
    const contentWidths: number[] = [];
    while (text.nextNode()) {
      if (!text.currentNode.textContent?.trim() || text.currentNode.parentElement?.closest('.sr-only, [hidden], [aria-hidden="true"]')) continue;
      content.selectNodeContents(text.currentNode);
      const rectangles = [...content.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      if (rectangles.length) contentWidths.push(rectangles.reduce((width, rect) => width + rect.width, 0));
    }
    for (const icon of trigger.querySelectorAll("svg")) contentWidths.push(icon.getBoundingClientRect().width);
    const followingFacts = [...owner.querySelectorAll("dt")].filter(term =>
      !term.closest("[data-technical-information]") &&
      term.getBoundingClientRect().width > 0 && term.getBoundingClientRect().height > 0 &&
      !!(element.compareDocumentPosition(term) & Node.DOCUMENT_POSITION_FOLLOWING));
    return {
      inHeader: !!element.closest('[data-slot="card-header"], [data-slot="card-action"], [data-page-header-actions]'),
      followingFacts: followingFacts.map(term => term.textContent),
      owner: owner.getAttribute("aria-label") ?? owner.querySelector("h2, h3")?.textContent,
      popup: trigger.getAttribute("aria-haspopup"), inlinePayloads: element.querySelectorAll("pre, [data-detail-fields]").length,
      triggerWidth: triggerBounds.width, triggerLeft: triggerBounds.left, triggerTop: triggerBounds.top,
      contentWidth: contentWidths.reduce((width, part) => width + part, 0) +
        Math.max(0, contentWidths.length - 1) * Number.parseFloat(triggerStyle.columnGap),
      triggerInset: Number.parseFloat(triggerStyle.paddingLeft) + Number.parseFloat(triggerStyle.paddingRight) +
        Number.parseFloat(triggerStyle.borderLeftWidth) + Number.parseFloat(triggerStyle.borderRightWidth),
      left: bounds.left, top: bounds.top, width: bounds.width,
      separators: [...element.querySelectorAll(':scope > [data-slot="separator"]')].filter(separator => separator.getBoundingClientRect().height > 0).length,
    };
  }));
  for (const placement of placements) {
    expect(placement.inHeader, "technical information belongs to the record body").toBe(false);
    expect(placement.followingFacts, "technical information follows the owning record's business facts: " + placement.owner).toEqual([]);
    expect(placement.popup, "technical information opens an independent dialog").toBe("dialog");
    expect(placement.inlinePayloads, "the main record contains only the technical information entry").toBe(0);
    expect(placement.separators, "technical disclosure adds no separate separator row").toBe(0);
    expect(Math.abs(placement.triggerTop - placement.top), "technical disclosure starts at its own body edge").toBeLessThanOrEqual(1);
    expect(Math.abs(placement.triggerLeft - placement.left)).toBeLessThanOrEqual(1);
    expect(placement.triggerWidth, "technical disclosure stays within its record").toBeLessThanOrEqual(placement.width + 1);
    expect(placement.triggerWidth, "technical disclosure keeps its natural content width").toBeLessThanOrEqual(placement.contentWidth + placement.triggerInset + 1);
  }
  return placements;
}

async function captureParentDetail(parent: Locator) {
  return parent.evaluateHandle(() => {
    const nodes = () => {
      const shell = document.querySelector<HTMLElement>('[data-overlay-content][data-overlay-record="true"]');
      return {
        shell,
        primary: shell?.querySelector<HTMLElement>("[data-overlay-primary]") ?? null,
        body: shell?.querySelector<HTMLElement>("[data-overlay-detail]") ?? null,
        page: shell?.querySelector<HTMLElement>("[data-detail-page]") ?? null,
        footer: shell?.querySelector<HTMLElement>("[data-overlay-footer]") ?? null,
        fields: [...(shell?.querySelectorAll('[data-overlay-detail] [data-detail-fields] > dl > div') ?? [])],
      };
    };
    const original = nodes();
    const box = (element: Element | null) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    };
    const scroll = (element: HTMLElement | null) => ({ top: element?.scrollTop ?? -1, left: element?.scrollLeft ?? -1,
      height: element?.scrollHeight ?? -1, width: element?.scrollWidth ?? -1,
      clientHeight: element?.clientHeight ?? -1, clientWidth: element?.clientWidth ?? -1 });
    const sample = () => {
      const current = nodes(), body = current.body;
      return {
        url: location.href,
        boxes: { shell: box(current.shell), primary: box(current.primary), body: box(body), page: box(current.page), footer: box(current.footer) },
        scroll: scroll(body), shellScroll: scroll(current.shell), primaryScroll: scroll(current.primary),
        fieldCount: current.fields.length,
      };
    };
    const sameNodes = () => {
      const current = nodes();
      const same = (before: Element | null, after: Element | null) => before ? before.isConnected && before === after : after === null;
      return {
        shell: same(original.shell, current.shell), primary: same(original.primary, current.primary),
        body: same(original.body, current.body), page: same(original.page, current.page), footer: same(original.footer, current.footer),
        fields: original.fields.length === current.fields.length && original.fields.every((field, index) => field.isConnected && field === current.fields[index]),
      };
    };
    return { before: sample(), sample, sameNodes };
  });
}

async function expectParentDetailPreserved(state: Awaited<ReturnType<typeof captureParentDetail>>, phase: string) {
  const comparison = await state.evaluate(state => ({ before: state.before, after: state.sample(), sameNodes: state.sameNodes() }));
  expect(comparison.sameNodes, phase + ": the original main record and business field nodes remain mounted").toEqual({
    shell: true, primary: true, body: true, page: true, footer: true, fields: true,
  });
  const shifted: Array<Record<string, unknown>> = [];
  for (const part of ["shell", "primary", "body", "page", "footer"] as const) {
    const before = comparison.before.boxes[part], after = comparison.after.boxes[part];
    if (!before || !after) { if (before !== after) shifted.push({ part, before, after }); continue; }
    for (const axis of ["x", "y", "width", "height"] as const) {
      if (Math.abs(before[axis] - after[axis]) > 1) shifted.push({ part, axis, before: before[axis], after: after[axis] });
    }
  }
  expect(shifted, phase + ": the main detail keeps its position and dimensions").toEqual([]);
  expect(comparison.after.scroll, phase + ": the main detail keeps its scroll position and content extent").toEqual(comparison.before.scroll);
  expect(comparison.after.shellScroll, phase + ": the main shell does not acquire its own scroll offset or overflow").toEqual(comparison.before.shellScroll);
  expect(comparison.after.primaryScroll, phase + ": the main primary container keeps its scroll state").toEqual(comparison.before.primaryScroll);
  expect(comparison.after.url, phase + ": opening or reading technical information does not navigate").toBe(comparison.before.url);
  return comparison;
}

export async function openTechnicalDialog(page: Page, technical: Locator) {
  const parent = page.locator('[data-overlay-content][data-overlay-record="true"]');
  const trigger = technical.locator(':scope > button[aria-haspopup="dialog"]');
  await expect(trigger).toHaveAccessibleName("技术信息");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(technical.locator("pre, [data-detail-fields]")).toHaveCount(0);
  const frameScroll = () => parent.evaluate(parent => ({ top: parent.scrollTop, left: parent.scrollLeft,
    primaryTop: parent.querySelector("[data-overlay-primary]")!.scrollTop, primaryLeft: parent.querySelector("[data-overlay-primary]")!.scrollLeft }));
  const originalFrameScroll = await frameScroll();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await waitForControlAnimations(trigger);
  expect(await frameScroll(), "revealing technical information scrolls only the main body, never its shell").toEqual(originalFrameScroll);
  const parentState = await captureParentDetail(parent);
  await page.keyboard.press("Enter");
  const dialog = page.locator("[data-technical-dialog]:visible");
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAccessibleName("技术信息");
  await expect(dialog).not.toHaveAttribute("data-overlay-step");
  await waitForControlAnimations(dialog);
  const title = dialog.getByRole("heading", { name: "技术信息", exact: true });
  const close = dialog.getByRole("button", { name: "关闭技术信息", exact: true });
  const body = dialog.locator(":scope > [data-admin-dialog-body]");
  const pre = body.locator('pre[aria-label="技术信息"]');
  await expect(title).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(pre).toBeVisible();
  await expect(technical.locator("pre, [data-detail-fields]")).toHaveCount(0);
  expect(await dialog.evaluate(element => !element.closest('[data-overlay-content]')), "technical information is portaled outside the main detail").toBe(true);
  const opened = await expectParentDetailPreserved(parentState, "secondary opened");
  return { page, parent, technical, trigger, dialog, title, close, body, pre, parentState, opened };
}

type TechnicalDialogSession = Awaited<ReturnType<typeof openTechnicalDialog>>;

export async function expectTechnicalDialogLayout(session: TechnicalDialogSession, { requireScroll = false } = {}) {
  const { page, dialog, body } = session;
  const measure = () => dialog.evaluate(dialog => {
    const body = dialog.querySelector<HTMLElement>(":scope > [data-admin-dialog-body]")!;
    const header = dialog.querySelector<HTMLElement>(':scope > [data-slot="dialog-header"]')!;
    const close = header.querySelector<HTMLElement>('button[aria-label="关闭技术信息"]')!;
    const footer = dialog.querySelector<HTMLElement>(':scope > [data-slot="dialog-footer"]')!;
    const pre = body.querySelector<HTMLPreElement>('pre[aria-label="技术信息"]')!;
    const rect = (element: Element) => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom }; };
    const visible = window.visualViewport;
    const viewport = { left: visible?.offsetLeft ?? 0, top: visible?.offsetTop ?? 0, width: visible?.width ?? innerWidth, height: visible?.height ?? innerHeight };
    const scrolling = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")].filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && /^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1;
    }).map(element => ({ body: element === body, tag: element.tagName, slot: element.getAttribute("data-slot") }));
    const closeBounds = close.getBoundingClientRect();
    const hit = document.elementFromPoint(closeBounds.left + closeBounds.width / 2, closeBounds.top + closeBounds.height / 2);
    return {
      viewport, rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      popup: rect(dialog), header: rect(header), close: rect(close), footer: rect(footer), body: rect(body),
      overflowY: getComputedStyle(body).overflowY, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight,
      scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrolling, closeHit: hit === close || !!hit && close.contains(hit),
      pre: { text: pre.textContent, width: pre.clientWidth, scrollWidth: pre.scrollWidth, height: pre.clientHeight, scrollHeight: pre.scrollHeight },
      fields: [...body.querySelectorAll('[data-detail-fields] > dl > div')].map(field => {
        const label = field.querySelector("dt")!, value = field.querySelector("dd")!, bounds = field.getBoundingClientRect();
        const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT), range = document.createRange();
        let visibleText = false;
        while (text.nextNode()) {
          if (!text.currentNode.textContent?.trim() || text.currentNode.parentElement?.closest('.sr-only, [hidden], [aria-hidden="true"]')) continue;
          range.selectNodeContents(text.currentNode);
          if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) { visibleText = true; break; }
        }
        return { label: label.textContent, left: bounds.left, right: bounds.right, valueWidth: value.clientWidth, valueScrollWidth: value.scrollWidth,
          valueHeight: value.clientHeight, valueScrollHeight: value.scrollHeight, visibleText,
          labelFont: Number.parseFloat(getComputedStyle(label).fontSize), valueFont: Number.parseFloat(getComputedStyle(value).fontSize) };
      }),
    };
  });
  const before = await measure();
  expect(before.popup.x).toBeGreaterThanOrEqual(before.viewport.left - 1);
  expect(before.popup.y).toBeGreaterThanOrEqual(before.viewport.top - 1);
  expect(before.popup.right).toBeLessThanOrEqual(before.viewport.left + before.viewport.width + 1);
  expect(before.popup.bottom).toBeLessThanOrEqual(before.viewport.top + before.viewport.height + 1);
  expect(before.overflowY).toBe("auto");
  expect(before.scrolling.length, "technical information has at most one vertical scroll owner").toBeLessThanOrEqual(1);
  expect(before.scrolling.every(element => element.body), "only the secondary body scrolls").toBe(true);
  expect(before.scrollWidth).toBeLessThanOrEqual(before.clientWidth + 1);
  expect(before.pre.text).toBeTruthy();
  expect(() => JSON.parse(before.pre.text!)).not.toThrow();
  expect(before.pre.scrollWidth, "the complete JSON wraps within the technical body").toBeLessThanOrEqual(before.pre.width + 1);
  expect(before.pre.scrollHeight, "the JSON contributes its full height to the body scroller").toBeLessThanOrEqual(before.pre.height + 1);
  expect(before.closeHit, "the fixed header close control remains clickable").toBe(true);
  expect(before.header.bottom).toBeLessThanOrEqual(before.body.y + 1);
  expect(before.body.bottom).toBeLessThanOrEqual(before.footer.y + 1);
  for (const field of before.fields) {
    expect(field.visibleText, "technical values remain visibly readable: " + field.label).toBe(true);
    expect(field.labelFont).toBeGreaterThanOrEqual(0.8125 * before.rootFont);
    expect(field.valueFont).toBeGreaterThanOrEqual(0.875 * before.rootFont);
    expect(field.left, field.label ?? "technical identifier").toBeGreaterThanOrEqual(before.body.x - 1);
    expect(field.right, field.label ?? "technical identifier").toBeLessThanOrEqual(before.body.right + 1);
    expect(field.valueScrollWidth, "complete technical value: " + field.label).toBeLessThanOrEqual(field.valueWidth + 1);
    expect(field.valueScrollHeight, "complete technical value height: " + field.label).toBeLessThanOrEqual(field.valueHeight + 1);
  }
  if (requireScroll) expect(before.scrollHeight, "the long record exercises an actual secondary scroll range").toBeGreaterThan(before.clientHeight + 1);
  if (before.scrollHeight > before.clientHeight + 1) {
    const target = before.scrollTop < before.scrollHeight - before.clientHeight - 1 ? 1 : -1;
    await body.hover();
    await page.mouse.wheel(0, target * Math.max(160, before.clientHeight * 0.75));
    await expect.poll(() => body.evaluate(element => element.scrollTop), { message: "wheel scrolling moves the secondary body" }).not.toBe(before.scrollTop);
  }
  const after = await measure();
  for (const part of ["popup", "header", "close", "footer", "body"] as const) {
    const changed = (["x", "y", "width", "height"] as const).filter(axis => Math.abs(before[part][axis] - after[part][axis]) > 1);
    expect(changed, "secondary scrolling leaves " + part + " fixed").toEqual([]);
  }
  const preserved = await expectParentDetailPreserved(session.parentState, "secondary scrolled");
  return { before, after, preserved };
}

export async function closeTechnicalDialog(session: TechnicalDialogSession, method: "escape" | "header" | "footer" = "escape") {
  try {
    if (method === "escape") await session.page.keyboard.press("Escape");
    else if (method === "header") await session.close.click();
    else await session.dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(session.dialog).toHaveCount(0);
    await expect(session.trigger).toHaveAttribute("aria-expanded", "false");
    await expect(session.trigger, "closing only the secondary dialog returns focus to its original entry").toBeFocused();
    await expect(session.parent).toBeVisible();
    await expect(session.technical.locator("pre, [data-detail-fields]")).toHaveCount(0);
    return await expectParentDetailPreserved(session.parentState, "secondary closed");
  } finally { await session.parentState.dispose(); }
}

export async function expectDetailRecordLayout(page: Page, alternativeTable?: string) {
  const overlay = page.locator('[data-overlay-content][data-overlay-record="true"]');
  await expect(overlay).toBeVisible();
  const body = overlay.locator("[data-overlay-detail]");
  await expect(body.getByRole("tablist"), "record sections share one reading surface").toHaveCount(0);
  await expect(body.getByRole("tabpanel")).toHaveCount(0);
  const firstFields = body.locator("[data-detail-fields]:visible").first();
  await expect(alternativeTable
    ? firstFields.or(body.getByRole("table", { name: alternativeTable, exact: true })).first()
    : firstFields).toBeVisible();
  const frame = await expectOverlayFits(page);
  const fields = await expectDetailFields(body.locator("[data-detail-fields]:visible"));
  const technical = await expectTechnicalPlacement(body.locator("[data-technical-information]:visible"));
  const geometry = await body.evaluate(body => {
    const detail = body.querySelector<HTMLElement>("[data-detail-page]")!;
    const visible = (element: Element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const cards = [...detail.querySelectorAll('[data-slot="card"]')].filter(visible);
    const bodyBounds = body.getBoundingClientRect();
    return {
      width: body.clientWidth, scrollWidth: body.scrollWidth,
      contentHeight: detail.getBoundingClientRect().height, scrollHeight: body.scrollHeight, scrollTop: body.scrollTop,
      visibleFieldCount: [...detail.querySelectorAll('[data-detail-fields] > dl > div')].filter(field => {
        const bounds = field.getBoundingClientRect();
        return visible(field) && bounds.top >= bodyBounds.top - 1 && bounds.bottom <= bodyBounds.bottom + 1;
      }).length,
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      pageGap: Number.parseFloat(getComputedStyle(detail).rowGap),
      sectionGaps: [...detail.querySelectorAll(".detail-section-content, .detail-sections")].filter(visible).map(section => Number.parseFloat(getComputedStyle(section).rowGap)),
      internalGaps: [...detail.querySelectorAll('.detail-section, [data-slot="card"], [data-slot="card-content"], [data-detail-credentials], [data-detail-order-summary] > [data-slot="item-content"]')]
        .filter(visible).map(section => Number.parseFloat(getComputedStyle(section).rowGap)),
      cards: cards.map(card => ({ title: card.getAttribute("aria-label"), radius: getComputedStyle(card).borderRadius, shadow: getComputedStyle(card).boxShadow })),
      timeFonts: [...detail.querySelectorAll('[data-detail-fields] .list-time, [data-delivery-attempts][data-density="comfortable"] .list-time')]
        .filter(visible).map(time => Number.parseFloat(getComputedStyle(time).fontSize)),
      overflowActions: cards.flatMap(card => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll('[data-slot="card-action"] a, [data-slot="card-action"] button')].filter(visible).flatMap(action => {
          const bounds = action.getBoundingClientRect();
          return getComputedStyle(action).visibility !== "hidden" && (bounds.left < box.left - 1 || bounds.right > box.right + 1)
            ? [{ label: action.getAttribute("aria-label") ?? action.textContent, left: bounds.left, right: bounds.right, cardLeft: box.left, cardRight: box.right }] : [];
        });
      }),
    };
  });
  expect(geometry.pageGap).toBeCloseTo(geometry.rootFont, 3);
  for (const gap of geometry.sectionGaps) expect(gap, "business sections retain a compact shared gap").toBeCloseTo(geometry.rootFont, 3);
  for (const gap of geometry.internalGaps) expect(gap, "facts stay close to their owning section heading").toBeCloseTo(0.5 * geometry.rootFont, 3);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.cards.filter(card => card.radius !== "0px" || card.shadow !== "none"), "record groups remain flat").toEqual([]);
  expect(geometry.timeFonts.filter(font => font < 0.875 * geometry.rootFont)).toEqual([]);
  expect(geometry.overflowActions, "record actions remain inside their owning section").toEqual([]);
  await expect(overlay.getByRole("heading", { level: 1 })).toHaveCount(1);
  return { ...geometry, frame, fields, technical };
}
