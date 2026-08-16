import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { OrderStore, type StoredOrderAggregate } from "../src/database/order-store.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import {
  ReconciliationStore,
} from "../src/reconciliation/index.ts";
import {
  financialExceptionResolutionFingerprint,
  financialOperationEvidence,
  financialOperationFingerprint,
  type FinancialOperationFingerprintInput,
} from "../src/reconciliation/model.ts";
import {
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
} from "../src/orders/model.ts";
import {
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
} from "../src/orders/service.ts";

const API_CLIENT_ID = "default";
const BASE_TIME = 2_000_000_000_000;
const EVENT_TIME = BASE_TIME + 60_000;
const WINDOW = {
  start: formatProviderTimestamp(BASE_TIME),
  end: formatProviderTimestamp(BASE_TIME + 60 * 60 * 1_000),
} as const;
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;

describe("automatic reconciliation settlement", () => {
  it("settles one safe amount match atomically and emits one notification", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "automatic", 999);
      const entry = recordCredit("automatic-entry", order.order.payableAmountCents, EVENT_TIME);

      const result = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 120_000);
      assert.equal(result.kind, "auto_settled");
      if (result.kind !== "auto_settled") throw new Error("expected automatic settlement");

      const stored = orders.orderById(API_CLIENT_ID, order.order.orderId);
      assert.equal(stored?.order.paymentStatus, "CONFIRMED");
      assert.equal(stored?.order.paymentBasis, "INFERRED");
      assert.equal(stored?.order.receivedAmountCents, order.order.payableAmountCents);
      assert.equal(reconciliation.ledgerEntry(entry.ledgerEntryId)?.state, "ALLOCATED");
      assert.equal(reconciliation.candidate(result.candidateId)?.status, "SELECTED");
      assert.equal(reconciliation.paymentMatch(result.paymentMatchId)?.status, "SETTLED");

      database.read((connection) => {
        assert.equal(readCountWhere(connection, "financial_operations", "operation_type = 'AUTO_SETTLEMENT'"), 1);
        assert.equal(readCountWhere(connection, "financial_operations", "actor_type = 'SYSTEM'"), 1);
        assert.equal(readCount(connection, "ledger_transactions"), 1);
        assert.equal(readCount(connection, "ledger_postings"), 2);
        assert.equal(readCountWhere(connection, "outbox_events", "event_type = 'PAYMENT_CONFIRMED'"), 1);
        assert.deepEqual(readOrderEventTypes(connection, order.order.orderId), ["CREATED", "PAYMENT_CONFIRMED"]);
        const payload = readText(connection, "SELECT payload_json FROM outbox_events LIMIT 1");
        assert.match(payload, /\"payment_basis\":\"INFERRED\"/);
        assert.match(payload, /\"evidence_type\":\"AMOUNT_INFERRED\"/);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("is idempotent across repeated scans and concurrent callers", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "idempotent", 1_999);
      const entry = recordCredit("idempotent-entry", order.order.payableAmountCents, EVENT_TIME);
      const first = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 120_000);
      assert.equal(first.kind, "auto_settled");
      if (first.kind !== "auto_settled") throw new Error("expected automatic settlement");

      const second = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 121_000);
      assert.deepEqual(second, {
        kind: "allocated",
        ledgerEntryId: entry.ledgerEntryId,
        paymentMatchId: first.paymentMatchId,
      });
      const concurrent = await Promise.all([
        Promise.resolve().then(() => reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 122_000)),
        Promise.resolve().then(() => reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 122_000)),
      ]);
      assert.deepEqual(concurrent, [second, second]);
      database.read((connection) => {
        assert.equal(readCount(connection, "financial_operations"), 1);
        assert.equal(readCount(connection, "payment_matches"), 1);
        assert.equal(readCount(connection, "outbox_events"), 1);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("settles a previously persisted credit when the matching order becomes available and survives restart", async () => {
    await withStores(async ({ database, databasePath, orders, reconciliation, recordCredit, setNow }) => {
      const entry = recordCredit("order-compensation-entry", 1_500, BASE_TIME);
      setNow(BASE_TIME + 500);
      const order = createOrder(orders, "order-compensation", 1_499);
      assert.deepEqual({
        amountCents: entry.amountCents,
        occurredAt: entry.occurredAt,
        precisionMilliseconds: entry.occurredAtPrecisionMilliseconds,
        state: entry.state,
        payableAmountCents: order.order.payableAmountCents,
        eligibleFrom: order.order.eligibleFrom,
      }, {
        amountCents: 1_500,
        occurredAt: BASE_TIME,
        precisionMilliseconds: 1_000,
        state: "UNALLOCATED",
        payableAmountCents: 1_500,
        eligibleFrom: BASE_TIME + 500,
      });

      const batch = reconciliation.reconcileOrder(
        order.order.orderId,
        10,
        BASE_TIME + 2_000,
      );
      assert.equal(batch.processed, 1);
      assert.equal(batch.hasMore, false);
      assert.equal(batch.results[0]?.kind, "auto_settled");
      const result = batch.results[0];
      if (!result || result.kind !== "auto_settled") {
        throw new Error("expected compensated automatic settlement");
      }

      database.close();
      const reopened = await AppDatabase.open(databasePath);
      try {
        const reopenedOrders = new OrderStore(reopened, () => BASE_TIME + 2_000);
        const reopenedReconciliation = new ReconciliationStore(reopened);
        const stored = reopenedOrders.orderById(API_CLIENT_ID, order.order.orderId);
        assert.equal(stored?.order.paymentStatus, "CONFIRMED");
        assert.equal(stored?.order.paymentBasis, "INFERRED");
        assert.equal(stored?.order.receivedAmountCents, 1_500);
        assert.equal(reopenedReconciliation.ledgerEntry(entry.ledgerEntryId)?.state, "ALLOCATED");
        assert.equal(reopenedReconciliation.candidate(result.candidateId)?.status, "SELECTED");
        assert.equal(reopenedReconciliation.paymentMatch(result.paymentMatchId)?.status, "SETTLED");
        reopened.read((connection) => {
          assert.equal(readCountWhere(connection, "financial_operations", "operation_type = 'AUTO_SETTLEMENT'"), 1);
          assert.equal(readCount(connection, "ledger_transactions"), 1);
          assert.equal(readCount(connection, "ledger_postings"), 2);
          assert.equal(readCountWhere(connection, "outbox_events", "event_type = 'PAYMENT_CONFIRMED'"), 1);
        });
        assert.equal(reopened.integrityCheck().ok, true);
      } finally {
        reopened.close();
      }
    });
  });

  it("settles a later exact order and supersedes the earlier amount inference", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const firstOrder = createOrder(orders, "cross-order-exception-first", 999);
      const entry = recordCredit("cross-order-exception-entry", 1_500, BASE_TIME);
      const unmatched = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 200);
      assert.equal(unmatched.kind, "unmatched");
      if (unmatched.kind !== "unmatched") throw new Error("expected an amount exception");
      const originalException = reconciliation.exception(unmatched.exceptionId);
      assert.equal(originalException?.exceptionType, "AMOUNT_MISMATCH");
      assert.equal(originalException?.orderId, firstOrder.order.orderId);

      setNow(BASE_TIME + 500);
      const secondOrder = createOrder(orders, "cross-order-exception-second", 1_499);
      assert.equal(secondOrder.order.payableAmountCents, entry.amountCents);
      const settled = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 3_000);
      assert.equal(settled.kind, "auto_settled");

      assert.equal(
        orders.orderById(API_CLIENT_ID, firstOrder.order.orderId)?.order.paymentStatus,
        "UNPAID",
      );
      assert.equal(
        orders.orderById(API_CLIENT_ID, secondOrder.order.orderId)?.order.paymentStatus,
        "CONFIRMED",
      );
      const supersededException = reconciliation.exception(unmatched.exceptionId);
      assert.equal(supersededException?.status, "RESOLVED");
      assert.equal(supersededException?.resolution?.resolution, "superseded_by_settlement");
      assert.equal(
        supersededException?.resolution?.payment_match_id,
        settled.paymentMatchId,
      );
      database.read((connection) => {
        assert.equal(readCountWhere(connection, "financial_operations", "operation_type = 'AUTO_SETTLEMENT'"), 1);
        assert.equal(readCount(connection, "payment_matches"), 1);
        assert.equal(readCount(connection, "outbox_events"), 1);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("does not auto-settle an amount reused inside a settled slot's timestamp interval", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const firstOrder = createOrder(orders, "settled-overlap-first", 999);
      const firstEntry = recordCredit(
        "settled-overlap-first-entry",
        firstOrder.order.payableAmountCents,
        BASE_TIME,
      );
      assert.equal(
        reconciliation.reconcileEntry(firstEntry.ledgerEntryId, BASE_TIME + 200).kind,
        "auto_settled",
      );

      setNow(BASE_TIME + 400);
      assert.ok(orders.closeOrder(API_CLIENT_ID, firstOrder.order.orderId));
      setNow(BASE_TIME + 600);
      const secondOrder = createOrder(orders, "settled-overlap-second", 999);
      assert.equal(secondOrder.order.payableAmountCents, firstOrder.order.payableAmountCents);
      const secondEntry = recordCredit(
        "settled-overlap-second-entry",
        secondOrder.order.payableAmountCents,
        BASE_TIME,
      );

      const result = reconciliation.reconcileEntry(secondEntry.ledgerEntryId, BASE_TIME + 3_000);
      assert.equal(result.kind, "unmatched");
      if (result.kind !== "unmatched") throw new Error("expected a duplicate-payment exception");
      const exception = reconciliation.exception(result.exceptionId);
      assert.equal(exception?.exceptionType, "DUPLICATE_PAYMENT");
      assert.equal(exception?.orderId, firstOrder.order.orderId);
      assert.equal(exception?.details.overlapping_settled_order_count, 1);
      assert.equal(reconciliation.ledgerEntry(secondEntry.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(
        orders.orderById(API_CLIENT_ID, secondOrder.order.orderId)?.order.paymentStatus,
        "UNPAID",
      );
      const candidate = reconciliation
        .listCandidates(secondEntry.ledgerEntryId)
        .find((item) => item.orderId === secondOrder.order.orderId);
      assert.equal(candidate?.status, "ELIGIBLE");
      if (!candidate) throw new Error("expected the unpaid order candidate");

      const repeated = reconciliation.reconcileEntry(secondEntry.ledgerEntryId, BASE_TIME + 3_001);
      assert.deepEqual(repeated, result);
      assert.throws(
        () => insertUnsafeAutomaticMatch(
          database,
          candidate,
          secondEntry.ledgerEntryId,
          secondOrder.order.orderId,
          BASE_TIME + 3_002,
        ),
        /payment match is not supported by its operation and facts/,
      );
      assert.equal(reconciliation.candidate(candidate.candidateId)?.status, "ELIGIBLE");
      database.read((connection) => {
        assert.equal(readCountWhere(connection, "financial_operations", "operation_type = 'AUTO_SETTLEMENT'"), 1);
        assert.equal(readCount(connection, "payment_matches"), 1);
        assert.equal(readCountWhere(connection, "financial_exceptions", "exception_type = 'DUPLICATE_PAYMENT'"), 1);
        assert.equal(readCount(connection, "outbox_events"), 1);
      });

      const manual = reconciliation.settleManually({
        financialOperationId: randomUUID(),
        orderId: secondOrder.order.orderId,
        ledgerEntryId: secondEntry.ledgerEntryId,
        actorId: "admin",
        reason: "reviewed overlapping historical amount slot",
        now: BASE_TIME + 4_000,
      });
      assert.equal(manual.paymentMatch.evidenceType, "MANUAL");
      assert.equal(reconciliation.exception(result.exceptionId)?.status, "RESOLVED");
      assert.equal(
        reconciliation.exception(result.exceptionId)?.resolution?.resolution,
        "superseded_by_settlement",
      );
      assert.equal(
        orders.orderById(API_CLIENT_ID, secondOrder.order.orderId)?.order.paymentBasis,
        "MANUAL",
      );
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("does not bind a duplicate exception to one of several historical slots", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const firstOrder = createOrder(orders, "multiple-overlap-first", 999);
      const firstEntry = recordCredit(
        "multiple-overlap-first-entry",
        firstOrder.order.payableAmountCents,
        EVENT_TIME,
      );
      assert.equal(
        reconciliation.reconcileEntry(firstEntry.ledgerEntryId, EVENT_TIME + 100).kind,
        "auto_settled",
      );
      setNow(EVENT_TIME + 200);
      assert.ok(orders.closeOrder(API_CLIENT_ID, firstOrder.order.orderId));

      setNow(EVENT_TIME + 400);
      const secondOrder = createOrder(orders, "multiple-overlap-second", 999);
      const secondEntry = recordCredit(
        "multiple-overlap-second-entry",
        secondOrder.order.payableAmountCents,
        EVENT_TIME,
      );
      reconciliation.settleManually({
        financialOperationId: randomUUID(),
        orderId: secondOrder.order.orderId,
        ledgerEntryId: secondEntry.ledgerEntryId,
        actorId: "admin",
        reason: "verified second payment inside provider timestamp precision",
        now: EVENT_TIME + 500,
      });
      setNow(EVENT_TIME + 700);
      assert.ok(orders.closeOrder(API_CLIENT_ID, secondOrder.order.orderId));

      setNow(EVENT_TIME + 900);
      const thirdOrder = createOrder(orders, "multiple-overlap-third", 999);
      const broadEntry = recordCredit(
        "multiple-overlap-third-entry",
        thirdOrder.order.payableAmountCents,
        EVENT_TIME,
      );
      const result = reconciliation.reconcileEntry(broadEntry.ledgerEntryId, EVENT_TIME + 2_000);
      assert.equal(result.kind, "unmatched");
      if (result.kind !== "unmatched") throw new Error("expected a duplicate-payment exception");

      const exception = reconciliation.exception(result.exceptionId);
      assert.equal(exception?.exceptionType, "DUPLICATE_PAYMENT");
      assert.equal(exception?.orderId, null);
      assert.equal(exception?.details.overlapping_settled_order_count, 2);
      assert.equal(exception?.details.overlapping_settled_order_count_is_lower_bound, true);
      assert.equal(
        orders.orderById(API_CLIENT_ID, thirdOrder.order.orderId)?.order.paymentStatus,
        "UNPAID",
      );
      assert.equal(reconciliation.ledgerEntry(broadEntry.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("allows amount reuse when the new timestamp interval no longer overlaps the settled slot", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const firstOrder = createOrder(orders, "settled-boundary-first", 999);
      const firstEntry = recordCredit(
        "settled-boundary-first-entry",
        firstOrder.order.payableAmountCents,
        BASE_TIME,
      );
      assert.equal(
        reconciliation.reconcileEntry(firstEntry.ledgerEntryId, BASE_TIME + 200).kind,
        "auto_settled",
      );
      setNow(BASE_TIME + 400);
      assert.ok(orders.closeOrder(API_CLIENT_ID, firstOrder.order.orderId));

      setNow(BASE_TIME + 1_000);
      const secondOrder = createOrder(orders, "settled-boundary-second", 999);
      const secondEntry = recordCredit(
        "settled-boundary-second-entry",
        secondOrder.order.payableAmountCents,
        BASE_TIME + 1_000,
      );
      assert.equal(
        reconciliation.reconcileEntry(secondEntry.ledgerEntryId, BASE_TIME + 3_000).kind,
        "auto_settled",
      );
      assert.equal(
        orders.orderById(API_CLIENT_ID, secondOrder.order.orderId)?.order.paymentStatus,
        "CONFIRMED",
      );
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("classifies a second credit for an already settled order as a duplicate without confirming it", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "duplicate-credit", 2_499);
      const first = recordCredit("duplicate-credit-first", order.order.payableAmountCents, EVENT_TIME);
      assert.equal(reconciliation.reconcileEntry(first.ledgerEntryId, BASE_TIME + 120_000).kind, "auto_settled");

      const duplicate = recordCredit(
        "duplicate-credit-second",
        order.order.payableAmountCents,
        EVENT_TIME + 1_000,
      );
      const result = reconciliation.reconcileEntry(duplicate.ledgerEntryId, BASE_TIME + 121_000);
      assert.equal(result.kind, "unmatched");
      if (result.kind !== "unmatched") throw new Error("expected duplicate exception");
      const exception = reconciliation.exception(result.exceptionId);
      assert.equal(exception?.exceptionType, "DUPLICATE_PAYMENT");
      assert.equal(exception?.orderId, order.order.orderId);
      assert.equal(reconciliation.ledgerEntry(duplicate.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentStatus, "CONFIRMED");
      database.read((connection) => {
        assert.equal(readCount(connection, "payment_matches"), 1);
        assert.equal(readCountWhere(connection, "financial_operations", "operation_type = 'AUTO_SETTLEMENT'"), 1);
        assert.equal(readCountWhere(connection, "outbox_events", "event_type = 'PAYMENT_CONFIRMED'"), 1);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("does not match credit intervals that only touch the order window boundaries", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const before = recordCredit("boundary-before", 3_500, BASE_TIME);
      assert.equal(before.occurredAtPrecisionMilliseconds, 1_000);
      setNow(BASE_TIME + 1_000);
      const order = createOrder(orders, "time-boundaries", 3_499);
      assert.equal(order.order.eligibleFrom, BASE_TIME + 1_000);

      const after = recordCredit(
        "boundary-after",
        order.order.payableAmountCents,
        order.order.expiresAt,
      );
      assert.equal(reconciliation.reconcileEntry(before.ledgerEntryId, BASE_TIME + 250_000).kind, "unmatched");
      assert.equal(reconciliation.reconcileEntry(after.ledgerEntryId, BASE_TIME + 250_000).kind, "unmatched");

      assert.equal(
        database.read((connection) => readText(connection, "SELECT payment_status FROM payment_orders LIMIT 1")),
        "UNPAID",
      );
      assert.equal(reconciliation.ledgerEntry(before.ledgerEntryId)?.state, "UNALLOCATED");
      assert.equal(reconciliation.ledgerEntry(after.ledgerEntryId)?.state, "UNALLOCATED");
      database.read((connection) => {
        assert.equal(readCount(connection, "match_candidates"), 0);
        assert.equal(readCount(connection, "payment_matches"), 0);
        assert.equal(readCount(connection, "outbox_events"), 0);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("leaves ambiguous amount reuse for an administrator exception", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, setNow }) => {
      const first = createOrder(orders, "ambiguous-first", 999);
      setNow(BASE_TIME + 400);
      assert.ok(orders.closeOrder(API_CLIENT_ID, first.order.orderId));
      setNow(BASE_TIME + 600);
      const second = createOrder(orders, "ambiguous-second", 999);
      assert.equal(first.order.payableAmountCents, second.order.payableAmountCents);
      const entry = recordCredit("ambiguous-entry", first.order.payableAmountCents, BASE_TIME);

      const result = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 2_000);
      assert.equal(result.kind, "ambiguous");
      if (result.kind !== "ambiguous") throw new Error("expected ambiguity");
      assert.equal(result.candidateIds.length, 2);
      assert.equal(reconciliation.ledgerEntry(entry.ledgerEntryId)?.state, "CANDIDATE");
      assert.equal(reconciliation.listOpenExceptions()[0]?.exceptionType, "AMBIGUOUS_MATCH");
      assert.equal(reconciliation.candidate(result.candidateIds[0]!)?.status, "ELIGIBLE");
      database.read((connection) => {
        assert.equal(readCount(connection, "financial_operations"), 0);
        assert.equal(readCount(connection, "payment_matches"), 0);
        assert.equal(readCount(connection, "outbox_events"), 0);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("does not settle wrong amount, late, debit, or conflicted evidence", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, recordDebit, recordConflict }) => {
      const order = createOrder(orders, "exceptions", 999);
      const wrong = recordCredit("wrong-amount", order.order.payableAmountCents + 1, EVENT_TIME);
      assert.equal(reconciliation.reconcileEntry(wrong.ledgerEntryId, BASE_TIME + 120_000).kind, "unmatched");
      const debit = recordDebit("debit-entry", order.order.payableAmountCents, EVENT_TIME + 1_000);
      assert.equal(reconciliation.reconcileEntry(debit.ledgerEntryId, BASE_TIME + 120_000).kind, "unmatched");
      const late = recordCredit("late-entry", order.order.payableAmountCents, BASE_TIME + 60 * 60 * 1_000);
      assert.equal(reconciliation.reconcileEntry(late.ledgerEntryId, BASE_TIME + 120_000).kind, "unmatched");
      const conflict = recordConflict("conflict-entry", order.order.payableAmountCents, EVENT_TIME + 2_000, "CREDIT");
      assert.equal(reconciliation.reconcileEntry(conflict.ledgerEntryId, BASE_TIME + 120_000).kind, "ignored");
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentStatus, "UNPAID");
      database.read((connection) => {
        assert.equal(readCount(connection, "payment_matches"), 0);
        assert.equal(readCount(connection, "outbox_events"), 0);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("rolls back candidate, accounting, order, and outbox writes as one unit", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "rollback", 999);
      const entry = recordCredit("rollback-entry", order.order.payableAmountCents, EVENT_TIME);
      database.write((connection) => connection.exec(`
        CREATE TRIGGER test_abort_outbox
        BEFORE INSERT ON outbox_events
        BEGIN
          SELECT RAISE(ABORT, 'test outbox failure');
        END;
      `));
      assert.throws(
        () => reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 120_000),
        /test outbox failure/,
      );
      database.write((connection) => connection.exec("DROP TRIGGER test_abort_outbox"));
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentStatus, "UNPAID");
      database.read((connection) => {
        assert.equal(readCount(connection, "match_candidates"), 0);
        assert.equal(readCount(connection, "financial_operations"), 0);
        assert.equal(readCount(connection, "ledger_transactions"), 0);
        assert.equal(readCount(connection, "payment_matches"), 0);
        assert.equal(readCount(connection, "outbox_events"), 0);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("supports exceptional manual claim, reversal, and partial-to-full refund without changing evidence semantics", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit, recordDebit }) => {
      const order = createOrder(orders, "manual", 999);
      const credit = recordCredit("manual-credit", order.order.payableAmountCents + 7, EVENT_TIME);
      const manualOperationId = randomUUID();
      const manual = reconciliation.settleManually({
        financialOperationId: manualOperationId,
        orderId: order.order.orderId,
        ledgerEntryId: credit.ledgerEntryId,
        actorId: "admin",
        reason: "exception claim",
        now: BASE_TIME + 120_000,
      });
      assert.equal(manual.operation.operationType, "MANUAL_SETTLEMENT");
      assert.equal(manual.replayed, false);
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentBasis, "MANUAL");
      const replay = reconciliation.settleManually({
        financialOperationId: manualOperationId,
        orderId: order.order.orderId,
        ledgerEntryId: credit.ledgerEntryId,
        actorId: "admin",
        reason: "exception claim",
        now: BASE_TIME + 121_000,
      });
      assert.equal(replay.replayed, true);
      assert.equal(reconciliation.paymentMatch(manual.paymentMatch.paymentMatchId)?.status, "SETTLED");

      const reversed = reconciliation.reverseSettlement({
        financialOperationId: randomUUID(),
        paymentMatchId: manual.paymentMatch.paymentMatchId,
        actorId: "admin",
        reason: "payment dispute",
        now: BASE_TIME + 122_000,
      });
      assert.equal(reversed.operation.operationType, "REVERSE_SETTLEMENT");
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentStatus, "DISPUTED");
      assert.equal(orders.orderById(API_CLIENT_ID, order.order.orderId)?.order.paymentBasis, "MANUAL");
      assert.equal(reconciliation.paymentMatch(manual.paymentMatch.paymentMatchId)?.status, "REVERSED");

      const refundOrder = createOrder(orders, "refund", 99_999);
      const refundCredit = recordCredit("refund-credit", refundOrder.order.payableAmountCents, BASE_TIME + 180_000);
      const automatic = reconciliation.reconcileEntry(refundCredit.ledgerEntryId, BASE_TIME + 130_000);
      assert.equal(automatic.kind, "auto_settled", JSON.stringify({
        automatic,
        exceptions: reconciliation.listOpenExceptions(),
        refundOrder: refundOrder.order,
      }));
      const partialAmountCents = 40_000;
      const partialDebit = recordDebit("refund-debit-partial", partialAmountCents, BASE_TIME + 181_000);
      const partialRefund = reconciliation.recordRefund({
        financialOperationId: randomUUID(),
        orderId: refundOrder.order.orderId,
        ledgerEntryId: partialDebit.ledgerEntryId,
        actorId: "admin",
        reason: "partial refund received",
        now: BASE_TIME + 131_000,
      });
      assert.equal(partialRefund.refundStatus, "PARTIAL");
      assert.equal(orders.orderById(API_CLIENT_ID, refundOrder.order.orderId)?.order.refundStatus, "PARTIAL");

      const remainingAmountCents = refundOrder.order.payableAmountCents - partialAmountCents;
      const finalDebit = recordDebit("refund-debit-final", remainingAmountCents, BASE_TIME + 182_000);
      const finalRefund = reconciliation.recordRefund({
        financialOperationId: randomUUID(),
        orderId: refundOrder.order.orderId,
        ledgerEntryId: finalDebit.ledgerEntryId,
        actorId: "admin",
        reason: "remaining refund received",
        now: BASE_TIME + 132_000,
      });
      assert.equal(finalRefund.refundStatus, "FULL");
      const refunded = orders.orderById(API_CLIENT_ID, refundOrder.order.orderId)?.order;
      assert.equal(refunded?.paymentStatus, "CONFIRMED");
      assert.equal(refunded?.refundStatus, "FULL");
      database.read((connection) => {
        assert.equal(readCount(connection, "refund_records"), 2);
        assert.equal(readCountWhere(connection, "outbox_events", "event_type = 'REFUND_UPDATED'"), 2);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("rejects unrelated operations as exception resolutions and detects trigger bypass", async () => {
    await withStores(async ({ database, orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "exception-resolution", 999);
      const credit = recordCredit(
        "exception-resolution-credit",
        order.order.payableAmountCents,
        EVENT_TIME,
      );
      const settled = reconciliation.reconcileEntry(credit.ledgerEntryId, BASE_TIME + 120_000);
      assert.equal(settled.kind, "auto_settled");
      if (settled.kind !== "auto_settled") throw new Error("expected automatic settlement");
      const reversed = reconciliation.reverseSettlement({
        financialOperationId: randomUUID(),
        paymentMatchId: settled.paymentMatchId,
        actorId: "admin",
        reason: "resolution operation boundary",
        now: BASE_TIME + 121_000,
      });
      const exception = reconciliation.listOpenExceptions()[0];
      assert.ok(exception);
      const resolutionJson = JSON.stringify({
        resolution: "forged_reversal_resolution",
        payment_match_id: settled.paymentMatchId,
      });
      const parameters = [
        reversed.operation.financialOperationId,
        resolutionJson,
        financialExceptionResolutionFingerprint(resolutionJson),
        reversed.operation.createdAt,
        exception.exceptionId,
      ] as const;
      const update = `UPDATE financial_exceptions
                         SET status = 'RESOLVED', resolution_operation_id = ?,
                             resolution_json = ?, resolution_fingerprint = ?, resolved_at = ?
                       WHERE exception_id = ? AND status = 'OPEN'`;

      assert.throws(
        () => database.write((connection) => connection.prepare(update).run(...parameters)),
        /financial exception resolution is invalid/,
      );
      assert.equal(reconciliation.exception(exception.exceptionId)?.status, "OPEN");
      assert.equal(database.integrityCheck().ok, true);

      database.write((connection) => {
        connection.exec("DROP TRIGGER financial_exceptions_resolution_once");
        connection.prepare(update).run(...parameters);
      });
      const damaged = database.integrityCheck();
      assert.equal(damaged.ok, false);
      assert.ok(damaged.domainViolations >= 1);
    });
  });

  it("exposes only settled/reversed history and preserves the selected evidence", async () => {
    await withStores(async ({ orders, reconciliation, recordCredit }) => {
      const order = createOrder(orders, "history", 999);
      const entry = recordCredit("history-entry", order.order.payableAmountCents, EVENT_TIME);
      const result = reconciliation.reconcileEntry(entry.ledgerEntryId, BASE_TIME + 120_000);
      assert.equal(result.kind, "auto_settled");
      if (result.kind !== "auto_settled") throw new Error("expected automatic settlement");
      const detail = reconciliation.paymentMatchDetail(result.paymentMatchId);
      assert.equal(detail?.paymentMatch.status, "SETTLED");
      assert.equal(detail?.candidate?.status, "SELECTED");
      assert.equal(detail?.paymentMatch.evidenceType, "AMOUNT_INFERRED");
      const page = reconciliation.paymentMatchHistoryPage("SETTLED");
      assert.equal(page.matches.length, 1);
      assert.equal(page.matches[0]?.paymentMatch.paymentMatchId, result.paymentMatchId);
      assert.throws(
        () => reconciliation.paymentMatchHistoryPage("PROPOSED" as never),
        /payment match history status is invalid/,
      );
    });
  });
});

interface StoreTestContext {
  readonly database: AppDatabase;
  readonly databasePath: string;
  readonly orders: OrderStore;
  readonly reconciliation: ReconciliationStore;
  readonly recordCredit: (externalEventId: string, amountCents: number, occurredAt: number) => LedgerEntry;
  readonly recordDebit: (externalEventId: string, amountCents: number, occurredAt: number) => LedgerEntry;
  readonly recordConflict: (externalEventId: string, amountCents: number, occurredAt: number, direction: "CREDIT" | "DEBIT") => LedgerEntry;
  readonly setNow: (value: number) => void;
}

async function withStores(operation: (context: StoreTestContext) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-reconciliation-store-"));
  const databasePath = join(directory, "database.sqlite3");
  const database = await AppDatabase.open(databasePath);
  let now = BASE_TIME;
  let ingestSequence = 0;
  try {
    database.write((connection) => {
      connection.prepare(`INSERT INTO api_client_config(
        singleton_key, client_id, secret_fingerprint, key_version,
        enabled, created_at, updated_at
      ) VALUES (1, ?, ?, 1, 1, ?, ?)`).run(API_CLIENT_ID, "a".repeat(64), now, now);
      connection.prepare(`INSERT INTO api_client_keys(
        client_id, key_version, secret_fingerprint, activated_at, retired_at
      ) VALUES (?, 1, ?, ?, NULL)`).run(API_CLIENT_ID, "a".repeat(64), now);
    });
    const orders = new OrderStore(database, () => now);
    const ledger = new LedgerStore(database);
    ledger.bindProviderIdentity(PROVIDER_IDENTITY, now);
    const profile = fingerprintCollectionCodeProfile("https://qr.example.test/primary");
    orders.syncCollectionProfile({
      codePayload: "https://qr.example.test/primary",
      payloadFingerprint: profile.payloadFingerprint,
      profileFingerprint: profile.profileFingerprint,
    });
    await operation({
      database,
      databasePath,
      orders,
      reconciliation: new ReconciliationStore(database),
      recordCredit(externalEventId, amountCents, occurredAt) {
        const startedAt = BASE_TIME + 100 + ingestSequence++ * 2_000;
        return recordLedgerEntry(ledger, externalEventId, amountCents, occurredAt, startedAt, "CREDIT");
      },
      recordDebit(externalEventId, amountCents, occurredAt) {
        const startedAt = BASE_TIME + 100 + ingestSequence++ * 2_000;
        return recordLedgerEntry(ledger, externalEventId, amountCents, occurredAt, startedAt, "DEBIT");
      },
      recordConflict(externalEventId, amountCents, occurredAt, direction) {
        const startedAt = BASE_TIME + 100 + ingestSequence++ * 2_000;
        return recordLedgerConflict(ledger, externalEventId, amountCents, occurredAt, startedAt, direction);
      },
      setNow(value) {
        now = value;
      },
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createOrder(store: OrderStore, suffix: string, requestedAmountCents: number): StoredOrderAggregate {
  const request = createOrderRequestSchema.parse({
    idempotency_key: `idem-${suffix}`,
    merchant_order_no: `merchant-${suffix}`,
    amount_cents: requestedAmountCents,
  });
  const result = store.createOrder({
    apiClientId: API_CLIENT_ID,
    request,
    idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
    requestFingerprint: fingerprintCreateOrderRequest(request),
    ttlMilliseconds: 5 * 60 * 1_000,
    amountOffsetMaximumCents: 99,
  });
  if (result.kind !== "created") throw new Error(`expected a created order, received ${result.kind}`);
  return result.aggregate;
}

function recordLedgerEntry(
  store: LedgerStore,
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
  direction: "CREDIT" | "DEBIT",
): LedgerEntry {
  const amount = (amountCents / 100).toFixed(2);
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const detail: AccountLogDetail = {
    raw: { account_log_id: externalEventId, amount, direction, occurred_at: occurredAtText },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction,
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const record = (runStartedAt: number, observedAt: number) => {
    const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: runStartedAt });
    return store.recordPage({
      ingestRunId: run.ingestRunId,
      page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [detail] },
      evidence: {
        httpStatus: 200,
        headers: { "alipay-request-id": `trace-${externalEventId}` },
        body: JSON.stringify({ external_event_id: externalEventId, amount }),
        traceId: `trace-${externalEventId}`,
        signatureVerified: true,
      },
      now: observedAt,
    });
  };
  let recorded = record(startedAt, startedAt + 1);
  if (recorded.kind === "variant") {
    recorded = record(startedAt + 2, startedAt + 3);
    assert.equal(recorded.kind, "confirmed_variant");
  }
  const normalized = recorded.normalized[0];
  if (!normalized || normalized.kind !== "created") {
    throw new Error(`expected a created ledger entry, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.entry;
}

function recordLedgerConflict(
  store: LedgerStore,
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
  direction: "CREDIT" | "DEBIT",
): LedgerEntry {
  const first = recordLedgerEntry(store, externalEventId, amountCents, occurredAt, startedAt, direction);
  const amount = ((amountCents + 1) / 100).toFixed(2);
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const detail: AccountLogDetail = {
    raw: { account_log_id: externalEventId, amount, direction, occurred_at: occurredAtText },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction,
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const run = store.startIngestRun({ ...WINDOW, pageSize: 1, now: startedAt + 2 });
  const firstVariant = store.recordPage({
    ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [detail] },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-conflict-${externalEventId}` },
      body: JSON.stringify({ external_event_id: externalEventId, amount }),
      traceId: `trace-conflict-${externalEventId}`,
      signatureVerified: true,
    },
    now: startedAt + 3,
  });
  assert.equal(firstVariant.kind, "variant");
  const secondVariantRun = store.startIngestRun({ ...WINDOW, pageSize: 1, now: startedAt + 4 });
  const result = store.recordPage({
    ingestRunId: secondVariantRun.ingestRunId,
    page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [detail] },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-conflict-${externalEventId}-2` },
      body: JSON.stringify({ external_event_id: externalEventId, amount }),
      traceId: `trace-conflict-${externalEventId}-2`,
      signatureVerified: true,
    },
    now: startedAt + 5,
  });
  assert.equal(result.kind, "confirmed_variant");
  assert.equal(result.normalized[0]?.kind, "conflict");
  const conflict = result.normalized[0];
  if (!conflict || conflict.kind !== "conflict") throw new Error("expected conflict entry");
  return first;
}

function readCount(connection: import("node:sqlite").DatabaseSync, table: string): number {
  const row = connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: bigint | number };
  return Number(row.count);
}

function readCountWhere(
  connection: import("node:sqlite").DatabaseSync,
  table: string,
  predicate: string,
): number {
  const row = connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as { count: bigint | number };
  return Number(row.count);
}

function readText(connection: import("node:sqlite").DatabaseSync, sql: string): string {
  const row = connection.prepare(sql).get() as Record<string, string> | undefined;
  assert.ok(row);
  const value = Object.values(row)[0];
  if (typeof value !== "string") throw new Error("expected text");
  return value;
}

function readOrderEventTypes(connection: import("node:sqlite").DatabaseSync, orderId: string): string[] {
  const rows = connection.prepare(
    "SELECT event_type FROM order_events WHERE order_id = ? ORDER BY sequence",
  ).all(orderId) as Array<{ event_type: string }>;
  return rows.map((row) => row.event_type);
}

function insertUnsafeAutomaticMatch(
  database: AppDatabase,
  candidate: NonNullable<ReturnType<ReconciliationStore["candidate"]>>,
  ledgerEntryId: string,
  orderId: string,
  now: number,
): void {
  const financialOperationId = randomUUID();
  const paymentMatchId = randomUUID();
  const fingerprintInput: FinancialOperationFingerprintInput = {
    operationType: "AUTO_SETTLEMENT",
    actorType: "SYSTEM",
    actorId: null,
    orderId,
    ledgerEntryId,
    candidateId: candidate.candidateId,
    paymentMatchId,
    reversesOperationId: null,
    reason: null,
  };
  database.write((connection) => {
    connection.prepare(
      `INSERT INTO financial_operations(
         financial_operation_id, operation_key, request_fingerprint, request_json,
         operation_type, actor_type, actor_id, order_id, ledger_entry_id,
         reverses_operation_id, reason, created_at
       ) VALUES (?, ?, ?, ?, 'AUTO_SETTLEMENT', 'SYSTEM', NULL, ?, ?, NULL, NULL, ?)`,
    ).run(
      financialOperationId,
      `test-auto:${candidate.candidateId}`,
      financialOperationFingerprint(fingerprintInput),
      JSON.stringify(financialOperationEvidence(fingerprintInput)),
      orderId,
      ledgerEntryId,
      now,
    );
    connection.prepare(
      `UPDATE match_candidates
          SET status = 'SELECTED', decided_by_operation_id = ?, updated_at = ?, decided_at = ?
        WHERE candidate_id = ? AND status = 'ELIGIBLE'`,
    ).run(financialOperationId, now, now, candidate.candidateId);
    connection.prepare(
      `INSERT INTO payment_matches(
         payment_match_id, ledger_entry_id, order_id, candidate_id,
         match_role, evidence_type, evidence_json, status,
         created_by_operation_id, resolved_by_operation_id,
         created_at, updated_at, resolved_at
       ) VALUES (?, ?, ?, ?, 'PRIMARY_SETTLEMENT', 'AMOUNT_INFERRED', ?,
                 'SETTLED', ?, ?, ?, ?, ?)`,
    ).run(
      paymentMatchId,
      ledgerEntryId,
      orderId,
      candidate.candidateId,
      JSON.stringify(candidate.evidence),
      financialOperationId,
      financialOperationId,
      now,
      now,
      now,
    );
  });
}

function formatProviderTimestamp(milliseconds: number): string {
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}
