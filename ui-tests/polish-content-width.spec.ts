import type { Page, TestInfo } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";

type Mode = "compact" | "full";
type Theme = "light" | "dark";
type Scenario = { name: string; route: string; kind: "list" | "detail" | "settings"; ready: string };

// Motion already has its own native-timing acceptance. This matrix isolates
// content reflow, readable fields and retained editor state.
test.use({ reducedMotion: "reduce" });

async function configure(page: Page, width: number, theme: Theme, mode: Mode) {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}

async function settled(page: Page, scenario: Scenario) {
  await expect(page.locator(scenario.ready).first()).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(100);
  if (scenario.route === "/settings/security") {
    await expect(page.locator(".security-settings-card-grid")).toHaveAttribute("data-measured", "true");
  }
}

async function setWidth(page: Page, mode: Mode) {
  const content = page.locator("[data-content-width]");
  if (await content.getAttribute("data-content-width") !== mode) {
    await page.locator("[data-content-width-toggle]").click();
  }
  await expect(content).toHaveAttribute("data-content-width", mode);
  await page.clock.runFor(100);
}

async function accountRoute(page: Page, manifest: Manifest) {
  await page.goto(manifest.origin + "/admin/settings/accounts");
  const account = page.locator('[data-account-list] a[href^="/admin/settings/accounts/"]').first();
  await expect(account).toBeVisible();
  const href = await account.getAttribute("href");
  expect(href).toBeTruthy();
  return new URL(href!, manifest.origin).pathname.replace(/^\/admin/, "");
}

function detailRoute(manifest: Manifest, key: string) {
  const route = manifest.details[key];
  expect(route, "named isolated fixture: " + key).toBeTruthy();
  return route!;
}

function lists(): Scenario[] {
  return [
    { name: "orders", route: "/orders", kind: "list", ready: '[data-business-table="orders"] [data-business-row]' },
    { name: "notifications", route: "/notifications", kind: "list", ready: "[data-business-table] [data-business-row]" },
    { name: "ledger", route: "/ledger", kind: "list", ready: "[data-business-table] [data-business-row]" },
  ];
}

function details(manifest: Manifest): Scenario[] {
  return [
    { name: "order-detail", route: detailRoute(manifest, "orderLong"), kind: "detail", ready: '[data-order-card="order"]' },
    { name: "ledger-detail", route: detailRoute(manifest, "ledgerAssociated"), kind: "detail", ready: "[data-ledger-summary]" },
    { name: "notification-detail", route: detailRoute(manifest, "notificationDns"), kind: "detail", ready: "[data-detail-order-summary]" },
  ];
}

function settings(account: string): Scenario[] {
  return [
    { name: "display", route: "/settings/display", kind: "settings", ready: "#setting-system-name" },
    { name: "security", route: "/settings/security", kind: "settings", ready: ".security-settings-card-grid" },
    { name: "accounts", route: "/settings/accounts", kind: "settings", ready: "[data-account-list]" },
    { name: "account-detail", route: account, kind: "settings", ready: "#alipay-name" },
  ];
}

async function inspect(page: Page, scenario: Scenario, info: TestInfo, mode: Mode, theme: Theme) {
  await settled(page, scenario);
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
  const geometry = await page.locator("[data-content-width]").evaluate((content, kind) => {
    const root = content.getBoundingClientRect();
    const blockSelector = kind === "list"
      ? '[data-business-table], .business-table-surface, [data-slot="table-container"], .list-toolbar'
      : kind === "detail"
        ? '[data-detail-page], [data-order-card], [data-ledger-summary], [data-detail-fields]'
        : '.admin-settings-layout, [data-settings-content], [data-account-list], [data-slot="card"]';
    const blocks = [...content.querySelectorAll<HTMLElement>(blockSelector)].filter(node => node.getBoundingClientRect().width > 0).map(node => {
      const box = node.getBoundingClientRect();
      return { slot: node.getAttribute("data-slot") ?? node.className, width: box.width,
        contained: box.left >= root.left - 1 && box.right <= root.right + 1,
        overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    // List identities intentionally retain their two-line summaries. Check
    // complete amounts/times/column labels; details and form labels must read fully.
    const textSelector = kind === "list"
      ? '.list-money, .list-time, thead th'
      : kind === "detail"
        ? '[data-detail-fields] dt, [data-detail-fields] dd, .list-money'
        : '[data-slot="field-label"], [data-account-list] a, [data-slot="card-title"]';
    const texts = [...content.querySelectorAll<HTMLElement>(textSelector)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility === "visible";
    }).map(node => {
      const box = node.getBoundingClientRect(), walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const clipped: string[] = [];
      let lines = 0;
      while (walker.nextNode()) {
        const text = walker.currentNode, parent = text.parentElement;
        if (!text.textContent?.trim() || !parent || parent.closest('.sr-only, [hidden], [aria-hidden="true"], svg, textarea, input')) continue;
        // Range rectangles may include a collapsed space hanging past the end
        // of a wrapped line. Measure non-whitespace runs so only painted text
        // contributes to the clipping check; long unbroken text is still tested.
        const ranges = [...text.textContent.matchAll(/\S+/gu)].flatMap(match => {
          const range = document.createRange();
          range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
          return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        });
        for (const line of ranges) {
          lines++;
          if (line.left < box.left - 1 || line.right > box.right + 1 || line.top < box.top - 1 || line.bottom > box.bottom + 1) clipped.push("own bounds: " + JSON.stringify({ left: line.left - box.left, right: line.right - box.right, top: line.top - box.top, bottom: line.bottom - box.bottom }));
          for (let ancestor: Element | null = parent; ancestor && ancestor !== content.parentElement; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
            if (["hidden", "clip"].includes(style.overflowX) && (line.left < bounds.left - 1 || line.right > bounds.right + 1)) clipped.push("ancestor horizontal clip");
            if (["hidden", "clip"].includes(style.overflowY) && (line.top < bounds.top - 1 || line.bottom > bounds.bottom + 1)) clipped.push("ancestor vertical clip");
          }
        }
      }
      return { text: node.textContent?.trim().slice(0, 160), lines, clipped: [...new Set(clipped)] };
    }).filter(item => item.lines > 0);
    // Base UI also renders offscreen native form inputs. Measure the painted
    // controls, rather than treating those submission mirrors as visible UI.
    const fields = [...content.querySelectorAll<HTMLElement>('[data-slot="input"], [data-slot="textarea"], [data-slot="input-group-control"], [data-slot="select-trigger"], [data-slot="switch"]')]
      .filter(node => node.getBoundingClientRect().width > 0).map(node => {
        const box = node.getBoundingClientRect();
        return { id: node.id, contained: box.left >= root.left - 1 && box.right <= root.right + 1 };
      });
    const settings = content.querySelector(".admin-settings-layout")?.getBoundingClientRect();
    return { width: root.width, maxWidth: getComputedStyle(content).maxWidth, blocks, texts, fields,
      settingsWidth: settings?.width ?? null, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) };
  }, scenario.kind);
  await record(page, info, { feature: "polish-content-width", scenario: scenario.name, mode, theme, geometry });
  expect(geometry.blocks.length, scenario.name + " has measured content").toBeGreaterThan(0);
  expect(geometry.blocks.filter(block => !block.contained || block.overflow), scenario.name + " keeps nested surfaces inside the content width").toEqual([]);
  expect(geometry.texts.length, scenario.name + " has readable fields").toBeGreaterThan(0);
  expect(geometry.texts.filter(text => text.clipped.length), scenario.name + " keeps complete field text readable").toEqual([]);
  expect(geometry.fields.filter(field => !field.contained), scenario.name + " keeps form controls contained").toEqual([]);
  if (scenario.kind === "settings" && scenario.name !== "security") {
    expect(geometry.settingsWidth, "ordinary settings keep their separate reading width").not.toBeNull();
    expect(geometry.settingsWidth!).toBeLessThanOrEqual(56 * geometry.rem + 1);
  }
  return geometry.width;
}

async function desktopMatrix(page: Page, manifest: Manifest, info: TestInfo, scenarios: Scenario[]) {
  for (const width of [1440, 1920]) for (const theme of ["light", "dark"] as const) {
    for (const scenario of scenarios) {
      await configure(page, width, theme, "compact");
      await page.goto(manifest.origin + "/admin" + scenario.route);
      const compact = await inspect(page, scenario, info, "compact", theme);
      const route = page.url();
      await setWidth(page, "full");
      expect(page.url(), "content width is a presentation preference").toBe(route);
      const full = await inspect(page, scenario, info, "full", theme);
      expect(full).toBeGreaterThanOrEqual(compact - 1);
      if (width === 1920 && scenario.kind !== "settings") expect(full - compact, "wide view exercises a genuinely wider reading canvas").toBeGreaterThan(100);
      if (width === 1920 && theme === "light" && scenario === scenarios[0]) {
        const path = info.outputPath(`${scenario.name}-1920-full.png`);
        await page.screenshot({ path, fullPage: true });
        await info.attach("expanded-width", { path, contentType: "image/png" });
      }
    }
  }
}

test("representative lists retain columns and readable values in both desktop content widths", async ({ page, manifest }, info) => {
  test.setTimeout(300_000);
  await login(page, manifest);
  await desktopMatrix(page, manifest, info, lists());
});

test("representative details retain complete fields in both desktop content widths", async ({ page, manifest }, info) => {
  test.setTimeout(300_000);
  await login(page, manifest);
  await desktopMatrix(page, manifest, info, details(manifest));
});

test("settings and accounts retain their reading layouts in both desktop content widths", async ({ page, manifest }, info) => {
  test.setTimeout(300_000);
  await login(page, manifest);
  await desktopMatrix(page, manifest, info, settings(await accountRoute(page, manifest)));
});

test("display, security and account drafts survive width changes without remounting or writes", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const account = await accountRoute(page, manifest);
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname);
  });
  for (const scenario of [
    { ...settings(account)[0]!, label: "支付系统名称", draft: "内容宽度切换草稿" },
    { ...settings(account)[1]!, label: "允许的 IP / 网段", draft: "192.0.2.1\n198.51.100.0/24" },
    { ...settings(account)[3]!, label: "账号名称", draft: "未保存的账号名称" },
  ]) {
    await configure(page, 1440, "dark", "compact");
    await page.goto(manifest.origin + "/admin" + scenario.route);
    await settled(page, scenario);
    const field = page.getByLabel(scenario.label, { exact: true });
    const previous = await field.inputValue();
    await field.fill(scenario.draft);
    const original = await field.elementHandle();
    const route = page.url();
    for (const [width, mode] of [[1440, "full"], [1920, "compact"], [1920, "full"]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await setWidth(page, mode);
      expect(await original!.evaluate(element => element.isConnected), "width changes preserve the editor instance").toBe(true);
      expect(await field.evaluate((element, original) => element === original, original)).toBe(true);
      await expect(field).toHaveValue(scenario.draft);
      expect(page.url()).toBe(route);
      await expect(page.getByRole("alertdialog", { name: "放弃未保存的修改？" })).toHaveCount(0);
      await inspect(page, scenario, info, mode, "dark");
    }
    await field.fill(previous);
    await original!.dispose();
  }
  expect(writes, "presentation changes never submit or queue a form").toEqual([]);
});

test("a persisted full-width preference keeps representative mobile pages inside 390px", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const account = await accountRoute(page, manifest);
  const scenarios = [lists()[0]!, details(manifest)[0]!, ...settings(account)];
  for (const scenario of scenarios) {
    await configure(page, 390, "light", "full");
    await page.goto(manifest.origin + "/admin" + scenario.route);
    await expect(page.locator("[data-content-width-toggle]")).toBeHidden();
    await inspect(page, scenario, info, "full", "light");
  }
});
