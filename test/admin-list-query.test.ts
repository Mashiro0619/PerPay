import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import {
  ORDER_SORT_FIELDS,
  DELIVERY_SORT_FIELDS,
  normalizeKeyword,
  readListQuery,
} from "../src/shared/list-query.ts";
import { listKeyset, listSearch } from "../src/database/list-query.ts";
import { encodeListCursor, decodeListCursor } from "../src/http/list-cursor.ts";
import { withHttpFixture, login } from "./reconciliation-http-fixture.ts";

type Row = {
  order_id: string;
  created_at: string;
  payable_amount_cents: number;
  payment: { received_amount_cents: number | null };
  delivery_id: string;
  attempt_count: number;
  next_attempt_at: string | null;
  status: string;
  last_error_code: string | null;
};
function compare(
  a: string | number | null,
  b: string | number | null,
  aId: string,
  bId: string,
  direction: string,
) {
  if (a === null && b !== null) return 1;
  if (b === null && a !== null) return -1;
  const difference =
    a === b ? (aId < bId ? -1 : aId > bId ? 1 : 0) : a! < b! ? -1 : 1;
  return direction === "asc" ? difference : -difference;
}

describe("query normalization and keyset contracts", () => {
  it("counts Unicode characters, trims once and rejects duplicate or non-whitelisted sorts", () => {
    assert.equal(normalizeKeyword("  中文😀%_  "), "中文😀%_");
    assert.equal(Array.from(normalizeKeyword("😀".repeat(100))).length, 100);
    assert.throws(() => normalizeKeyword("😀".repeat(101)));
    assert.throws(() => normalizeKeyword("x\0y"));
    for (const query of [
      "q=a&q=b",
      "sort_by=note",
      "sort_order=ASC",
      "sort_by=created_at&sort_by=created_at",
      "q=%ED%A0%80".replace("%ED%A0%80", "x") + "&sort_order=",
    ])
      assert.throws(() =>
        readListQuery(
          new URLSearchParams(query),
          ORDER_SORT_FIELDS,
          "created_at",
          "desc",
        ),
      );
  });
  it("keeps literal search and NULLS LAST keysets deterministic for both directions", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE rows (id TEXT PRIMARY KEY, value INTEGER, text TEXT)",
      );
      const insert = db.prepare("INSERT INTO rows VALUES (?, ?, ?)");
      for (const [id, value] of [
        ["a", 3],
        ["b", 3],
        ["c", null],
        ["d", 1],
        ["e", null],
      ] as const)
        insert.run(id, value, "中文%_x");
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM rows WHERE " +
              listSearch(["text"], "%_").where,
          )
          .get(...listSearch(["text"], "%_").parameters)?.n,
        5,
      );
      for (const order of ["asc", "desc"] as const) {
        let position = null as { value: number | null; keys: string[] } | null;
        const seen: string[] = [];
        for (let page = 0; page < 5; page++) {
          const query = listKeyset("value", ["id"], order, position, true);
          const row = db
            .prepare(
              "SELECT * FROM rows " +
                (query.where ? "WHERE " + query.where : "") +
                " ORDER BY " +
                query.orderBy +
                " LIMIT 1",
            )
            .get(...query.parameters) as { id: string; value: number | null };
          assert.ok(row);
          seen.push(row.id);
          position = { value: row.value, keys: [row.id] };
        }
        assert.deepEqual(
          seen,
          order === "asc"
            ? ["d", "a", "b", "c", "e"]
            : ["b", "a", "d", "e", "c"],
        );
      }
    } finally {
      db.close();
    }
  });
  it("binds canonical cursor envelopes to resource, keyword, sort and filters", () => {
    const binding = [
      { q: "中文", sortBy: "created_at", sortOrder: "desc" },
      { status: "OPEN" },
    ];
    const position = {
      value: 100,
      keys: ["00000000-0000-4000-8000-000000000001"],
    };
    const cursor = encodeListCursor("orders", binding, position)!;
    assert.deepEqual(
      decodeListCursor(cursor, "orders", binding, "number"),
      position,
    );
    assert.throws(() =>
      decodeListCursor(cursor, "deliveries", binding, "number"),
    );
    assert.throws(() =>
      decodeListCursor(cursor, "orders", [...binding, "changed"], "number"),
    );
    assert.throws(() =>
      decodeListCursor(cursor + "=", "orders", binding, "number"),
    );
  });
});

describe("administrator global list queries", () => {
  it("searches beyond the first page, handles literals and excludes order notes", async () => {
    await withHttpFixture(async (f) => {
      const ids: string[] = [];
      for (let i = 0; i < 9; i++)
        ids.push(
          f.services.orders.create(
            createOrderRequestSchema.parse({
              idempotency_key: "search-" + i,
              merchant_order_no: "merchant-" + i,
              product_name: i < 3 ? "中文😀%_礼物" : "普通项目",
              note: "secret-reason-only",
              amount_cents: 1000 + i * 100,
            }),
          ).order.orderId,
        );
      const auth = await login(f.app);
      const get = (query: string) =>
        f.app.request("/api/admin/v1/orders?" + query, {
          headers: { cookie: auth.cookie },
        });
      const first = (await (await get("limit=2")).json()) as {
        data: Row[];
        page: { next_cursor: string };
      };
      assert.ok(first.data.every((r) => !ids.slice(0, 3).includes(r.order_id)));
      const matched = (await (
        await get("q=" + encodeURIComponent("  中文😀%_  ") + "&limit=2")
      ).json()) as { data: Row[]; page: { next_cursor: string } };
      assert.equal(matched.data.length, 2);
      assert.ok(
        matched.data.every((r) => ids.slice(0, 3).includes(r.order_id)),
      );
      const next = (await (
        await get(
          "q=" +
            encodeURIComponent("中文😀%_") +
            "&limit=2&cursor=" +
            matched.page.next_cursor,
        )
      ).json()) as { data: Row[] };
      assert.equal(next.data.length, 1);
      for (const change of [
        "q=other",
        "q=" + encodeURIComponent("中文😀%_") + "&sort_order=asc",
        "q=" + encodeURIComponent("中文😀%_") + "&payment_status=UNPAID",
      ])
        assert.equal(
          (await get(change + "&cursor=" + matched.page.next_cursor)).status,
          422,
        );
      for (const q of ["%", "_", "😀", "礼物"])
        assert.equal(
          (
            (await (await get("q=" + encodeURIComponent(q))).json()) as {
              data: Row[];
            }
          ).data.length,
          3,
        );
      for (const q of ["secret-reason-only", "' OR 1=1 --"])
        assert.equal(
          (
            (await (await get("q=" + encodeURIComponent(q))).json()) as {
              data: Row[];
            }
          ).data.length,
          0,
        );
      assert.equal(
        (await get("q=" + encodeURIComponent("😀".repeat(100)))).status,
        200,
      );
      assert.equal(
        (await get("q=" + encodeURIComponent("😀".repeat(101)))).status,
        422,
      );
      for (const query of ["sort_by=note", "sort_order=sideways", "q=a&q=b"])
        assert.equal((await get(query)).status, 422);
      const anchor = first.data.at(-1)!;
      const legacy = Buffer.from(
        "perpay:admin-orders:v1\n*\n*\n" +
          Date.parse(anchor.created_at) +
          "\n" +
          anchor.order_id,
      ).toString("base64url");
      assert.equal((await get("cursor=" + legacy)).status, 200);
      assert.equal((await get("q=merchant&cursor=" + legacy)).status, 422);
      assert.equal(
        (await f.app.request("/api/admin/v1/orders?q=merchant")).status,
        401,
      );
    });
  });
  it("orders every global page by a whitelisted field with nulls last and unique ties", async () => {
    await withHttpFixture(async (f) => {
      for (let i = 0; i < 3; i++)
        f.createSettlement("sort-paid-" + i, 1000 + i * 1000);
      for (let i = 0; i < 5; i++)
        f.createOrder("sort-unpaid-" + i, 500 + i * 100);
      const auth = await login(f.app);
      const get = async (query: string) => {
        const r = await f.app.request("/api/admin/v1/orders?" + query, {
          headers: { cookie: auth.cookie },
        });
        assert.equal(r.status, 200);
        return (await r.json()) as {
          data: Row[];
          page: { next_cursor: string | null };
        };
      };
      const all = (await get("limit=200")).data;
      for (const field of ORDER_SORT_FIELDS)
        for (const order of ["asc", "desc"]) {
          const result: Row[] = [];
          let cursor: string | null = null;
          do {
            const page = await get(
              "limit=2&sort_by=" +
                field +
                "&sort_order=" +
                order +
                (cursor ? "&cursor=" + cursor : ""),
            );
            result.push(...page.data);
            cursor = page.page.next_cursor;
            assert.ok(result.length <= all.length);
          } while (cursor);
          const value = (r: Row) =>
            field === "received_amount_cents"
              ? r.payment.received_amount_cents
              : field === "created_at"
                ? r.created_at
                : r.payable_amount_cents;
          const expected = all.toSorted((a, b) =>
            compare(value(a), value(b), a.order_id, b.order_id, order),
          );
          assert.deepEqual(
            result.map((r) => r.order_id),
            expected.map((r) => r.order_id),
          );
        }
    });
  });
  it("searches notification identities, URLs and error codes, with projection-aligned retry sorting", async () => {
    await withHttpFixture(async (f) => {
      const secret = Buffer.alloc(32, 33).toString("base64url");
      f.services.settingsStore.saveWebhook(
        {
          revision: f.services.settings.snapshot().revision,
          enabled: true,
          allowed_origin: "https://query.example.test",
          timeout_milliseconds: 5000,
          maximum_attempts: 3,
          retry_base_seconds: 10,
          retry_maximum_seconds: 60,
          secret,
        },
        {
          actorId: "admin",
          requestId: "query-fixture",
          remoteAddressHash: "0".repeat(64),
        },
      );
      const fingerprint =
        f.services.settings.snapshot().webhook.signingKeyFingerprint!;
      f.webhooks.syncSigningKey({
        secretFingerprint: fingerprint,
        now: Date.now(),
      });
      const orders = Array.from(
        { length: 6 },
        (_, i) =>
          f.createSettlement(
            "notify-sort-" + i,
            2000 + i * 1000,
            "https://query.example.test/endpoint_" + i + "?literal=%25",
          ).order,
      );
      f.webhooks.materialize(20, Date.now());
      for (let i = 0; i < 2; i++) {
        const claim = f.webhooks.claimNext({
          now: Date.now(),
          leaseMilliseconds: 30000,
          maximumAttempts: 3,
        })!;
        f.webhooks.completeAttempt({
          deliveryId: claim.delivery.deliveryId,
          attemptId: claim.attempt.attemptId,
          leaseToken: claim.attempt.leaseToken,
          outcome: i === 0 ? "ACKNOWLEDGED" : "RETRYABLE_FAILURE",
          now: Date.now(),
          maximumAttempts: 3,
          retryBaseMilliseconds: 100000,
          retryMaximumMilliseconds: 100000,
          resolvedAddressesFingerprint: "a".repeat(64),
          connectedAddress: "203.0.113.10",
          httpStatus: i === 0 ? 200 : 503,
          responseBytes: 2,
          responseFingerprint: "b".repeat(64),
          ackCode: i === 0 ? "acknowledged" : null,
          errorCode: i === 0 ? null : "query_timeout",
        });
      }
      const auth = await login(f.app);
      const get = async (q: string) => {
        const r = await f.app.request(
          "/api/admin/v1/webhooks/deliveries?" + q,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(r.status, 200);
        return (await r.json()) as {
          data: Row[];
          page: { next_cursor: string | null };
        };
      };
      const all = (await get("limit=200")).data;
      assert.equal(all.length, 6);
      for (const q of ["query_timeout", "query.example.test"]) {
        const reminders = await f.app.request(
          "/api/admin/v1/work-items?q=" + encodeURIComponent(q),
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(reminders.status, 200);
        assert.equal(
          ((await reminders.json()) as { data: unknown[] }).data.length,
          1,
        );
      }
      for (const q of [
        orders[0]!.orderId,
        orders[0]!.merchantOrderNo,
        "endpoint_0",
        "query_timeout",
      ]) {
        const page = await get("q=" + encodeURIComponent(q));
        assert.equal(page.data.length, 1);
      }
      for (const field of DELIVERY_SORT_FIELDS)
        for (const order of ["asc", "desc"]) {
          const result: Row[] = [];
          let cursor: string | null = null;
          do {
            const page = await get(
              "limit=2&sort_by=" +
                field +
                "&sort_order=" +
                order +
                (cursor ? "&cursor=" + cursor : ""),
            );
            result.push(...page.data);
            cursor = page.page.next_cursor;
            assert.ok(result.length <= 6);
          } while (cursor);
          assert.deepEqual(
            result.map((r) => r.delivery_id),
            all
              .toSorted((a, b) =>
                compare(
                  a[field],
                  b[field],
                  a.delivery_id,
                  b.delivery_id,
                  order,
                ),
              )
              .map((r) => r.delivery_id),
          );
        }
      const first = await get("limit=1");
      const row = first.data[0]!;
      const legacy = Buffer.from(
        "perpay:webhook-deliveries:v1\n*\n" +
          Date.parse(row.created_at) +
          "\n" +
          row.delivery_id,
      ).toString("base64url");
      assert.equal((await get("cursor=" + legacy)).data.length, 5);
      for (const query of [
        "q=endpoint_",
        "sort_order=desc",
        "status=PENDING",
      ]) {
        const r = await f.app.request(
          "/api/admin/v1/webhooks/deliveries?" +
            query +
            "&cursor=" +
            first.page.next_cursor,
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(r.status, 422);
      }
    });
  });
});
