import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  withHttpFixture,
  login,
  financialHeaders,
  type ReconciliationHttpFixture,
} from "./reconciliation-http-fixture.ts";

type Page = {
  data: Array<Record<string, any>>;
  page: { next_cursor: string | null };
};
async function client(f: ReconciliationHttpFixture) {
  const auth = await login(f.app);
  return {
    auth,
    request: (path: string) =>
      f.app.request("/api/admin/v1/" + path, {
        headers: { cookie: auth.cookie },
      }),
    async page(path: string): Promise<Page> {
      const response = await f.app.request("/api/admin/v1/" + path, {
        headers: { cookie: auth.cookie },
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as Page;
    },
    async all(path: string): Promise<Array<Record<string, any>>> {
      const rows: Array<Record<string, any>> = [];
      let cursor: string | null = null;
      do {
        const response = await f.app.request(
          "/api/admin/v1/" +
            path +
            "&limit=2" +
            (cursor ? "&cursor=" + cursor : ""),
          { headers: { cookie: auth.cookie } },
        );
        assert.equal(response.status, 200, await response.clone().text());
        const page = (await response.json()) as Page;
        rows.push(...page.data);
        cursor = page.page.next_cursor;
        assert.ok(rows.length < 100);
      } while (cursor);
      return rows;
    },
  };
}
function compare(
  a: any,
  b: any,
  key: string,
  order: string,
  value: (row: any) => string | number | null,
) {
  const av = value(a),
    bv = value(b);
  if (av === null && bv !== null) return 1;
  if (bv === null && av !== null) return -1;
  const cmp =
    av === bv
      ? a[key] < b[key]
        ? -1
        : a[key] > b[key]
          ? 1
          : 0
      : av! < bv!
        ? -1
        : 1;
  return order === "asc" ? cmp : -cmp;
}
function exception(f: ReconciliationHttpFixture, key: string, amount: number) {
  const entry = f.recordCredit(key, amount, 0);
  f.reconciliation.reconcileEntry(entry.ledgerEntryId);
  return entry;
}

describe("reconciliation and reminder global queries", () => {
  it("searches/sorts complete match history and still accepts only correctly scoped legacy cursors", async () => {
    await withHttpFixture(async (f) => {
      const payments = Array.from({ length: 5 }, (_, i) =>
        f.createSettlement("match-search-" + i, 1000 + i * 1000),
      );
      const c = await client(f);
      const all = (await c.page("reconciliation/matches?limit=200")).data;
      for (const q of [
        payments[0]!.order.orderId,
        payments[0]!.order.merchantOrderNo,
        payments[0]!.entry.ledgerEntryId,
        payments[0]!.entry.externalEventId,
        all[0]!.payment_match_id,
      ])
        assert.equal(
          (await c.page("reconciliation/matches?q=" + encodeURIComponent(q)))
            .data.length,
          1,
        );
      for (const field of ["event_sequence", "created_at", "amount_cents"])
        for (const order of ["asc", "desc"]) {
          const rows = await c.all(
            "reconciliation/matches?sort_by=" + field + "&sort_order=" + order,
          );
          const expected =
            field === "event_sequence"
              ? order === "asc"
                ? all
                : [...all].reverse()
              : all.toSorted((a, b) =>
                  compare(a, b, "payment_match_id", order, (r) =>
                    field === "created_at"
                      ? r.created_at
                      : r.ledger_entry.amount_cents,
                  ),
                );
          assert.deepEqual(
            rows.map((r) => r.payment_match_id),
            expected.map((r) => r.payment_match_id),
          );
        }
      const first = await c.page("reconciliation/matches?limit=1");
      const sequence = f.database.read(
        (db) =>
          (
            db
              .prepare(
                "SELECT event_sequence FROM payment_match_events WHERE payment_match_id = ? AND status='SETTLED'",
              )
              .get(first.data[0]!.payment_match_id) as {
              event_sequence: number;
            }
          ).event_sequence,
      );
      const legacy = Buffer.from(
        "perpay:payment-match-history:v1\nSETTLED\n" + sequence,
      ).toString("base64url");
      assert.equal(
        (await c.page("reconciliation/matches?cursor=" + legacy)).data.length,
        4,
      );
      for (const suffix of [
        "q=match-search",
        "status=REVERSED",
        "sort_order=desc",
      ]) {
        assert.equal(
          (
            await c.request(
              "reconciliation/matches?" +
                suffix +
                "&cursor=" +
                first.page.next_cursor,
            )
          ).status,
          422,
        );
        assert.equal(
          (
            await c.request(
              "reconciliation/matches?" + suffix + "&cursor=" + legacy,
            )
          ).status,
          422,
        );
      }
    });
  });
  it("keeps conflict and exception searches provider-scoped and puts null external IDs last", async () => {
    await withHttpFixture(async (f) => {
      for (let i = 0; i < 4; i++) exception(f, "待核查%_" + i, 30000 + i * 100);
      for (let i = 0; i < 3; i++) {
        const key = "冲突_%_" + i;
        f.recordCredit(key, 60000 + i * 100, 0);
        assert.throws(
          () => f.recordCredit(key, 60050 + i * 100, 0),
          /expected a created ledger entry/,
        );
      }
      const c = await client(f);
      for (const resource of [
        "ledger/conflicts",
        "reconciliation/exceptions",
      ]) {
        const all = (await c.page(resource + "?limit=200")).data;
        assert.ok(all.length >= 3);
        const key = resource.includes("conflicts")
          ? "conflict_id"
          : "exception_id";
        assert.equal(
          (await c.page(resource + "?q=" + all[0]![key])).data.length,
          1,
        );
        assert.equal(
          (
            await c.page(
              resource +
                "?provider_account_key=another-account&q=" +
                all[0]![key],
            )
          ).data.length,
          0,
        );
        const first = await c.page(resource + "?limit=1");
        for (const change of [
          "q=changed",
          "sort_order=desc",
          "provider_account_key=another-account",
        ])
          assert.equal(
            (
              await c.request(
                resource + "?" + change + "&cursor=" + first.page.next_cursor,
              )
            ).status,
            422,
          );
        for (const direction of ["asc", "desc"]) {
          const rows = await c.all(
            resource + "?sort_by=created_at&sort_order=" + direction,
          );
          assert.deepEqual(
            rows.map((r) => r[key]),
            all
              .toSorted((a, b) =>
                compare(a, b, key, direction, (r) => r.created_at),
              )
              .map((r) => r[key]),
          );
        }
        const account =
          f.services.settings.snapshot().activeProviderAccountKey!;
        const legacy = Buffer.from(
          resource.includes("conflicts")
            ? "perpay:ledger-conflicts:v2\n" +
                account +
                "\nOPEN\n" +
                Date.parse(first.data[0]!.created_at) +
                "\n" +
                first.data[0]![key]
            : "perpay:financial-exceptions:v2\n" +
                account +
                "\n" +
                Date.parse(first.data[0]!.created_at) +
                "\n" +
                first.data[0]![key],
        ).toString("base64url");
        assert.equal(
          (await c.request(resource + "?cursor=" + legacy)).status,
          200,
        );
        assert.equal(
          (await c.request(resource + "?q=x&cursor=" + legacy)).status,
          422,
        );
      }
      const conflicts = (await c.page("ledger/conflicts?limit=200")).data;
      for (const direction of ["asc", "desc"]) {
        const rows = await c.all(
          "ledger/conflicts?sort_by=external_event_id&sort_order=" + direction,
        );
        assert.deepEqual(
          rows.map((r) => r.conflict_id),
          conflicts
            .toSorted((a, b) =>
              compare(
                a,
                b,
                "conflict_id",
                direction,
                (r) => r.external_event_id,
              ),
            )
            .map((r) => r.conflict_id),
        );
      }
      const literal = (
        await c.page("ledger/conflicts?q=" + encodeURIComponent("冲突_%_"))
      ).data;
      assert.equal(literal.length, 3);
    });
  });
  it("freezes batch membership across pages, normalizes keywords and rejects changed-scope retries", async () => {
    await withHttpFixture(async (f) => {
      for (let i = 0; i < 5; i++)
        exception(f, "范围中文%_" + i, 70000 + i * 100);
      exception(f, "不可忽略的其他事项", 80000);
      const c = await client(f);
      const q = encodeURIComponent("范围中文%_");
      const plan = f.database.read((db) =>
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT 1 FROM webhook_deliveries WHERE predecessor_delivery_id = ?",
          )
          .all(randomUUID()),
      );
      assert.ok(
        plan.some((row) => String(row.detail).includes("webhook_deliveries_predecessor_list_idx")),
      );
      const first = await c.page("work-items?q=" + q + "&limit=2");
      assert.equal(first.data.length, 2);
      assert.ok(first.page.next_cursor);
      const hits = await c.all(
        "work-items?q=" + q + "&sort_by=created_at&sort_order=asc",
      );
      assert.equal(hits.length, 5);
      assert.equal(
        (await c.request("work-items?sort_by=ignored_at")).status,
        422,
      );
      assert.equal(
        (
          await c.request(
            "work-items?q=" +
              q +
              "&sort_order=asc&cursor=" +
              first.page.next_cursor,
          )
        ).status,
        422,
      );
      const before = f.database.read((db) =>
        db
          .prepare("SELECT * FROM financial_exceptions ORDER BY exception_id")
          .all(),
      );
      const id = randomUUID();
      const body = {
        operation_id: id,
        type: "FINANCIAL_EXCEPTION",
        q: "  范围中文%_  ",
      };
      const ignore = (body: unknown) =>
        f.app.request("/api/admin/v1/work-items/actions/ignore-all", {
          method: "POST",
          headers: financialHeaders(c.auth),
          body: JSON.stringify(body),
        });
      const initial = await ignore(body);
      assert.equal(initial.status, 200);
      const receipt = (await initial.json()) as {
        data: { ignored_count: number; q: string };
      };
      assert.equal(receipt.data.ignored_count, 5);
      assert.equal(receipt.data.q, "范围中文%_");
      assert.deepEqual(
        f.database.read((db) =>
          db
            .prepare("SELECT * FROM financial_exceptions ORDER BY exception_id")
            .all(),
        ),
        before,
      );
      exception(f, "范围中文%_新增", 81000);
      const retry = await ignore({ ...body, q: "范围中文%_" });
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), receipt);
      assert.equal((await ignore({ ...body, q: "其他" })).status, 409);
      assert.equal((await c.page("work-items?q=" + q)).data.length, 1);
      assert.equal(
        (await c.page("work-items?q=" + encodeURIComponent("不可忽略"))).data
          .length,
        1,
      );
      const ignored = await c.all(
        "work-items?visibility=IGNORED&q=" +
          q +
          "&sort_by=ignored_at&sort_order=asc",
      );
      assert.equal(ignored.length, 5);
      const ignoredFirst = await c.page(
        "work-items?visibility=IGNORED&q=" + q + "&limit=1",
      );
      assert.equal(
        (
          await c.request(
            "work-items?visibility=ACTIVE&q=" +
              q +
              "&cursor=" +
              ignoredFirst.page.next_cursor,
          )
        ).status,
        422,
      );
      assert.equal(
        f.database.read((db) =>
          Number(
            (
              db
                .prepare(
                  "SELECT COUNT(*) n FROM admin_work_item_operations WHERE operation_id=?",
                )
                .get(id) as { n: number }
            ).n,
          ),
        ),
        5,
      );
      const noKeyword = { operation_id: randomUUID(), type: "ALL" };
      const noKeywordReceipt = await (await ignore(noKeyword)).json();
      assert.deepEqual(
        await (await ignore({ ...noKeyword, q: "   " })).json(),
        noKeywordReceipt,
      );
      assert.equal(
        (
          await ignore({
            operation_id: randomUUID(),
            type: "ALL",
            q: "😀".repeat(101),
          })
        ).status,
        422,
      );
    });
  });
});
