import { test, expect } from "@playwright/test";
import { AlipayAccountService } from "../src/alipay-accounts/service";
import { OrderService } from "../src/orders/service";
import { createSettingsServer } from "./settings-server";

for (const width of [390, 1440]) {
  test(`${width}: configure an account, assign website collection and create a test payment`, async ({
    page,
  }, info) => {
    const epoch = Date.now();
    let platformKey = "";
    const fixture = await createSettingsServer(epoch, {
      runtime: (services) => {
        const store = services.settings.accountService()!.store();
        const accounts = new AlipayAccountService({
          store,
          verifyProviderApplicationKey: async () => undefined,
        });
        platformKey = accounts.list()[0]!.platform_public_key!;
        const snapshot = services.settings.instanceSnapshot();
        const orders = new OrderService(
          services.database,
          () => services.settings.instanceSnapshot(),
          () => epoch,
          services.sites,
          "default",
          { accounts: () => store.snapshots(), available: () => true },
        );
        orders.initialize();
        const healthy = {
          enabled: true,
          state: "healthy" as const,
          paymentRevision: snapshot.paymentRevision,
          inFlight: false,
          lastAttemptAt: epoch,
          lastSuccessAt: epoch,
          lastErrorCode: null,
          consecutiveFailures: 0,
        };
        return {
          orders,
          alipayAccounts: accounts,
          accountHealth: (id) => ({
            state: "healthy",
            lastSuccessAt: epoch,
            lastErrorCode: null,
            collectionReady:
              accounts.get(id).configured && accounts.get(id).enabled,
          }),
          runtimeStatus: () => ({
            configured: true,
            transitioning: false,
            paymentRevision: snapshot.paymentRevision,
            activeProviderAccountKey: snapshot.activeProviderAccountKey,
            scanIntervalMilliseconds: 10_000,
            maximumSuccessAgeMilliseconds: 120_000,
          }),
          ledgerHealth: () => healthy,
          reconciliationHealth: () => ({
            ...healthy,
            pendingOrders: 0,
            continuationPending: false,
          }),
        };
      },
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === fixture.origin
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      await page.context().addCookies(fixture.cookies);
      await page.goto(fixture.origin + "/admin/settings/accounts/new");
      await page.getByLabel("账号名称", { exact: true }).fill("备用账号");
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect(page.getByText("账号已保存", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/admin\/settings\/accounts\/alipay_[0-9a-f-]+$/);
      await page.reload();
      await page
        .getByRole("button", { name: "生成应用密钥", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "复制应用公钥", exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("应用 ID（App ID）", { exact: true })
        .fill("2026000000000002");
      await page.getByLabel("支付宝公钥", { exact: true }).fill(platformKey);
      await page
        .getByLabel("支付宝收款码内容", { exact: true })
        .fill("https://qr.alipay.com/browser-second-account");
      await page
        .getByRole("button", { name: "保存并检查", exact: true })
        .click();
      await expect(
        page.getByText("连接检查通过", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`account-configured-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);

      await page.goto(fixture.origin + "/admin/sites/new");
      await page
        .getByLabel("业务网站名称", { exact: true })
        .fill("多账号测试网站");
      await expect(
        page.getByRole("combobox", { name: "支付宝账号", exact: true }),
      ).toContainText("请选择收款账号");
      await page.getByRole("button", { name: "按权重", exact: true }).click();
      const accountsResponse = await page.request.get(
        fixture.origin + "/api/admin/v1/alipay-accounts",
      );
      const accounts = (await accountsResponse.json()).data as Array<{
        id: string;
        name: string;
      }>;
      const primary = accounts.find((account) => account.name !== "备用账号")!;
      const secondary = accounts.find(
        (account) => account.name === "备用账号",
      )!;
      await page
        .getByRole("checkbox", { name: primary.name, exact: true })
        .check();
      await page
        .getByRole("checkbox", { name: "备用账号", exact: true })
        .check();
      await page.getByLabel("备用账号权重", { exact: true }).fill("3");
      await expect(
        page.getByLabel("备用账号分配比例", { exact: true }),
      ).toHaveText("75.0%");
      await page.screenshot({
        path: info.outputPath(`weighted-accounts-${width}.png`),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "创建业务网站", exact: true })
        .click();
      await expect(page).toHaveURL(/\/admin\/sites\/site_/);
      const siteId = new URL(page.url()).pathname.split("/").at(-1)!;

      await page.goto(
        fixture.origin + "/admin/sites/" + siteId + "/settings/collection",
      );
      await page.getByRole("button", { name: "指定账号", exact: true }).click();
      await page
        .getByRole("combobox", { name: "支付宝账号", exact: true })
        .click();
      await page.getByRole("option", { name: "备用账号", exact: true }).click();
      await page
        .getByRole("button", { name: "保存业务网站", exact: true })
        .click();
      await expect(
        page.getByText("业务网站配置已保存", { exact: true }),
      ).toBeVisible();
      await page.goto(fixture.origin + "/admin/test-payment");
      await page
        .getByRole("combobox", { name: "业务网站", exact: true })
        .click();
      await page
        .getByRole("option", { name: "多账号测试网站", exact: true })
        .click();
      await page
        .getByRole("button", { name: "创建测试订单", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "备用账号", exact: true }),
      ).toHaveAttribute(
        "href",
        new RegExp("settings/accounts/" + secondary.id),
      );
      await expect(
        page.getByText("测试订单已创建", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`test-payment-account-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
}
