import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { screenshot } from "./audit";

const currentId = "11111111-1111-4111-8111-111111111111";
const mobileId = "22222222-2222-4222-8222-222222222222";
const legacyId = "33333333-3333-4333-8333-333333333333";
const ipv6 = "2409:8924:405f:40ff:18e0:adf0:f68c:a954";
const cardSelector = "[data-login-sessions]";

type Session = {
  session_id: string;
  is_current: boolean;
  user_agent: string | null;
  ip_address: string | null;
  auth_method: "password";
  last_seen_at: string;
  expires_at: string;
};

function sessions(epoch: number): Session[] {
  const iso = (offset: number) => new Date(epoch + offset).toISOString();
  return [
    { session_id: currentId, is_current: true,
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      ip_address: "192.0.2.25", auth_method: "password", last_seen_at: iso(-18_000), expires_at: iso(1_800_000) },
    { session_id: mobileId, is_current: false,
      user_agent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      ip_address: ipv6, auth_method: "password", last_seen_at: iso(-2 * 86_400_000), expires_at: iso(29 * 86_400_000) },
    { session_id: legacyId, is_current: false, user_agent: null, ip_address: null,
      auth_method: "password", last_seen_at: iso(-4 * 86_400_000), expires_at: iso(20 * 86_400_000) },
  ];
}

async function syntheticSessions(page: Page, manifest: Manifest) {
  const state = { rows: sessions(manifest.epoch), reads: 0, writes: [] as string[],
    unexpectedWrites: [] as string[], failedReads: 0, failMutation: false };
  // Every write stays in this browser. No revoke operation reaches the shared
  // demo fixture, even when its browser-only read-only hint is bypassed.
  await page.route("**/api/admin/v1/**", route => {
    const request = route.request();
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    state.unexpectedWrites.push(request.method() + " " + new URL(request.url()).pathname);
    return route.abort("blockedbyclient");
  });
  await page.route("**/api/admin/v1/sessions**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/admin/v1/sessions") {
      state.reads++;
      if (state.failedReads > 0) {
        state.failedReads--;
        return route.fulfill({ status: 503, json: { error: { code: "session_list_unavailable", message: "合成会话列表暂不可用" } } });
      }
      return route.fulfill({ json: { data: state.rows } });
    }
    if (request.method() !== "POST") return route.fallback();
    const revokeId = path.match(/^\/api\/admin\/v1\/sessions\/([^/]+)\/revoke$/)?.[1];
    if (path !== "/api/admin/v1/sessions/revoke-others" && !revokeId) return route.fallback();
    state.writes.push(path);
    expect(request.postDataJSON()).toEqual({});
    if (state.failMutation) return route.fulfill({ status: 503,
      json: { error: { code: "session_revoke_unavailable", message: "合成会话撤销暂不可用" } } });
    if (revokeId) {
      state.rows = state.rows.filter(row => row.session_id !== revokeId);
      return route.fulfill({ status: 204 });
    }
    const revoked = state.rows.filter(row => !row.is_current).length;
    state.rows = state.rows.filter(row => row.is_current);
    return route.fulfill({ json: { data: { revoked_sessions: revoked } } });
  });
  return state;
}

async function openSecurity(page: Page, manifest: Manifest, writable = false) {
  await page.goto(manifest.origin + "/admin/settings/security");
  await expect(page.locator(cardSelector)).toBeVisible();
  await expect(page.getByLabel("允许的 IP / 网段", { exact: true })).toBeVisible();
  if (writable) await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
}

test("session rows fill their own card across themes and narrow or wide content", async ({ page, manifest }, info) => {
  const state = await syntheticSessions(page, manifest);
  await login(page, manifest);
  for (const [width, theme, mode] of [
    [320, "light", "compact"], [390, "dark", "full"],
    [1440, "light", "compact"], [1440, "dark", "full"],
    [2190, "light", "full"], [2190, "dark", "compact"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, { theme, mode });
    await openSecurity(page, manifest);
    const card = page.locator(cardSelector);
    await expect(card.locator("[data-session-id]")).toHaveCount(3);
    expect(await card.locator("[data-session-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-session-id"))))
      .toEqual([currentId, mobileId, legacyId]);
    await expect(card.locator(`[data-session-id="${currentId}"]`)).toContainText("Chrome");
    await expect(card.locator(`[data-session-id="${currentId}"]`)).toContainText("Windows");
    await expect(card.locator(`[data-session-id="${currentId}"]`)).toContainText("当前");
    await expect(card.locator(`[data-session-id="${mobileId}"]`)).toContainText("Android");
    await expect(card.getByText(ipv6, { exact: false })).toBeVisible();
    await expect(card.locator(`[data-session-id="${legacyId}"]`)).toContainText("未知");
    const geometry = await card.evaluate(element => {
      const box = element.getBoundingClientRect(), grid = document.querySelector(".security-settings-card-grid")!.getBoundingClientRect();
      return { width: box.width, top: box.top, gridWidth: grid.width, gridBottom: grid.bottom,
        clipped: element.scrollWidth > element.clientWidth + 1,
        clippedRows: [...element.querySelectorAll<HTMLElement>("[data-session-id]")].filter(row => row.scrollWidth > row.clientWidth + 1).length };
    });
    expect(Math.abs(geometry.width - geometry.gridWidth)).toBeLessThanOrEqual(1);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.gridBottom + 15);
    expect(geometry.clipped).toBe(false);
    expect(geometry.clippedRows).toBe(0);
    await record(page, info, { feature: "login-session-card", width, theme, mode, geometry, source: "synthetic-public-session-metadata" });
    if (width === 320 || width === 390 || width === 1440) await screenshot(page, info, `sessions-${width}-${theme}`);
  }
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("session confirmations cancel with restored focus and no session writes", async ({ page, manifest }) => {
  const state = await syntheticSessions(page, manifest);
  await login(page, manifest);
  await openSecurity(page, manifest, true);
  const card = page.locator(cardSelector);
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  for (const [trigger, title] of [
    [card.getByRole("button", { name: "退出登录", exact: true }), "退出当前会话？"],
    [card.locator(`[data-session-id="${mobileId}"]`).getByRole("button", { name: /^撤销/ }), "撤销此会话？"],
    [card.getByRole("button", { name: "退出其他会话", exact: true }), "退出其他会话？"],
  ] as const) {
    await trigger.click();
    const dialog = page.getByRole("alertdialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  const menuTrigger = card.getByRole("button", { name: "会话操作", exact: true });
  await menuTrigger.click();
  await page.getByRole("menuitem", { name: "注销全部会话", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "注销全部会话？", exact: true });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("single and other-session revocation refresh only the session list and retain security drafts", async ({ page, manifest }, info) => {
  const state = await syntheticSessions(page, manifest);
  await login(page, manifest);
  await openSecurity(page, manifest, true);
  const card = page.locator(cardSelector);
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  const whitelist = page.getByLabel("允许的 IP / 网段", { exact: true });
  const password = page.getByLabel("新密码", { exact: true });
  const draft = "192.0.2.0/24\n2001:db8::/32";
  await whitelist.fill(draft);
  await password.fill("synthetic-unsubmitted-password");
  await password.evaluate(element => element.setAttribute("data-session-draft", "original"));
  const reads = state.reads;
  await card.locator(`[data-session-id="${mobileId}"]`).getByRole("button", { name: /^撤销/ }).click();
  const revoke = page.getByRole("alertdialog", { name: "撤销此会话？", exact: true });
  await expect(revoke).toContainText(ipv6);
  await revoke.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(revoke).toHaveCount(0);
  await expect(card.locator("[data-session-id]")).toHaveCount(2);
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  await expect(whitelist).toHaveValue(draft);
  await expect(password).toHaveValue("synthetic-unsubmitted-password");
  await expect(password).toHaveAttribute("data-session-draft", "original");
  await card.getByRole("button", { name: "退出其他会话", exact: true }).click();
  const others = page.getByRole("alertdialog", { name: "退出其他会话？", exact: true });
  await others.getByRole("button", { name: "退出其他会话", exact: true }).click();
  await expect(others).toHaveCount(0);
  await expect(card.locator("[data-session-id]")).toHaveCount(1);
  await expect(card.locator(`[data-session-id="${currentId}"]`)).toBeVisible();
  await expect(card.getByRole("button", { name: "退出其他会话", exact: true })).toBeDisabled();
  await expect(whitelist).toHaveValue(draft);
  await expect(password).toHaveAttribute("data-session-draft", "original");
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  expect(state.writes).toEqual([`/api/admin/v1/sessions/${mobileId}/revoke`, "/api/admin/v1/sessions/revoke-others"]);
  expect(state.unexpectedWrites).toEqual([]);
  await record(page, info, { feature: "session-revocation-draft-retention", reads: state.reads, writes: state.writes, fixtureWrites: 0 });
});

test("session read and revoke failures stay local and permit retry without losing a draft", async ({ page, manifest }) => {
  const state = await syntheticSessions(page, manifest);
  state.failedReads = 2;
  await login(page, manifest);
  await openSecurity(page, manifest, true);
  const card = page.locator(cardSelector);
  await expect(card.getByRole("alert")).toContainText("合成会话列表暂不可用");
  const password = page.getByLabel("新密码", { exact: true });
  await password.fill("retained-through-read-error");
  state.failedReads = 0;
  await card.getByRole("button", { name: "重试", exact: true }).click();
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  await expect(card.getByRole("alert")).toHaveCount(0);
  state.failMutation = true;
  await card.locator(`[data-session-id="${mobileId}"]`).getByRole("button", { name: /^撤销/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "撤销此会话？", exact: true });
  await dialog.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("合成会话撤销暂不可用");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  state.failedReads = 2;
  await card.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("合成会话列表暂不可用");
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  await expect(password).toHaveValue("retained-through-read-error");
  state.failedReads = 0;
  await card.getByRole("button", { name: "重试", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(password).toHaveValue("retained-through-read-error");
  expect(state.unexpectedWrites).toEqual([]);
});

test("read-only demo rejects new session revocation in both browser and server guards", async ({ page, manifest }) => {
  const state = await syntheticSessions(page, manifest);
  await login(page, manifest);
  await openSecurity(page, manifest);
  const card = page.locator(cardSelector);
  await expect(card.locator("[data-session-id]")).toHaveCount(3);
  await card.getByRole("button", { name: "退出其他会话", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "退出其他会话？", exact: true });
  await dialog.getByRole("button", { name: "退出其他会话", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("只读演示");
  expect(state.writes).toEqual([]);
  const csrf = manifest.sessionCookies.find(cookie => cookie.name.includes("csrf"));
  expect(csrf).toBeDefined();
  for (const path of ["/api/admin/v1/sessions/revoke-others", `/api/admin/v1/sessions/${mobileId}/revoke`]) {
    const response = await page.request.post(manifest.origin + path, {
      headers: { Origin: manifest.origin, "X-CSRF-Token": decodeURIComponent(csrf!.value) }, data: {},
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe("demo_read_only");
  }
  expect(state.unexpectedWrites).toEqual([]);
});
