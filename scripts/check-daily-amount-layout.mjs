// SPDX-License-Identifier: MIT
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

// Run after npm run build:admin, then open the printed fixture in a browser.
// Pixel assertions run on load; body[data-layout-result] is passed or failed.
const root = fileURLToPath(new URL("../", import.meta.url));
const admin = resolve(root, "web-dist/admin");
const entry = await readFile(resolve(admin, "index.html"), "utf8");
const stylesheets = [...entry.matchAll(/href="\/admin\/([^"?#]+\.css)"/g)];
if (!stylesheets.length) throw new Error("Build the admin first: npm run build:admin");
const css = (await Promise.all(stylesheets.map((match) => readFile(resolve(admin, match[1]), "utf8")))).join("\n");

const server = await createServer({
  configFile: resolve(root, "web/vite.config.ts"),
  server: { middlewareMode: true },
  plugins: [{
    name: "daily-amount-layout-desktop",
    enforce: "pre",
    load(id) {
      // SSR cannot measure the container; exercise the real desktop report DOM.
      if (id.split("?")[0].replaceAll("\\", "/").endsWith("/hooks/use-list-size.ts")) {
        return "export function useListSize() { return { ref: null, isSummary: false }; }";
      }
    },
  }],
});
const cases = [];
try {
  const { DailyAnalytics } = await server.ssrLoadModule("/src/components/daily-analytics.tsx");
  for (const large of [false, true]) {
    const daily = Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10),
      confirmed_amount_cents: large && (index === 19 || index === 26) ? 2_000_000_000_000_000 : [100000, 99900, 50000, 0, 0, 0, 0][index % 7],
      confirmations: 1, orders_created: 1,
      notifications_acknowledged: 0, notifications_failed: 0,
    }));
    const analytics = {
      range_days: 30, from: "2026-09-30T16:00:00.000Z", to: "2026-10-30T16:00:00.000Z", daily,
      confirmations: { count: 30, amount_cents: daily.reduce((sum, day) => sum + day.confirmed_amount_cents, 0) },
      orders: { created: 30, confirmed: 30, unpaid: 0, disputed: 0, closed: 0, expired: 0 },
      notifications: { acknowledged: 0, failed: 0, pending: 0 },
      pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
    };
    const markup = renderToString(createElement(DailyAnalytics, { analytics, range: 30, pending: false }));
    for (const width of [640, 1048]) cases.push({
      id: `${large ? "large" : "normal"}-${width}`, width, markup,
      amounts: Object.fromEntries(daily.map((day) => [day.date, day.confirmed_amount_cents])),
      maximum: Math.max(...daily.map((day) => day.confirmed_amount_cents)),
    });
  }
} finally {
  await server.close();
}

async function checkLayout(fixtures) {
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  try {
    for (const fixture of fixtures) {
      const section = document.getElementById(fixture.id);
      const bars = [...section.querySelectorAll("svg[data-date]")];
      const track = bars[0].getBoundingClientRect().width;
      assert(section.querySelectorAll("table").length === 2, `${fixture.id}: expected two open weeks`);
      assert(track > 0, `${fixture.id}: bars must have visible tracks`);
      const measured = bars.map((bar) => {
        const amount = fixture.amounts[bar.dataset.date];
        const actualTrack = bar.getBoundingClientRect().width;
        const fill = bar.querySelector("[data-daily-bar-fill]").getBoundingClientRect().width;
        assert(Math.abs(actualTrack - track) < 0.05, `${fixture.id}: unequal track at ${bar.dataset.date}`);
        assert(Math.abs(fill - track * amount / fixture.maximum) < 0.05, `${fixture.id}: incorrect fill at ${bar.dataset.date}`);
        if (amount === 0) assert(fill === 0, `${fixture.id}: zero amount has a visible fill`);
        return { amount, fill };
      });
      const smaller = measured.find((row) => row.amount === 99900);
      const larger = measured.find((row) => row.amount === 100000);
      assert(smaller && larger && smaller.fill <= larger.fill + 0.001, `${fixture.id}: ¥999 bar is longer than ¥1,000`);
      for (const element of section.querySelectorAll(".daily-amount, .daily-amount > .list-money, table, [data-slot=table-container]")) {
        assert(element.scrollWidth <= element.clientWidth + 1, `${fixture.id}: ${element.className} overflows`);
        assert(element.scrollHeight <= element.clientHeight + 1, `${fixture.id}: ${element.className} clips vertically`);
      }
      results.push({ id: fixture.id, rows: bars.length, track, smallerFill: smaller.fill, largerFill: larger.fill });
    }
    document.body.dataset.layoutResult = "passed";
  } catch (error) {
    document.body.dataset.layoutResult = "failed";
    results.push({ error: error.message });
  }
  document.getElementById("results").textContent = JSON.stringify({ result: document.body.dataset.layoutResult, cases: results }, null, 2);
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Daily amount layout regression</title><style>${css}</style></head><body data-layout-result="pending"><h1>Daily amount layout regression</h1><pre id="results">Checking…</pre>${cases.map((fixture) => `<section id="${fixture.id}" style="width:${fixture.width}px"><h2>${fixture.id}</h2>${fixture.markup}</section>`).join("\n")}<script>(${checkLayout.toString()})(${JSON.stringify(cases.map(({ markup, ...fixture }) => fixture))});</script></body></html>`;
const output = resolve(root, ".playwright-mcp/daily-amount-layout.html");
await mkdir(resolve(root, ".playwright-mcp"), { recursive: true });
await writeFile(output, html, "utf8");
console.log(output);
