import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";
import {
  MAX_ORDER_CLOCK_AHEAD_MILLISECONDS,
  orderEventDetailsFingerprint,
} from "../orders/model.ts";
import {
  MAX_RECONCILIATION_BATCH_SIZE,
  MAX_FINANCIAL_REASON_BYTES,
  MAX_LATE_PAYMENT_ATTRIBUTION_MILLISECONDS,
  RECONCILIATION_RULE_VERSION,
  candidateEvidence,
  candidateFingerprint,
  financialExceptionDetailsFingerprint,
  financialOperationEvidence,
  financialExceptionFingerprint,
  financialExceptionResolutionFingerprint,
  financialOperationFingerprint,
  manualSettlementEvidence,
  outboxPayloadFingerprint,
  refundRecordEvidence,
  type CandidateFingerprintInput,
  type FinancialException,
  type FinancialExceptionType,
  type FinancialOperation,
  type FinancialOperationFingerprintInput,
  type FinancialOperationType,
  type MatchCandidate,
  type PaymentMatch,
  type PaymentMatchStatus,
} from "./model.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

export type ReconcileEntryResult =
  | { readonly kind: "ignored"; readonly ledgerEntryId: string }
  | { readonly kind: "allocated"; readonly ledgerEntryId: string; readonly paymentMatchId: string }
  | { readonly kind: "unmatched"; readonly ledgerEntryId: string; readonly exceptionId: string }
  | {
      readonly kind: "ambiguous";
      readonly ledgerEntryId: string;
      readonly candidateIds: readonly string[];
      readonly exceptionId: string;
    }
  | {
      readonly kind: "auto_settled";
      readonly ledgerEntryId: string;
      readonly candidateId: string;
      readonly paymentMatchId: string;
      readonly orderId: string;
    };

export interface ReconciliationBatchResult {
  readonly processed: number;
  readonly results: readonly ReconcileEntryResult[];
  readonly hasMore: boolean;
}

export interface ReconciliationSweepCursor {
  readonly occurredAt: number;
  readonly ledgerEntryId: string;
}

export interface PendingLedgerPage {
  readonly ledgerEntryIds: readonly string[];
  readonly nextCursor: ReconciliationSweepCursor | null;
  readonly hasMore: boolean;
}

export interface FinancialExceptionCursor {
  readonly createdAt: number;
  readonly exceptionId: string;
}

export interface FinancialExceptionPage {
  readonly exceptions: readonly FinancialException[];
  readonly nextCursor: FinancialExceptionCursor | null;
}

export interface FinancialExceptionSummary {
  readonly providerAccountKey: string;
  readonly open: number;
  readonly resolved: number;
  readonly total: number;
}

export interface ReconciliationLedgerProjection {
  readonly ledgerEntryId: string;
  readonly externalEventId: string;
  readonly semanticFingerprint: string;
  readonly occurredAt: number;
  readonly occurredAtPrecisionMilliseconds: 1 | 10 | 100 | 1_000;
  readonly occurredAtIntervalEndExclusive: number;
  readonly amountCents: number;
  readonly direction: "CREDIT" | "DEBIT";
  readonly currency: "CNY";
  readonly alipayOrderNo: string | null;
  readonly merchantOrderNo: string | null;
  readonly transMemo: string | null;
  readonly otherAccount: string | null;
  readonly state: LedgerEntryRow["state"];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ReconciliationOrderProjection {
  readonly orderId: string;
  readonly merchantOrderNo: string;
  readonly requestedAmountCents: number;
  readonly payableAmountCents: number;
  readonly receivedAmountCents: number | null;
  readonly currency: "CNY";
  readonly productName: string;
  readonly note: string | null;
  readonly checkoutStatus: "OPEN" | "EXPIRED" | "CLOSED";
  readonly paymentStatus: OrderDecisionRow["payment_status"];
  readonly paymentBasis: OrderDecisionRow["payment_basis"];
  readonly refundStatus: OrderDecisionRow["refund_status"];
  readonly eligibleFrom: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly closedAt: number | null;
  readonly updatedAt: number;
  readonly version: number;
}

export interface PaymentMatchDetail {
  readonly paymentMatch: PaymentMatch;
  readonly candidate: MatchCandidate | null;
  readonly ledgerEntry: ReconciliationLedgerProjection;
  readonly order: ReconciliationOrderProjection;
}

export interface PaymentMatchHistoryCursor {
  readonly eventSequence: number;
}

export interface PaymentMatchHistoryPage {
  readonly matches: readonly PaymentMatchDetail[];
  readonly nextCursor: PaymentMatchHistoryCursor | null;
}

export interface FinancialDecisionInput {
  readonly financialOperationId: string;
  readonly paymentMatchId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now?: number | undefined;
}

export interface ManualSettlementInput {
  readonly financialOperationId: string;
  readonly orderId: string;
  readonly ledgerEntryId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now?: number | undefined;
}

export interface RefundRecordInput {
  readonly financialOperationId: string;
  readonly orderId: string;
  readonly ledgerEntryId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly now?: number | undefined;
}

export interface RefundRecordResult {
  readonly operation: FinancialOperation;
  readonly refundRecordId: string;
  readonly orderId: string;
  readonly ledgerEntryId: string;
  readonly refundStatus: "PARTIAL" | "FULL";
  readonly orderVersion: number;
  readonly replayed: boolean;
}

export interface FinancialDecisionResult {
  readonly operation: FinancialOperation;
  readonly paymentMatch: PaymentMatch;
  readonly orderId: string;
  readonly ledgerEntryId: string;
  readonly orderVersion: number;
  readonly replayed: boolean;
}

export type ReconciliationErrorCode =
  | "candidate_not_found"
  | "match_not_found"
  | "match_state_conflict"
  | "candidate_set_changed"
  | "operation_conflict"
  | "financial_clock_unavailable";

export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode, message: string) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
  }
}

interface LedgerEntryRow {
  readonly ledger_entry_id: string;
  readonly provider_account_key: string;
  readonly semantic_fingerprint: string;
  readonly occurred_at: bigint | number;
  readonly occurred_at_precision_ms: bigint | number;
  readonly amount_cents: bigint | number;
  readonly direction: "CREDIT" | "DEBIT";
  readonly currency: "CNY";
  readonly state: "UNALLOCATED" | "CANDIDATE" | "ALLOCATED" | "CONFLICT" | "ISOLATED" | "IGNORED";
}

interface CandidateFactRow {
  readonly order_id: string;
  readonly collection_profile_id: string;
  readonly slot_id: string;
  readonly generation: bigint | number;
  readonly occupied_from: bigint | number;
  readonly released_at: bigint | number | null;
  readonly payment_status: "UNPAID" | "CONFIRMED" | "DISPUTED";
}

interface CandidateRow {
  readonly candidate_id: string;
  readonly ledger_entry_id: string;
  readonly order_id: string;
  readonly slot_id: string;
  readonly evidence_type: "AMOUNT_INFERRED";
  readonly rule_version: bigint | number;
  readonly evidence_json: string;
  readonly candidate_fingerprint: string;
  readonly status: MatchCandidate["status"];
  readonly decided_by_operation_id: string | null;
  readonly created_at: bigint | number;
  readonly updated_at: bigint | number;
  readonly decided_at: bigint | number | null;
}

interface PaymentMatchRow {
  readonly payment_match_id: string;
  readonly ledger_entry_id: string;
  readonly order_id: string;
  readonly candidate_id: string | null;
  readonly evidence_type: "AMOUNT_INFERRED" | "MANUAL";
  readonly evidence_json: string;
  readonly status: PaymentMatch["status"];
  readonly created_by_operation_id: string;
  readonly resolved_by_operation_id: string | null;
  readonly created_at: bigint | number;
  readonly updated_at: bigint | number;
  readonly resolved_at: bigint | number | null;
}

interface PaymentMatchHistoryPageRow extends PaymentMatchRow {
  readonly event_sequence: bigint | number;
}

interface FinancialOperationRow {
  readonly financial_operation_id: string;
  readonly operation_key: string;
  readonly request_fingerprint: string;
  readonly operation_type: FinancialOperationType;
  readonly actor_type: "SYSTEM" | "ADMIN";
  readonly actor_id: string | null;
  readonly order_id: string | null;
  readonly ledger_entry_id: string | null;
  readonly reverses_operation_id: string | null;
  readonly reason: string | null;
  readonly created_at: bigint | number;
}

interface ExceptionRow {
  readonly exception_id: string;
  readonly provider_account_key: string;
  readonly exception_type: FinancialExceptionType;
  readonly ledger_entry_id: string | null;
  readonly order_id: string | null;
  readonly candidate_id: string | null;
  readonly context_key: string;
  readonly details_json: string;
  readonly details_fingerprint: string;
  readonly exception_fingerprint: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly resolution_operation_id: string | null;
  readonly resolution_json: string | null;
  readonly resolution_fingerprint: string | null;
  readonly created_at: bigint | number;
  readonly resolved_at: bigint | number | null;
}

interface OrderDecisionRow {
  readonly order_id: string;
  readonly merchant_order_no: string;
  readonly product_name: string;
  readonly note: string | null;
  readonly requested_amount_cents: bigint | number;
  readonly payable_amount_cents: bigint | number;
  readonly received_amount_cents: bigint | number | null;
  readonly currency: "CNY";
  readonly payment_status: "UNPAID" | "CONFIRMED" | "DISPUTED";
  readonly payment_basis: "NONE" | "INFERRED" | "MANUAL";
  readonly refund_status: "NONE" | "PARTIAL" | "FULL";
  readonly updated_at: bigint | number;
  readonly version: bigint | number;
}

interface ReviewLedgerRow {
  readonly ledger_entry_id: string;
  readonly external_event_id: string;
  readonly semantic_fingerprint: string;
  readonly occurred_at: bigint | number;
  readonly occurred_at_precision_ms: bigint | number;
  readonly amount_cents: bigint | number;
  readonly direction: "CREDIT" | "DEBIT";
  readonly currency: "CNY";
  readonly alipay_order_no: string | null;
  readonly merchant_order_no: string | null;
  readonly trans_memo: string | null;
  readonly other_account: string | null;
  readonly state: LedgerEntryRow["state"];
  readonly created_at: bigint | number;
  readonly updated_at: bigint | number;
}

interface ReviewOrderRow {
  readonly order_id: string;
  readonly merchant_order_no: string;
  readonly requested_amount_cents: bigint | number;
  readonly payable_amount_cents: bigint | number;
  readonly received_amount_cents: bigint | number | null;
  readonly currency: "CNY";
  readonly product_name: string;
  readonly note: string | null;
  readonly checkout_status: "OPEN" | "EXPIRED" | "CLOSED";
  readonly payment_status: OrderDecisionRow["payment_status"];
  readonly payment_basis: OrderDecisionRow["payment_basis"];
  readonly refund_status: OrderDecisionRow["refund_status"];
  readonly eligible_from: bigint | number;
  readonly created_at: bigint | number;
  readonly expires_at: bigint | number;
  readonly closed_at: bigint | number | null;
  readonly updated_at: bigint | number;
  readonly version: bigint | number;
}

/**
 * Reconciliation repository. Every decision method owns exactly one short
 * BEGIN IMMEDIATE transaction through AppDatabase.write().
 */
export class ReconciliationStore {
  readonly #database: DatabaseOwner;

  constructor(database: DatabaseOwner) {
    this.#database = database;
  }

  reconcileEntry(ledgerEntryId: string, nowInput?: number): ReconcileEntryResult {
    requireIdentifier(ledgerEntryId, "ledger entry ID");
    return this.#database.write((connection) => {
      const now = financialNow(connection, nowInput);
      const entry = readLedgerEntry(connection, ledgerEntryId);
      if (
        !entry ||
        entry.state === "CONFLICT" ||
        entry.state === "ISOLATED" ||
        entry.state === "IGNORED" ||
        hasOpenLedgerConflict(connection, ledgerEntryId)
      ) {
        return { kind: "ignored", ledgerEntryId };
      }

      const activeMatch = readActiveMatchForEntry(connection, ledgerEntryId);
      if (activeMatch) {
        return { kind: "allocated", ledgerEntryId, paymentMatchId: activeMatch.paymentMatchId };
      }
      if (entry.state === "ALLOCATED") {
        throw new ReconciliationError("match_state_conflict", "allocated ledger entry has no active match");
      }

      if (entry.direction === "DEBIT") {
        const exception = ensureException(connection, {
          providerAccountKey: entry.provider_account_key,
          exceptionType: "UNMATCHED_DEBIT",
          ledgerEntryId,
          orderId: null,
          candidateId: null,
          contextKey: latestMatchContext(connection, ledgerEntryId),
          details: {
            reason: "debit_requires_verified_refund_link",
            refund_classification: "not_inferred",
          },
          now,
        });
        return { kind: "unmatched", ledgerEntryId, exceptionId: exception.exceptionId };
      }

      const settledOrderOverlap = readSettledOrderOverlap(connection, entry);
      const facts = readCandidateFacts(connection, entry);
      const candidates = facts
        .map((fact) => ensureCandidate(connection, entry, fact, now))
        .filter((candidate) => candidate.status === "ELIGIBLE");
      supersedeStaleEligibleCandidates(connection, entry, new Set(candidates.map((item) => item.candidateId)), now);

      if (candidates.length === 0) {
        setLedgerState(connection, entry, "UNALLOCATED", now);
        const classification = classifyUnmatchedCredit(connection, entry, settledOrderOverlap);
        const exception = ensureException(connection, {
          providerAccountKey: entry.provider_account_key,
          exceptionType: classification.exceptionType,
          ledgerEntryId,
          orderId: classification.orderId,
          candidateId: null,
          contextKey: classification.contextKey,
          details: classification.details,
          now,
        });
        return { kind: "unmatched", ledgerEntryId, exceptionId: exception.exceptionId };
      }

      if (candidates.length > 1) {
        setLedgerState(connection, entry, "CANDIDATE", now);
        const exception = ensureException(connection, {
          providerAccountKey: entry.provider_account_key,
          exceptionType: "AMBIGUOUS_MATCH",
          ledgerEntryId,
          orderId: null,
          candidateId: null,
          contextKey: `rule:${RECONCILIATION_RULE_VERSION}`,
          details: { candidate_count: candidates.length },
          now,
        });
        return {
          kind: "ambiguous",
          ledgerEntryId,
          candidateIds: Object.freeze(candidates.map((candidate) => candidate.candidateId)),
          exceptionId: exception.exceptionId,
        };
      }

      const candidate = candidates[0];
      if (!candidate) throw new Error("candidate disappeared");
      if (settledOrderOverlap.count > 0) {
        setLedgerState(connection, entry, "UNALLOCATED", now);
        const classification = duplicatePaymentClassification(settledOrderOverlap);
        const exception = ensureException(connection, {
          providerAccountKey: entry.provider_account_key,
          exceptionType: classification.exceptionType,
          ledgerEntryId,
          orderId: classification.orderId,
          candidateId: null,
          contextKey: classification.contextKey,
          details: classification.details,
          now,
        });
        return { kind: "unmatched", ledgerEntryId, exceptionId: exception.exceptionId };
      }
      return autoSettleCandidate(connection, entry, candidate, now);
    });
  }

  reconcilePending(limit = MAX_RECONCILIATION_BATCH_SIZE, nowInput?: number): ReconciliationBatchResult {
    validateBatchLimit(limit);
    const page = this.pendingLedgerPage(null, limit);
    const results = page.ledgerEntryIds.map((ledgerEntryId) => this.reconcileEntry(ledgerEntryId, nowInput));
    return Object.freeze({
      processed: results.length,
      results: Object.freeze(results),
      hasMore: page.hasMore,
    });
  }

  pendingLedgerPage(
    cursor: ReconciliationSweepCursor | null,
    limit = MAX_RECONCILIATION_BATCH_SIZE,
  ): PendingLedgerPage {
    validateBatchLimit(limit);
    if (cursor !== null) {
      requireIdentifier(cursor.ledgerEntryId, "reconciliation cursor ledger entry ID");
      if (!Number.isSafeInteger(cursor.occurredAt) || cursor.occurredAt < 0) {
        throw new RangeError("reconciliation cursor occurrence is invalid");
      }
    }
    const rows = this.#database.read((connection) => connection
      .prepare(
        `SELECT ledger_entry_id, occurred_at
          FROM ledger_entries
          WHERE state IN ('UNALLOCATED', 'CANDIDATE')
            AND NOT EXISTS (
              SELECT 1
                FROM ledger_conflicts AS conflict
               WHERE conflict.existing_ledger_entry_id = ledger_entries.ledger_entry_id
                 AND conflict.status = 'OPEN'
            )
            AND (
              ? IS NULL OR occurred_at > ? OR
              (occurred_at = ? AND ledger_entry_id > ?)
            )
          ORDER BY occurred_at, ledger_entry_id
          LIMIT ?`,
      )
      .all(
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.occurredAt ?? null,
        cursor?.ledgerEntryId ?? null,
        limit + 1,
      ) as unknown as Array<{ ledger_entry_id: string; occurred_at: bigint | number }>);
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return Object.freeze({
      ledgerEntryIds: Object.freeze(selected.map((row) => row.ledger_entry_id)),
      nextCursor: last
        ? Object.freeze({
          occurredAt: toSafeInteger(last.occurred_at, "reconciliation cursor occurrence"),
          ledgerEntryId: last.ledger_entry_id,
        })
        : null,
      hasMore: rows.length > limit,
    });
  }

  reconcileOrder(orderId: string, limit = MAX_RECONCILIATION_BATCH_SIZE, nowInput?: number): ReconciliationBatchResult {
    requireIdentifier(orderId, "order ID");
    validateBatchLimit(limit);
    const ids = this.#database.read((connection) =>
      (connection
        .prepare(
          `SELECT entry.ledger_entry_id
             FROM payment_orders AS orders
             JOIN collection_profiles AS profile
               ON profile.profile_id = orders.collection_profile_id
             JOIN collection_profile_provider_accounts AS profile_provider
               ON profile_provider.profile_id = profile.profile_id
             JOIN amount_slots AS slot ON slot.order_id = orders.order_id
             JOIN ledger_entries AS entry
               ON entry.provider_account_key = profile_provider.provider_account_key
              AND entry.direction = 'CREDIT'
              AND entry.currency = orders.currency
              AND entry.amount_cents = orders.payable_amount_cents
              AND entry.occurred_at + entry.occurred_at_precision_ms > orders.eligible_from
              AND entry.occurred_at + entry.occurred_at_precision_ms > slot.occupied_from
              AND entry.occurred_at < orders.expires_at
              AND (slot.released_at IS NULL OR entry.occurred_at < slot.released_at)
            WHERE orders.order_id = ?
              AND entry.state IN ('UNALLOCATED', 'CANDIDATE')
              AND NOT EXISTS (
                SELECT 1
                  FROM ledger_conflicts AS conflict
                 WHERE conflict.existing_ledger_entry_id = entry.ledger_entry_id
                   AND conflict.status = 'OPEN'
              )
            ORDER BY entry.occurred_at, entry.ledger_entry_id
            LIMIT ?`,
        )
        .all(orderId, limit + 1) as Array<{ ledger_entry_id: string }>).map((row) => row.ledger_entry_id),
    );
    const selected = ids.slice(0, limit);
    const results = selected.map((ledgerEntryId) => this.reconcileEntry(ledgerEntryId, nowInput));
    return Object.freeze({
      processed: results.length,
      results: Object.freeze(results),
      hasMore: ids.length > limit,
    });
  }

  settleManually(input: ManualSettlementInput): FinancialDecisionResult {
    validateManualSettlementInput(input);
    return this.#database.write((connection) => {
      const now = financialNow(connection, input.now);
      const existingOperation = readOperation(connection, input.financialOperationId);
      const existingMatch = existingOperation?.operationType === "MANUAL_SETTLEMENT"
        ? readPaymentMatchByCreationOperation(connection, existingOperation.financialOperationId)
        : null;
      const paymentMatchId = existingMatch?.paymentMatchId ?? randomUUID();
      const operationInput: FinancialOperationFingerprintInput = {
        operationType: "MANUAL_SETTLEMENT",
        actorType: "ADMIN",
        actorId: input.actorId,
        orderId: input.orderId,
        ledgerEntryId: input.ledgerEntryId,
        candidateId: null,
        paymentMatchId,
        reversesOperationId: null,
        reason: input.reason,
      };
      const replay = readDecisionReplay(connection, input.financialOperationId, operationInput);
      if (replay) return decisionResult(connection, replay, paymentMatchId, true);

      const entry = requireLedgerEntry(connection, input.ledgerEntryId);
      const order = requireOrderDecision(connection, input.orderId);
      if (
        entry.direction !== "CREDIT" ||
        entry.currency !== order.currency ||
        !["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state) ||
        order.payment_status !== "UNPAID" ||
        order.payment_basis !== "NONE" ||
        readActiveMatchForEntry(connection, entry.ledger_entry_id) !== null ||
        !orderUsesProviderAccount(connection, order.order_id, entry.provider_account_key)
      ) {
        throw new ReconciliationError("match_state_conflict", "manual settlement facts are not eligible");
      }

      supersedeStaleEligibleCandidates(connection, entry, new Set(), now);
      const operation = insertFinancialOperation(connection, {
        financialOperationId: input.financialOperationId,
        operationKey: `admin:${input.financialOperationId}`,
        fingerprintInput: operationInput,
        orderId: order.order_id,
        ledgerEntryId: entry.ledger_entry_id,
        reversesOperationId: null,
        reason: input.reason,
        now,
      });
      const receivedAmountCents = toSafeInteger(entry.amount_cents, "ledger amount");
      postAccountingTransaction(connection, {
        operation,
        orderId: order.order_id,
        ledgerEntryId: entry.ledger_entry_id,
        transactionType: "SETTLEMENT",
        amountCents: receivedAmountCents,
        debitAccount: "PROVIDER_CASH",
        creditAccount: "ORDER_SETTLEMENT",
        now,
      });
      const evidence = manualSettlementEvidence({
        financialOperationId: operation.financialOperationId,
        actorId: input.actorId,
        reason: input.reason,
      });
      assertChangedOnce(
        connection
          .prepare(
            `INSERT INTO payment_matches(
               payment_match_id, ledger_entry_id, order_id, candidate_id,
               match_role, evidence_type, evidence_json, status,
               created_by_operation_id, resolved_by_operation_id,
               created_at, updated_at, resolved_at
             ) VALUES (?, ?, ?, NULL, 'PRIMARY_SETTLEMENT', 'MANUAL', ?,
                       'SETTLED', ?, ?, ?, ?, ?)`,
          )
          .run(
            paymentMatchId,
            entry.ledger_entry_id,
            order.order_id,
            JSON.stringify(evidence),
            operation.financialOperationId,
            operation.financialOperationId,
            now,
            now,
            now,
          ).changes,
        "manual payment match insert",
      );
      setLedgerState(connection, entry, "ALLOCATED", now);
      const nextVersion = updateOrderPayment(connection, {
        order,
        paymentStatus: "CONFIRMED",
        paymentBasis: "MANUAL",
        receivedAmountCents,
        now,
      });
      insertOrderEvent(connection, {
        orderId: order.order_id,
        sequence: nextVersion,
        type: "PAYMENT_CONFIRMED",
        now,
        details: {
          financial_operation_id: operation.financialOperationId,
          payment_match_id: paymentMatchId,
          evidence_type: "MANUAL",
        },
      });
      insertOutboxEvent(connection, {
        operation,
        order: {
          ...order,
          received_amount_cents: BigInt(receivedAmountCents),
          payment_status: "CONFIRMED",
          payment_basis: "MANUAL",
          version: nextVersion,
        },
        eventType: "PAYMENT_CONFIRMED",
        eventDetails: {
          payment_match_id: paymentMatchId,
          evidence_type: "MANUAL",
        },
        now,
      });
      resolveEntryExceptions(
        connection,
        entry.ledger_entry_id,
        operation,
        "manually_settled",
        paymentMatchId,
        now,
      );
      return decisionResult(connection, operation, paymentMatchId, false);
    });
  }

  recordRefund(input: RefundRecordInput): RefundRecordResult {
    validateRefundRecordInput(input);
    return this.#database.write((connection) => {
      const now = financialNow(connection, input.now);
      const operationInput: FinancialOperationFingerprintInput = {
        operationType: "RECORD_REFUND",
        actorType: "ADMIN",
        actorId: input.actorId,
        orderId: input.orderId,
        ledgerEntryId: input.ledgerEntryId,
        candidateId: null,
        paymentMatchId: null,
        reversesOperationId: null,
        reason: input.reason,
      };
      const replay = readDecisionReplay(connection, input.financialOperationId, operationInput);
      if (replay) return refundDecisionResult(connection, replay, true);

      const entry = requireLedgerEntry(connection, input.ledgerEntryId);
      const order = requireOrderDecision(connection, input.orderId);
      if (
        entry.direction !== "DEBIT" ||
        entry.currency !== order.currency ||
        !["UNALLOCATED", "CONFLICT"].includes(entry.state) ||
        !["CONFIRMED", "DISPUTED"].includes(order.payment_status) ||
        order.refund_status === "FULL" ||
        !orderUsesProviderAccount(connection, order.order_id, entry.provider_account_key)
      ) {
        throw new ReconciliationError("match_state_conflict", "refund facts are not eligible");
      }

      const amountCents = toSafeInteger(entry.amount_cents, "refund ledger amount");
      const receivedAmountCents = toSafeInteger(order.received_amount_cents, "received amount");
      if (amountCents > 9_999_999_999) {
        throw new ReconciliationError("match_state_conflict", "refund amount exceeds the order boundary");
      }
      const previousRefunded = readRecordedRefundTotal(connection, order.order_id);
      const refundedAmountCents = previousRefunded + amountCents;
      if (
        !Number.isSafeInteger(refundedAmountCents) ||
        refundedAmountCents > receivedAmountCents
      ) {
        throw new ReconciliationError(
          "match_state_conflict",
          "cumulative refund amount exceeds the received amount",
        );
      }

      const operation = insertFinancialOperation(connection, {
        financialOperationId: input.financialOperationId,
        operationKey: `admin:${input.financialOperationId}`,
        fingerprintInput: operationInput,
        orderId: order.order_id,
        ledgerEntryId: entry.ledger_entry_id,
        reversesOperationId: null,
        reason: input.reason,
        now,
      });
      postAccountingTransaction(connection, {
        operation,
        orderId: order.order_id,
        ledgerEntryId: entry.ledger_entry_id,
        transactionType: "REFUND",
        amountCents,
        debitAccount: "REFUND_CLEARING",
        creditAccount: "PROVIDER_CASH",
        now,
      });
      const refundRecordId = randomUUID();
      assertChangedOnce(
        connection
          .prepare(
            `INSERT INTO refund_records(
               refund_record_id, financial_operation_id, ledger_entry_id,
               order_id, amount_cents, evidence_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            refundRecordId,
            operation.financialOperationId,
            entry.ledger_entry_id,
            order.order_id,
            amountCents,
            JSON.stringify(refundRecordEvidence({
              financialOperationId: operation.financialOperationId,
              actorId: input.actorId,
              reason: input.reason,
            })),
            now,
          ).changes,
        "refund record insert",
      );
      setLedgerState(connection, entry, "ALLOCATED", now);
      const refundStatus = refundedAmountCents >= receivedAmountCents ? "FULL" : "PARTIAL";
      const nextVersion = updateOrderRefund(connection, order, refundStatus, now);
      insertOrderEvent(connection, {
        orderId: order.order_id,
        sequence: nextVersion,
        type: "REFUND_UPDATED",
        now,
        details: {
          financial_operation_id: operation.financialOperationId,
          refund_record_id: refundRecordId,
          refund_amount_cents: amountCents,
          refunded_amount_cents: refundedAmountCents,
          refund_status: refundStatus,
        },
      });
      insertOutboxEvent(connection, {
        operation,
        order: { ...order, refund_status: refundStatus, version: nextVersion },
        eventType: "REFUND_UPDATED",
        eventDetails: {
          refund_record_id: refundRecordId,
          refund_amount_cents: amountCents,
          refunded_amount_cents: refundedAmountCents,
        },
        now,
      });
      resolveEntryExceptions(
        connection,
        entry.ledger_entry_id,
        operation,
        "refund_recorded",
        refundRecordId,
        now,
      );
      return Object.freeze({
        operation,
        refundRecordId,
        orderId: order.order_id,
        ledgerEntryId: entry.ledger_entry_id,
        refundStatus,
        orderVersion: nextVersion,
        replayed: false,
      });
    });
  }

  reverseSettlement(input: FinancialDecisionInput): FinancialDecisionResult {
    validateDecisionInput(input);
    return this.#database.write((connection) => {
      const now = financialNow(connection, input.now);
      const match = readPaymentMatch(connection, input.paymentMatchId);
      if (!match) throw new ReconciliationError("match_not_found", "payment match does not exist");
      const existingOperation = readOperation(connection, input.financialOperationId);
      const reversesOperationId = existingOperation?.operationType === "REVERSE_SETTLEMENT"
        ? existingOperation.reversesOperationId
        : match.resolvedByOperationId;
      const operationInput: FinancialOperationFingerprintInput = {
        operationType: "REVERSE_SETTLEMENT",
        actorType: "ADMIN",
        actorId: input.actorId,
        orderId: match.orderId,
        ledgerEntryId: match.ledgerEntryId,
        candidateId: match.candidateId,
        paymentMatchId: match.paymentMatchId,
        reversesOperationId,
        reason: input.reason,
      };
      const replay = readDecisionReplay(connection, input.financialOperationId, operationInput);
      if (replay) return decisionResult(connection, replay, match.paymentMatchId, true);
      if (match.status !== "SETTLED" || match.resolvedByOperationId === null) {
        throw new ReconciliationError("match_state_conflict", "only a settled match can be reversed");
      }
      const entry = requireLedgerEntry(connection, match.ledgerEntryId);
      const order = requireOrderDecision(connection, match.orderId);
      if (entry.state !== "ALLOCATED" || order.payment_status !== "CONFIRMED") {
        throw new ReconciliationError("match_state_conflict", "settlement facts have changed");
      }

      const operation = insertFinancialOperation(connection, {
        financialOperationId: input.financialOperationId,
        operationKey: `admin:${input.financialOperationId}`,
        fingerprintInput: operationInput,
        orderId: match.orderId,
        ledgerEntryId: match.ledgerEntryId,
        reversesOperationId: match.resolvedByOperationId,
        reason: input.reason,
        now,
      });
      postAccountingTransaction(connection, {
        operation,
        orderId: match.orderId,
        ledgerEntryId: match.ledgerEntryId,
        transactionType: "REVERSAL",
        amountCents: toSafeInteger(order.received_amount_cents, "received amount"),
        debitAccount: "ORDER_SETTLEMENT",
        creditAccount: "PROVIDER_CASH",
        now,
      });
      assertChangedOnce(
        connection
          .prepare(
            `UPDATE payment_matches
                SET status = 'REVERSED', resolved_by_operation_id = ?,
                    updated_at = ?, resolved_at = ?
              WHERE payment_match_id = ? AND status = 'SETTLED'`,
          )
          .run(operation.financialOperationId, now, now, match.paymentMatchId).changes,
        "payment match reversal",
      );
      setLedgerState(connection, entry, "CONFLICT", now);
      const nextVersion = updateOrderPayment(connection, {
        order,
        paymentStatus: "DISPUTED",
        paymentBasis: order.payment_basis,
        receivedAmountCents: toSafeInteger(order.received_amount_cents, "received amount"),
        now,
      });
      insertOrderEvent(connection, {
        orderId: order.order_id,
        sequence: nextVersion,
        type: "PAYMENT_DISPUTED",
        now,
        details: {
          financial_operation_id: operation.financialOperationId,
          payment_match_id: match.paymentMatchId,
        },
      });
      insertOutboxEvent(connection, {
        operation,
        order: { ...order, payment_status: "DISPUTED", payment_basis: order.payment_basis, version: nextVersion },
        eventType: "PAYMENT_DISPUTED",
        eventDetails: { payment_match_id: match.paymentMatchId },
        now,
      });
      ensureException(connection, {
        providerAccountKey: entry.provider_account_key,
        exceptionType: "RECONCILIATION_CONFLICT",
        ledgerEntryId: entry.ledger_entry_id,
        orderId: order.order_id,
        candidateId: match.candidateId,
        contextKey: operation.financialOperationId,
        details: { reason: "settlement_reversed", payment_match_id: match.paymentMatchId },
        now,
      });
      return decisionResult(connection, operation, match.paymentMatchId, false);
    });
  }

  candidate(candidateId: string): MatchCandidate | null {
    requireIdentifier(candidateId, "candidate ID");
    return this.#database.read((connection) => readCandidate(connection, candidateId));
  }

  paymentMatch(paymentMatchId: string): PaymentMatch | null {
    requireIdentifier(paymentMatchId, "payment match ID");
    return this.#database.read((connection) => readPaymentMatch(connection, paymentMatchId));
  }

  paymentMatchDetail(paymentMatchId: string): PaymentMatchDetail | null {
    requireIdentifier(paymentMatchId, "payment match ID");
    return this.#database.read((connection) => {
      const paymentMatch = readPaymentMatch(connection, paymentMatchId);
      return paymentMatch ? requirePaymentMatchDetail(connection, paymentMatch) : null;
    });
  }

  paymentMatchDetailsForOrder(orderId: string): readonly PaymentMatchDetail[] {
    requireIdentifier(orderId, "order ID");
    return this.#database.read((connection) => {
      const rows = connection
        .prepare(
          `SELECT payment_match_id, ledger_entry_id, order_id, candidate_id,
                  evidence_type, evidence_json, status, created_by_operation_id,
                  resolved_by_operation_id, created_at, updated_at, resolved_at
             FROM payment_matches
            WHERE order_id = ?
            ORDER BY created_at DESC, payment_match_id DESC`,
        )
        .all(orderId) as unknown as PaymentMatchRow[];
      return readPaymentMatchDetails(connection, rows.map(mapPaymentMatch));
    });
  }

  paymentMatchHistoryPage(
    status: PaymentMatchStatus = "SETTLED",
    cursor: PaymentMatchHistoryCursor | null = null,
    limit = 100,
  ): PaymentMatchHistoryPage {
    if (!PAYMENT_MATCH_STATUSES.has(status)) {
      throw new RangeError("payment match history status is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("payment match history limit is invalid");
    }
    if (cursor !== null) {
      if (!Number.isSafeInteger(cursor.eventSequence) || cursor.eventSequence < 1) {
        throw new RangeError("payment match history cursor sequence is invalid");
      }
    }
    return this.#database.read((connection) => {
      const rows = connection
        .prepare(
          `SELECT payment_match.payment_match_id, payment_match.ledger_entry_id,
                  payment_match.order_id, payment_match.candidate_id,
                  payment_match.evidence_type, payment_match.evidence_json,
                  payment_match.status, payment_match.created_by_operation_id,
                  payment_match.resolved_by_operation_id, payment_match.created_at,
                  payment_match.updated_at, payment_match.resolved_at,
                  match_event.event_sequence
             FROM payment_match_events AS match_event
             JOIN payment_matches AS payment_match
               ON payment_match.payment_match_id = match_event.payment_match_id
              AND payment_match.status = match_event.status
            WHERE match_event.status = ?
              AND (? IS NULL OR match_event.event_sequence > ?)
            ORDER BY match_event.event_sequence
            LIMIT ?`,
        )
        .all(
          status,
          cursor?.eventSequence ?? null,
          cursor?.eventSequence ?? null,
          limit + 1,
        ) as unknown as PaymentMatchHistoryPageRow[];
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);
      return Object.freeze({
        matches: readPaymentMatchDetails(connection, selected.map(mapPaymentMatch)),
        nextCursor: rows.length > limit && last
          ? Object.freeze({
              eventSequence: toSafeInteger(
                last.event_sequence,
                "payment match history cursor sequence",
              ),
            })
          : null,
      });
    });
  }

  ledgerEntry(ledgerEntryId: string): ReconciliationLedgerProjection | null {
    requireIdentifier(ledgerEntryId, "ledger entry ID");
    return this.#database.read((connection) => readReviewLedgerEntry(connection, ledgerEntryId));
  }

  exception(exceptionId: string): FinancialException | null {
    requireIdentifier(exceptionId, "financial exception ID");
    return this.#database.read((connection) => {
      const row = connection
        .prepare(`${EXCEPTION_COLUMNS} WHERE exception_id = ?`)
        .get(exceptionId) as unknown as ExceptionRow | undefined;
      return row ? mapException(row) : null;
    });
  }

  financialExceptionsForOrder(orderId: string): readonly FinancialException[] {
    requireIdentifier(orderId, "order ID");
    return this.#database.read((connection) => Object.freeze(
      (connection
        .prepare(`${EXCEPTION_COLUMNS} WHERE order_id = ? ORDER BY created_at DESC, exception_id DESC`)
        .all(orderId) as unknown as ExceptionRow[]).map(mapException),
    ));
  }

  listCandidates(ledgerEntryId: string): readonly MatchCandidate[] {
    requireIdentifier(ledgerEntryId, "ledger entry ID");
    return this.#database.read((connection) => Object.freeze(
      (connection
        .prepare(`${CANDIDATE_COLUMNS} WHERE ledger_entry_id = ? ORDER BY created_at, candidate_id`)
        .all(ledgerEntryId) as unknown as CandidateRow[]).map(mapCandidate),
    ));
  }

  listOpenExceptions(providerAccountKey = "primary", limit = 100): readonly FinancialException[] {
    return this.openExceptionPage(providerAccountKey, null, limit).exceptions;
  }

  exceptionSummary(providerAccountKey = "primary"): FinancialExceptionSummary {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerAccountKey)) {
      throw new RangeError("provider account key is invalid");
    }
    return this.#database.read((connection) => {
      const row = connection
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
             SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved_count,
             COUNT(*) AS total_count
             FROM financial_exceptions
            WHERE provider_account_key = ?`,
        )
        .get(providerAccountKey) as {
          open_count: bigint | number | null;
          resolved_count: bigint | number | null;
          total_count: bigint | number;
        };
      return Object.freeze({
        providerAccountKey,
        open: row.open_count === null ? 0 : toSafeInteger(row.open_count, "open exception count"),
        resolved: row.resolved_count === null
          ? 0
          : toSafeInteger(row.resolved_count, "resolved exception count"),
        total: toSafeInteger(row.total_count, "exception count"),
      });
    });
  }

  openExceptionPage(
    providerAccountKey = "primary",
    cursor: FinancialExceptionCursor | null = null,
    limit = 100,
  ): FinancialExceptionPage {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerAccountKey)) {
      throw new RangeError("provider account key is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("exception limit is invalid");
    }
    if (cursor !== null) {
      requireIdentifier(cursor.exceptionId, "financial exception cursor ID");
      if (!Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0) {
        throw new RangeError("financial exception cursor time is invalid");
      }
    }
    const rows = this.#database.read((connection) => connection
        .prepare(
          `${EXCEPTION_COLUMNS}
            WHERE provider_account_key = ? AND status = 'OPEN'
              AND (
                ? IS NULL OR created_at > ? OR
                (created_at = ? AND exception_id > ?)
              )
            ORDER BY created_at, exception_id
            LIMIT ?`,
        )
        .all(
          providerAccountKey,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.exceptionId ?? null,
          limit + 1,
        ) as unknown as ExceptionRow[]);
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return Object.freeze({
      exceptions: Object.freeze(selected.map(mapException)),
      nextCursor: rows.length > limit && last
        ? Object.freeze({
            createdAt: toSafeInteger(last.created_at, "financial exception cursor time"),
            exceptionId: last.exception_id,
          })
        : null,
    });
  }

}

const CANDIDATE_COLUMNS = `
  SELECT candidate_id, ledger_entry_id, order_id, slot_id, evidence_type,
         rule_version, evidence_json, candidate_fingerprint, status,
         decided_by_operation_id,
         created_at, updated_at, decided_at
    FROM match_candidates`;

const PAYMENT_MATCH_COLUMNS = `
  SELECT payment_match_id, ledger_entry_id, order_id, candidate_id,
         evidence_type, evidence_json, status, created_by_operation_id,
         resolved_by_operation_id, created_at, updated_at, resolved_at
    FROM payment_matches`;

const REVIEW_LEDGER_COLUMNS = `
  SELECT ledger_entry_id, external_event_id, semantic_fingerprint,
         occurred_at, occurred_at_precision_ms, amount_cents, direction, currency,
         alipay_order_no, merchant_order_no, trans_memo, other_account,
         state, created_at, updated_at
    FROM ledger_entries`;

const REVIEW_ORDER_COLUMNS = `
  SELECT order_id, merchant_order_no, requested_amount_cents,
         payable_amount_cents, received_amount_cents, currency,
         product_name, note, checkout_status, payment_status, payment_basis,
         refund_status, eligible_from, created_at, expires_at,
         closed_at, updated_at, version
    FROM payment_orders`;

const OPERATION_COLUMNS = `
  SELECT financial_operation_id, operation_key, request_fingerprint,
         operation_type, actor_type, actor_id, order_id, ledger_entry_id,
         reverses_operation_id, reason, created_at
    FROM financial_operations`;

const EXCEPTION_COLUMNS = `
  SELECT exception_id, provider_account_key, exception_type, ledger_entry_id,
         order_id, candidate_id, context_key, details_json, details_fingerprint,
         exception_fingerprint, status, resolution_operation_id,
         resolution_json, resolution_fingerprint, created_at, resolved_at
    FROM financial_exceptions`;

const PAYMENT_MATCH_STATUSES = new Set<PaymentMatchStatus>(["SETTLED", "REVERSED"]);

function readLedgerEntry(connection: DatabaseSync, ledgerEntryId: string): LedgerEntryRow | null {
  return connection
    .prepare(
      `SELECT ledger_entry_id, provider_account_key, semantic_fingerprint,
              occurred_at, occurred_at_precision_ms, amount_cents, direction, currency, state
         FROM ledger_entries
        WHERE ledger_entry_id = ?`,
    )
    .get(ledgerEntryId) as unknown as LedgerEntryRow | undefined ?? null;
}

function hasOpenLedgerConflict(connection: DatabaseSync, ledgerEntryId: string): boolean {
  const row = connection
    .prepare(
      `SELECT EXISTS(
         SELECT 1
           FROM ledger_conflicts
          WHERE existing_ledger_entry_id = ? AND status = 'OPEN'
       ) AS has_conflict`,
    )
    .get(ledgerEntryId) as { has_conflict: bigint | number };
  return Number(row.has_conflict) === 1;
}

function readReviewLedgerEntry(
  connection: DatabaseSync,
  ledgerEntryId: string,
): ReconciliationLedgerProjection | null {
  const row = connection
    .prepare(`${REVIEW_LEDGER_COLUMNS} WHERE ledger_entry_id = ?`)
    .get(ledgerEntryId) as unknown as ReviewLedgerRow | undefined;
  return row ? mapReviewLedger(row) : null;
}

function mapReviewLedger(row: ReviewLedgerRow): ReconciliationLedgerProjection {
  const occurredAt = toSafeInteger(row.occurred_at, "ledger occurrence time");
  const occurredAtPrecisionMilliseconds = toTimestampPrecision(
    row.occurred_at_precision_ms,
    "ledger occurrence precision",
  );
  return Object.freeze({
    ledgerEntryId: row.ledger_entry_id,
    externalEventId: row.external_event_id,
    semanticFingerprint: row.semantic_fingerprint,
    occurredAt,
    occurredAtPrecisionMilliseconds,
    occurredAtIntervalEndExclusive: occurredAt + occurredAtPrecisionMilliseconds,
    amountCents: toSafeInteger(row.amount_cents, "ledger amount"),
    direction: row.direction,
    currency: row.currency,
    alipayOrderNo: row.alipay_order_no,
    merchantOrderNo: row.merchant_order_no,
    transMemo: row.trans_memo,
    otherAccount: row.other_account,
    state: row.state,
    createdAt: toSafeInteger(row.created_at, "ledger creation time"),
    updatedAt: toSafeInteger(row.updated_at, "ledger update time"),
  });
}

function requirePaymentMatchDetail(
  connection: DatabaseSync,
  paymentMatch: PaymentMatch,
): PaymentMatchDetail {
  const ledgerEntry = readReviewLedgerEntry(connection, paymentMatch.ledgerEntryId);
  const order = readReviewOrder(connection, paymentMatch.orderId);
  if (!ledgerEntry || !order) {
    throw new Error("payment match facts are incomplete");
  }
  return Object.freeze({
    paymentMatch,
    candidate: paymentMatch.candidateId
      ? readCandidate(connection, paymentMatch.candidateId)
      : null,
    ledgerEntry,
    order,
  });
}

function readPaymentMatchDetails(
  connection: DatabaseSync,
  paymentMatches: readonly PaymentMatch[],
): readonly PaymentMatchDetail[] {
  if (paymentMatches.length === 0) return Object.freeze([]);
  const candidateIds = paymentMatches.flatMap((match) =>
    match.candidateId === null ? [] : [match.candidateId]
  );
  const candidates = new Map(
    (candidateIds.length === 0
      ? []
      : (connection
          .prepare(`${CANDIDATE_COLUMNS} WHERE candidate_id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(candidateIds)) as unknown as CandidateRow[])
    ).map((row) => {
      const candidate = mapCandidate(row);
      return [candidate.candidateId, candidate] as const;
    }),
  );
  const ledgerEntries = new Map(
    (connection
      .prepare(`${REVIEW_LEDGER_COLUMNS} WHERE ledger_entry_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(paymentMatches.map((match) => match.ledgerEntryId))) as unknown as ReviewLedgerRow[])
      .map((row) => {
        const entry = mapReviewLedger(row);
        return [entry.ledgerEntryId, entry] as const;
      }),
  );
  const orders = new Map(
    (connection
      .prepare(`${REVIEW_ORDER_COLUMNS} WHERE order_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(paymentMatches.map((match) => match.orderId))) as unknown as ReviewOrderRow[])
      .map((row) => {
        const order = mapReviewOrder(row);
        return [order.orderId, order] as const;
      }),
  );
  return Object.freeze(paymentMatches.map((paymentMatch) => {
    const ledgerEntry = ledgerEntries.get(paymentMatch.ledgerEntryId);
    const order = orders.get(paymentMatch.orderId);
    const candidate = paymentMatch.candidateId === null
      ? null
      : candidates.get(paymentMatch.candidateId);
    if (!ledgerEntry || !order || candidate === undefined) {
      throw new Error("payment match facts are incomplete");
    }
    return Object.freeze({ paymentMatch, candidate, ledgerEntry, order });
  }));
}

function readReviewOrder(
  connection: DatabaseSync,
  orderId: string,
): ReconciliationOrderProjection | null {
  const row = connection
    .prepare(`${REVIEW_ORDER_COLUMNS} WHERE order_id = ?`)
    .get(orderId) as unknown as ReviewOrderRow | undefined;
  return row ? mapReviewOrder(row) : null;
}

function mapReviewOrder(row: ReviewOrderRow): ReconciliationOrderProjection {
  return Object.freeze({
    orderId: row.order_id,
    merchantOrderNo: row.merchant_order_no,
    requestedAmountCents: toSafeInteger(row.requested_amount_cents, "requested amount"),
    payableAmountCents: toSafeInteger(row.payable_amount_cents, "payable amount"),
    receivedAmountCents: nullableSafeInteger(row.received_amount_cents, "received amount"),
    currency: row.currency,
    productName: row.product_name,
    note: row.note,
    checkoutStatus: row.checkout_status,
    paymentStatus: row.payment_status,
    paymentBasis: row.payment_basis,
    refundStatus: row.refund_status,
    eligibleFrom: toSafeInteger(row.eligible_from, "order eligibility time"),
    createdAt: toSafeInteger(row.created_at, "order creation time"),
    expiresAt: toSafeInteger(row.expires_at, "order expiry time"),
    closedAt: nullableSafeInteger(row.closed_at, "order close time"),
    updatedAt: toSafeInteger(row.updated_at, "order update time"),
    version: toSafeInteger(row.version, "order version"),
  });
}

function requireLedgerEntry(connection: DatabaseSync, ledgerEntryId: string): LedgerEntryRow {
  const entry = readLedgerEntry(connection, ledgerEntryId);
  if (!entry) throw new ReconciliationError("match_state_conflict", "ledger entry does not exist");
  return entry;
}

function readCandidateFacts(connection: DatabaseSync, entry: LedgerEntryRow): CandidateFactRow[] {
  return connection
    .prepare(
      `SELECT orders.order_id, orders.collection_profile_id, slot.slot_id,
              slot.generation, slot.occupied_from, slot.released_at,
              orders.payment_status
         FROM payment_orders AS orders
         JOIN collection_profiles AS profile
           ON profile.profile_id = orders.collection_profile_id
         JOIN collection_profile_provider_accounts AS profile_provider
           ON profile_provider.profile_id = profile.profile_id
         JOIN amount_slots AS slot ON slot.order_id = orders.order_id
        WHERE profile_provider.provider_account_key = ?
          AND orders.currency = ?
          AND orders.payable_amount_cents = ?
          AND ? + ? > orders.eligible_from
          AND ? + ? > slot.occupied_from
          AND ? < orders.expires_at
          AND (slot.released_at IS NULL OR ? < slot.released_at)
          AND orders.payment_status = 'UNPAID'
        ORDER BY orders.eligible_from, orders.order_id`,
    )
    .all(
      entry.provider_account_key,
      entry.currency,
      entry.amount_cents,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at,
    ) as unknown as CandidateFactRow[];
}

interface SettledOrderOverlap {
  readonly count: number;
  readonly orderId: string | null;
}

function readSettledOrderOverlap(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
): SettledOrderOverlap {
  const row = connection
    .prepare(
      `SELECT COUNT(*) AS overlap_count,
              CASE
                WHEN COUNT(*) = 1 THEN MIN(overlap.order_id)
                ELSE NULL
              END AS order_id
         FROM (
           SELECT orders.order_id
            FROM amount_slots AS slot
            JOIN payment_orders AS orders
              ON orders.order_id = slot.order_id
              AND orders.collection_profile_id = slot.collection_profile_id
              AND orders.payable_amount_cents = slot.payable_amount_cents
            JOIN collection_profile_provider_accounts AS profile_provider
              ON profile_provider.profile_id = slot.collection_profile_id
            WHERE slot.collection_profile_id IN (
                    SELECT profile_id
                      FROM collection_profile_provider_accounts
                     WHERE provider_account_key = ?
                  )
              AND slot.payable_amount_cents = ?
              AND orders.currency = ?
              AND ? + ? > orders.eligible_from
              AND ? + ? > slot.occupied_from
              AND ? < orders.expires_at
              AND (slot.released_at IS NULL OR ? < slot.released_at)
              AND orders.payment_status IN ('CONFIRMED', 'DISPUTED')
            LIMIT 2
         ) AS overlap`,
    )
    .get(
      entry.provider_account_key,
      entry.amount_cents,
      entry.currency,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at,
    ) as { overlap_count: bigint | number; order_id: string | null };
  return Object.freeze({
    count: toSafeInteger(row.overlap_count, "settled order overlap count"),
    orderId: row.order_id,
  });
}

interface UnmatchedCreditClassification {
  readonly exceptionType: Extract<
    FinancialExceptionType,
    "UNMATCHED_CREDIT" | "DUPLICATE_PAYMENT" | "CHECKOUT_ENDED_PAYMENT" | "AMOUNT_MISMATCH"
  >;
  readonly orderId: string | null;
  readonly contextKey: string;
  readonly details: Readonly<Record<string, unknown>>;
}

function classifyUnmatchedCredit(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
  settledOrderOverlap: SettledOrderOverlap,
): UnmatchedCreditClassification {
  const previousContext = latestMatchContext(connection, entry.ledger_entry_id);
  if (settledOrderOverlap.count > 0) {
    return duplicatePaymentClassification(settledOrderOverlap);
  }

  const ended = connection
    .prepare(
      `SELECT orders.order_id,
              CASE
                WHEN orders.checkout_status = 'OPEN' THEN 'EXPIRED'
                ELSE orders.checkout_status
              END AS checkout_status,
              min(
                orders.expires_at,
                coalesce(slot.released_at, orders.expires_at)
              ) AS ended_at
         FROM payment_orders AS orders
         JOIN collection_profiles AS profile
           ON profile.profile_id = orders.collection_profile_id
         JOIN collection_profile_provider_accounts AS profile_provider
           ON profile_provider.profile_id = profile.profile_id
         JOIN amount_slots AS slot ON slot.order_id = orders.order_id
        WHERE profile_provider.provider_account_key = ?
          AND orders.currency = ?
          AND orders.payable_amount_cents = ?
          AND ? >= min(
            orders.expires_at,
            coalesce(slot.released_at, orders.expires_at)
          )
          AND ? - min(
            orders.expires_at,
            coalesce(slot.released_at, orders.expires_at)
          ) <= ?
        ORDER BY ended_at DESC, orders.order_id
        LIMIT 2`,
    )
    .all(
      entry.provider_account_key,
      entry.currency,
      entry.amount_cents,
      entry.occurred_at,
      entry.occurred_at,
      MAX_LATE_PAYMENT_ATTRIBUTION_MILLISECONDS,
    ) as unknown as Array<{
      order_id: string;
      checkout_status: "CLOSED" | "EXPIRED";
      ended_at: bigint | number;
    }>;
  if (ended.length === 1 && ended[0]) {
    return {
      exceptionType: "CHECKOUT_ENDED_PAYMENT",
      orderId: ended[0].order_id,
      contextKey: `order:${ended[0].order_id}`,
      details: {
        reason: "exact_amount_arrived_after_checkout_end",
        checkout_status: ended[0].checkout_status,
        checkout_ended_at: toSafeInteger(ended[0].ended_at, "effective checkout end time"),
        attribution_window_milliseconds: MAX_LATE_PAYMENT_ATTRIBUTION_MILLISECONDS,
      },
    };
  }

  const possibleMismatch = connection
    .prepare(
      `SELECT orders.order_id, orders.payable_amount_cents
         FROM payment_orders AS orders
         JOIN collection_profiles AS profile
           ON profile.profile_id = orders.collection_profile_id
         JOIN collection_profile_provider_accounts AS profile_provider
           ON profile_provider.profile_id = profile.profile_id
         JOIN amount_slots AS slot ON slot.order_id = orders.order_id
        WHERE profile_provider.provider_account_key = ?
          AND orders.currency = ?
          AND orders.payable_amount_cents != ?
          AND orders.payment_status = 'UNPAID'
          AND ? + ? > orders.eligible_from
          AND ? + ? > slot.occupied_from
          AND ? < orders.expires_at
          AND (slot.released_at IS NULL OR ? < slot.released_at)
        ORDER BY orders.eligible_from, orders.order_id
        LIMIT 2`,
    )
    .all(
      entry.provider_account_key,
      entry.currency,
      entry.amount_cents,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at_precision_ms,
      entry.occurred_at,
      entry.occurred_at,
    ) as unknown as Array<{ order_id: string; payable_amount_cents: bigint | number }>;
  if (possibleMismatch.length === 1 && possibleMismatch[0]) {
    const expectedAmountCents = toSafeInteger(
      possibleMismatch[0].payable_amount_cents,
      "expected order amount",
    );
    const actualAmountCents = toSafeInteger(entry.amount_cents, "ledger amount");
    return {
      exceptionType: "AMOUNT_MISMATCH",
      orderId: possibleMismatch[0].order_id,
      contextKey: `order:${possibleMismatch[0].order_id}`,
      details: {
        reason: actualAmountCents < expectedAmountCents ? "possible_underpayment" : "possible_overpayment",
        association: "single_open_slot_inference",
        expected_amount_cents: expectedAmountCents,
        actual_amount_cents: actualAmountCents,
        difference_cents: actualAmountCents - expectedAmountCents,
      },
    };
  }

  return {
    exceptionType: "UNMATCHED_CREDIT",
    orderId: null,
    contextKey: previousContext,
    details: { reason: "no_exact_amount_slot_interval" },
  };
}

function duplicatePaymentClassification(
  overlap: SettledOrderOverlap,
): UnmatchedCreditClassification {
  if (overlap.count < 1) throw new Error("settled order overlap is missing");
  return {
    exceptionType: "DUPLICATE_PAYMENT",
    orderId: overlap.orderId,
    contextKey: overlap.orderId === null
      ? `settled-orders:${RECONCILIATION_RULE_VERSION}:${overlap.count}`
      : `order:${overlap.orderId}`,
    details: {
      reason: "order_already_has_primary_settlement",
      overlapping_settled_order_count: overlap.count,
      overlapping_settled_order_count_is_lower_bound: overlap.count > 1,
    },
  };
}

function ensureCandidate(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
  fact: CandidateFactRow,
  now: number,
): MatchCandidate {
  const existing = readCandidateByTuple(
    connection,
    entry.ledger_entry_id,
    fact.order_id,
    fact.slot_id,
  );
  if (existing) return existing;
  const fingerprintInput: CandidateFingerprintInput = {
    providerAccountKey: entry.provider_account_key,
    ledgerEntryId: entry.ledger_entry_id,
    ledgerSemanticFingerprint: entry.semantic_fingerprint,
    occurredAt: toSafeInteger(entry.occurred_at, "ledger occurrence"),
    occurredAtPrecisionMilliseconds: toTimestampPrecision(
      entry.occurred_at_precision_ms,
      "ledger occurrence precision",
    ),
    amountCents: toSafeInteger(entry.amount_cents, "ledger amount"),
    orderId: fact.order_id,
    collectionProfileId: fact.collection_profile_id,
    slotId: fact.slot_id,
    slotGeneration: toSafeInteger(fact.generation, "slot generation"),
    slotOccupiedFrom: toSafeInteger(fact.occupied_from, "slot occupied time"),
    slotReleasedAt: nullableSafeInteger(fact.released_at, "slot release time"),
  };
  const evidence = candidateEvidence(fingerprintInput);
  const candidateId = randomUUID();
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO match_candidates(
           candidate_id, ledger_entry_id, order_id, slot_id, evidence_type,
           rule_version, evidence_json, candidate_fingerprint, status,
           decided_by_operation_id,
           created_at, updated_at, decided_at
         ) VALUES (?, ?, ?, ?, 'AMOUNT_INFERRED', ?, ?, ?, 'ELIGIBLE', NULL, ?, ?, NULL)`,
      )
      .run(
        candidateId,
        entry.ledger_entry_id,
        fact.order_id,
        fact.slot_id,
        RECONCILIATION_RULE_VERSION,
        JSON.stringify(evidence),
        candidateFingerprint(fingerprintInput),
        now,
        now,
      ).changes,
    "match candidate insert",
  );
  return readCandidate(connection, candidateId) ?? invalidState("inserted candidate cannot be read");
}

function autoSettleCandidate(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
  candidate: MatchCandidate,
  now: number,
): ReconcileEntryResult {
  if (hasOpenLedgerConflict(connection, entry.ledger_entry_id)) {
    throw new ReconciliationError(
      "match_state_conflict",
      "ledger entry has unresolved provider evidence conflicts",
    );
  }
  const currentFacts = readCandidateFacts(connection, entry)
    .map((fact) => readCandidateByTuple(
      connection,
      entry.ledger_entry_id,
      fact.order_id,
      fact.slot_id,
    ))
    .filter((item) => item === null || item.status === "ELIGIBLE");
  if (currentFacts.length !== 1 || currentFacts[0]?.candidateId !== candidate.candidateId) {
    throw new ReconciliationError("candidate_set_changed", "candidate set is no longer unique");
  }

  const order = requireOrderDecision(connection, candidate.orderId);
  if (
    order.payment_status !== "UNPAID" ||
    order.payment_basis !== "NONE" ||
    order.received_amount_cents !== null ||
    readActiveMatchForEntry(connection, entry.ledger_entry_id) !== null ||
    readActiveMatchForOrder(connection, order.order_id) !== null
  ) {
    throw new ReconciliationError("match_state_conflict", "automatic settlement facts have changed");
  }

  const operationKey = `auto-settlement:${candidate.candidateFingerprint}`;
  const existingOperation = readOperationByKey(connection, operationKey);
  if (existingOperation) {
    if (
      existingOperation.operationType !== "AUTO_SETTLEMENT" ||
      existingOperation.orderId !== candidate.orderId ||
      existingOperation.ledgerEntryId !== entry.ledger_entry_id
    ) {
      throw new ReconciliationError("operation_conflict", "automatic settlement operation key is already used");
    }
    const existingMatch = readPaymentMatchByCreationOperation(
      connection,
      existingOperation.financialOperationId,
    );
    if (!existingMatch || existingMatch.status !== "SETTLED" || existingMatch.candidateId !== candidate.candidateId) {
      throw new ReconciliationError("match_state_conflict", "automatic settlement operation result is incomplete");
    }
    return {
      kind: "auto_settled",
      ledgerEntryId: entry.ledger_entry_id,
      candidateId: candidate.candidateId,
      paymentMatchId: existingMatch.paymentMatchId,
      orderId: candidate.orderId,
    };
  }

  const paymentMatchId = randomUUID();
  const operationId = randomUUID();
  const fingerprintInput: FinancialOperationFingerprintInput = {
    operationType: "AUTO_SETTLEMENT",
    actorType: "SYSTEM",
    actorId: null,
    orderId: candidate.orderId,
    ledgerEntryId: entry.ledger_entry_id,
    candidateId: candidate.candidateId,
    paymentMatchId,
    reversesOperationId: null,
    reason: null,
  };
  const operation = insertFinancialOperation(connection, {
    financialOperationId: operationId,
    operationKey,
    fingerprintInput,
    orderId: candidate.orderId,
    ledgerEntryId: entry.ledger_entry_id,
    reversesOperationId: null,
    reason: null,
    now,
  });
  assertChangedOnce(
    connection
      .prepare(
        `UPDATE match_candidates
            SET status = 'SELECTED', decided_by_operation_id = ?,
                updated_at = ?, decided_at = ?
          WHERE candidate_id = ? AND status = 'ELIGIBLE'`,
      )
      .run(operation.financialOperationId, now, now, candidate.candidateId).changes,
    "automatic candidate selection",
  );
  const receivedAmountCents = toSafeInteger(entry.amount_cents, "ledger amount");
  postAccountingTransaction(connection, {
    operation,
    orderId: order.order_id,
    ledgerEntryId: entry.ledger_entry_id,
    transactionType: "SETTLEMENT",
    amountCents: receivedAmountCents,
    debitAccount: "PROVIDER_CASH",
    creditAccount: "ORDER_SETTLEMENT",
    now,
  });
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO payment_matches(
           payment_match_id, ledger_entry_id, order_id, candidate_id,
           match_role, evidence_type, evidence_json, status,
           created_by_operation_id, resolved_by_operation_id,
           created_at, updated_at, resolved_at
         ) VALUES (?, ?, ?, ?, 'PRIMARY_SETTLEMENT', 'AMOUNT_INFERRED', ?,
                   'SETTLED', ?, ?, ?, ?, ?)`,
      )
      .run(
        paymentMatchId,
        entry.ledger_entry_id,
        candidate.orderId,
        candidate.candidateId,
        JSON.stringify(candidate.evidence),
        operation.financialOperationId,
        operation.financialOperationId,
        now,
        now,
        now,
      ).changes,
    "automatic payment match insert",
  );
  setLedgerState(connection, entry, "ALLOCATED", now);
  const nextVersion = updateOrderPayment(connection, {
    order,
    paymentStatus: "CONFIRMED",
    paymentBasis: "INFERRED",
    receivedAmountCents,
    now,
  });
  insertOrderEvent(connection, {
    orderId: order.order_id,
    sequence: nextVersion,
    type: "PAYMENT_CONFIRMED",
    now,
    details: {
      financial_operation_id: operation.financialOperationId,
      payment_match_id: paymentMatchId,
      candidate_id: candidate.candidateId,
      evidence_type: "AMOUNT_INFERRED",
    },
  });
  insertOutboxEvent(connection, {
    operation,
    order: {
      ...order,
      received_amount_cents: BigInt(receivedAmountCents),
      payment_status: "CONFIRMED",
      payment_basis: "INFERRED",
      version: nextVersion,
    },
    eventType: "PAYMENT_CONFIRMED",
    eventDetails: {
      payment_match_id: paymentMatchId,
      candidate_id: candidate.candidateId,
      evidence_type: "AMOUNT_INFERRED",
    },
    now,
  });
  resolveEntryExceptions(
    connection,
    entry.ledger_entry_id,
    operation,
    "auto_settled",
    paymentMatchId,
    now,
  );
  return {
    kind: "auto_settled",
    ledgerEntryId: entry.ledger_entry_id,
    candidateId: candidate.candidateId,
    paymentMatchId,
    orderId: candidate.orderId,
  };
}

function supersedeStaleEligibleCandidates(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
  activeCandidateIds: ReadonlySet<string>,
  now: number,
): void {
  const stale = (connection
    .prepare(`${CANDIDATE_COLUMNS} WHERE ledger_entry_id = ? AND status = 'ELIGIBLE'`)
    .all(entry.ledger_entry_id) as unknown as CandidateRow[])
    .map(mapCandidate)
    .filter((candidate) => !activeCandidateIds.has(candidate.candidateId));
  for (const candidate of stale) {
    const operationId = randomUUID();
    const input: FinancialOperationFingerprintInput = {
      operationType: "SUPERSEDE_CANDIDATE",
      actorType: "SYSTEM",
      actorId: null,
      orderId: candidate.orderId,
      ledgerEntryId: candidate.ledgerEntryId,
      candidateId: candidate.candidateId,
      paymentMatchId: null,
      reversesOperationId: null,
      reason: null,
    };
    const operation = insertFinancialOperation(connection, {
      financialOperationId: operationId,
      operationKey: `supersede:${candidate.candidateId}`,
      fingerprintInput: input,
      orderId: candidate.orderId,
      ledgerEntryId: candidate.ledgerEntryId,
      reversesOperationId: null,
      reason: null,
      now,
    });
    assertChangedOnce(
      connection
        .prepare(
          `UPDATE match_candidates
              SET status = 'SUPERSEDED', decided_by_operation_id = ?,
                  updated_at = ?, decided_at = ?
            WHERE candidate_id = ? AND status = 'ELIGIBLE'`,
        )
        .run(operation.financialOperationId, now, now, candidate.candidateId).changes,
      "candidate supersede",
    );
  }
}

function ensureException(
  connection: DatabaseSync,
  input: {
    readonly providerAccountKey: string;
    readonly exceptionType: FinancialExceptionType;
    readonly ledgerEntryId: string | null;
    readonly orderId: string | null;
    readonly candidateId: string | null;
    readonly contextKey: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly now: number;
  },
): FinancialException {
  // Exception facts are immutable. When a classification returns after an
  // earlier occurrence was resolved, derive a new bounded context key so the
  // current occurrence can be represented without reopening history.
  let candidateInput = input;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const fingerprint = financialExceptionFingerprint(candidateInput);
    const existing = connection
      .prepare(`${EXCEPTION_COLUMNS} WHERE exception_fingerprint = ?`)
      .get(fingerprint) as unknown as ExceptionRow | undefined;
    if (existing?.status === "OPEN") return mapException(existing);
    if (!existing) {
      const exceptionId = randomUUID();
      const detailsJson = JSON.stringify(candidateInput.details);
      assertChangedOnce(
        connection
          .prepare(
            `INSERT INTO financial_exceptions(
               exception_id, provider_account_key, exception_type, ledger_entry_id,
               order_id, candidate_id, context_key, details_json, details_fingerprint,
               exception_fingerprint, status, resolution_operation_id,
               resolution_json, resolution_fingerprint, created_at, resolved_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, ?, NULL)`,
          )
          .run(
            exceptionId,
            candidateInput.providerAccountKey,
            candidateInput.exceptionType,
            candidateInput.ledgerEntryId,
            candidateInput.orderId,
            candidateInput.candidateId,
            candidateInput.contextKey,
            detailsJson,
            financialExceptionDetailsFingerprint(detailsJson),
            fingerprint,
            candidateInput.now,
          ).changes,
        "financial exception insert",
      );
      return mapException(
        connection
          .prepare(`${EXCEPTION_COLUMNS} WHERE exception_id = ?`)
          .get(exceptionId) as unknown as ExceptionRow,
      );
    }

    const history = readExceptionClassificationHistory(connection, input);
    const latest = history[0] ?? existing;
    candidateInput = {
      ...input,
      contextKey: `reclassified:${history.length + 1}:${latest.exception_id}`,
    };
  }
  throw new Error("financial exception classification history is exhausted");
}

function readExceptionClassificationHistory(
  connection: DatabaseSync,
  input: {
    readonly providerAccountKey: string;
    readonly exceptionType: FinancialExceptionType;
    readonly ledgerEntryId: string | null;
    readonly orderId: string | null;
    readonly candidateId: string | null;
  },
): ExceptionRow[] {
  return connection
    .prepare(
      `${EXCEPTION_COLUMNS}
        WHERE provider_account_key = ?
          AND exception_type = ?
          AND ledger_entry_id IS ?
          AND order_id IS ?
          AND candidate_id IS ?
        ORDER BY created_at DESC, exception_id DESC`,
    )
    .all(
      input.providerAccountKey,
      input.exceptionType,
      input.ledgerEntryId,
      input.orderId,
      input.candidateId,
    ) as unknown as ExceptionRow[];
}

function resolveEntryExceptions(
  connection: DatabaseSync,
  ledgerEntryId: string,
  operation: FinancialOperation,
  resolution: string,
  paymentMatchId: string,
  now: number,
): void {
  const resolutionJson = JSON.stringify({ resolution, payment_match_id: paymentMatchId });
  connection
    .prepare(
      `UPDATE financial_exceptions
          SET status = 'RESOLVED', resolution_operation_id = ?,
              resolution_json = ?, resolution_fingerprint = ?, resolved_at = ?
        WHERE ledger_entry_id = ? AND status = 'OPEN'
          AND (order_id IS NULL OR order_id = ?)`,
    )
    .run(
      operation.financialOperationId,
      resolutionJson,
      financialExceptionResolutionFingerprint(resolutionJson),
      now,
      ledgerEntryId,
      operation.orderId,
    );

  if (
    operation.operationType !== "AUTO_SETTLEMENT" &&
    operation.operationType !== "MANUAL_SETTLEMENT"
  ) {
    return;
  }
  if (operation.orderId === null || paymentMatchId === null) {
    throw new ReconciliationError(
      "match_state_conflict",
      "settlement exception resolution has incomplete operation facts",
    );
  }
  const supersededResolutionJson = JSON.stringify({
    resolution: "superseded_by_settlement",
    payment_match_id: paymentMatchId,
  });
  connection
    .prepare(
      `UPDATE financial_exceptions
          SET status = 'RESOLVED', resolution_operation_id = ?,
              resolution_json = ?, resolution_fingerprint = ?, resolved_at = ?
        WHERE ledger_entry_id = ? AND status = 'OPEN'
          AND order_id IS NOT NULL AND order_id != ?`,
    )
    .run(
      operation.financialOperationId,
      supersededResolutionJson,
      financialExceptionResolutionFingerprint(supersededResolutionJson),
      now,
      ledgerEntryId,
      operation.orderId,
    );
}

function insertFinancialOperation(
  connection: DatabaseSync,
  input: {
    readonly financialOperationId: string;
    readonly operationKey: string;
    readonly fingerprintInput: FinancialOperationFingerprintInput;
    readonly orderId: string | null;
    readonly ledgerEntryId: string | null;
    readonly reversesOperationId: string | null;
    readonly reason: string | null;
    readonly now: number;
  },
): FinancialOperation {
  const requestFingerprint = financialOperationFingerprint(input.fingerprintInput);
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO financial_operations(
           financial_operation_id, operation_key, request_fingerprint, request_json,
           operation_type, actor_type, actor_id, order_id, ledger_entry_id,
           reverses_operation_id, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.financialOperationId,
        input.operationKey,
        requestFingerprint,
        JSON.stringify(financialOperationEvidence(input.fingerprintInput)),
        input.fingerprintInput.operationType,
        input.fingerprintInput.actorType,
        input.fingerprintInput.actorId,
        input.orderId,
        input.ledgerEntryId,
        input.reversesOperationId,
        input.reason,
        input.now,
      ).changes,
    "financial operation insert",
  );
  return readOperation(connection, input.financialOperationId) ?? invalidState("inserted operation cannot be read");
}

function readDecisionReplay(
  connection: DatabaseSync,
  financialOperationId: string,
  input: FinancialOperationFingerprintInput,
): FinancialOperation | null {
  const existing = readOperation(connection, financialOperationId);
  if (!existing) return null;
  if (
    existing.operationKey !== `admin:${financialOperationId}` ||
    existing.requestFingerprint !== financialOperationFingerprint(input) ||
    existing.operationType !== input.operationType
  ) {
    throw new ReconciliationError("operation_conflict", "financial operation ID was reused with different input");
  }
  return existing;
}

function readOperation(connection: DatabaseSync, id: string): FinancialOperation | null {
  const row = connection
    .prepare(`${OPERATION_COLUMNS} WHERE financial_operation_id = ?`)
    .get(id) as unknown as FinancialOperationRow | undefined;
  return row ? mapOperation(row) : null;
}

function readOperationByKey(connection: DatabaseSync, operationKey: string): FinancialOperation | null {
  const row = connection
    .prepare(`${OPERATION_COLUMNS} WHERE operation_key = ?`)
    .get(operationKey) as unknown as FinancialOperationRow | undefined;
  return row ? mapOperation(row) : null;
}

function readCandidate(connection: DatabaseSync, candidateId: string): MatchCandidate | null {
  const row = connection
    .prepare(`${CANDIDATE_COLUMNS} WHERE candidate_id = ?`)
    .get(candidateId) as unknown as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

function readCandidateByTuple(
  connection: DatabaseSync,
  ledgerEntryId: string,
  orderId: string,
  slotId: string,
): MatchCandidate | null {
  const row = connection
    .prepare(
      `${CANDIDATE_COLUMNS}
        WHERE ledger_entry_id = ? AND order_id = ? AND slot_id = ?
          AND evidence_type = 'AMOUNT_INFERRED' AND rule_version = ?`,
    )
    .get(ledgerEntryId, orderId, slotId, RECONCILIATION_RULE_VERSION) as unknown as CandidateRow | undefined;
  return row ? mapCandidate(row) : null;
}

function readPaymentMatch(connection: DatabaseSync, paymentMatchId: string): PaymentMatch | null {
  const row = connection
    .prepare(`${PAYMENT_MATCH_COLUMNS} WHERE payment_match_id = ?`)
    .get(paymentMatchId) as unknown as PaymentMatchRow | undefined;
  return row ? mapPaymentMatch(row) : null;
}

function readPaymentMatchByCreationOperation(
  connection: DatabaseSync,
  financialOperationId: string,
): PaymentMatch | null {
  const row = connection
    .prepare(`${PAYMENT_MATCH_COLUMNS} WHERE created_by_operation_id = ?`)
    .get(financialOperationId) as unknown as PaymentMatchRow | undefined;
  return row ? mapPaymentMatch(row) : null;
}

function readActiveMatchForEntry(connection: DatabaseSync, ledgerEntryId: string): PaymentMatch | null {
  const row = connection
    .prepare(
      `${PAYMENT_MATCH_COLUMNS}
        WHERE ledger_entry_id = ? AND status = 'SETTLED'`,
    )
    .get(ledgerEntryId) as unknown as PaymentMatchRow | undefined;
  return row ? mapPaymentMatch(row) : null;
}

function readActiveMatchForOrder(connection: DatabaseSync, orderId: string): PaymentMatch | null {
  const row = connection
    .prepare(`${PAYMENT_MATCH_COLUMNS} WHERE order_id = ? AND status = 'SETTLED'`)
    .get(orderId) as unknown as PaymentMatchRow | undefined;
  return row ? mapPaymentMatch(row) : null;
}

function latestMatchContext(connection: DatabaseSync, ledgerEntryId: string): string {
  const row = connection
    .prepare(
      `SELECT payment_match_id
         FROM payment_matches
        WHERE ledger_entry_id = ?
        ORDER BY created_at DESC, payment_match_id DESC
        LIMIT 1`,
    )
    .get(ledgerEntryId) as { payment_match_id: string } | undefined;
  return row?.payment_match_id ?? "initial";
}

function requireOrderDecision(connection: DatabaseSync, orderId: string): OrderDecisionRow {
  const row = connection
    .prepare(
      `SELECT order_id, merchant_order_no, product_name, note,
               requested_amount_cents,
              payable_amount_cents, received_amount_cents, currency,
              payment_status, payment_basis, refund_status, updated_at, version
         FROM payment_orders
        WHERE order_id = ?`,
    )
    .get(orderId) as unknown as OrderDecisionRow | undefined;
  if (!row) throw new ReconciliationError("candidate_not_found", "payment order does not exist");
  return row;
}

function orderUsesProviderAccount(
  connection: DatabaseSync,
  orderId: string,
  providerAccountKey: string,
): boolean {
  return connection
    .prepare(
      `SELECT 1 AS present
         FROM payment_orders AS orders
         JOIN collection_profiles AS profile
           ON profile.profile_id = orders.collection_profile_id
         JOIN collection_profile_provider_accounts AS profile_provider
           ON profile_provider.profile_id = profile.profile_id
        WHERE orders.order_id = ? AND profile_provider.provider_account_key = ?`,
    )
    .get(orderId, providerAccountKey) !== undefined;
}

function updateOrderPayment(
  connection: DatabaseSync,
  input: {
    readonly order: OrderDecisionRow;
    readonly paymentStatus: OrderDecisionRow["payment_status"];
    readonly paymentBasis: OrderDecisionRow["payment_basis"];
    readonly receivedAmountCents: number | null;
    readonly now: number;
  },
): number {
  const nextVersion = toSafeInteger(input.order.version, "order version") + 1;
  assertChangedOnce(
    connection
      .prepare(
        `UPDATE payment_orders
            SET payment_status = ?, payment_basis = ?, received_amount_cents = ?,
                updated_at = ?, version = version + 1
          WHERE order_id = ? AND version = ? AND payment_status = ?`,
      )
      .run(
        input.paymentStatus,
        input.paymentBasis,
        input.receivedAmountCents,
        input.now,
        input.order.order_id,
        input.order.version,
        input.order.payment_status,
      ).changes,
    "payment order state update",
  );
  return nextVersion;
}

function updateOrderRefund(
  connection: DatabaseSync,
  order: OrderDecisionRow,
  refundStatus: "PARTIAL" | "FULL",
  now: number,
): number {
  const nextVersion = toSafeInteger(order.version, "order version") + 1;
  const result = order.refund_status === refundStatus
    ? connection
      .prepare(
        `UPDATE payment_orders
            SET updated_at = ?, version = version + 1
          WHERE order_id = ? AND version = ? AND refund_status = ?`,
      )
      .run(now, order.order_id, order.version, order.refund_status)
    : connection
      .prepare(
        `UPDATE payment_orders
            SET refund_status = ?, updated_at = ?, version = version + 1
          WHERE order_id = ? AND version = ? AND refund_status = ?`,
      )
      .run(refundStatus, now, order.order_id, order.version, order.refund_status);
  assertChangedOnce(result.changes, "payment order refund update");
  return nextVersion;
}

function readRecordedRefundTotal(connection: DatabaseSync, orderId: string): number {
  const row = connection
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refund_records WHERE order_id = ?")
    .get(orderId) as { total: bigint | number };
  return toSafeInteger(row.total, "recorded refund total");
}

function setLedgerState(
  connection: DatabaseSync,
  entry: LedgerEntryRow,
  state: LedgerEntryRow["state"],
  now: number,
): void {
  if (entry.state === state) return;
  assertChangedOnce(
    connection
      .prepare(
        `UPDATE ledger_entries
            SET state = ?, updated_at = ?
          WHERE ledger_entry_id = ? AND state = ?`,
      )
      .run(state, now, entry.ledger_entry_id, entry.state).changes,
    "ledger entry state update",
  );
}

function postAccountingTransaction(
  connection: DatabaseSync,
  input: {
    readonly operation: FinancialOperation;
    readonly orderId: string;
    readonly ledgerEntryId: string;
    readonly transactionType: "SETTLEMENT" | "REVERSAL" | "REFUND";
    readonly amountCents: number;
    readonly debitAccount: "PROVIDER_CASH" | "ORDER_SETTLEMENT" | "REFUND_CLEARING";
    readonly creditAccount: "PROVIDER_CASH" | "ORDER_SETTLEMENT" | "REFUND_CLEARING";
    readonly now: number;
  },
): void {
  const transactionId = randomUUID();
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO ledger_transactions(
           ledger_transaction_id, financial_operation_id, order_id,
           ledger_entry_id, transaction_type, currency, status,
           created_at, posted_at
         ) VALUES (?, ?, ?, ?, ?, 'CNY', 'DRAFT', ?, NULL)`,
      )
      .run(
        transactionId,
        input.operation.financialOperationId,
        input.orderId,
        input.ledgerEntryId,
        input.transactionType,
        input.now,
      ).changes,
    "ledger transaction insert",
  );
  const insert = connection.prepare(
    `INSERT INTO ledger_postings(
       posting_id, ledger_transaction_id, account_code, side,
       amount_cents, currency, order_id, ledger_entry_id, created_at
     ) VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?)`,
  );
  assertChangedOnce(
    insert.run(
      randomUUID(),
      transactionId,
      input.debitAccount,
      "DEBIT",
      input.amountCents,
      input.orderId,
      input.ledgerEntryId,
      input.now,
    ).changes,
    "debit posting insert",
  );
  assertChangedOnce(
    insert.run(
      randomUUID(),
      transactionId,
      input.creditAccount,
      "CREDIT",
      input.amountCents,
      input.orderId,
      input.ledgerEntryId,
      input.now,
    ).changes,
    "credit posting insert",
  );
  assertChangedOnce(
    connection
      .prepare(
        `UPDATE ledger_transactions
            SET status = 'POSTED', posted_at = ?
          WHERE ledger_transaction_id = ? AND status = 'DRAFT'`,
      )
      .run(input.now, transactionId).changes,
    "ledger transaction post",
  );
}

function insertOrderEvent(
  connection: DatabaseSync,
  input: {
    readonly orderId: string;
    readonly sequence: number;
    readonly type:
      | "PAYMENT_CONFIRMED"
      | "PAYMENT_DISPUTED"
      | "REFUND_UPDATED";
    readonly now: number;
    readonly details: Readonly<Record<string, unknown>>;
  },
): void {
  const detailsJson = JSON.stringify(input.details);
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO order_events(
           event_id, order_id, sequence, event_type, occurred_at,
           details_json, details_fingerprint
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.orderId,
        input.sequence,
        input.type,
        input.now,
        detailsJson,
        orderEventDetailsFingerprint(detailsJson),
      ).changes,
    "payment order event insert",
  );
}

function insertOutboxEvent(
  connection: DatabaseSync,
  input: {
    readonly operation: FinancialOperation;
    readonly order: OrderDecisionRow;
    readonly eventType: "PAYMENT_CONFIRMED" | "PAYMENT_DISPUTED" | "REFUND_UPDATED";
    readonly eventDetails: Readonly<Record<string, unknown>>;
    readonly now: number;
  },
): void {
  const outboxEventId = randomUUID();
  const payloadJson = JSON.stringify({
    schema: "perpay:outbox-event:v2",
    event_id: outboxEventId,
    event_type: input.eventType,
    financial_operation_id: input.operation.financialOperationId,
    order_id: input.order.order_id,
    merchant_order_no: input.order.merchant_order_no,
    product_name: input.order.product_name,
    note: input.order.note,
    requested_amount_cents: toSafeInteger(input.order.requested_amount_cents, "requested amount"),
    payable_amount_cents: toSafeInteger(input.order.payable_amount_cents, "payable amount"),
    received_amount_cents: toSafeInteger(input.order.received_amount_cents, "received amount"),
    currency: input.order.currency,
    payment_status: input.order.payment_status,
    payment_basis: input.order.payment_basis,
    refund_status: input.order.refund_status,
    event_details: input.eventDetails,
    order_version: toSafeInteger(input.order.version, "order version"),
    occurred_at: input.now,
  });
  assertChangedOnce(
    connection
      .prepare(
        `INSERT INTO outbox_events(
           outbox_event_id, financial_operation_id, aggregate_type,
           aggregate_id, aggregate_version, event_type, payload_json,
           payload_fingerprint, created_at
         ) VALUES (?, ?, 'PAYMENT_ORDER', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outboxEventId,
        input.operation.financialOperationId,
        input.order.order_id,
        input.order.version,
        input.eventType,
        payloadJson,
        outboxPayloadFingerprint(payloadJson),
        input.now,
      ).changes,
    "outbox event insert",
  );
}

function decisionResult(
  connection: DatabaseSync,
  operation: FinancialOperation,
  paymentMatchId: string,
  replayed: boolean,
): FinancialDecisionResult {
  const match = readPaymentMatch(connection, paymentMatchId);
  if (!match) throw new ReconciliationError("match_not_found", "payment match does not exist");
  const orderVersion = decisionOrderVersion(connection, operation, match.orderId);
  const paymentMatch = replayed
    ? replayedPaymentMatch(match, operation)
    : match;
  return Object.freeze({
    operation,
    paymentMatch,
    orderId: match.orderId,
    ledgerEntryId: match.ledgerEntryId,
    orderVersion,
    replayed,
  });
}

function decisionOrderVersion(
  connection: DatabaseSync,
  operation: FinancialOperation,
  orderId: string,
): number {
  const eventType = decisionEventType(operation.operationType);
  const rows = connection
    .prepare(
      `SELECT sequence, occurred_at
         FROM order_events
        WHERE order_id = ?
          AND event_type = ?
          AND json_extract(details_json, '$.financial_operation_id') = ?`,
    )
    .all(orderId, eventType, operation.financialOperationId) as Array<{
      sequence: bigint | number;
      occurred_at: bigint | number;
    }>;
  if (rows.length !== 1 || !rows[0]) {
    throw new ReconciliationError("match_state_conflict", "financial operation result is incomplete");
  }
  const occurredAt = toSafeInteger(rows[0].occurred_at, "financial operation event time");
  if (occurredAt !== operation.createdAt) {
    throw new ReconciliationError("match_state_conflict", "financial operation event time is inconsistent");
  }
  return toSafeInteger(rows[0].sequence, "financial operation order version");
}

function decisionEventType(
  operationType: FinancialOperation["operationType"],
): "PAYMENT_CONFIRMED" | "PAYMENT_DISPUTED" {
  switch (operationType) {
    case "MANUAL_SETTLEMENT":
      return "PAYMENT_CONFIRMED";
    case "REVERSE_SETTLEMENT":
      return "PAYMENT_DISPUTED";
    default:
      throw new ReconciliationError("match_state_conflict", "financial operation has no decision event");
  }
}

function replayedPaymentMatch(
  match: PaymentMatch,
  operation: FinancialOperation,
): PaymentMatch {
  const status = operation.operationType === "REVERSE_SETTLEMENT" ? "REVERSED" : "SETTLED";
  return Object.freeze({
    ...match,
    status,
    resolvedByOperationId: operation.financialOperationId,
    updatedAt: operation.createdAt,
    resolvedAt: operation.createdAt,
  });
}

function refundDecisionResult(
  connection: DatabaseSync,
  operation: FinancialOperation,
  replayed: boolean,
): RefundRecordResult {
  const row = connection
    .prepare(
      `SELECT refund.refund_record_id, refund.order_id, refund.ledger_entry_id,
              outbox.aggregate_version,
              json_extract(outbox.payload_json, '$.refund_status') AS refund_status
         FROM refund_records AS refund
         JOIN outbox_events AS outbox
           ON outbox.financial_operation_id = refund.financial_operation_id
        WHERE refund.financial_operation_id = ?`,
    )
    .get(operation.financialOperationId) as unknown as {
      refund_record_id: string;
      order_id: string;
      ledger_entry_id: string;
      aggregate_version: bigint | number;
      refund_status: "PARTIAL" | "FULL";
    } | undefined;
  if (!row || !["PARTIAL", "FULL"].includes(row.refund_status)) {
    throw new ReconciliationError("match_state_conflict", "refund operation has no committed result");
  }
  return Object.freeze({
    operation,
    refundRecordId: row.refund_record_id,
    orderId: row.order_id,
    ledgerEntryId: row.ledger_entry_id,
    refundStatus: row.refund_status,
    orderVersion: toSafeInteger(row.aggregate_version, "refund order version"),
    replayed,
  });
}

function mapCandidate(row: CandidateRow): MatchCandidate {
  const ruleVersion = toSafeInteger(row.rule_version, "candidate rule version");
  if (ruleVersion !== RECONCILIATION_RULE_VERSION) {
    throw new Error(`unsupported candidate rule version ${ruleVersion}`);
  }
  return Object.freeze({
    candidateId: row.candidate_id,
    ledgerEntryId: row.ledger_entry_id,
    orderId: row.order_id,
    slotId: row.slot_id,
    evidenceType: row.evidence_type,
    ruleVersion: RECONCILIATION_RULE_VERSION,
    evidence: parseObject(row.evidence_json, "candidate evidence"),
    candidateFingerprint: row.candidate_fingerprint,
    status: row.status,
    decidedByOperationId: row.decided_by_operation_id,
    createdAt: toSafeInteger(row.created_at, "candidate creation time"),
    updatedAt: toSafeInteger(row.updated_at, "candidate update time"),
    decidedAt: nullableSafeInteger(row.decided_at, "candidate decision time"),
  });
}

function mapPaymentMatch(row: PaymentMatchRow): PaymentMatch {
  return Object.freeze({
    paymentMatchId: row.payment_match_id,
    ledgerEntryId: row.ledger_entry_id,
    orderId: row.order_id,
    candidateId: row.candidate_id,
    evidenceType: row.evidence_type,
    evidence: parseObject(row.evidence_json, "payment match evidence"),
    status: row.status,
    createdByOperationId: row.created_by_operation_id,
    resolvedByOperationId: row.resolved_by_operation_id,
    createdAt: toSafeInteger(row.created_at, "payment match creation time"),
    updatedAt: toSafeInteger(row.updated_at, "payment match update time"),
    resolvedAt: nullableSafeInteger(row.resolved_at, "payment match resolution time"),
  });
}

function mapOperation(row: FinancialOperationRow): FinancialOperation {
  return Object.freeze({
    financialOperationId: row.financial_operation_id,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    operationType: row.operation_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    orderId: row.order_id,
    ledgerEntryId: row.ledger_entry_id,
    reversesOperationId: row.reverses_operation_id,
    reason: row.reason,
    createdAt: toSafeInteger(row.created_at, "financial operation time"),
  });
}

function mapException(row: ExceptionRow): FinancialException {
  return Object.freeze({
    exceptionId: row.exception_id,
    providerAccountKey: row.provider_account_key,
    exceptionType: row.exception_type,
    ledgerEntryId: row.ledger_entry_id,
    orderId: row.order_id,
    candidateId: row.candidate_id,
    contextKey: row.context_key,
    details: parseObject(row.details_json, "financial exception details"),
    exceptionFingerprint: row.exception_fingerprint,
    status: row.status,
    resolutionOperationId: row.resolution_operation_id,
    resolution: row.resolution_json === null
      ? null
      : parseObject(row.resolution_json, "financial exception resolution"),
    createdAt: toSafeInteger(row.created_at, "financial exception creation time"),
    resolvedAt: nullableSafeInteger(row.resolved_at, "financial exception resolution time"),
  });
}

function financialNow(connection: DatabaseSync, nowInput: number | undefined): number {
  const physical = nowInput ?? databaseTime(connection);
  if (!Number.isSafeInteger(physical) || physical < 0) {
    throw new RangeError("financial clock must be a non-negative safe integer");
  }
  const clock = connection
    .prepare("SELECT last_now_ms FROM order_clock WHERE singleton_key = 1")
    .get() as { last_now_ms: bigint | number } | undefined;
  if (!clock) throw new ReconciliationError("financial_clock_unavailable", "order clock is missing");
  const previous = toSafeInteger(clock.last_now_ms, "financial clock");
  if (previous - physical > MAX_ORDER_CLOCK_AHEAD_MILLISECONDS) {
    throw new ReconciliationError("financial_clock_unavailable", "financial clock is too far ahead");
  }
  const now = Math.max(previous, physical);
  const row = connection
    .prepare(
      `UPDATE order_clock
          SET last_now_ms = ?
        WHERE singleton_key = 1
        RETURNING last_now_ms`,
    )
    .get(now) as { last_now_ms: bigint | number } | undefined;
  if (!row) throw new ReconciliationError("financial_clock_unavailable", "order clock cannot be advanced");
  return toSafeInteger(row.last_now_ms, "financial clock");
}

function databaseTime(connection: DatabaseSync): number {
  const row = connection
    .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
    .get() as { now_ms: bigint | number };
  return toSafeInteger(row.now_ms, "database time");
}

function validateBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILIATION_BATCH_SIZE) {
    throw new RangeError("reconciliation batch limit is invalid");
  }
}

function validateDecisionInput(input: FinancialDecisionInput): void {
  requireIdentifier(input.financialOperationId, "financial operation ID");
  requireIdentifier(input.paymentMatchId, "payment match ID");
  validateAdministratorOperationInput(input.actorId, input.reason);
}

function validateAdministratorOperationInput(actorId: string, reason: string): void {
  if (
    actorId.length < 1 ||
    actorId.length > 128 ||
    actorId.includes("\0") ||
    reason.length < 1 ||
    reason.length > 512 ||
    Buffer.byteLength(reason, "utf8") > MAX_FINANCIAL_REASON_BYTES ||
    reason !== reason.trim() ||
    /\p{Cc}/u.test(reason)
  ) {
    throw new RangeError("financial decision input is invalid");
  }
}

function validateManualSettlementInput(input: ManualSettlementInput): void {
  requireIdentifier(input.financialOperationId, "financial operation ID");
  requireIdentifier(input.orderId, "payment order ID");
  requireIdentifier(input.ledgerEntryId, "ledger entry ID");
  validateAdministratorOperationInput(input.actorId, input.reason);
}

function validateRefundRecordInput(input: RefundRecordInput): void {
  requireIdentifier(input.financialOperationId, "financial operation ID");
  requireIdentifier(input.orderId, "payment order ID");
  requireIdentifier(input.ledgerEntryId, "ledger entry ID");
  validateAdministratorOperationInput(input.actorId, input.reason);
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

function parseObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

function assertChangedOnce(changes: bigint | number, action: string): void {
  if (Number(changes) !== 1) throw new Error(`${action} changed ${String(changes)} rows`);
}

function nullableSafeInteger(value: bigint | number | null, label: string): number | null {
  return value === null ? null : toSafeInteger(value, label);
}

function toSafeInteger(value: bigint | number | null, label: string): number {
  if (value === null) throw new Error(`${label} is missing`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is outside the safe integer range`);
  return number;
}

function toTimestampPrecision(
  value: bigint | number | null,
  label: string,
): 1 | 10 | 100 | 1_000 {
  const precision = toSafeInteger(value, label);
  if (precision !== 1 && precision !== 10 && precision !== 100 && precision !== 1_000) {
    throw new Error(`${label} is invalid`);
  }
  return precision;
}

function invalidState(message: string): never {
  throw new Error(message);
}
