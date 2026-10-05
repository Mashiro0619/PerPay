import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { OrderService } from "../src/orders/service.ts";
import { SiteStore } from "../src/sites/store.ts";
import { MULTI_SITE_SCHEMA_SQL } from "../src/sites/migrations/schema.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

export async function createSitePaymentFixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-site-orders-"));
  const services = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/site-orders" });
  const snapshot = services.settings.snapshot();
  services.database.write(connection => { connection.exec(MULTI_SITE_SCHEMA_SQL); migrateSiteData(connection, services.config.masterKey); });
  const sites = new SiteStore(services.database, services.config.masterKey);
  let now = Date.now();
  const orders = new OrderService(services.database, () => services.settings.snapshot(), () => now, sites);
  const createSite = (name: string) => sites.create({ operation_id: randomUUID(), configuration: { name, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: sites.defaults().policy } }, { actorId: "admin" });
  return {
    ...services, sites, orders, createSite, snapshot, now: () => now, setNow: (value: number) => { now = value; },
    close() {
      services.database.close();
      const target = resolve(directory);
      assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("perpay-site-orders-"));
      rmSync(target, { recursive: true });
    },
  };
}
