import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export type Manifest = { origin: string; epoch: number; routes: string[]; extendedRoutes: string[]; details: Record<string, string>; checkouts: Record<string, string>; sessionCookies: { name: string; value: string }[]; setTime: (time: number, reset?: boolean) => Promise<void>; setCheckoutFailure: (status: 429 | 503 | null) => Promise<void> };
export const test = base.extend<{ manifest: Manifest }, { harness: Manifest }>({
  harness: [async ({}, use) => {
    const child = fork(fileURLToPath(new URL("./server.ts", import.meta.url)), [], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let log = "";
    child.stderr?.on("data", data => { log += String(data); });
    child.stdout?.on("data", data => { log += String(data); });
    try {
      const manifest = await new Promise<Manifest>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("UI fixture timeout: " + log)), 180_000);
        child.once("exit", code => { clearTimeout(timeout); reject(new Error(`UI fixture exited ${code}: ${log}`)); });
        child.on("message", (message: Manifest & { type: string }) => { if (message.type === "ready") { clearTimeout(timeout); resolve(message); } });
      });
      let requestId = 0;
      const send = (payload: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
        const id = ++requestId;
        const timeout = setTimeout(() => { child.off("message", done); reject(new Error("Fixture clock timeout: " + log)); }, 5000);
        const done = (message: { type?: string; id?: number }) => { if (message.type === "done" && message.id === id) { clearTimeout(timeout); child.off("message", done); resolve(); } };
        child.on("message", done);
        child.send({ ...payload, id });
      });
      manifest.setTime = (time, reset = false) => send({ type: "clock", time, reset });
      manifest.setCheckoutFailure = checkoutFailure => send({ type: "scenario", checkoutFailure });
      await use(manifest);
    } finally { if (child.connected) child.disconnect(); await new Promise<void>(resolve => { child.once("exit", () => resolve()); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); }); }
  }, { scope: "worker", timeout: 180_000 }],
  manifest: async ({ harness }, use) => { await harness.setTime(harness.epoch, true); await use(harness); },
  page: async ({ page, manifest }, use) => {
    await page.clock.install({ time: new Date(manifest.epoch) });
    await page.clock.setFixedTime(new Date(manifest.epoch));
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    await use(page);
  },
});
export { expect };
export async function login(page: Page, manifest: Manifest) {
  await page.context().addCookies(manifest.sessionCookies.map(cookie => ({ ...cookie, url: manifest.origin, httpOnly: !cookie.name.includes("csrf"), sameSite: "Strict" })));
  await page.goto(manifest.origin + "/admin/");
  await expect(page.locator("[data-content-width]")).toBeVisible();
}
const measurements = new WeakMap<TestInfo, number>();
export async function record(page: Page, info: TestInfo, extra = {}) {
  if ((extra as { javascript?: boolean }).javascript !== false) {
    await page.clock.runFor(50);
    await page.evaluate(() => document.fonts.ready);
  }
  const sequence = (measurements.get(info) ?? 0) + 1; measurements.set(info, sequence);
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    theme: document.documentElement.dataset.theme ?? (document.documentElement.classList.contains("dark") || matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    density: document.querySelector("[data-business-table]")?.getAttribute("data-density"), width: document.querySelector("[data-content-width]")?.getAttribute("data-content-width"),
    sidebar: document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute("data-state"),
    headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].map(e => ({ text: e.textContent, level: e.getAttribute("aria-level") ?? e.tagName.slice(1) })),
    documentWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    overflowElements: [...document.querySelectorAll("body *")].filter(e => {
      const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1) && getComputedStyle(e).position !== "fixed";
    }).slice(0, 24).map(e => ({ tag: e.tagName, class: e.getAttribute("class"), text: e.textContent?.slice(0, 60), width: e.getBoundingClientRect().width, right: e.getBoundingClientRect().right })) }));
  const path = info.outputPath(`measurement-${sequence}.json`);
  writeFileSync(path, JSON.stringify({ ...extra, source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDiff: createHash("sha256").update(execFileSync("git", ["-c", "core.safecrlf=false", "diff", "--binary", "HEAD", "--", "src", "web", "scripts"], { stdio: ["ignore", "pipe", "ignore"] })).digest("hex"),
    adminBuild: createHash("sha256").update(readFileSync("web-dist/admin/index.html")).digest("hex"),
    checkoutBuild: createHash("sha256").update(readFileSync("web-dist/checkout/.vite/manifest.json")).digest("hex"),
    browser: page.context().browser()?.version(), requestedViewport: page.viewportSize(), url: page.url(), ...geometry }, null, 2));
  await info.attach("measurement", { path, contentType: "application/json" });
  expect(geometry.overflow).toBe(false);
  return geometry;
}
