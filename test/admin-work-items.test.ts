import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";
import {
  adminWorkItemPage,
  type AdminWorkItem,
  type AdminWorkItemCursor,
  type AdminWorkItemType,
} from "../src/http/admin-work-items.ts";
import {
  createConfiguredHttpServices,
  HTTP_TEST_ADMIN_PASSWORD,
} from "./http-fixture.ts";

const IDS = {
  retryNewest: "00000000-0000-4000-8000-000000000001",
  retrySameTime: "00000000-0000-4000-8000-000000000002",
  conflict: "00000000-0000-4000-8000-000000000003",
  exceptionLower: "00000000-0000-4000-8000-000000000004",
  exceptionHigher: "00000000-0000-4000-8000-000000000005",
  deadLetter: "00000000-0000-4000-8000-000000000006",
  supersededDeadLetter: "00000000-0000-4000-8000-000000000007",
  successor: "00000000-0000-4000-8000-000000000008",
  excludedPending: "00000000-0000-4000-8000-000000000009",
  excludedLeased: "00000000-0000-4000-8000-00000000000a",
  excludedAcknowledged: "00000000-0000-4000-8000-00000000000b",
  orderLinked: "00000000-0000-4000-8000-00000000000c",
  orderFallback: "00000000-0000-4000-8000-00000000000d",
} as const;

describe("administrator work item projection", () => {
  it("runs against the current empty application schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-admin-work-items-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    try {
      assert.deepEqual(
        adminWorkItemPage(database, { type: "ALL", cursor: null, limit: 20 }),
        { items: [], nextCursor: null },
      );
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("combines only actionable states across provider generations in one read", () => {
    withFixture(({ database, readCount }) => {
      const page = adminWorkItemPage(database, { type: "ALL", cursor: null, limit: 20 });

      assert.equal(readCount(), 1);
      assert.equal(page.nextCursor, null);
      assert.deepEqual(page.items.map(itemIdentity), [
        `NOTIFICATION_FAILURE:${IDS.retryNewest}`,
        `NOTIFICATION_FAILURE:${IDS.retrySameTime}`,
        `LEDGER_CONFLICT:${IDS.conflict}`,
        `FINANCIAL_EXCEPTION:${IDS.exceptionHigher}`,
        `FINANCIAL_EXCEPTION:${IDS.exceptionLower}`,
        `NOTIFICATION_FAILURE:${IDS.deadLetter}`,
      ]);

      const linked = requireItem(page.items, IDS.retryNewest, "NOTIFICATION_FAILURE");
      assert.equal(linked.providerAccountKey, "generation-2");
      assert.equal(linked.eventType, "PAYMENT_CONFIRMED");
      assert.equal(linked.status, "RETRY_WAIT");
      assert.equal(linked.attemptCount, 1);
      assert.equal(linked.lastErrorCode, "transport_timeout");
      assert.equal(linked.createdAt, 100);
      assert.equal(linked.actionableAt, 401);

      const fallback = requireItem(page.items, IDS.deadLetter, "NOTIFICATION_FAILURE");
      assert.equal(fallback.providerAccountKey, "legacy-generation");
      assert.equal(fallback.status, "DEAD_LETTER");
      assert.equal(fallback.deadLetteredAt, 251);

      assert.equal(page.items.some((item) => item.itemId === IDS.supersededDeadLetter), false);
      assert.equal(page.items.some((item) => item.itemId === IDS.successor), false);
      assert.equal(page.items.some((item) => item.itemId === IDS.excludedPending), false);
      assert.equal(page.items.some((item) => item.itemId === IDS.excludedLeased), false);
      assert.equal(page.items.some((item) => item.itemId === IDS.excludedAcknowledged), false);
    });
  });

  it("uses a deterministic descending keyset cursor without duplicates", () => {
    withFixture(({ database }) => {
      const seen: string[] = [];
      let cursor: AdminWorkItemCursor | null = null;
      do {
        const page = adminWorkItemPage(database, { type: "ALL", cursor, limit: 1 });
        assert.equal(page.items.length, 1);
        seen.push(itemIdentity(page.items[0]!));
        cursor = page.nextCursor;
      } while (cursor !== null);

      assert.deepEqual(seen, [
        `NOTIFICATION_FAILURE:${IDS.retryNewest}`,
        `NOTIFICATION_FAILURE:${IDS.retrySameTime}`,
        `LEDGER_CONFLICT:${IDS.conflict}`,
        `FINANCIAL_EXCEPTION:${IDS.exceptionHigher}`,
        `FINANCIAL_EXCEPTION:${IDS.exceptionLower}`,
        `NOTIFICATION_FAILURE:${IDS.deadLetter}`,
      ]);
      assert.equal(new Set(seen).size, seen.length);
    });
  });

  it("filters by one decoded work item type", () => {
    withFixture(({ database }) => {
      const expected: Readonly<Record<Exclude<AdminWorkItemType, "ALL">, number>> = {
        FINANCIAL_EXCEPTION: 2,
        LEDGER_CONFLICT: 1,
        NOTIFICATION_FAILURE: 3,
      };
      for (const [type, count] of Object.entries(expected)) {
        const page = adminWorkItemPage(database, {
          type: type as Exclude<AdminWorkItemType, "ALL">,
          cursor: null,
          limit: 20,
        });
        assert.equal(page.items.length, count);
        assert.equal(page.items.every((item) => item.kind === type), true);
      }
    });
  });

  it("rejects invalid decoded input before reading the database", () => {
    withFixture(({ database, readCount }) => {
      assert.throws(
        () => adminWorkItemPage(database, { type: "ALL", cursor: null, limit: 0 }),
        /page limit is invalid/,
      );
      assert.throws(
        () => adminWorkItemPage(database, { type: "ALL", cursor: null, limit: 201 }),
        /page limit is invalid/,
      );
      assert.throws(
        () => adminWorkItemPage(database, {
          type: "ALL",
          cursor: { actionableAt: -1, kind: "LEDGER_CONFLICT", itemId: IDS.conflict },
          limit: 10,
        }),
        /cursor is invalid/,
      );
      assert.throws(
        () => adminWorkItemPage(database, {
          type: "ALL",
          cursor: { actionableAt: 1, kind: "LEDGER_CONFLICT", itemId: "not-a-uuid" },
          limit: 10,
        }),
        /cursor is invalid/,
      );
      assert.equal(readCount(), 0);
    });
  });

  it("exposes an authenticated, filter-bound HTTP cursor contract", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-admin-work-items-http-"));
    const services = await createConfiguredHttpServices({
      directory,
      apiSecret: Buffer.alloc(32, 91).toString("base64url"),
      collectionCodePayload: "https://qr.alipay.com/fkx-admin-work-items-http",
    });
    const projectionConnection = new DatabaseSync(":memory:", { readBigInts: true });
    createSchema(projectionConnection);
    seedFixture(projectionConnection);
    const projectionDatabase = {
      read<T>(operation: (connection: DatabaseSync) => T): T {
        return operation(projectionConnection);
      },
    } as AppDatabase;
    const app = createApp({
      config: services.config,
      database: projectionDatabase,
      identity: services.identity,
      settings: services.settings,
      orders: services.orders,
      startedAt: new Date(0),
    });
    try {
      const anonymous = await app.request("/api/admin/v1/work-items");
      assert.equal(anonymous.status, 401);
      assert.equal(await errorCode(anonymous), "session_invalid");

      const cookie = await login(app);
      const first = await app.request("/api/admin/v1/work-items?limit=1", {
        headers: { cookie },
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        data: Array<Record<string, unknown>>;
        page: { next_cursor: string | null };
      };
      assert.equal(firstBody.data.length, 1);
      assert.equal(firstBody.data[0]?.type, "NOTIFICATION_FAILURE");
      assert.equal(firstBody.data[0]?.resource_id, IDS.retryNewest);
      assert.equal(firstBody.data[0]?.created_at, new Date(100).toISOString());
      assert.equal(firstBody.data[0]?.actionable_at, new Date(401).toISOString());
      assert.equal(
        firstBody.data[0]?.detail_url,
        `/api/admin/v1/webhooks/deliveries/${IDS.retryNewest}`,
      );
      assert.ok(firstBody.page.next_cursor);

      const seen = [String(firstBody.data[0]?.resource_id)];
      let cursor: string | null = firstBody.page.next_cursor;
      while (cursor !== null) {
        const response = await app.request(
          `/api/admin/v1/work-items?limit=1&cursor=${encodeURIComponent(cursor)}`,
          { headers: { cookie } },
        );
        assert.equal(response.status, 200);
        const page = (await response.json()) as {
          data: Array<Record<string, unknown>>;
          page: { next_cursor: string | null };
        };
        assert.equal(page.data.length, 1);
        seen.push(String(page.data[0]?.resource_id));
        cursor = page.page.next_cursor;
      }
      assert.deepEqual(seen, [
        IDS.retryNewest,
        IDS.retrySameTime,
        IDS.conflict,
        IDS.exceptionHigher,
        IDS.exceptionLower,
        IDS.deadLetter,
      ]);
      assert.equal(new Set(seen).size, seen.length);

      const financial = await app.request(
        "/api/admin/v1/work-items?type=FINANCIAL_EXCEPTION",
        { headers: { cookie } },
      );
      assert.equal(financial.status, 200);
      const financialBody = (await financial.json()) as {
        data: Array<Record<string, unknown>>;
      };
      assert.equal(financialBody.data.length, 2);
      assert.equal(financialBody.data.every((item) => item.type === "FINANCIAL_EXCEPTION"), true);
      assert.equal(financialBody.data.every((item) => item.status === "OPEN"), true);

      const rebound = await app.request(
        "/api/admin/v1/work-items?type=NOTIFICATION_FAILURE&limit=1" +
          `&cursor=${encodeURIComponent(firstBody.page.next_cursor!)}`,
        { headers: { cookie } },
      );
      assert.equal(rebound.status, 422);
      assert.equal(await errorCode(rebound), "validation_failed");

      for (const query of [
        "type=UNKNOWN",
        "limit=0",
        "limit=201",
        "type=ALL&type=ALL",
        "cursor=not-a-canonical-cursor",
        "unknown=value",
      ]) {
        const invalid = await app.request(`/api/admin/v1/work-items?${query}`, {
          headers: { cookie },
        });
        assert.equal(invalid.status, 422, query);
        assert.equal(await errorCode(invalid), "validation_failed");
      }
    } finally {
      projectionConnection.close();
      services.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/admin/v1/session/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:6190",
    },
    body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

function withFixture(
  operation: (context: {
    readonly database: AppDatabase;
    readonly readCount: () => number;
  }) => void,
): void {
  const connection = new DatabaseSync(":memory:", { readBigInts: true });
  let reads = 0;
  const database = {
    read<T>(read: (databaseConnection: DatabaseSync) => T): T {
      reads += 1;
      return read(connection);
    },
  } as AppDatabase;
  try {
    createSchema(connection);
    seedFixture(connection);
    operation({ database, readCount: () => reads });
  } finally {
    connection.close();
  }
}

function createSchema(connection: DatabaseSync): void {
  connection.exec(`
    CREATE TABLE financial_exceptions (
      exception_id TEXT PRIMARY KEY,
      provider_account_key TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      ledger_entry_id TEXT,
      order_id TEXT,
      candidate_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_conflicts (
      conflict_id TEXT PRIMARY KEY,
      provider_account_key TEXT NOT NULL,
      conflict_type TEXT NOT NULL,
      existing_ledger_entry_id TEXT,
      external_event_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE collection_profiles (
      profile_id TEXT PRIMARY KEY,
      provider_account_key TEXT NOT NULL
    );
    CREATE TABLE collection_profile_provider_accounts (
      profile_id TEXT PRIMARY KEY,
      provider_account_key TEXT NOT NULL
    );
    CREATE TABLE payment_orders (
      order_id TEXT PRIMARY KEY,
      collection_profile_id TEXT NOT NULL
    );
    CREATE TABLE outbox_events (
      outbox_event_id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL
    );
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      outbox_event_id TEXT NOT NULL,
      predecessor_delivery_id TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error_code TEXT,
      dead_lettered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function seedFixture(connection: DatabaseSync): void {
  const insertException = connection.prepare(`
    INSERT INTO financial_exceptions(
      exception_id, provider_account_key, exception_type, ledger_entry_id,
      order_id, candidate_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertException.run(
    IDS.exceptionLower, "primary", "UNMATCHED_CREDIT", "ledger-exception-lower",
    "order-exception-lower", null, "OPEN", 300,
  );
  insertException.run(
    IDS.exceptionHigher, "generation-2", "AMBIGUOUS_MATCH", "ledger-exception-higher",
    "order-exception-higher", "candidate-higher", "OPEN", 300,
  );
  insertException.run(
    "00000000-0000-4000-8000-00000000000e", "primary", "AMOUNT_MISMATCH", null,
    null, null, "RESOLVED", 500,
  );

  const insertConflict = connection.prepare(`
    INSERT INTO ledger_conflicts(
      conflict_id, provider_account_key, conflict_type, existing_ledger_entry_id,
      external_event_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertConflict.run(
    IDS.conflict, "archived-generation", "DUPLICATE_EXTERNAL_ID",
    "ledger-conflict", "external-conflict", "OPEN", 300,
  );
  insertConflict.run(
    "00000000-0000-4000-8000-00000000000f", "primary", "INVALID_SHAPE",
    null, null, "IGNORED", 600,
  );

  connection.prepare(
    "INSERT INTO collection_profiles(profile_id, provider_account_key) VALUES (?, ?)",
  ).run("profile-linked", "primary");
  connection.prepare(
    "INSERT INTO collection_profile_provider_accounts(profile_id, provider_account_key) VALUES (?, ?)",
  ).run("profile-linked", "generation-2");
  connection.prepare(
    "INSERT INTO collection_profiles(profile_id, provider_account_key) VALUES (?, ?)",
  ).run("profile-fallback", "legacy-generation");
  connection.prepare(
    "INSERT INTO payment_orders(order_id, collection_profile_id) VALUES (?, ?)",
  ).run(IDS.orderLinked, "profile-linked");
  connection.prepare(
    "INSERT INTO payment_orders(order_id, collection_profile_id) VALUES (?, ?)",
  ).run(IDS.orderFallback, "profile-fallback");
  connection.prepare(
    "INSERT INTO outbox_events(outbox_event_id, aggregate_id, event_type) VALUES (?, ?, ?)",
  ).run("outbox-linked", IDS.orderLinked, "PAYMENT_CONFIRMED");
  connection.prepare(
    "INSERT INTO outbox_events(outbox_event_id, aggregate_id, event_type) VALUES (?, ?, ?)",
  ).run("outbox-fallback", IDS.orderFallback, "PAYMENT_DISPUTED");

  const insertDelivery = connection.prepare(`
    INSERT INTO webhook_deliveries(
      delivery_id, outbox_event_id, predecessor_delivery_id, status, attempt_count,
      next_attempt_at, last_error_code, dead_lettered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertDelivery.run(
    IDS.retryNewest, "outbox-linked", null, "RETRY_WAIT", 1,
    450, "transport_timeout", null, 100, 401,
  );
  insertDelivery.run(
    IDS.retrySameTime, "outbox-linked", null, "RETRY_WAIT", 2,
    460, "http_server_error", null, 300, 302,
  );
  insertDelivery.run(
    IDS.deadLetter, "outbox-fallback", null, "DEAD_LETTER", 3,
    250, "maximum_attempts_exceeded", 251, 250, 251,
  );
  insertDelivery.run(
    IDS.supersededDeadLetter, "outbox-linked", null, "DEAD_LETTER", 3,
    500, "maximum_attempts_exceeded", 501, 500, 501,
  );
  insertDelivery.run(
    IDS.successor, "outbox-linked", IDS.supersededDeadLetter, "PENDING", 0,
    502, null, null, 502, 502,
  );
  insertDelivery.run(
    IDS.excludedPending, "outbox-linked", null, "PENDING", 0,
    700, null, null, 700, 700,
  );
  insertDelivery.run(
    IDS.excludedLeased, "outbox-linked", null, "LEASED", 1,
    700, null, null, 700, 700,
  );
  insertDelivery.run(
    IDS.excludedAcknowledged, "outbox-linked", null, "ACKNOWLEDGED", 1,
    700, null, null, 700, 700,
  );
}

function itemIdentity(item: AdminWorkItem): string {
  return `${item.kind}:${item.itemId}`;
}

function requireItem<K extends AdminWorkItem["kind"]>(
  items: readonly AdminWorkItem[],
  itemId: string,
  kind: K,
): Extract<AdminWorkItem, { readonly kind: K }> {
  const item = items.find((candidate) => candidate.itemId === itemId && candidate.kind === kind);
  assert.ok(item);
  return item as Extract<AdminWorkItem, { readonly kind: K }>;
}
