import { serve } from "@hono/node-server";
import { createServer } from "node:net";
import { createPreviewDemo } from "../scripts/preview-demo.ts";
import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";
import { renderCheckoutPage } from "../src/http/web/checkout.ts";

if (!process.send) throw new Error("UI fixture requires an IPC parent");
const epoch = Date.UTC(2026, 9, 15, 6);
let now = epoch;
let generation = 0;
let checkoutFailure: 429 | 503 | null = null;
const take = PublicCheckoutRateLimiter.prototype.take;
const budgets = new WeakMap<PublicCheckoutRateLimiter, { generation: number; limiter: PublicCheckoutRateLimiter }>();
// Test-process-only clock/reset seam; the production limiter and its policy stay intact.
PublicCheckoutRateLimiter.prototype.take = function (address: string) {
  let budget = budgets.get(this);
  if (!budget || budget.generation !== generation) {
    budget = { generation, limiter: new PublicCheckoutRateLimiter() }; budgets.set(this, budget);
  }
  return take.call(budget.limiter, address, Math.max(0, now - epoch));
};
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
const routes = ["/", "/orders", "/work-items", "/notifications", "/reconciliation", "/ledger", "/sites", "/sites/new", "/sites/defaults", "/system", "/test-payment",
  ...["accounts", "collection-policy", "security", "backup", "display", "advanced"].map(value => "/settings/" + value),
  "/settings/onboarding/check", "/orders/" + demo.featured,
  "/ledger/" + demo.scenarios.ledger.identical,
  "/ledger/" + demo.scenarios.ledger.inconsistent,
  "/notifications/" + Object.values(demo.scenarios.notifications.deliveries)[0],
  "/reconciliation/matches/" + firstId("payment_matches", "payment_match_id"),
  "/reconciliation/candidates/" + firstId("match_candidates", "candidate_id"),
  "/reconciliation/ledger/" + Object.values(demo.scenarios.financial.entries)[0],
  "/reconciliation/exceptions/" + Object.values(demo.scenarios.financial.exceptions)[0],
  "/reconciliation/conflicts/" + Object.values(demo.scenarios.financial.conflicts)[0],
  ...["", "/orders", "/notifications", "/work-items", "/settings"].map(path => "/sites/" + demo.scenarios.sites.store + path),
];
const extendedRoutes = [
  ...["accounts", "sites"].map(step => "/settings/onboarding/" + step),
  ...["collection", "orders", "integration", "display"].map(section => "/sites/" + demo.scenarios.sites.store + "/settings/" + section),
  "/sites/" + demo.scenarios.sites.store + "/orders/" + demo.featured,
  "/sites/" + demo.scenarios.sites.notifications + "/notifications/" + Object.values(demo.scenarios.notifications.deliveries)[0],
  ...([ ["matches", "payment_matches", "payment_match_id"], ["candidates", "match_candidates", "candidate_id"] ] as const).map(([kind, table, key]) => demo.database.read(db => {
    const row = db.prepare(`SELECT resource.${key} AS id, payment_orders.api_client_id AS client_id FROM ${table} resource JOIN payment_orders ON payment_orders.order_id = resource.order_id LIMIT 1`).get() as { id: string; client_id: string };
    return "/sites/" + row.client_id + "/reconciliation/" + kind + "/" + row.id;
  })),
];
// Named real-domain scenarios keep dense-detail checks independent of row order.
const matchScenario = (where: string) => demo.database.read(db => db.prepare(`
  SELECT match.payment_match_id AS id, match.ledger_entry_id AS ledger_id,
         orders.api_client_id AS client_id
    FROM payment_matches AS match JOIN payment_orders AS orders USING (order_id)
   WHERE ${where} ORDER BY match.created_at, match.payment_match_id LIMIT 1
`).get()) as { id: string; ledger_id: string; client_id: string };
const inferredMatch = matchScenario("match.status = 'SETTLED' AND match.evidence_type = 'AMOUNT_INFERRED'");
const manualMatch = matchScenario("match.status = 'SETTLED' AND match.evidence_type = 'MANUAL'");
const reversedMatch = matchScenario("match.status = 'REVERSED'");
const retryHttp = demo.database.read(db => db.prepare(`SELECT delivery.delivery_id AS id
  FROM webhook_deliveries AS delivery JOIN webhook_attempts AS attempt USING (delivery_id)
  WHERE delivery.status = 'RETRY_WAIT' AND attempt.http_status = 503
  ORDER BY delivery.created_at DESC LIMIT 1`).get()) as { id: string };
const details = {
  orderLong: "/orders/" + demo.scenarios.lifecycle.longDescription,
  orderPaid: "/orders/" + demo.scenarios.lifecycle.fullEvidence,
  notificationDns: "/notifications/" + demo.scenarios.notifications.deliveries.dnsRetry,
  notificationHttp: "/notifications/" + retryHttp.id,
  notificationPending: "/notifications/" + demo.scenarios.notifications.deliveries.pending,
  notificationDead: "/notifications/" + demo.scenarios.notifications.deliveries.deadLetter,
  notificationHistory: "/notifications/" + demo.scenarios.notifications.deliveries.replayHistoryOriginal,
  notificationSite: "/sites/" + demo.scenarios.sites.notifications + "/notifications/" + demo.scenarios.notifications.deliveries.dnsRetry,
  matchInferred: "/reconciliation/matches/" + inferredMatch.id,
  matchSite: "/sites/" + inferredMatch.client_id + "/reconciliation/matches/" + inferredMatch.id,
  matchManual: "/reconciliation/matches/" + manualMatch.id,
  matchReversed: "/reconciliation/matches/" + reversedMatch.id,
  exceptionOpen: "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.lateClosed,
  exceptionSite: "/sites/" + demo.scenarios.sites.financial + "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.lateClosed,
  exceptionIgnored: "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.underpaid,
  exceptionResolved: "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.manualOverpaid,
  exceptionCandidate: "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.disputedInferred,
  exceptionUnmatched: "/reconciliation/exceptions/" + demo.scenarios.financial.exceptions.unmatched,
  ledgerAssociated: "/ledger/" + inferredMatch.ledger_id,
  ledgerIdentical: "/ledger/" + demo.scenarios.ledger.identical,
  ledgerDisputed: "/ledger/" + demo.scenarios.ledger.inconsistent,
};
const checkouts: Record<string, string> = {};
for (const [name, id] of Object.entries(demo.scenarios.lifecycle)) {
  const response = await demo.app.request("/api/admin/v1/orders/" + id + "/checkout", { headers: { cookie } });
  if (response.headers.has("location")) checkouts[name] = response.headers.get("location")!;
}
const openCheckout = checkouts.open!;
const openApi = openCheckout.replace("/checkout/", "/api/public/v1/checkouts/");
const server = serve({ fetch: async (request, env) => {
  const path = new URL(request.url).pathname;
  if (checkoutFailure && path === openApi) return Response.json({ error: { code: "ui_synthetic_unavailable", message: "合成收款服务暂不可用" } }, { status: checkoutFailure, headers: { "retry-after": "2", "date": new Date(now).toUTCString() } });
  const response = await demo.app.fetch(request, env);
  if (!checkoutFailure || path !== openCheckout) return response;
  const headers = new Headers(response.headers); headers.delete("content-length"); headers.set("retry-after", "2");
  return new Response(renderCheckoutPage({ checkoutToken: openCheckout.split("/").at(-1)!, checkout: null, qrImageUrl: null,
    serverTime: now, demoMode: true, initialError: { status: checkoutFailure, code: "ui_synthetic_unavailable", message: "合成收款服务暂不可用", retryAfterSeconds: 2 } }), { status: checkoutFailure, headers });
}, hostname: "127.0.0.1", port: Number(new URL(demo.origin).port) });
try {
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
} catch (error) { demo.dispose(); throw error; }
process.send({ type: "ready", origin: demo.origin, epoch, routes, extendedRoutes, details, checkouts, directory: demo.directory,
  sessionCookies: login.headers.getSetCookie().map(value => { const entry = value.split(";")[0]!; const index = entry.indexOf("="); return { name: entry.slice(0, index), value: entry.slice(index + 1) }; }) });
process.on("message", (message: { type: string; time?: number; id?: number; reset?: boolean; checkoutFailure?: 429 | 503 | null }) => {
  if (message.reset) { generation++; checkoutFailure = null; }
  if (message.type === "scenario") { checkoutFailure = message.checkoutFailure ?? null; process.send?.({ type: "done", id: message.id }); }
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
