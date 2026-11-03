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

/** Measure the field container, rather than inferring columns from screen size. */
export async function expectDetailFields(containers: Locator) {
  const groups = await containers.evaluateAll(containers => containers.map(container => {
    const dl = container.querySelector("dl")!, bounds = container.getBoundingClientRect(), style = getComputedStyle(dl);
    const fields = Array.from(dl.children).map((field, index) => {
      const term = field.querySelector("dt")!, value = field.querySelector("dd")!;
      const box = field.getBoundingClientRect(), label = term.getBoundingClientRect(), definition = value.getBoundingClientRect();
      return {
        index, name: term.textContent, wide: field.getAttribute("data-field-wide") === "true",
        width: box.width, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        labelLeft: label.left, labelTop: label.top, labelBottom: label.bottom,
        valueTop: definition.top, valueLeft: definition.left,
        labelFont: Number.parseFloat(getComputedStyle(term).fontSize), valueFont: Number.parseFloat(getComputedStyle(value).fontSize),
        scrollWidth: value.scrollWidth, valueWidth: value.clientWidth,
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
    for (const field of fields) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0]!.top - field.top) <= 1) row.push(field);
      else rows.push([field]);
    }
    return {
      width: bounds.width, left: bounds.left, right: bounds.right, layout: container.getAttribute("data-layout"),
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      desktop: matchMedia("(min-width: 768px)").matches,
      display: style.display, columns: style.gridTemplateColumns.trim().split(/\s+/).length,
      rowGap: Number.parseFloat(style.rowGap), columnGap: Number.parseFloat(style.columnGap),
      orderSummary: !!container.closest("[data-detail-order-summary]"), credentials: !!container.closest("[data-detail-credentials]"),
      fields, rows: rows.map(row => row.map(field => field.name)),
    };
  }));
  for (const group of groups) {
    const columns = group.desktop && group.width >= 36 * group.rootFont ? 2 : 1;
    expect(group.display, "detail facts use a shared grid").toBe("grid");
    expect(group.columns, "columns follow both the viewport and the 36rem container boundary").toBe(columns);
    expect(group.rowGap).toBeCloseTo(group.rootFont, 3);
    expect(group.columnGap).toBeCloseTo(1.5 * group.rootFont, 3);
    expect(group.fields.length).toBeGreaterThan(0);
    const cellWidth = (group.width - (columns - 1) * group.columnGap) / columns;
    const rows: typeof group.fields[] = [];
    for (const field of group.fields) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0]!.top - field.top) <= 1) row.push(field);
      else rows.push([field]);
      expect(field.labelFont, field.name ?? "field label").toBeGreaterThanOrEqual(0.8125 * group.rootFont);
      expect(field.valueFont, field.name ?? "field value").toBeGreaterThanOrEqual(0.875 * group.rootFont);
      expect(Math.abs(field.width - (field.wide ? group.width : cellWidth)), "short fields share equal columns; wide values span their group: " + field.name).toBeLessThanOrEqual(1);
      expect(field.left, field.name ?? "field").toBeGreaterThanOrEqual(group.left - 1);
      expect(field.right, field.name ?? "field").toBeLessThanOrEqual(group.right + 1);
      expect(Math.abs(field.labelLeft - field.left), "labels start at their own field: " + field.name).toBeLessThanOrEqual(1);
      expect(Math.abs(field.valueLeft - field.left), "values start directly below their labels: " + field.name).toBeLessThanOrEqual(1);
      expect(Math.abs(field.valueTop - field.labelBottom - 0.25 * group.rootFont), "label and value retain a readable vertical gap: " + field.name).toBeLessThanOrEqual(1);
      expect(field.firstValue, "visible content exists for " + field.name).not.toBeNull();
      expect(Math.abs(field.firstValue!.left - field.valueLeft), "value content is not indented inside its column: " + field.name).toBeLessThanOrEqual(1);
      expect(field.scrollWidth, "complete value fits: " + field.name).toBeLessThanOrEqual(field.valueWidth + 1);
      if (field.textBounds) {
        expect(field.textBounds.textHeight).toBeLessThanOrEqual(field.textBounds.boxHeight + 1);
        expect(field.textBounds.textRight).toBeLessThanOrEqual(field.textBounds.boxRight + 1);
      }
    }
    for (const [index, row] of rows.entries()) {
      expect(row.length, "a visual row never exceeds the available columns").toBeLessThanOrEqual(columns);
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
  }
  return groups;
}

export async function expectTechnicalPlacement(technical: Locator) {
  const placements = await technical.evaluateAll(items => items.map(element => {
    const owner = element.closest('[data-slot="card"], [data-ledger-source], [data-ledger-match], .detail-section, [data-detail-section], [data-detail-page]')!;
    const followingFacts = [...owner.querySelectorAll("dt")].filter(term =>
      !term.closest("[data-technical-information]") &&
      term.getBoundingClientRect().width > 0 && term.getBoundingClientRect().height > 0 &&
      !!(element.compareDocumentPosition(term) & Node.DOCUMENT_POSITION_FOLLOWING));
    return {
      inHeader: !!element.closest('[data-slot="card-header"], [data-slot="card-action"], [data-page-header-actions]'),
      followingFacts: followingFacts.map(term => term.textContent),
      owner: owner.getAttribute("aria-label") ?? owner.querySelector("h2, h3")?.textContent,
    };
  }));
  for (const placement of placements) {
    expect(placement.inHeader, "technical information belongs to the record body").toBe(false);
    expect(placement.followingFacts, "technical information follows the owning record's business facts: " + placement.owner).toEqual([]);
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
    return {
      width: body.clientWidth, scrollWidth: body.scrollWidth,
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      pageGap: Number.parseFloat(getComputedStyle(detail).rowGap),
      sectionGaps: [...detail.querySelectorAll(".detail-section-content")].filter(visible).map(section => Number.parseFloat(getComputedStyle(section).rowGap)),
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
  expect(geometry.pageGap).toBeCloseTo(1.5 * geometry.rootFont, 3);
  for (const gap of geometry.sectionGaps) expect(gap, "business sections keep a shared vertical rhythm").toBeCloseTo(1.5 * geometry.rootFont, 3);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.cards.filter(card => card.radius !== "0px" || card.shadow !== "none"), "record groups remain flat").toEqual([]);
  expect(geometry.timeFonts.filter(font => font < 0.875 * geometry.rootFont)).toEqual([]);
  expect(geometry.overflowActions, "record actions remain inside their owning section").toEqual([]);
  await expect(overlay.getByRole("heading", { level: 1 })).toHaveCount(1);
  return { ...geometry, frame, fields, technical };
}
