import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { withHttpFixture, login } from "../test/reconciliation-http-fixture.ts";

// All records live in the fixture's temporary database. No provider/notification workers run.
const count = Number(process.argv[2] ?? 10000);
if (!Number.isInteger(count) || count < 100 || count > 20000)
  throw new Error("count must be between 100 and 20000");
await withHttpFixture(async (f) => {
  const secret = Buffer.alloc(32, 91).toString("base64url");
  f.services.settingsStore.saveWebhook(
    {
      revision: f.services.settings.snapshot().revision,
      enabled: true,
      allowed_origin: "https://bench.example.test",
      timeout_milliseconds: 5000,
      maximum_attempts: 3,
      retry_base_seconds: 10,
      retry_maximum_seconds: 60,
      secret,
    },
    {
      actorId: "admin",
      requestId: "query-benchmark",
      remoteAddressHash: "0".repeat(64),
    },
  );
  f.webhooks.syncSigningKey({
    secretFingerprint:
      f.services.settings.snapshot().webhook.signingKeyFingerprint!,
    now: Date.now(),
  });
  const seed = performance.now();
  const template = f.createSettlement(
    "bench-template",
    2000,
    "https://bench.example.test/notify/template",
  );
  f.webhooks.materialize(20, Date.now());
  const reminderBenchmark = process.argv[3] === "work-items";
  if (reminderBenchmark) {
    const claim = f.webhooks.claimNext({
      now: Date.now(),
      leaseMilliseconds: 30000,
      maximumAttempts: 3,
    })!;
    f.webhooks.completeAttempt({
      deliveryId: claim.delivery.deliveryId,
      attemptId: claim.attempt.attemptId,
      leaseToken: claim.attempt.leaseToken,
      outcome: "RETRYABLE_FAILURE",
      now: Date.now(),
      maximumAttempts: 3,
      retryBaseMilliseconds: 600000,
      retryMaximumMilliseconds: 600000,
      errorCode: "benchmark_timeout",
    });
  }
  // A read-query benchmark, NOT a financial-write benchmark. Clone one validated synthetic
  // projection in this disposable fixture; omit write triggers only during bulk snapshot loading.
  // Correctness/security tests use the complete production schema and real operations instead.
  f.database.write((db) => {
    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers)
      db.exec('DROP TRIGGER "' + trigger.name.replaceAll('"', '""') + '"');
    const tables = [
      "payment_orders",
      "checkout_sessions",
      "webhook_targets",
      "financial_operations",
      "outbox_events",
      "webhook_deliveries",
    ];
    const clones = tables.map((table) => {
      const original = db
        .prepare("SELECT * FROM " + table + " LIMIT 1")
        .get() as Record<string, SQLInputValue>;
      const columns = Object.keys(original);
      return {
        table,
        original,
        columns,
        insert: db.prepare(
          "INSERT INTO " +
            table +
            " (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map(() => "?").join(",") +
            ")",
        ),
      };
    });
    for (let i = 1; i < count; i++) {
      const orderId = randomUUID(),
        eventId = randomUUID(),
        targetId = randomUUID(),
        operationId = randomUUID();
      for (const item of clones) {
        const row = { ...item.original };
        const digest = createHash("sha256").update(orderId).digest("hex");
        if (item.table === "payment_orders")
          Object.assign(row, {
            order_id: orderId,
            merchant_order_no: "bench-" + String(i).padStart(5, "0"),
            idempotency_key_digest: digest,
            product_name: "基准中文项目 " + i,
            requested_amount_cents: 2000 + i,
            payable_amount_cents: 2001 + i,
            received_amount_cents: 2001 + i,
          });
        if (item.table === "checkout_sessions")
          Object.assign(row, {
            checkout_id: randomUUID(),
            order_id: orderId,
            token_digest: digest,
          });
        if (item.table === "webhook_targets")
          Object.assign(row, { target_id: targetId, order_id: orderId });
        if (item.table === "financial_operations")
          Object.assign(row, {
            financial_operation_id: operationId,
            order_id: orderId,
            operation_key: operationId,
          });
        if (item.table === "outbox_events")
          Object.assign(row, {
            outbox_event_id: eventId,
            aggregate_id: orderId,
            financial_operation_id: operationId,
          });
        if (item.table === "webhook_deliveries")
          Object.assign(row, {
            delivery_id: randomUUID(),
            outbox_event_id: eventId,
            target_id: targetId,
            request_key: randomUUID(),
          });
        item.insert.run(...item.columns.map((column) => row[column]!));
      }
    }
    for (const trigger of triggers) db.exec(trigger.sql);
  });
  const auth = await login(f.app);
  const rows: Array<{
    resource: string;
    query: string;
    firstMs: number;
    nextMs: number | null;
    returned: number;
  }> = [];
  for (const [resource, query] of [
    ["orders", "q=bench-000&sort_by=created_at&sort_order=desc"],
    ["orders", "q=bench-&sort_by=payable_amount_cents&sort_order=asc"],
    ["orders", "sort_by=received_amount_cents&sort_order=desc"],
    ["webhooks/deliveries", "q=notify/&sort_by=created_at&sort_order=asc"],
    ["webhooks/deliveries", "q=bench-&sort_by=attempt_count&sort_order=desc"],
    ["webhooks/deliveries", "sort_by=next_attempt_at&sort_order=desc"],
    ...(reminderBenchmark
      ? ([
          ["work-items", "q=基准中文&sort_by=created_at&sort_order=asc"],
          [
            "work-items",
            "q=benchmark_timeout&sort_by=actionable_at&sort_order=desc",
          ],
        ] as const)
      : []),
  ] as const) {
    const path = "/api/admin/v1/" + resource + "?limit=20&" + query;
    const start = performance.now();
    const response = await f.app.request(path, {
      headers: { cookie: auth.cookie },
    });
    assert.equal(response.status, 200);
    const firstMs = performance.now() - start;
    const body = (await response.json()) as {
      data: unknown[];
      page: { next_cursor: string | null };
    };
    let nextMs: number | null = null;
    if (body.page.next_cursor) {
      const start = performance.now();
      const next = await f.app.request(
        path + "&cursor=" + body.page.next_cursor,
        { headers: { cookie: auth.cookie } },
      );
      assert.equal(next.status, 200);
      nextMs = performance.now() - start;
    }
    rows.push({
      resource,
      query,
      firstMs: Number(firstMs.toFixed(3)),
      nextMs: nextMs === null ? null : Number(nextMs.toFixed(3)),
      returned: body.data.length,
    });
  }
  const indexes = f.database.read((db) =>
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%_list_idx' ORDER BY name",
      )
      .all(),
  );
  console.log(
    JSON.stringify(
      {
        count,
        fixture:
          "bulk synthetic read projections; all write triggers restored before measurement",
        seedMs: Number((performance.now() - seed).toFixed(1)),
        rows,
        indexes,
      },
      null,
      2,
    ),
  );
});
