import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { expectOverlayFits } from "./overlay-fixtures";

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
    expect(placement.separators, "technical disclosure adds no separate separator row").toBe(0);
    expect(Math.abs(placement.triggerTop - placement.top), "technical disclosure starts at its own body edge").toBeLessThanOrEqual(1);
    expect(Math.abs(placement.triggerLeft - placement.left)).toBeLessThanOrEqual(1);
    expect(placement.triggerWidth, "technical disclosure stays within its record").toBeLessThanOrEqual(placement.width + 1);
    expect(placement.triggerWidth, "technical disclosure keeps its natural content width").toBeLessThanOrEqual(placement.contentWidth + placement.triggerInset + 1);
  }
  return placements;
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
