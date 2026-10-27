import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it } from "node:test";
import { readManualCandidates, type ManualCandidateKind, type ManualCandidateQuery } from "../src/reconciliation/manual-candidates.ts";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

describe("manual candidate window query", () => {
  for (const scenario of [
    { name: "before the slot window", occupied: 1100, released: 1800, occurred: 900, precision: 100, overlap: false, distance: 100 },
    { name: "precision ending at the window start", occupied: 1100, released: 1800, occurred: 1000, precision: 100, overlap: false, distance: 0 },
    { name: "precision spanning the window start", occupied: 1100, released: 1800, occurred: 1050, precision: 100, overlap: true, distance: 0 },
    { name: "at the window start", occupied: 1100, released: 1800, occurred: 1100, precision: 1, overlap: true, distance: 0 },
    { name: "just before the window end", occupied: 1100, released: 1800, occurred: 1799, precision: 1, overlap: true, distance: 0 },
    { name: "at the window end", occupied: 1100, released: 1800, occurred: 1800, precision: 100, overlap: false, distance: 0 },
    { name: "after the slot window", occupied: 1100, released: 1800, occurred: 1900, precision: 1, overlap: false, distance: 100 },
    { name: "without a slot", occupied: undefined, released: null, occurred: 1500, precision: 100, overlap: false, distance: 600 },
    { name: "an empty slot interval", occupied: 1800, released: 1800, occurred: 1500, precision: 100, overlap: false, distance: 600 },
    { name: "a slot outside the order interval", occupied: 2100, released: 2200, occurred: 1500, precision: 100, overlap: false, distance: 600 },
    { name: "an unreleased slot", occupied: 1100, released: null, occurred: 1900, precision: 100, overlap: true, distance: 0 },
    { name: "expiry ending an unreleased slot", occupied: 1100, released: null, occurred: 2000, precision: 100, overlap: false, distance: 0 },
    { name: "eligibility clipping the slot start", occupied: 800, released: 2200, occurred: 900, precision: 100, overlap: false, distance: 0 },
    { name: "expiry clipping the slot end", occupied: 800, released: 2200, occurred: 2050, precision: 100, overlap: false, distance: 50 },
  ]) {
    it(`preserves both recommendation directions for ${scenario.name}`, () => {
      withProjection((db) => {
        order(db, 1);
        if (scenario.occupied !== undefined) slot(db, 1, scenario.occupied, scenario.released);
        ledger(db, 101, scenario.occurred, scenario.precision);
        for (const kind of ["orders", "ledger-entries"] as const) {
          for (const view of ["recommended", "all"] as const) {
            const result = readManualCandidates(db, kind, { contextId: id(kind === "orders" ? 101 : 1), q: "", view, limit: 1, position: null });
            assert.deepEqual(result, {
              selections: [{ id: id(kind === "orders" ? 1 : 101), recommendation: { amountMatch: true, timeWindowOverlap: scenario.overlap, timeDistanceMilliseconds: scenario.distance } }],
              nextPosition: null,
            });
          }
        }
      });
    });
  }

  it("keeps equal sort values stable across both views and directions", () => {
    withProjection((db) => {
      for (const value of [1, 2, 3]) { order(db, value); slot(db, value, 1100, 1800); }
      for (const value of [101, 102, 103]) ledger(db, value, 1500, 100);
      for (const kind of ["orders", "ledger-entries"] as const) {
        for (const view of ["recommended", "all"] as const) {
          const query = { contextId: id(kind === "orders" ? 101 : 1), q: "", view, limit: 1, position: null };
          assert.deepEqual(pageIds(db, kind, query), (kind === "orders" ? [3, 2, 1] : [103, 102, 101]).map(id));
        }
      }
      const all = readManualCandidates(db, "orders", { contextId: null, q: "", view: "all", limit: 10, position: null });
      assert.deepEqual(all?.selections, [3, 2, 1].map((value) => ({ id: id(value), recommendation: null })));
    });
  });

  it("filters foreign-site and conflicting ledger evidence before pagination", () => {
    withProjection((db) => {
      order(db, 1, "site_a"); order(db, 2, "site_b"); slot(db, 1, 1100, 1800);
      for (const value of [101, 102, 103, 104]) ledger(db, value, 1500, 100);
      db.prepare("INSERT INTO match_candidates VALUES (?, ?)").run(id(102), id(2));
      db.prepare("INSERT INTO ledger_conflicts VALUES (?, 'OPEN')").run(id(103));
      for (const view of ["recommended", "all"] as const) {
        const query = { contextId: id(1), q: "", view, limit: 1, position: null, siteClientId: "site_a" };
        assert.deepEqual(pageIds(db, "ledger-entries", query), [104, 101].map(id));
      }
    });
  });

  it("uses one covering slot lookup per paired candidate query including cursor pages", () => {
    withProjection((db) => {
      for (const value of [1, 2, 3]) { order(db, value); slot(db, value, 1100, 1800); }
      for (const value of [101, 102, 103]) ledger(db, value, 1500, 100);
      for (const kind of ["orders", "ledger-entries"] as const) {
        for (const view of ["recommended", "all"] as const) {
          const plans: string[][] = [];
          const reader = {
            prepare(sql: string) {
              const statement = db.prepare(sql);
              return {
                get: (...parameters: SQLInputValue[]) => statement.get(...parameters),
                all: (...parameters: SQLInputValue[]) => {
                  const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...parameters) as { detail: string }[];
                  plans.push(plan.map((step) => step.detail));
                  return statement.all(...parameters);
                },
              };
            },
          } as unknown as DatabaseSync;
          const query = { contextId: id(kind === "orders" ? 101 : 1), q: "", view, limit: 1, position: null };
          assert.equal(pageIds(reader, kind, query).length, 3);
          assert.equal(plans.length, 3);
          for (const plan of plans) {
            const slots = plan.filter((detail) => /\b(?:SCAN|SEARCH) s\b/.test(detail));
            assert.equal(slots.length, 1, `${kind} ${view}: ${plan.join("\n")}`);
            assert.match(slots[0]!, /COVERING INDEX amount_slots_order_interval_idx/);
          }
        }
      }
    });
  });
});

function pageIds(db: DatabaseSync, kind: ManualCandidateKind, query: ManualCandidateQuery): string[] {
  const ids: string[] = [];
  let position: ManualCandidateQuery["position"] = null;
  do {
    const page = readManualCandidates(db, kind, { ...query, position });
    assert.ok(page);
    ids.push(...page.selections.map((item) => item.id));
    assert.ok(ids.length <= 10, "cursor did not advance");
    position = page.nextPosition;
  } while (position);
  return ids;
}

function withProjection(operation: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  try {
    // The read fixture keeps the production UNIQUE(order_id) and covering slot index.
    // HTTP tests separately verify candidate discovery against the complete application schema.
    db.exec(`
      CREATE TABLE payment_orders (order_id TEXT PRIMARY KEY, api_client_id TEXT, collection_profile_id TEXT,
        currency TEXT, payment_status TEXT, payment_basis TEXT, payable_amount_cents INTEGER,
        created_at INTEGER, eligible_from INTEGER, expires_at INTEGER, merchant_order_no TEXT, product_name TEXT);
      CREATE TABLE amount_slots (order_id TEXT NOT NULL UNIQUE, occupied_from INTEGER NOT NULL, released_at INTEGER);
      CREATE INDEX amount_slots_order_interval_idx ON amount_slots(order_id, occupied_from, released_at);
      CREATE TABLE ledger_entries (ledger_entry_id TEXT PRIMARY KEY, direction TEXT, currency TEXT, state TEXT,
        amount_cents INTEGER, provider_account_key TEXT, occurred_at INTEGER, occurred_at_precision_ms INTEGER,
        external_event_id TEXT, alipay_order_no TEXT, merchant_order_no TEXT, other_account TEXT);
      CREATE TABLE collection_profile_provider_accounts (profile_id TEXT, provider_account_key TEXT);
      INSERT INTO collection_profile_provider_accounts VALUES ('profile', 'provider');
      CREATE TABLE payment_matches (ledger_entry_id TEXT, order_id TEXT, status TEXT);
      CREATE TABLE match_candidates (ledger_entry_id TEXT, order_id TEXT);
      CREATE TABLE financial_exceptions (ledger_entry_id TEXT, order_id TEXT);
      CREATE TABLE ledger_conflicts (existing_ledger_entry_id TEXT, status TEXT);
    `);
    operation(db);
  } finally { db.close(); }
}

function order(db: DatabaseSync, value: number, site = "site_a"): void {
  db.prepare("INSERT INTO payment_orders VALUES (?, ?, 'profile', 'CNY', 'UNPAID', 'NONE', 10001, 900, 1000, 2000, ?, 'candidate')").run(id(value), site, id(value));
}
function slot(db: DatabaseSync, value: number, occupied: number, released: number | null): void {
  db.prepare("INSERT INTO amount_slots VALUES (?, ?, ?)").run(id(value), occupied, released);
}
function ledger(db: DatabaseSync, value: number, occurred: number, precision: number): void {
  db.prepare("INSERT INTO ledger_entries VALUES (?, 'CREDIT', 'CNY', 'UNALLOCATED', 10001, 'provider', ?, ?, '', '', '', '')").run(id(value), occurred, precision);
}
