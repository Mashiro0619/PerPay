import { serve } from "@hono/node-server";
import { createServer } from "node:net";
import { createPreviewDemo } from "../scripts/preview-demo.ts";

if (!process.send) throw new Error("UI fixture requires an IPC parent");
const epoch = Date.UTC(2026, 9, 15, 6);
let now = epoch;
// This test process uses only isolated synthetic stores and never external transports.
globalThis.fetch = async () => { throw new Error("External fetch is forbidden in UI fixtures"); };
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}
const demo = await createPreviewDemo({ port: process.env.PERPAY_UI_PORT ? Number(process.env.PERPAY_UI_PORT) : await freePort(), now, clock: () => now });
const login = await demo.app.request(demo.origin + "/api/admin/v1/session/login", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: demo.origin }, body: JSON.stringify({ password: demo.password }),
});
const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const firstId = (table: string, column: string) => demo.database.read(db =>
  (db.prepare(`SELECT ${column} AS id FROM ${table} LIMIT 1`).get() as { id: string }).id);
const routes = ["/", "/orders", "/work-items", "/notifications", "/reconciliation", "/sites", "/sites/new", "/sites/defaults", "/system", "/test-payment",
  ...["provider", "collection", "collection-policy", "security", "backup", "display", "advanced"].map(value => "/settings/" + value),
  "/settings/onboarding/check", "/orders/" + demo.featured,
  "/notifications/" + Object.values(demo.scenarios.notifications.deliveries)[0],
  "/reconciliation/matches/" + firstId("payment_matches", "payment_match_id"),
  "/reconciliation/candidates/" + firstId("match_candidates", "candidate_id"),
  "/reconciliation/ledger/" + Object.values(demo.scenarios.financial.entries)[0],
  "/reconciliation/exceptions/" + Object.values(demo.scenarios.financial.exceptions)[0],
  "/reconciliation/conflicts/" + Object.values(demo.scenarios.financial.conflicts)[0],
  ...["", "/orders", "/notifications", "/work-items", "/settings"].map(path => "/sites/" + demo.scenarios.sites.store + path),
];
const checkouts: Record<string, string> = {};
for (const [name, id] of Object.entries(demo.scenarios.lifecycle)) {
  const response = await demo.app.request("/api/admin/v1/orders/" + id + "/checkout", { headers: { cookie } });
  if (response.headers.has("location")) checkouts[name] = response.headers.get("location")!;
}
const server = serve({ fetch: demo.app.fetch, hostname: "127.0.0.1", port: Number(new URL(demo.origin).port) });
try {
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
} catch (error) { demo.dispose(); throw error; }
process.send({ type: "ready", origin: demo.origin, epoch, routes, checkouts, directory: demo.directory });
process.on("message", (message: { type: string; time?: number; id?: number }) => {
  if (message.type === "clock") { now = message.time ?? epoch; process.send?.({ type: "done", id: message.id }); }
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { demo.dispose(); process.exit(0); });
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
