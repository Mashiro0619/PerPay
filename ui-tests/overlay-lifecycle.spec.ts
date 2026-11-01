import { test as base, expect, type Page } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import { HTTP_TEST_ADMIN_PASSWORD } from "../test/http-fixture";
import { LedgerStore } from "../src/ledger/store";
import { ReconciliationStore } from "../src/reconciliation/store";

type SettingsFixture = Awaited<ReturnType<typeof createSettingsServer>>;
const test = base.extend<{ fixture: SettingsFixture }>({
  fixture: async ({}, use) => {
    const epoch = Date.now();
    const fixture = await createSettingsServer(epoch, { runtime: services => {
      const snapshot = services.settings.instanceSnapshot();
      const healthy = { enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: epoch, lastSuccessAt: epoch, lastErrorCode: null, consecutiveFailures: 0, paymentRevision: snapshot.paymentRevision };
      // Real local stores with explicit readiness; no provider or webhook transport runs.
      return {
        ledger: new LedgerStore(services.database),
        reconciliation: new ReconciliationStore(services.database),
        runtimeStatus: () => ({ configured: true, transitioning: false, paymentRevision: snapshot.paymentRevision,
          activeProviderAccountKey: snapshot.activeProviderAccountKey, scanIntervalMilliseconds: 10_000, maximumSuccessAgeMilliseconds: 60_000 }),
        ledgerHealth: () => healthy,
        reconciliationHealth: () => ({ ...healthy, pendingOrders: 0, continuationPending: false }),
        accountHealth: () => ({ state: "healthy", lastSuccessAt: epoch, lastErrorCode: null, collectionReady: true }),
      };
    } });
    try { await use(fixture); } finally { await fixture.close(); }
  },
  page: async ({ page, fixture }, use) => {
    await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await use(page);
  },
});
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

async function openSiteEditor(page: Page, fixture: SettingsFixture) {
  await page.goto(fixture.origin + "/admin/sites/default/settings/basic");
  await page.getByRole("link", { name: "编辑基本信息", exact: true }).click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByRole("textbox", { name: "业务网站名称", exact: true })).toBeVisible();
  return overlay;
}

async function browserBack(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    addEventListener("popstate", () => requestAnimationFrame(() => resolve()), { once: true });
    history.back();
  }));
}

test("a dirty editor keeps its tabs, values and focus when Escape or browser Back is cancelled", async ({ page, fixture }) => {
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/v1/sites/default" && request.method() !== "GET") writes.push(request.method());
  });
  const overlay = await openSiteEditor(page, fixture);
  const field = overlay.getByRole("textbox", { name: "业务网站名称", exact: true });
  await field.fill("保留网站草稿");
  await overlay.getByRole("tab", { name: "订单设置", exact: true }).click();
  await overlay.getByRole("tab", { name: "基本信息", exact: true }).click();
  await expect(field).toHaveValue("保留网站草稿");
  await field.focus();
  const address = page.url();
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(field).toHaveValue("保留网站草稿");
  await expect(page).toHaveURL(address);
  await expect(field).toBeFocused();
  await browserBack(page);
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page).toHaveURL(address);
  await expect(field).toHaveValue("保留网站草稿");
  await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await discard.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await expect(page).toHaveURL(fixture.origin + "/admin/sites/default/settings/basic");
  expect(writes).toEqual([]);
});

test("a submitted test payment blocks browser Back and dismissal, then retains its one result after reopening", async ({ page, fixture }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let created!: () => void;
  const committed = new Promise<void>(resolve => { created = resolve; });
  let requests = 0;
  await page.route(fixture.origin + "/api/admin/v1/sites/default/test-payments", async route => {
    requests++;
    // The isolated SQLite command completes; only its browser response is held.
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    created();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(fixture.origin + "/admin/sites/default");
    const trigger = page.getByRole("button", { name: "测试收款", exact: true });
    await trigger.click();
    const overlay = page.locator("[data-overlay-content]");
    await expect(overlay.getByRole("textbox", { name: "测试金额（元）", exact: true })).toBeVisible();
    const submit = overlay.getByRole("button", { name: "创建测试订单", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await committed;
    const address = page.url();
    await expect(overlay.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await browserBack(page);
    await expect(page).toHaveURL(address);
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await expect(overlay).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(requests).toBe(1);
    release();
    await expect(overlay.getByRole("heading", { name: "测试订单已创建", exact: true })).toBeVisible();
    await overlay.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(overlay).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(overlay.getByRole("heading", { name: "测试订单已创建", exact: true })).toBeVisible();
    await expect(overlay.getByRole("link", { name: "查看订单", exact: true })).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("session revocation clears an open dirty editor and signing in again keeps the parent page", async ({ page, fixture }) => {
  const overlay = await openSiteEditor(page, fixture);
  await overlay.getByRole("textbox", { name: "业务网站名称", exact: true }).fill("旧会话的草稿");
  const peer = await page.context().newPage();
  try {
    await peer.goto(fixture.origin + "/admin/");
    await peer.getByRole("button", { name: /账户菜单$/ }).click();
    await peer.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(peer.getByRole("heading", { name: "登录管理后台", exact: true })).toBeVisible();
    await page.bringToFront();
    // The regular foreground-resume query observes the revoked server session.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("heading", { name: "登录管理后台", exact: true })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page).toHaveURL(fixture.origin + "/admin/sites/default/settings/basic");
    await page.getByLabel("管理员密码", { exact: true }).fill(HTTP_TEST_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("link", { name: "编辑基本信息", exact: true })).toBeVisible();
    await expect(overlay).toHaveCount(0);
    expect(await page.locator("input").evaluateAll(inputs => inputs.some(input => input instanceof HTMLInputElement && input.value === "旧会话的草稿"))).toBe(false);
  } finally { await peer.close(); }
});

test("a first unauthenticated visit retains its shared overlay URL through sign-in", async ({ page, fixture }) => {
  await page.context().clearCookies();
  const address = fixture.origin + "/admin/settings/security?overlay=%2Fsettings%2Fsecurity%2Fpassword";
  await page.goto(address);
  await expect(page.getByRole("heading", { name: "登录管理后台", exact: true })).toBeVisible();
  await expect(page).toHaveURL(address);
  await page.getByLabel("管理员密码", { exact: true }).fill(HTTP_TEST_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("[data-overlay-content]").getByLabel("新密码", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(address);
});

test("native new-tab links retain the filtered parent and old deep links close safely after reload", async ({ page, fixture }) => {
  const orderId = fixture.seedPaidOrder();
  const parent = fixture.origin + "/admin/orders?payment=CONFIRMED&q=" + encodeURIComponent("退款");
  await page.goto(parent);
  const rows = page.locator('[data-business-table="orders"]');
  const original = await rows.elementHandle();
  expect(original).not.toBeNull();
  const link = rows.locator("a[data-row-link]").first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(new URL(href!, fixture.origin).pathname).toBe("/admin/orders");
  expect(new URL(href!, fixture.origin).searchParams.get("overlay")).toBe("/orders/" + orderId);
  expect(new URL(href!, fixture.origin).searchParams.get("payment")).toBe("CONFIRMED");
  const [opened] = await Promise.all([page.context().waitForEvent("page", { timeout: 10_000 }), link.click({ button: "middle" })]);
  try {
    await expect(opened.locator("[data-overlay-content]")).toBeVisible();
    expect(new URL(opened.url()).searchParams.get("q")).toBe("退款");
    await opened.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await expect(opened.locator("[data-overlay-content]")).toHaveCount(0);
    await expect(opened).toHaveURL(parent);
    await expect(page).toHaveURL(parent);
  } finally { await opened.close(); }
  await link.click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay).toBeVisible();
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await overlay.getByRole("tab", { name: "通知", exact: true }).click();
  expect(new URL(page.url()).searchParams.has("section")).toBe(false);
  expect(new URL(page.url()).searchParams.get("overlay")).toBe("/orders/" + orderId + "?section=notifications");
  await browserBack(page);
  await expect(overlay).toHaveCount(0);
  await expect(page).toHaveURL(parent);
  await expect(link).toBeFocused();
  expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  await page.goto(fixture.origin + "/admin/orders/" + orderId);
  await expect(overlay).toBeVisible();
  await page.reload();
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(page).toHaveURL(fixture.origin + "/admin/orders");
  await expect(overlay).toHaveCount(0);
});

test("site-scoped related details keep a global parent and restore foreground history without changing its API scope", async ({ page, fixture }) => {
  const orderId = fixture.seedPaidOrder();
  const response = await page.request.get(fixture.origin + "/api/admin/v1/sites/default/orders/" + orderId);
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { data: { reconciliation: { matches: { payment_match_id: string }[] } } };
  const matchId = payload.data.reconciliation.matches[0]!.payment_match_id;
  const reads: string[] = [];
  page.on("request", request => { if (request.method() === "GET" && request.url().startsWith(fixture.origin + "/api/")) reads.push(new URL(request.url()).pathname); });
  const parent = fixture.origin + "/admin/orders?payment=CONFIRMED";
  const target = "/sites/default/orders/" + orderId;
  await page.goto(parent + "&overlay=" + encodeURIComponent(target));
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByRole("tab", { name: "收款关联", exact: true })).toBeVisible();
  const popup = await overlay.elementHandle();
  await overlay.getByRole("tab", { name: "收款关联", exact: true }).click();
  await overlay.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true }).click();
  const related = page.getByRole("menuitem", { name: "查看详情", exact: true });
  await expect(related).toBeVisible();
  expect(new URL((await related.getAttribute("href"))!, fixture.origin).pathname).toBe("/admin/orders");
  await related.click();
  const matchTarget = "/sites/default/reconciliation/matches/" + matchId;
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(matchTarget);
  await expect.poll(() => reads.includes("/api/admin/v1/sites/default/reconciliation/matches/" + matchId)).toBe(true);
  expect(reads).toContain("/api/admin/v1/orders");
  expect(reads).toContain("/api/admin/v1/sites/default/orders/" + orderId);
  expect(reads).not.toContain("/api/admin/v1/sites/default/orders");
  expect(reads).not.toContain("/api/admin/v1/reconciliation/matches/" + matchId);
  expect(await popup!.evaluate(element => element.isConnected)).toBe(true);
  await browserBack(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(target + "?section=payments");
  await expect(overlay.getByRole("tab", { name: "收款关联", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => history.forward());
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(matchTarget);
  await overlay.getByRole("button", { name: "返回上一步", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(target + "?section=payments");
  await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(page).toHaveURL(parent);
});
