import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { waitForAdminRoute } from "./admin-route-readiness";
import type { AdminOrderPageEnvelope, AdminWorkItem, AdminWorkItemPageEnvelope, AlipayAccountListEnvelope } from "../web/src/api/generated/types.gen";

const lists = [
  { path: "/work-items", table: "work-items" },
  { path: "/orders", table: "orders" },
  { path: "/notifications", table: "notifications" },
  { path: "/reconciliation", table: "administrator-ledger" },
  { path: "/sites", table: "sites" },
  { path: "/settings/accounts", table: "alipay-accounts" },
] as const;

async function prepare(page: Page, manifest: Manifest, width: number, theme: "light" | "dark", fontScale = 1) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await login(page, manifest);
  await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
  if (fontScale !== 1) await page.addInitScript(scale => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = 16 * scale + "px";
      window.dispatchEvent(new Event("resize"));
    }, { once: true });
  }, fontScale);
}

function reminderCaption(item: AdminWorkItem) {
  if (item.ended) return "已结束";
  if (item.ignored_at) return "已忽略";
  if (item.type === "FINANCIAL_EXCEPTION") return "账务异常";
  if (item.type === "LEDGER_CONFLICT") return "账本冲突";
  return item.status === "ACKNOWLEDGED" ? "通知已确认" : "通知失败";
}

async function openList(page: Page, manifest: Manifest, path: string, table: string, expectedWorkItems?: AdminWorkItem[]) {
  await page.goto(manifest.origin + "/admin" + path);
  await waitForAdminRoute(page, path);
  const root = page.locator('[data-business-table="' + table + '"]');
  await expect(root).toBeVisible();
  await expect(root.locator("[data-business-row]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(100);
  if (path.startsWith("/work-items")) {
    // Compare with an independent read of this list's filters. An overview
    // prefetch may finish during navigation and belongs to a different page.
    let data = expectedWorkItems;
    if (!data) {
      const search = new URL(path, manifest.origin).searchParams;
      const visibility = search.get("visibility") ?? "ACTIVE";
      const query = new URLSearchParams({ type: search.get("type") ?? "ALL", visibility, limit: "20",
        sort_by: search.get("sort_by") ?? (visibility === "IGNORED" ? "ignored_at" : "priority"),
        sort_order: search.get("sort_order") ?? "desc" });
      const response = await page.request.get(manifest.origin + "/api/admin/v1/work-items?" + query);
      expect(response.status()).toBe(200);
      data = (await response.json() as AdminWorkItemPageEnvelope).data;
    }
    expect(data.length).toBeGreaterThan(0);
    await expect(root.locator("[data-business-row]")).toHaveCount(data.length);
    for (const item of data) {
      const row = root.locator('[data-business-row="' + item.type + ":" + item.resource_id + '"]');
      const label = row.getByText(reminderCaption(item), { exact: true });
      await expect(label).toBeVisible();
      await expect(label).toHaveAttribute("data-slot", "badge");
      if (await root.getAttribute("data-list-layout") === "table") {
        await expect(row.locator('[data-column-id="actions"]')).toHaveAttribute("data-column-layout", "status");
      } else await expect(row.locator(".list-summary-aside")).toContainText(reminderCaption(item));
    }
    return { root, workItems: data };
  }
  return { root, workItems: [] as AdminWorkItem[] };
}

async function measureLabels(root: Locator) {
  return root.evaluate(root => {
    const bounds = (element: Element) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const painted = (element: Element) => {
      if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let current: Element | null = element; current && root.contains(current); current = current.parentElement) {
        const style = getComputedStyle(current), box = current.getBoundingClientRect();
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 ||
          /inset\(50%(?:\s|\))/.test(style.clipPath) || box.width === 0 || box.height === 0) return false;
      }
      return true;
    };
    const textRects = (element: Element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const result: ReturnType<typeof bounds>[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement || node.parentElement.closest("svg") || !painted(node.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) {
          result.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
        }
      }
      return result;
    };
    const gap = (first: ReturnType<typeof bounds>, second: ReturnType<typeof bounds>) =>
      Math.max(first.left - second.right, second.left - first.right, first.top - second.bottom, second.top - first.bottom);
    const clipping = (element: Element, rectangles: ReturnType<typeof textRects>) => {
      const cuts: Array<{ ancestor: string; axis: string; overflow: string }> = [];
      for (let ancestor = element.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = bounds(ancestor);
        // A native table scroller may position later columns offscreen until the
        // user scrolls them into view. Intrinsic cell/text clipping is different.
        const tableScroller = ancestor.matches('[data-slot="table-container"], .business-table-surface');
        const horizontal = !tableScroller && ["hidden", "clip"].includes(style.overflowX);
        const vertical = ["hidden", "clip"].includes(style.overflowY);
        if (horizontal && rectangles.some(rect => rect.left < box.left - 1 || rect.right > box.right + 1)) cuts.push({ ancestor: ancestor.className, axis: "x", overflow: style.overflowX });
        if (vertical && rectangles.some(rect => rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) cuts.push({ ancestor: ancestor.className, axis: "y", overflow: style.overflowY });
      }
      return cuts;
    };
    const badges = [...root.querySelectorAll<HTMLElement>('[data-slot="badge"]')].filter(painted);
    const labels = badges.map(element => {
      const text = element.textContent?.trim().replace(/\s+/g, " ") ?? "";
      const box = bounds(element), fragments = textRects(element);
      const lines: number[] = [];
      for (const fragment of fragments) if (!lines.some(top => Math.abs(top - fragment.top) < 2)) lines.push(fragment.top);
      const cell = element.closest("td");
      return { text, short: /^[\p{Script=Han}]{2,7}$/u.test(text), box, fragments, lines: lines.length,
        fontSize: parseFloat(getComputedStyle(element).fontSize), whiteSpace: getComputedStyle(element).whiteSpace,
        cuts: clipping(element, fragments), cell: cell ? bounds(cell) : null };
    });
    const badgeGroups = [...root.querySelectorAll<HTMLElement>(".business-cell-badges, .business-cell-stack")].filter(painted).flatMap(group => {
      const entries = [...group.querySelectorAll<HTMLElement>('[data-slot="badge"]')].filter(painted);
      return entries.flatMap((first, index) => entries.slice(index + 1).map(second => ({ first: first.textContent, second: second.textContent, gap: gap(bounds(first), bounds(second)) })));
    });
    const actionSlots = [...root.querySelectorAll<HTMLElement>('td[data-column-layout="actions"], .business-summary-field[data-column-layout="actions"], td[data-column-id="actions"], .list-summary-aside')].filter(painted);
    const actionGroups = actionSlots.map(slot => {
      const elements = [...slot.querySelectorAll<HTMLElement>('button, a[href]')].filter(painted);
      return { slot: bounds(slot), controls: elements.map(element => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim(), box: bounds(element), fragments: textRects(element), cuts: clipping(element, textRects(element)) })),
        gaps: elements.flatMap((first, index) => elements.slice(index + 1).map(second => gap(bounds(first), bounds(second)))) };
    });
    const tableScrollers = [...root.querySelectorAll<HTMLElement>('.business-table-surface, [data-slot="table-container"]')].map(element => ({
      kind: element.getAttribute("data-slot") ?? "business-table-surface", box: bounds(element),
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
      tableWidth: element.querySelector("table")?.getBoundingClientRect().width ?? null,
    }));
    return { layout: root.getAttribute("data-list-layout"), root: bounds(root), labels, badgeGroups, actionGroups, tableScrollers,
      documentWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

async function assertGeometry(page: Page, info: TestInfo, root: Locator, details: Record<string, unknown>) {
  const geometry = await measureLabels(root);
  await info.attach("compact-status-geometry", { body: JSON.stringify({ ...details, ...geometry }, null, 2), contentType: "application/json" });
  expect(geometry.scrollWidth, "status labels do not widen the page").toBeLessThanOrEqual(geometry.documentWidth + 1);
  if (details.route === "/settings/accounts" && details.width === 1440 && details.fontScale === 1) {
    expect(geometry.layout).toBe("table");
    expect(geometry.tableScrollers.length).toBeGreaterThan(0);
    for (const scroller of geometry.tableScrollers) {
      expect(scroller.scrollLeft, "account columns start fully visible without horizontal scrolling").toBe(0);
      expect(scroller.scrollWidth, "the account table fits its settings container").toBeLessThanOrEqual(scroller.clientWidth + 1);
      expect(scroller.tableWidth, "the complete account table stays within its local scroller").not.toBeNull();
      expect(scroller.tableWidth!).toBeLessThanOrEqual(scroller.clientWidth + 1);
    }
    const configuration = root.locator('td[data-column-id="actions"] :is(button, a[href])');
    // This assertion runs before the reachability loop below can scroll any
    // action into view: the initial settings page must already show Configure.
    await expect(configuration.first()).toBeInViewport({ ratio: 1 });
    expect(await configuration.first().evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || !!hit && element.contains(hit);
    }), "Configure is initially visible and unobstructed").toBe(true);
  }
  const short = geometry.labels.filter(label => label.short);
  expect(short.length, "the requested list contains actual short status labels").toBeGreaterThan(0);
  for (const label of short) {
    expect.soft(label.lines, label.text + " stays on one painted text line").toBe(1);
    expect.soft(label.cuts, label.text + " is not clipped by a summary or cell wrapper").toEqual([]);
    for (const fragment of label.fragments) {
      expect.soft(fragment.left, label.text + " left text edge").toBeGreaterThanOrEqual(label.box.left - 1);
      expect.soft(fragment.right, label.text + " right text edge").toBeLessThanOrEqual(label.box.right + 1);
      expect.soft(fragment.top, label.text + " top text edge").toBeGreaterThanOrEqual(label.box.top - 1);
      expect.soft(fragment.bottom, label.text + " bottom text edge").toBeLessThanOrEqual(label.box.bottom + 1);
    }
    if (label.cell) {
      expect.soft(label.box.left, label.text + " remains in its table column").toBeGreaterThanOrEqual(label.cell.left - 1);
      expect.soft(label.box.right, label.text + " remains in its table column").toBeLessThanOrEqual(label.cell.right + 1);
    }
  }
  for (const group of geometry.badgeGroups) expect.soft(group.gap, String(group.first) + " / " + String(group.second) + " keep a visible gap").toBeGreaterThanOrEqual(2);
  for (const group of geometry.actionGroups) {
    for (const control of group.controls) {
      expect.soft(control.box.width, control.name + " width").toBeGreaterThanOrEqual(24);
      expect.soft(control.box.height, control.name + " height").toBeGreaterThanOrEqual(24);
      expect.soft(control.cuts, control.name + " is not clipped").toEqual([]);
      expect.soft(control.box.left, control.name + " stays in its action slot").toBeGreaterThanOrEqual(group.slot.left - 1);
      expect.soft(control.box.right, control.name + " stays in its action slot").toBeLessThanOrEqual(group.slot.right + 1);
      for (const fragment of control.fragments) {
        expect.soft(fragment.left, control.name + " visible text start").toBeGreaterThanOrEqual(control.box.left - 1);
        expect.soft(fragment.right, control.name + " visible text end").toBeLessThanOrEqual(control.box.right + 1);
      }
    }
    for (const distance of group.gaps) expect.soft(distance, "row actions do not overlap").toBeGreaterThanOrEqual(2);
  }
  const actions = root.locator('td[data-column-layout="actions"] :is(button, a[href]), .business-summary-field[data-column-layout="actions"] :is(button, a[href]), .list-summary-aside button');
  for (const action of await actions.all()) {
    if (!await action.isVisible()) continue;
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport();
    expect.soft(await action.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || !!hit && element.contains(hit);
    }), "row action can be reached without another element covering it").toBe(true);
  }
  await record(page, info, { feature: "compact-status", ...details, statusMeasurements: geometry });
  return geometry;
}

for (const width of [1440, 768, 390, 320]) for (const theme of ["light", "dark"] as const) {
  test(`${width}px ${theme}: all business lists keep status labels and row actions intact`, async ({ page, manifest }, info) => {
    await prepare(page, manifest, width, theme);
    for (const entry of lists) await test.step(entry.path, async () => {
      const { root } = await openList(page, manifest, entry.path, entry.table);
      await assertGeometry(page, info, root, { route: entry.path, width, theme, fontScale: 1, evidence: "actual-isolated-preview-records" });
    });
  });
}

for (const width of [1440, 320]) for (const theme of ["light", "dark"] as const) {
  test(`${width}px ${theme}: 200% text preserves categories, grouped states and seven-character account labels`, async ({ page, manifest }, info) => {
    await prepare(page, manifest, width, theme, 2);
    let selected: AdminWorkItem | undefined;
    for (const type of ["NOTIFICATION_FAILURE", "FINANCIAL_EXCEPTION", "LEDGER_CONFLICT"] as const) {
      const path = "/work-items?type=" + type;
      const { root, workItems } = await openList(page, manifest, path, "work-items");
      expect(workItems.every(item => item.type === type)).toBe(true);
      selected ??= workItems[0];
      const geometry = await assertGeometry(page, info, root, { route: path, width, theme, fontScale: 2, evidence: "actual-isolated-preview-records" });
      expect(geometry.rootFontSize).toBe(32);
      expect(geometry.layout).toBe("summary");
    }
    expect(selected).toBeDefined();
    // Only an ignored-state read snapshot is synthesized. Its existing record
    // identity and business facts remain intact, and no restore POST is sent.
    const ignored = { ...selected!, ignored_at: new Date(manifest.epoch).toISOString(), ignored_by: "几何验收", ended: false } as AdminWorkItem;
    await page.route(manifest.origin + "/api/admin/v1/work-items?*", route => {
      const url = new URL(route.request().url());
      return url.searchParams.get("visibility") === "IGNORED"
        ? route.fulfill({ status: 200, json: { data: [ignored], page: { next_cursor: null } } }) : route.continue();
    });
    const ignoredPath = "/work-items?visibility=IGNORED";
    const ignoredView = await openList(page, manifest, ignoredPath, "ignored-work-items", [ignored]);
    await expect(ignoredView.root.getByRole("button", { name: "恢复提醒", exact: true })).toBeVisible();
    await assertGeometry(page, info, ignoredView.root, { route: ignoredPath, width, theme, fontScale: 2, evidence: "synthetic-ignored-read-snapshot-no-writes", resource: ignored.resource_id });

    const orderPath = "/orders?q=" + encodeURIComponent("空气循环扇");
    const response = await page.request.get(manifest.origin + "/api/admin/v1/orders?q=" + encodeURIComponent("空气循环扇") + "&limit=20");
    expect(response.status()).toBe(200);
    const orders = (await response.json() as AdminOrderPageEnvelope).data;
    expect(orders.some(order => order.refund_mark.marked && order.payment.status === "CONFIRMED")).toBe(true);
    const orderView = await openList(page, manifest, orderPath, "orders");
    await expect(orderView.root.getByText("收款已确认", { exact: true })).toBeVisible();
    await expect(orderView.root.getByText("已标记退款", { exact: true })).toBeVisible();
    const grouped = await assertGeometry(page, info, orderView.root, { route: orderPath, width, theme, fontScale: 2, evidence: "actual-isolated-refund-marked-order" });
    expect(grouped.badgeGroups.length).toBeGreaterThan(0);

    const accountResponse = await page.request.get(manifest.origin + "/api/admin/v1/alipay-accounts");
    expect(accountResponse.status()).toBe(200);
    const accounts = (await accountResponse.json() as AlipayAccountListEnvelope).data;
    expect(accounts.length).toBeGreaterThan(0);
    // The legacy status is a read-only presentation fixture; it neither edits
    // the saved account nor changes any live collection configuration.
    await page.route(manifest.origin + "/api/admin/v1/alipay-accounts", route => route.fulfill({ status: 200, json: { data: [{ ...accounts[0], environment: "SANDBOX", enabled: false }] } }));
    const accountView = await openList(page, manifest, "/settings/accounts", "alipay-accounts");
    await expect(accountView.root.getByText("旧版账号已停用", { exact: true })).toBeVisible();
    await assertGeometry(page, info, accountView.root, { route: "/settings/accounts", width, theme, fontScale: 2, evidence: "synthetic-legacy-account-read-snapshot-no-writes" });
  });
}
