import { test, expect } from "@playwright/test";
import { APP_VERSION } from "../src/version";
import { UpdateCheckUnavailable, type OfficialUpdate, type OfficialUpdateChannel } from "../src/update/checker";
import { createSettingsServer } from "./settings-server";

const SIX_HOURS = 6 * 60 * 60 * 1_000;
function updateFor(channel: OfficialUpdateChannel, epoch: number): OfficialUpdate {
  const latest = channel === "stable" ? "1.0.0" : "1.1.0-alpha.1";
  return {
    status: "update_available", current_version: APP_VERSION, latest_version: latest,
    release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + latest,
    published_at: new Date(epoch - 86_400_000).toISOString(), checked_at: new Date(epoch).toISOString(),
  };
}

for (const width of [390, 740, 1440]) {
  test(`${width}: update channels, automatic checks and browser preferences remain usable`, async ({ page }, info) => {
    const epoch = Date.now();
    const channels: OfficialUpdateChannel[] = [];
    const fixture = await createSettingsServer(epoch, { updateChecker: { check: async (channel = "prerelease") => {
      channels.push(channel);
      return updateFor(channel, epoch);
    } } });
    try {
      await page.setViewportSize({ width, height: 960 });
      if (width === 740) {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.addInitScript(() => localStorage.setItem("perpay:theme", "dark"));
      }
      await page.clock.install({ time: new Date(epoch) });
      await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
      await page.context().addCookies(fixture.cookies);
      await page.goto(fixture.origin + "/admin/system");
      const panel = page.getByRole("region", { name: "官方更新", exact: true });
      const automatic = panel.getByRole("switch", { name: "自动检查更新", exact: true });
      const channel = panel.getByRole("combobox", { name: "检查通道", exact: true });
      await expect(automatic).toBeChecked();
      await expect(panel).toContainText("1.1.0-alpha.1");
      await expect(channel).toContainText("包含预发布版");
      expect(channels).toEqual(["prerelease"]);
      await expect(panel).not.toContainText(/偏好仅作用|6 小时|不会自动安装|只读演示|演示模式|上次检查时间|发布时间|官方预发布版|官方稳定版|当前版本高于/);
      await expect(panel.getByRole("button", { name: "发布信息", exact: true })).toHaveCount(0);
      const controls = panel.getByRole("group", { name: "更新检查设置", exact: true });
      const manual = controls.getByRole("button", { name: "检查更新", exact: true });
      await expect(manual).toBeVisible();
      await expect(manual).toBeEnabled();
      const alignment = await controls.evaluate(element => {
        const center = (selector: string) => {
          const target = element.querySelector(selector);
          if (!target) throw new Error("Missing update control " + selector);
          const box = target.getBoundingClientRect();
          return box.y + box.height / 2;
        };
        return {
          automatic: center('[role="switch"]'), channel: center('[role="combobox"]'),
          automaticLabel: center('label[for="official-update-automatic"]'), channelLabel: center('label[for="official-update-channel"]'),
          manual: center('.system-update-check'),
        };
      });
      expect(Math.abs(alignment.automatic - alignment.automaticLabel)).toBeLessThanOrEqual(1);
      expect(Math.abs(alignment.channel - alignment.channelLabel)).toBeLessThanOrEqual(1);
      if (width >= 740) {
        expect(Math.abs(alignment.automatic - alignment.channel)).toBeLessThanOrEqual(1);
        expect(Math.abs(alignment.manual - alignment.channel)).toBeLessThanOrEqual(1);
      }

      await channel.click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await expect(page.getByRole("option", { name: "跟随当前版本", exact: true })).toHaveCount(0);
      await page.getByRole("option", { name: "仅稳定版", exact: true }).click();
      await expect(panel).toContainText("有可用更新：v1.0.0");
      expect(channels).toEqual(["prerelease", "stable"]);
      await channel.click();
      await page.getByRole("option", { name: "包含预发布版", exact: true }).click();
      await expect(panel).toContainText("1.1.0-alpha.1");
      expect(channels).toEqual(["prerelease", "stable", "prerelease"]);

      if (width === 1440) {
        await page.clock.fastForward(SIX_HOURS + 1_000);
        await expect.poll(() => channels.length).toBe(4);
        expect(channels[3]).toBe("prerelease");
      }
      await automatic.click();
      await expect(automatic).not.toBeChecked();
      const count = channels.length;
      await page.clock.fastForward(SIX_HOURS + 1_000);
      expect(channels.length).toBe(count);
      await panel.getByRole("button", { name: "检查更新", exact: true }).click();
      await expect.poll(() => channels.length).toBe(count + 1);
      await expect(panel).toContainText("1.1.0-alpha.1");

      await page.reload();
      await expect(automatic).not.toBeChecked();
      await expect(channel).toContainText("包含预发布版");
      await expect(panel.getByRole("button", { name: "检查更新", exact: true })).toBeEnabled();
      await expect(panel.locator("[role='status']")).toHaveCount(0);
      expect(channels.length).toBe(count + 1);
      if (width === 1440) {
        const other = await page.context().newPage();
        try {
          await other.goto(fixture.origin + "/admin/system");
          const otherPanel = other.getByRole("region", { name: "官方更新", exact: true });
          await expect(otherPanel.getByRole("switch", { name: "自动检查更新", exact: true })).not.toBeChecked();
          await otherPanel.getByRole("combobox", { name: "检查通道", exact: true }).click();
          await other.getByRole("option", { name: "仅稳定版", exact: true }).click();
          await expect(channel).toContainText("仅稳定版");
          expect(channels.length).toBe(count + 1);
        } finally { await other.close(); }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await panel.screenshot({ path: info.outputPath("update-preferences.png") });
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 900 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await page.clock.runFor(100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await expect(channel).toContainText("包含预发布版");
        const bounds = await channel.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
        await panel.screenshot({ path: info.outputPath("update-preferences-320-200pct.png") });
      }
      if (width === 740) {
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await expect(manual).toBeVisible();
        await expect(manual).toBeEnabled();
        await panel.screenshot({ path: info.outputPath("update-preferences-dark-200pct.png") });
      }
    } finally { await fixture.close(); }
  });
}

test("the preview keeps manual version checks available without explanatory banners", async ({ page }, info) => {
  let checks = 0;
  const epoch = Date.now();
  const fixture = await createSettingsServer(epoch, { demoMode: true, updateChecker: { check: async (channel = "prerelease") => {
    checks++;
    return updateFor(channel, epoch);
  } } });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/system");
    const panel = page.getByRole("region", { name: "官方更新", exact: true });
    await expect(panel).toContainText("有可用更新：v1.1.0-alpha.1");
    await expect(panel).not.toContainText(/只读演示|演示模式|偏好仅作用|不会自动安装/);
    const manual = panel.getByRole("button", { name: "检查更新", exact: true });
    await expect(manual).toBeEnabled();
    await expect.poll(() => checks).toBe(1);
    await manual.click();
    await expect.poll(() => checks).toBe(2);
    await panel.getByRole("combobox", { name: "检查通道", exact: true }).click();
    await page.getByRole("option", { name: "仅稳定版", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "检查通道", exact: true })).toContainText("仅稳定版");
    await expect(panel).toContainText("有可用更新：v1.0.0");
    expect(checks).toBe(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await panel.screenshot({ path: info.outputPath("demo-update-preferences.png") });
  } finally { await fixture.close(); }
});

test("manual update checks respect a failed request's retry delay and recover", async ({ page }) => {
  const epoch = Date.now();
  let checks = 0;
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async (channel = "prerelease") => {
    if (++checks === 1) throw new UpdateCheckUnavailable(2);
    return updateFor(channel, epoch);
  } } });
  try {
    await page.clock.install({ time: new Date(epoch) });
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/system");
    const panel = page.getByRole("region", { name: "官方更新", exact: true });
    const manual = panel.getByRole("button", { name: "检查更新", exact: true });
    await expect(panel).toContainText("暂时无法检查更新。");
    await expect(manual).toBeDisabled();
    expect(checks).toBe(1);
    await page.clock.fastForward(3_000);
    await expect(manual).toBeEnabled();
    expect(checks).toBe(1);
    await manual.click();
    await expect(panel).toContainText("有可用更新：v1.1.0-alpha.1");
    expect(checks).toBe(2);
  } finally { await fixture.close(); }
});

test("legacy follow preferences become prerelease while explicit stable and automatic opt-out survive", async ({ page }) => {
  const epoch = Date.now();
  const channels: OfficialUpdateChannel[] = [];
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async (channel = "prerelease") => {
    channels.push(channel);
    return updateFor(channel, epoch);
  } } });
  try {
    await page.addInitScript(() => {
      if (localStorage.getItem("perpay:update-preferences") === null)
        localStorage.setItem("perpay:update-preferences", JSON.stringify({ automatic: false, channel: "auto" }));
    });
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/system");
    const panel = page.getByRole("region", { name: "官方更新", exact: true });
    const channel = panel.getByRole("combobox", { name: "检查通道", exact: true });
    await expect(channel).toContainText("包含预发布版");
    await expect(panel.getByRole("switch", { name: "自动检查更新", exact: true })).not.toBeChecked();
    expect(channels).toEqual([]);
    await panel.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(panel).toContainText("有可用更新：v1.1.0-alpha.1");
    expect(channels).toEqual(["prerelease"]);
    await channel.click();
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.getByRole("option", { name: "仅稳定版", exact: true }).click();
    expect(channels).toEqual(["prerelease"]);
    await page.reload();
    await expect(channel).toContainText("仅稳定版");
    await expect(panel.getByRole("switch", { name: "自动检查更新", exact: true })).not.toBeChecked();
    expect(channels).toEqual(["prerelease"]);
    await panel.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(panel).toContainText("有可用更新：v1.0.0");
    expect(channels).toEqual(["prerelease", "stable"]);
  } finally { await fixture.close(); }
});
