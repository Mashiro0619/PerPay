import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { AdminLedgerDetail, AdminLedgerPageEnvelope } from "../web/src/api/generated/types.gen";

test("ledger pagination and keyboard links restore filters, page and scroll position", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/ledger?direction=CREDIT");
  const rows = page.locator("[data-business-row]");
  await expect(rows).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  await expect(rows).toHaveCount(20);
  const listUrl = page.url();
  const identity = await rows.first().locator("a[data-row-link]").getAttribute("href");
  const recordLink = rows.nth(12).locator("a[data-row-link]");
  await recordLink.focus();
  await page.clock.runFor(100);
  const scroll = await page.evaluate(() => scrollY);
  expect(scroll).toBeGreaterThan(0);
  const detailHref = await recordLink.getAttribute("href");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + detailHref);
  await expect(page.locator("#main-content")).toContainText("采集来源");
  await page.locator("#main-content").getByRole("link", { name: /返回.*流水|支付宝流水/ }).first().click();
  await expect(page).toHaveURL(listUrl);
  await expect(rows.first().locator("a[data-row-link]")).toHaveAttribute("href", identity!);
  await expect.poll(() => page.evaluate(expected => Math.abs(scrollY - expected) < 5, scroll)).toBe(true);
  const order = rows.getByRole("link", { name: /^查看订单：/ }).first();
  await expect(order).toBeVisible();
  const orderHref = await order.getAttribute("href");
  await order.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + orderHref);
  await page.locator("#main-content").getByRole("link", { name: /返回.*流水|支付宝流水/ }).first().click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  await record(page, info);
});

test("ledger controls use transaction dates, exact amounts and reset pagination", async ({ page, manifest }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/ledger");
  const date = page.getByRole("combobox", { name: "交易日期范围" });
  await expect(date).toContainText("全部");
  await date.click();
  await page.getByRole("option", { name: "近 7 天", exact: true }).click();
  await expect(page).toHaveURL(/occurred_from=/);
  expect(new URL(page.url()).searchParams.has("created_from")).toBe(false);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/);
  await page.getByRole("button", { name: "金额范围", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "金额范围", exact: true });
  await dialog.getByLabel("最低金额（元）").fill("0.001");
  await dialog.getByRole("button", { name: "应用金额", exact: true }).click();
  await expect(dialog).toContainText("最多保留两位小数");
  await dialog.getByLabel("最低金额（元）").fill("0");
  await dialog.getByLabel("最高金额（元）").fill("0");
  await dialog.getByRole("button", { name: "应用金额", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("[data-business-row]")).toHaveCount(0);
  const filtered = new URL(page.url()).searchParams;
  expect(filtered.get("min_amount_cents")).toBe("0");
  expect(filtered.get("max_amount_cents")).toBe("0");
  expect(filtered.has("cursor")).toBe(false);
  expect(filtered.has("page")).toBe(false);
});

test("switching websites keeps global ledger rows, cursor and requests stable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/ledger?direction=CREDIT");
  await page.getByRole("button", { name: "切换导航", exact: true }).click();
  await expect(page.locator('[data-slot="sidebar"][data-collapsible="icon"]')).toBeVisible();
  await page.clock.runFor(250);
  await expect(page.locator("[data-business-row]")).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  const cursor = new URL(page.url()).searchParams.get("cursor");
  const first = page.locator("[data-business-row]").first();
  await first.evaluate(element => { element.setAttribute("data-ledger-retained", "true"); });
  const ledgerRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/v1/ledger/entries") ledgerRequests.push(request.url());
  });
  const sites = (await (await page.request.get(manifest.origin + "/api/admin/v1/sites")).json()).data as Array<{ client_id: string; configuration: { name: string } }>;
  for (const site of [sites[0]!, sites[1]!, sites[0]!]) {
    await page.getByRole("button", { name: /切换业务网站/ }).click();
    await page.getByRole("dialog", { name: "业务网站", exact: true }).getByRole("link", { name: site.configuration.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp("selected_site=" + site.client_id));
    await expect(first).toHaveAttribute("data-ledger-retained", "true");
    expect(new URL(page.url()).searchParams.get("cursor")).toBe(cursor);
    await page.clock.runFor(200);
  }
  expect(ledgerRequests).toEqual([]);
  await record(page, info, { ledgerRequests, navigationOnly: true });
});

test("ledger variants render in both themes at 320, 390 and 1440 pixels", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const detailPaths = manifest.routes.filter(path => path.startsWith("/ledger/"));
  expect(detailPaths).toHaveLength(2);
  const versions = await Promise.all(detailPaths.map(async path => {
    const response = await page.request.get(manifest.origin + "/api/admin/v1" + path.replace("/ledger/", "/ledger/entries/"));
    expect(response.status()).toBe(200);
    return (await response.json()).data as AdminLedgerDetail;
  }));
  expect(versions.map(entry => entry.content_consistent)).toEqual([true, false]);
  const listResponse = await page.request.get(manifest.origin + "/api/admin/v1/ledger/entries");
  const list = await listResponse.json() as AdminLedgerPageEnvelope;
  expect(list.data).toHaveLength(20);
  for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => localStorage.setItem("perpay:theme", value), theme);
    for (const path of ["/ledger", ...detailPaths]) {
      await page.goto(manifest.origin + "/admin" + path);
      if (path === "/ledger") await expect(page.locator("[data-business-row]")).toHaveCount(20);
      else await expect(page.locator("#main-content")).toContainText("采集来源");
      await record(page, info, { width, theme, source: "local-synthetic-ledger" });
      await screenshot(page, info, `ledger-${width}-${theme}-${path.split("/").at(-1)}`);
      if (width === 320) await audit(page, info, `ledger-${theme}-${path.split("/").at(-1)}`);
    }
  }
  expect(errors).toEqual([]);
});
