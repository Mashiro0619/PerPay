import { defineConfig } from "@playwright/test";
const stamp = process.env.PERPAY_UI_RUN ??= new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = `.ui-audit/runs/${stamp}`;
export default defineConfig({
  testDir: "./ui-tests",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  outputDir: `${output}/artifacts`,
  reporter: [["list"], ["json", { outputFile: `${output}/results.json` }]],
  use: { browserName: "chromium", channel: "chromium", locale: "zh-CN", timezoneId: "Asia/Shanghai", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "core", testIgnore: /full\.spec\.ts/ }, { name: "full", testMatch: /full\.spec\.ts/ }],
});
