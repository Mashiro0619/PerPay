import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createdDateRange,
  createdDatePreset,
  beijingDate,
} from "../src/shared/created-dates.ts";
import { csvCell, exportOrders } from "../src/http/order-export.ts";
import type { AppDatabase } from "../src/database/database.ts";
import {
  withHttpFixture,
  login,
  PUBLIC_ORIGIN,
} from "./reconciliation-http-fixture.ts";

describe("creation dates and order CSV", () => {
  it("uses inclusive Beijing days and validates real calendar dates and pairs", () => {
    assert.deepEqual(createdDateRange("2024-02-29", "2024-03-01"), {
      start: Date.parse("2024-02-28T16:00:00Z"),
      end: Date.parse("2024-03-01T16:00:00Z"),
      days: 2,
    });
    assert.equal(createdDateRange(), null);
    for (const [a, b] of [
      ["2025-02-29", "2025-03-01"],
      ["2026-04-31", "2026-05-01"],
      ["2026-01-02", "2026-01-01"],
      ["", ""],
      ["2026-01-01", undefined],
      [undefined, "2026-01-01"],
      ["2026-1-01", "2026-01-01"],
    ])
      assert.throws(() => createdDateRange(a, b));
    const now = Date.parse("2026-09-30T16:00:00Z");
    assert.equal(beijingDate(now), "2026-10-01");
    assert.deepEqual(createdDatePreset(7, false, now), {
      from: "2026-09-25",
      to: "2026-10-01",
    });
    assert.deepEqual(createdDatePreset(1, true, now), {
      from: "2026-09-30",
      to: "2026-09-30",
    });
  });
  it("filters both lists by creation dates and rejects cursors from a different range", async () => {
    await withHttpFixture(async (f) => {
      f.createOrder("date-a", 1900);
      f.createOrder("date-b", 2900);
      const auth = await login(f.app),
        headers = { cookie: auth.cookie };
      const today = beijingDate(f.baseTime),
        tomorrow = beijingDate(f.baseTime + 86400000);
      for (const resource of ["orders", "webhooks/deliveries"]) {
        for (const query of [
          "created_from=" + today,
          "created_from=2026-02-30&created_to=2026-03-01",
          "created_from=" +
            today +
            "&created_to=" +
            today +
            "&created_from=" +
            today,
        ])
          assert.equal(
            (
              await f.app.request("/api/admin/v1/" + resource + "?" + query, {
                headers,
              })
            ).status,
            422,
          );
        const empty = await f.app.request(
          "/api/admin/v1/" +
            resource +
            "?created_from=" +
            tomorrow +
            "&created_to=" +
            tomorrow,
          { headers },
        );
        assert.equal(empty.status, 200);
        assert.deepEqual(
          ((await empty.json()) as { data: unknown[] }).data,
          [],
        );
      }
      const page = await f.app.request("/api/admin/v1/orders?limit=1", {
        headers,
      });
      const cursor = ((await page.json()) as { page: { next_cursor: string } })
        .page.next_cursor;
      assert.equal(
        (
          await f.app.request(
            "/api/admin/v1/orders?limit=1&cursor=" +
              cursor +
              "&created_from=" +
              today +
              "&created_to=" +
              today,
            { headers },
          )
        ).status,
        422,
      );
      const dated = await f.app.request(
        "/api/admin/v1/orders?limit=1&created_from=" +
          today +
          "&created_to=" +
          today,
        { headers },
      );
      const body = (await dated.json()) as {
        data: unknown[];
        page: { next_cursor: string };
      };
      assert.equal(body.data.length, 1);
      assert.ok(body.page.next_cursor);
      assert.equal(
        (
          await f.app.request(
            "/api/admin/v1/orders?cursor=" + body.page.next_cursor,
            { headers },
          )
        ).status,
        422,
      );
      const next = await f.app.request(
        "/api/admin/v1/orders?cursor=" +
          body.page.next_cursor +
          "&created_from=" +
          today +
          "&created_to=" +
          today,
        { headers },
      );
      assert.equal(((await next.json()) as { data: unknown[] }).data.length, 1);
    });
  });
  it("requires auth, same origin and CSRF, returns BOM CSV and never changes financial records", async () => {
    await withHttpFixture(async (f) => {
      f.createOrder("csv-unpaid", 1999);
      const paid = f.createSettlement("csv-paid", 3001).order;
      const date = beijingDate(f.baseTime),
        body = JSON.stringify({
          created_from: date,
          created_to: date,
          q: "csv-",
          sort_by: "payable_amount_cents",
          sort_order: "asc",
        });
      const auth = await login(f.app),
        headers = {
          cookie: auth.cookie,
          Origin: PUBLIC_ORIGIN,
          "Content-Type": "application/json",
          "X-CSRF-Token": auth.csrfToken,
        };
      const request = (h: Record<string, string>, b = body) =>
        f.app.request(PUBLIC_ORIGIN + "/api/admin/v1/orders/export", {
          method: "POST",
          headers: h,
          body: b,
        });
      assert.equal((await request({})).status, 401);
      assert.equal(
        (await request({ ...headers, "X-CSRF-Token": "bad" })).status,
        403,
      );
      assert.equal(
        (await request({ ...headers, Origin: "https://other.example.com" }))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            headers,
            '{"created_from":"2020-01-01","created_to":"2021-01-01"}',
          )
        ).status,
        422,
      );
      assert.equal((await request(headers, "{}")).status, 422);
      const before = f.database.read((db) => [
        db.prepare("SELECT * FROM payment_orders").all(),
        db.prepare("SELECT * FROM order_events").all(),
      ]);
      const response = await request(headers);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /^text\/csv/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
      const csv = bytes.toString("utf8");
      assert.match(csv, /付款确认时间/);
      assert.match(csv, /19\.99/);
      assert.match(csv, /30\.01/);
      assert.ok(csv.includes(paid.orderId));
      assert.ok(!csv.includes(paid.checkoutToken));
      assert.deepEqual(
        f.database.read((db) => [
          db.prepare("SELECT * FROM payment_orders").all(),
          db.prepare("SELECT * FROM order_events").all(),
        ]),
        before,
      );
    });
  });
  it("rechecks the administrator after the request body finishes", async () => {
    await withHttpFixture(async (f) => {
      const auth = await login(f.app);
      const token = auth.cookie.match(/(?:^|; )perpay_session=([^;]+)/)![1]!;
      let complete!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"created_from":"2026-10-01",'),
          );
          complete = () => {
            controller.enqueue(
              new TextEncoder().encode('"created_to":"2026-10-01"}'),
            );
            controller.close();
          };
        },
      });
      const request = new Request(
        PUBLIC_ORIGIN + "/api/admin/v1/orders/export",
        {
          method: "POST",
          headers: {
            cookie: auth.cookie,
            Origin: PUBLIC_ORIGIN,
            "Content-Type": "application/json",
            "X-CSRF-Token": auth.csrfToken,
          },
          body,
          duplex: "half",
        } as RequestInit,
      );
      const response = f.app.request(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      f.services.identity.logout(f.services.identity.authenticate(token)!);
      complete();
      assert.equal((await response).status, 401);
    });
  });
  it("quotes formulas/newlines, retains historical confirmation on disputes, distinguishes null/zero, and refuses over 10000", () => {
    for (const text of ["=1+1", " +1", "-1", "@SUM(A1)", "\t1", "\r1", "\n1"])
      assert.ok(csvCell(text).startsWith(String.fromCharCode(34, 39)));
    assert.equal(csvCell('two,"quoted"\nlines'), '"two,""quoted""\nlines"');
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE payment_orders (order_id TEXT PRIMARY KEY,merchant_order_no TEXT,product_name TEXT,requested_amount_cents INTEGER,payable_amount_cents INTEGER,received_amount_cents INTEGER,currency TEXT,payment_status TEXT,checkout_status TEXT,created_at INTEGER,expires_at INTEGER); CREATE TABLE order_events(order_id TEXT,event_type TEXT,occurred_at INTEGER)",
      );
      const day = Date.parse("2026-09-30T16:00:00Z");
      const insert = db.prepare(
        "INSERT INTO payment_orders VALUES(?,?,?,1999,2001,?,'CNY',?,'OPEN',?,?)",
      );
      insert.run(
        "a",
        "=formula",
        '商品,"A"\n测试',
        null,
        "UNPAID",
        day,
        day + 60000,
      );
      insert.run("b", "zero", "zero", 0, "DISPUTED", day + 1, day + 60000);
      db.prepare(
        "INSERT INTO order_events VALUES('b','PAYMENT_CONFIRMED',?)",
      ).run(day + 86400000);
      db.prepare(
        "INSERT INTO order_events VALUES('b','PAYMENT_CONFIRMED',?)",
      ).run(day + 86401000);
      insert.run(
        "outside",
        "outside",
        "outside",
        null,
        "UNPAID",
        day + 86400000,
        day + 86460000,
      );
      const owner = {
        read: <T>(operation: (connection: DatabaseSync) => T) => operation(db),
      } as AppDatabase;
      const input = { created_from: "2026-10-01", created_to: "2026-10-01" };
      const csv = exportOrders(owner, input, day + 70000);
      assert.ok(csv.includes("'="));
      assert.ok(csv.includes('"19.99","20.01",""'));
      assert.ok(csv.includes('"0.00","CNY","需核对","已过期"'));
      assert.ok(csv.includes("2026-10-02 00:00:01"));
      assert.ok(!csv.includes("outside"));
      assert.equal(
        db
          .prepare(
            "SELECT checkout_status FROM payment_orders WHERE order_id='a'",
          )
          .get()?.checkout_status,
        "OPEN",
      );
      db.exec("BEGIN");
      for (let n = 2; n < 10001; n++)
        insert.run(
          String(n),
          String(n),
          "bulk",
          null,
          "UNPAID",
          day,
          day + 60000,
        );
      db.exec("COMMIT");
      assert.throws(() => exportOrders(owner, input, day), /10,000/);
      assert.ok(
        exportOrders(owner, { ...input, q: "商品" }, day).includes("商品"),
      );
    } finally {
      db.close();
    }
  });
});
