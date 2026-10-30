import { mkdir } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit } from "./audit";

const gridSelector = ".security-settings-card-grid";
const cardLabels = ["管理员 IP 白名单", "密钥", "修改密码", "登录会话"];
const evidenceDirectory = ".ui-audit/security-card-flow-20261021";

async function configure(page: Page, theme: "light" | "dark", mode: "compact" | "full") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}

async function storageWidth(page: Page, mode: "compact" | "full") {
  // Notify the existing preference store without stealing focus from a draft
  // or clicking behind an open menu or dialog.
  await page.evaluate(mode => {
    const key = "perpay:content-width", oldValue = localStorage.getItem(key);
    localStorage.setItem(key, mode);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: mode, storageArea: localStorage, url: location.href }));
  }, mode);
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
}

async function openSecurity(page: Page, manifest: Manifest) {
  await page.goto(manifest.origin + "/admin/settings/security");
  await expect(page.locator('.admin-settings-layout[data-settings-section="security"]')).toBeVisible();
  await expect(page.locator(gridSelector)).toHaveAttribute("data-measured", "true");
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByLabel("允许的 IP / 网段", { exact: true })).toBeVisible();
}

async function gridGeometry(page: Page) {
  return page.locator(gridSelector).evaluate(grid => {
    const root = grid.getBoundingClientRect(), style = getComputedStyle(grid);
    const widths = style.gridTemplateColumns.trim().split(/\s+/).map(Number.parseFloat);
    const gap = Number.parseFloat(style.columnGap);
    const items = [...grid.querySelectorAll<HTMLElement>(":scope > [data-detail-grid-item]")].map((item, index) => {
      const content = item.querySelector<HTMLElement>(":scope > [data-detail-grid-content]")!;
      const card = content.querySelector<HTMLElement>('[data-slot="card"]')!;
      const box = content.getBoundingClientRect(), cardBox = card.getBoundingClientRect();
      const itemStyle = getComputedStyle(item);
      return { index, label: card.querySelector('[data-slot="card-title"]')?.textContent,
        left: box.left - root.left, top: box.top - root.top, width: box.width, height: box.height,
        cardHeight: cardBox.height, cardContained: cardBox.top >= box.top - 1 && cardBox.bottom <= box.bottom + 1,
        clipped: content.scrollWidth > content.clientWidth + 1 || card.scrollWidth > card.clientWidth + 1,
        span: itemStyle.gridRowEnd,
        columnSpan: Number.parseInt(itemStyle.gridColumnStart.match(/^span (\d+)$/)?.[1] ?? itemStyle.gridColumnEnd.match(/^span (\d+)$/)?.[1] ?? "1", 10),
      };
    });
    const cursors = widths.map(() => 0), previousBottoms: Array<number | null> = widths.map(() => null);
    const violations: string[] = [], verticalGaps: number[] = [];
    for (const item of items) {
      if (item.columnSpan < 1 || item.columnSpan > widths.length) {
        violations.push(`item ${item.index} has an invalid column span`);
        continue;
      }
      // A spanning card needs adjacent free tracks, so its earliest natural
      // position follows the tallest occupied track within each candidate span.
      const candidates = Array.from({ length: widths.length - item.columnSpan + 1 }, (_, column) =>
        Math.max(...cursors.slice(column, column + item.columnSpan)));
      const expectedTop = Math.min(...candidates), column = candidates.indexOf(expectedTop);
      const expectedLeft = widths.slice(0, column).reduce((sum, width) => sum + width, 0) + gap * column;
      const expectedWidth = widths.slice(column, column + item.columnSpan).reduce((sum, width) => sum + width, 0) + gap * (item.columnSpan - 1);
      if (Math.abs(item.left - expectedLeft) > 1) violations.push(`item ${item.index} is not in the first available column span`);
      if (Math.abs(item.top - expectedTop) > 1) violations.push(`item ${item.index} leaves a vertical hole`);
      if (Math.abs(item.width - expectedWidth) > 1) violations.push(`item ${item.index} does not fill its column span`);
      if (Math.abs(item.cardHeight - item.height) > 1 || !item.cardContained) violations.push(`item ${item.index} stretches or clips its card`);
      if (item.clipped) violations.push(`item ${item.index} clips its content horizontally`);
      const occupiedBottoms = previousBottoms.slice(column, column + item.columnSpan).filter((bottom): bottom is number => bottom !== null);
      if (occupiedBottoms.length) {
        const actualGap = item.top - Math.max(...occupiedBottoms);
        verticalGaps.push(actualGap);
        if (actualGap < 16 - 0.02 || actualGap > 17 + 0.02) violations.push(`item ${item.index} has vertical gap ${actualGap}`);
      }
      const span = Math.max(1, Math.ceil(item.height + gap));
      if (Number.parseInt(item.span.replace("span", "").trim(), 10) !== span) violations.push(`item ${item.index} span does not match its natural height`);
      for (let track = column; track < column + item.columnSpan; track++) {
        cursors[track] = expectedTop + span;
        previousBottoms[track] = item.top + item.height;
      }
      if (item.left < -1 || item.left + item.width > root.width + 1) violations.push(`item ${item.index} escapes the grid`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      if (overlapX > 1 && overlapY > 1) violations.push(`items ${i}/${j} overlap`);
    }
    const firstRow = items.slice(0, widths.length), following = items[widths.length];
    const continuesBeforeTallest = widths.length > 1 && !!following && following.top + 1 < Math.max(...firstRow.map(item => item.top + item.height)) + gap;
    return { width: root.width, columns: widths.length, gap, rowGap: Number.parseFloat(style.rowGap),
      widths, items, verticalGaps, continuesBeforeTallest, violations };
  });
}

async function settledGrid(page: Page) {
  await page.evaluate(async selector => {
    await document.fonts.ready;
    const animations = document.querySelector(selector)?.getAnimations({ subtree: true }) ?? [];
    await Promise.all(animations.filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  }, gridSelector);
  await page.clock.runFor(50);
  await expect.poll(async () => (await gridGeometry(page)).violations).toEqual([]);
  const geometry = await gridGeometry(page);
  expect(geometry.gap).toBe(16);
  expect(geometry.rowGap).toBe(0);
  expect(geometry.columns).toBe(geometry.width >= 1280 ? 3 : geometry.width >= 768 ? 2 : 1);
  expect(geometry.items.map(item => item.label)).toEqual(cardLabels);
  expect(geometry.items.map(item => item.columnSpan)).toEqual([1, 1, 1, geometry.columns === 3 ? 2 : 1]);
  return geometry;
}

async function retainItems(page: Page) {
  return page.locator(gridSelector + " > [data-detail-grid-item]").evaluateAll(items => items.map((item, index) => {
    const marker = "security-original-" + index;
    item.setAttribute("data-security-flow-retained", marker);
    return marker;
  }));
}

async function expectRetained(page: Page, markers: string[]) {
  expect(await page.locator(gridSelector + " > [data-detail-grid-item]").evaluateAll(items => items.map(item => item.getAttribute("data-security-flow-retained")))).toEqual(markers);
}

async function blockMutations(page: Page) {
  const attemptedWrites: string[] = [];
  await page.route("**/api/admin/v1/**", route => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    attemptedWrites.push(request.method() + " " + new URL(request.url()).pathname);
    return route.abort("blockedbyclient");
  });
  return attemptedWrites;
}

async function capture(page: Page, info: TestInfo, id: string) {
  await mkdir(evidenceDirectory, { recursive: true });
  const path = evidenceDirectory + "/" + id + ".png";
  await page.screenshot({ path, fullPage: true });
  await info.attach(id, { path, contentType: "image/png" });
}

test("security cards keep natural heights and DOM order across themes and content widths", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  const writes = await blockMutations(page), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page, manifest);
  const columns = new Set<number>();
  let shortestColumnWitness = false;
  let rightSideSessionsWitness = false;
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await configure(page, theme, mode);
    await openSecurity(page, manifest);
    const geometry = await settledGrid(page);
    columns.add(geometry.columns);
    shortestColumnWitness ||= geometry.continuesBeforeTallest;
    expect(new Set(geometry.items.map(item => item.height)).size).toBeGreaterThan(1);
    const layout = await page.locator('.admin-settings-layout[data-settings-section="security"]').evaluate(element => ({
      width: element.getBoundingClientRect().width, maxWidth: getComputedStyle(element).maxWidth,
    }));
    expect(layout.maxWidth).toBe("none");
    expect(Math.abs(layout.width - geometry.width)).toBeLessThanOrEqual(1);
    const sessions = await page.locator("[data-login-sessions]").evaluate(element => {
      const box = element.getBoundingClientRect();
      const grid = element.closest(".security-settings-card-grid")!.getBoundingClientRect();
      const item = element.closest("[data-detail-grid-item]")!.getBoundingClientRect();
      return { width: box.width, top: box.top - grid.top, left: box.left - grid.left,
        itemWidth: item.width, inGrid: !!element.closest(".security-settings-card-grid") };
    });
    expect(sessions.inGrid).toBe(true);
    expect(Math.abs(sessions.width - sessions.itemWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(sessions.top - geometry.items[3]!.top)).toBeLessThanOrEqual(1);
    if (geometry.columns === 3) {
      const [whitelist, keys, password] = geometry.items;
      expect(Math.abs(sessions.left - keys!.left)).toBeLessThanOrEqual(1);
      expect(sessions.top).toBeGreaterThanOrEqual(Math.max(keys!.top + keys!.height, password!.top + password!.height) + 15);
      expect(sessions.top, "sessions fill the right-side space beside the taller whitelist").toBeLessThan(whitelist!.top + whitelist!.height);
      rightSideSessionsWitness = true;
    }
    await record(page, info, { feature: "security-natural-card-flow", width, theme, mode, geometry, layout, sessions,
      evidence: "isolated-synthetic-settings-fixture" });
    await capture(page, info, `security-flow-${width}-${theme}-${mode}`);
    if (width === 320 && mode === "compact") await audit(page, info, "security-flow-" + theme);
  }
  expect([...columns].sort()).toEqual([1, 2, 3]);
  expect(shortestColumnWitness, "a later security card fills the shorter column before the taller card ends").toBe(true);
  expect(rightSideSessionsWitness, "the three-column layout places sessions below the two shorter right-hand cards").toBe(true);
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test("security drafts, validation and card identity survive resize and content-width changes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "compact");
  await openSecurity(page, manifest);
  const before = await settledGrid(page), retained = await retainItems(page);
  expect(before.columns).toBe(2);
  const whitelist = page.getByLabel("允许的 IP / 网段", { exact: true });
  const draft = Array.from({ length: 35 }, (_, index) => `192.0.2.${index + 1}`).join("\n");
  await whitelist.fill(draft);
  await whitelist.focus();
  await whitelist.evaluate(element => element.setAttribute("data-security-flow-draft", "whitelist"));
  const expanded = await settledGrid(page);
  expect(expanded.items[0]!.height, "long drafts stay within the bounded text area").toBeCloseTo(before.items[0]!.height, 1);
  expect(expanded.items.slice(1).every((item, index) => Math.abs(item.top - before.items[index + 1]!.top) <= 1 && Math.abs(item.left - before.items[index + 1]!.left) <= 1), "typing a long whitelist does not displace the other cards").toBe(true);
  const draftScroll = await whitelist.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return { height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight) };
  });
  expect(draftScroll.scrollHeight).toBeGreaterThan(draftScroll.height);
  expect(draftScroll.scrollTop, "the complete long draft remains reachable within its own text area").toBeGreaterThan(0);
  expect(draftScroll.height).toBeLessThanOrEqual(draftScroll.maxHeight + 1);
  await expectRetained(page, retained);
  for (const [width, mode] of [[320, "compact"], [390, "full"], [1440, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    const geometry = await settledGrid(page);
    await expect(whitelist).toHaveAttribute("data-security-flow-draft", "whitelist");
    await expect(whitelist).toHaveValue(draft);
    await expect(whitelist).toBeFocused();
    await expectRetained(page, retained);
    await record(page, info, { feature: "security-whitelist-draft-retained", width, mode, geometry, draftLines: 35 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await storageWidth(page, "compact");
  const password = page.getByLabel("新密码", { exact: true });
  const confirmation = page.getByLabel("再次输入新密码", { exact: true });
  await password.fill("tiny");
  await confirmation.fill("different-unsubmitted-confirmation");
  const withoutError = await settledGrid(page);
  await page.getByRole("button", { name: "修改并重新登录", exact: true }).click();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("密码至少需要 6 个字符。", { exact: true })).toBeVisible();
  const invalid = await settledGrid(page);
  expect(invalid.items[2]!.height).toBeGreaterThan(withoutError.items[2]!.height + 10);
  await password.evaluate(element => element.setAttribute("data-security-flow-draft", "password"));
  for (const [width, mode] of [[390, "full"], [2190, "full"], [1440, "compact"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await settledGrid(page);
    await expect(password).toHaveValue("tiny");
    await expect(confirmation).toHaveValue("different-unsubmitted-confirmation");
    await expect(password).toHaveAttribute("data-security-flow-draft", "password");
    await expect(password).toBeFocused();
    await expect(whitelist).toHaveValue(draft);
    await expectRetained(page, retained);
  }
  await record(page, info, { feature: "security-local-validation-reflow", before, expanded, withoutError, invalid,
    evidence: "local-validation-only-no-password-or-whitelist-submission" });
  await capture(page, info, "security-drafts-and-local-validation");
  expect(writes).toEqual([]);
});

test("security session cancellation keeps focus through card reflow without writes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "full");
  await openSecurity(page, manifest);
  await settledGrid(page);
  const retained = await retainItems(page);
  const session = page.getByRole("button", { name: "会话操作", exact: true });
  await session.evaluate(element => element.setAttribute("data-security-flow-session", "original"));
  await session.click();
  const menu = page.getByRole("menu", { includeHidden: true });
  const revoke = menu.getByRole("menuitem", { name: "注销全部会话", exact: true });
  await menu.evaluate(element => element.setAttribute("data-security-flow-menu", "original"));
  await revoke.focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await storageWidth(page, "compact");
  await settledGrid(page);
  await expect(menu).toHaveAttribute("data-security-flow-menu", "original");
  await expect(revoke).toBeFocused();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", { name: "注销全部会话？", exact: true });
  await expect(confirmation).toBeVisible();
  await page.setViewportSize({ width: 2190, height: 900 });
  await storageWidth(page, "full");
  await settledGrid(page);
  await expect(confirmation).toBeVisible();
  await expectRetained(page, retained);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(session).toBeFocused();
  await expect(session).toHaveAttribute("data-security-flow-session", "original");
  expect(writes).toEqual([]);
  await record(page, info, { feature: "security-session-modal-focus-retained", writes });
  await capture(page, info, "security-modal-focus-restored");
});

test("account key content, drafts and confirmation focus survive content-width changes without writes", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
      (window as Window & { __copiedText?: string }).__copiedText = value;
    } } });
  });
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "full");
  await openSecurity(page, manifest);
  const accountEntry = page.getByRole("link", { name: "在支付宝账号中管理应用密钥", exact: true });
  await accountEntry.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + "/admin/settings/accounts");
  const response = await page.request.get(manifest.origin + "/api/admin/v1/alipay-accounts");
  expect(response.ok()).toBe(true);
  const accounts = await response.json() as { data: { id: string; name: string; application_public_key: string | null }[] };
  const account = accounts.data.find(item => item.application_public_key);
  expect(account, "the isolated fixture has a configured account with a public key").toBeTruthy();
  await page.getByRole("link", { name: "配置" + account!.name, exact: true }).click();
  await expect(page).toHaveURL(manifest.origin + "/admin/settings/accounts/" + account!.id);
  const keyCard = page.locator("[data-account-key-card]");
  const publicKey = keyCard.getByText(account!.application_public_key!, { exact: true });
  await expect(publicKey).toHaveText(account!.application_public_key!);
  await keyCard.evaluate(element => element.setAttribute("data-security-flow-key-card", "original"));
  const name = page.getByLabel("账号名称", { exact: true });
  const draft = account!.name + " · 未保存的宽度验证";
  await name.fill(draft);
  await name.evaluate(element => element.setAttribute("data-security-flow-draft", "account"));
  for (const [width, mode] of [[390, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(name).toHaveValue(draft);
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("data-security-flow-draft", "account");
    await expect(keyCard).toHaveAttribute("data-security-flow-key-card", "original");
    await expect(publicKey).toHaveText(account!.application_public_key!);
  }
  await name.fill(account!.name);
  const copy = keyCard.getByRole("button", { name: "复制应用公钥", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(account!.application_public_key);
  await expect(copy).toBeFocused();
  const regenerate = page.getByRole("button", { name: "更换应用密钥", exact: true });
  await expect(regenerate).toBeEnabled();
  await regenerate.evaluate(element => element.setAttribute("data-security-flow-view", "original"));
  await regenerate.focus();
  await page.keyboard.press("Enter");
  const keyDialog = page.getByRole("alertdialog", { name: "生成新的应用密钥？", exact: true });
  await keyDialog.evaluate(element => element.setAttribute("data-security-flow-dialog", "key-confirmation"));
  const cancel = keyDialog.getByRole("button", { name: "取消", exact: true });
  await cancel.focus();
  for (const [width, mode] of [[390, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await expect(keyDialog).toHaveAttribute("data-security-flow-dialog", "key-confirmation");
    await expect(cancel).toBeFocused();
    await expect(keyCard).toHaveAttribute("data-security-flow-key-card", "original");
    await expect(name).toHaveAttribute("data-security-flow-draft", "account");
    await expect(name).toHaveValue(account!.name);
  }
  await cancel.click();
  await expect(keyDialog).toHaveCount(0);
  await expect(regenerate).toBeFocused();
  await expect(regenerate).toHaveAttribute("data-security-flow-view", "original");
  await expect(publicKey).toHaveText(account!.application_public_key!);
  expect(writes).toEqual([]);
  await record(page, info, { feature: "account-key-content-and-modal-focus-retained", keyCharacters: account!.application_public_key!.length, writes, evidence: "real account reads from the isolated synthetic fixture; no secret reveal or key change" });
  await capture(page, info, "account-key-modal-focus-restored");
});

test("other settings sections retain their existing 56rem maximum width", async ({ page, manifest }, info) => {
  const writes = await blockMutations(page);
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  for (const mode of ["compact", "full"] as const) {
    await configure(page, "light", mode);
    for (const section of ["accounts", "collection-policy", "backup", "display", "advanced", "provider", "collection"]) {
      await page.goto(manifest.origin + "/admin/settings/" + section);
      const currentSection = ["provider", "collection"].includes(section) ? "accounts" : section;
      await expect(page).toHaveURL(manifest.origin + "/admin/settings/" + currentSection);
      const layout = page.locator('.admin-settings-layout[data-settings-section="' + currentSection + '"]');
      await expect(layout).toBeVisible();
      await expect(page.locator(gridSelector)).toHaveCount(0);
      const geometry = await layout.evaluate(element => ({ width: element.getBoundingClientRect().width,
        maxWidth: getComputedStyle(element).maxWidth, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) }));
      expect(geometry.maxWidth).toBe(56 * geometry.rem + "px");
      expect(geometry.width).toBeLessThanOrEqual(56 * geometry.rem + 1);
      await record(page, info, { feature: "non-security-settings-width-retained", section, currentSection, mode, geometry });
    }
  }
  expect(writes).toEqual([]);
});
