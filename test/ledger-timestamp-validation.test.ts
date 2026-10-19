import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { OrderStore } from "../src/database/order-store.ts";
import { LedgerIngestService } from "../src/ledger/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import {
  createOrderRequestSchema,
  digestIdempotencyKey,
  fingerprintCreateOrderRequest,
} from "../src/orders/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { seedFixedSite } from "./fixed-site-fixture.ts";

it("isolates an invalid zoned provider date before it can confirm an order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-timestamp-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  try {
    const orderAt = Date.parse("2030-03-02T12:34:00+08:00");
    const scanAt = orderAt + 60_000;
    seedFixedSite(database, "default", orderAt);
    const ledger = new LedgerStore(database);
    ledger.bindProviderIdentity({
      providerAccountKey: "primary",
      providerKind: "alipay",
      endpoint: "https://openapi.alipay.com",
      externalAccountId: "synthetic-invalid-date",
    }, orderAt);
    const orders = new OrderStore(database, () => orderAt);
    const codePayload = "https://qr.example.test/invalid-date";
    orders.syncCollectionProfile({ codePayload, ...fingerprintCollectionCodeProfile(codePayload) });
    const request = createOrderRequestSchema.parse({
      idempotency_key: "invalid-date",
      merchant_order_no: "invalid-date",
      amount_cents: 999,
      product_name: "synthetic order",
    });
    const created = orders.createOrder({
      apiClientId: "default",
      request,
      idempotencyKeyDigest: digestIdempotencyKey("default", request.idempotency_key),
      requestFingerprint: fingerprintCreateOrderRequest(request),
      ttlMilliseconds: 300_000,
      amountOffsetMaximumCents: 99,
    });
    assert.equal(created.kind, "created");
    if (created.kind !== "created") throw new Error("expected order creation");
    assert.equal(created.aggregate.order.payableAmountCents, 1_000);

    const raw = {
      account_log_id: "invalid-iso-event",
      trans_dt: "2030-02-30T12:34:56+08:00",
      trans_amount: "10.00",
      direction: "CREDIT",
    };
    const ingest = new LedgerIngestService({
      store: ledger,
      providerAccountKey: "primary",
      pageSize: 1,
      windowMilliseconds: 60_000,
      safetyLagMilliseconds: 0,
      overlapMilliseconds: 0,
      scanIntervalMilliseconds: 1_000,
      maxRequestsPerRun: 1,
      initialWindowStartMilliseconds: orderAt,
      clock: () => scanAt,
      provider: {
        async queryPage(input) {
          return {
            pageNo: input.pageNo,
            pageSize: input.pageSize,
            totalSize: 1,
            hasMore: false,
            traceId: "synthetic-invalid-date",
            details: [{
              raw,
              accountLogId: raw.account_log_id,
              occurredAt: raw.trans_dt,
              amount: raw.trans_amount,
              direction: raw.direction,
              alipayOrderNo: null,
              merchantOrderNo: null,
              transMemo: null,
              otherAccount: null,
            }],
            rawResponse: {
              status: 200,
              headers: {},
              body: JSON.stringify(raw),
              traceId: "synthetic-invalid-date",
              signatureVerified: true,
            },
          };
        },
      },
    });

    const scan = await ingest.run("invalid_timestamp");
    assert.equal(scan.status, "COMPLETED");
    assert.equal(scan.createdEntries, 0);
    assert.equal(scan.isolatedDetails, 1);
    assert.equal(ledger.getLedgerEntry("primary", raw.account_log_id), null);
    assert.deepEqual(ledger.listOpenConflicts().map((conflict) => conflict.conflictType), [
      "INVALID_TIMESTAMP",
    ]);
    const reconciliation = new ReconciliationStore(database);
    assert.equal(reconciliation.reconcileOrder(created.aggregate.order.orderId, 10, scanAt).processed, 0);
    assert.equal(orders.orderById("default", created.aggregate.order.orderId)?.order.paymentStatus, "UNPAID");
    assert.equal(database.integrityCheck().ok, true);
  } finally {
    database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
