import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createApp } from "../src/http/app";
import { LedgerStore } from "../src/ledger/store";
import { createOrderRequestSchema } from "../src/orders/model";
import { ReconciliationStore } from "../src/reconciliation/store";
import { UpdateCheckUnavailable } from "../src/update/checker";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "../test/http-fixture";
import { recordLedgerEntry } from "../test/reconciliation-http-fixture";

/** Writable temporary SQLite fixture; no provider or notification transport runs. */
export async function createSettingsServer(epoch: number) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()));
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), "perpay-settings-browser-"));
  const services = await createConfiguredHttpServices({ directory, publicUrl: origin,
    apiSecret: null, collectionCodePayload: "https://qr.alipay.com/isolated-settings-fixture", identityClock: () => epoch });
  const app = createApp({ ...services, clock: () => epoch, startedAt: new Date(epoch),
    updateChecker: { check: async () => { throw new UpdateCheckUnavailable(3600); } },
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: address.port });
  await once(server, "listening");
  const response = await app.request(origin + "/api/admin/v1/session/login", {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  if (!response.ok) throw new Error("Fixture login failed");
  const cookies = response.headers.getSetCookie().map(cookie => {
    const entry = cookie.split(";")[0]!, index = entry.indexOf("=");
    return { name: entry.slice(0, index), value: entry.slice(index + 1), url: origin,
      httpOnly: !entry.slice(0, index).includes("csrf"), sameSite: "Strict" as const };
  });
  return { origin, cookies,
    timeout: () => services.sites.defaults().policy.notification_delivery.timeout_milliseconds,
    seedPaidOrder() {
      const now = Date.now();
      const order = services.orders.create(createOrderRequestSchema.parse({
        idempotency_key: "browser-refund-mark", merchant_order_no: "BROWSER-REFUND-MARK",
        amount_cents: 100, product_name: "退款标记边界验收",
      })).order;
      const providerKey = services.settings.instanceSnapshot().activeProviderAccountKey;
      if (!providerKey) throw new Error("Missing isolated provider account");
      const providerTime = (timestamp: number) => new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
      const entry = recordLedgerEntry(new LedgerStore(services.database), {
        start: providerTime(now - 60_000), end: providerTime(now + 180_000),
      }, "browser-refund-credit", order.payableAmountCents, now + 60_000, now, "CREDIT", providerKey);
      const match = new ReconciliationStore(services.database).reconcileEntry(entry.ledgerEntryId);
      if (match.kind !== "auto_settled") throw new Error("Isolated order was not settled");
      return order.orderId;
    },
    async close() {
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()); if ("closeAllConnections" in server) server.closeAllConnections(); });
      services.database.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("perpay-settings-browser-"))
        throw new Error("Unexpected settings fixture cleanup path");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
