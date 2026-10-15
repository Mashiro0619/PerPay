import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export type Manifest = { origin: string; epoch: number; routes: string[]; checkouts: Record<string, string>; setTime: (time: number) => Promise<void> };
export const test = base.extend<{ manifest: Manifest }, { harness: Manifest }>({
  harness: [async ({}, use) => {
    const child = fork(fileURLToPath(new URL("./server.ts", import.meta.url)), [], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let log = "";
    child.stderr?.on("data", data => { log += String(data); });
    child.stdout?.on("data", data => { log += String(data); });
    try {
      const manifest = await new Promise<Manifest>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("UI fixture timeout: " + log)), 90_000);
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`UI fixture exited ${code}: ${log}`)); });
        child.on("message", (message: Manifest & { type: string }) => { if (message.type === "ready") { clearTimeout(timeout); resolve(message); } });
      });
      let requestId = 0;
      manifest.setTime = time => new Promise<void>((resolve, reject) => {
        const id = ++requestId;
        const timeout = setTimeout(() => { child.off("message", done); reject(new Error("Fixture clock timeout")); }, 5000);
        const done = (message: { type?: string; id?: number }) => { if (message.type === "done" && message.id === id) { clearTimeout(timeout); child.off("message", done); resolve(); } };
        child.on("message", done);
        child.send({ type: "clock", time, id });
      });
      await use(manifest);
    } finally { if (child.connected) child.disconnect(); await new Promise<void>(resolve => { child.once("exit", () => resolve()); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); }); }
  }, { scope: "worker" }],
  manifest: async ({ harness }, use) => { await harness.setTime(harness.epoch); await use(harness); },
  page: async ({ page, manifest }, use) => {
    await page.clock.install({ time: new Date(manifest.epoch) });
    await page.clock.setFixedTime(new Date(manifest.epoch));
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    await use(page);
  },
});
export { expect };
export async function login(page: Page, manifest: Manifest) {
  await page.goto(manifest.origin + "/admin/");
  await page.locator("#password").fill("123456");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("[data-content-width]")).toBeVisible();
}
export async function record(page: Page, info: TestInfo, extra = {}) {
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    theme: document.documentElement.dataset.theme, headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map(e => ({ text: e.textContent, level: e.getAttribute("aria-level") ?? e.tagName.slice(1) })),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
  await info.attach("measurement", { body: JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    build: createHash("sha256").update(readFileSync("web-dist/admin/index.html")).digest("hex"), browser: page.context().browser()?.version(), url: page.url(), ...geometry, ...extra }, null, 2), contentType: "application/json" });
  expect(geometry.overflow).toBe(false);
}
