import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/summarize-ui-run.mjs .ui-audit/runs/<run>");
const report = JSON.parse(await readFile(join(root, "results.json"), "utf8"));
const artifacts = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith("-accessibility.json") || /^measurement-\d+\.json$/.test(entry.name)) artifacts.push(path);
  }
}
await walk(join(root, "artifacts"));
const measurements = [], accessibility = [];
for (const path of artifacts) {
  const data = JSON.parse(await readFile(path, "utf8"));
  const item = { path: relative(root, path).replaceAll("\\", "/"), ...data };
  if (path.endsWith("-accessibility.json")) accessibility.push(item); else measurements.push(item);
}
const summary = {
  stats: report.stats,
  pages: measurements.length,
  auditedPages: accessibility.length,
  failedRules: accessibility.reduce((sum, result) => sum + result.failed.length, 0),
  undeterminedRules: accessibility.reduce((sum, result) => sum + result.undetermined.length, 0),
  overflows: measurements.filter(result => result.overflow).map(result => result.path),
  measurements, accessibility,
};
await writeFile(join(root, "evidence-index.json"), JSON.stringify(summary, null, 2));
await writeFile(join(root, "EVIDENCE.md"), [
  "# UI evidence index", "", `Measurements: ${summary.pages}; axe audits: ${summary.auditedPages}; failed rules: ${summary.failedRules}; undetermined rules: ${summary.undeterminedRules}.`, "",
  "Undetermined checks require manual review and are never counted as passed.", "",
  "| Route | Viewport | Theme | Width / density / sidebar | Measurement |", "| --- | --- | --- | --- | --- |",
  ...measurements.map(item => `| ${new URL(item.url).pathname} | ${item.viewport.width} × ${item.viewport.height} | ${item.theme} | ${item.width ?? "—"} / ${item.density ?? "—"} / ${item.sidebar ?? "—"} | [JSON](${item.path}) |`),
].join("\n") + "\n");
console.log(JSON.stringify({ ...summary, measurements: summary.measurements.length, accessibility: summary.accessibility.length }));
if (summary.failedRules || summary.overflows.length || report.stats.unexpected) process.exitCode = 1;
