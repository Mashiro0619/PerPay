import { createHash } from "node:crypto";

import { z } from "zod";

export const RECONCILIATION_RULE_VERSION = 3;
export const MAX_RECONCILIATION_BATCH_SIZE = 256;
export const MAX_FINANCIAL_REASON_CHARACTERS = 512;
export const MAX_FINANCIAL_REASON_BYTES = MAX_FINANCIAL_REASON_CHARACTERS * 4;
export const MAX_LATE_PAYMENT_ATTRIBUTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export const financialOperationIdSchema = z.string().regex(UUID_V4_PATTERN);

export const financialDecisionReasonSchema = z
  .string()
  .min(1)
  .max(MAX_FINANCIAL_REASON_CHARACTERS)
  .refine((value) => value === value.trim(), { message: "reason must not have surrounding whitespace" })
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: "reason must not contain control characters",
  })
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_FINANCIAL_REASON_BYTES, {
    message: "reason is too large",
  });

export const financialDecisionRequestSchema = z
  .object({
    financial_operation_id: financialOperationIdSchema,
    reason: financialDecisionReasonSchema,
  })
  .strict();

export type FinancialDecisionRequest = z.infer<typeof financialDecisionRequestSchema>;

export const linkedFinancialDecisionRequestSchema = financialDecisionRequestSchema
  .extend({
    order_id: financialOperationIdSchema,
    ledger_entry_id: financialOperationIdSchema,
  })
  .strict();

export type LinkedFinancialDecisionRequest = z.infer<
  typeof linkedFinancialDecisionRequestSchema
>;

export type CandidateStatus = "ELIGIBLE" | "SELECTED" | "SUPERSEDED";

export type PaymentMatchStatus = "SETTLED" | "REVERSED";

export type FinancialOperationType =
  | "AUTO_SETTLEMENT"
  | "SUPERSEDE_CANDIDATE"
  | "MANUAL_SETTLEMENT"
  | "REVERSE_SETTLEMENT"
  | "RECORD_REFUND";

export type FinancialExceptionType =
  | "UNMATCHED_CREDIT"
  | "UNMATCHED_DEBIT"
  | "AMBIGUOUS_MATCH"
  | "CHECKOUT_ENDED_PAYMENT"
  | "DUPLICATE_PAYMENT"
  | "AMOUNT_MISMATCH"
  | "UNLINKED_REFUND"
  | "RECONCILIATION_CONFLICT";

export interface MatchCandidate {
  readonly candidateId: string;
  readonly ledgerEntryId: string;
  readonly orderId: string;
  readonly slotId: string;
  readonly evidenceType: "AMOUNT_INFERRED";
  readonly ruleVersion: typeof RECONCILIATION_RULE_VERSION;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly candidateFingerprint: string;
  readonly status: CandidateStatus;
  readonly decidedByOperationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decidedAt: number | null;
}

export interface PaymentMatch {
  readonly paymentMatchId: string;
  readonly ledgerEntryId: string;
  readonly orderId: string;
  readonly candidateId: string | null;
  readonly evidenceType: "AMOUNT_INFERRED" | "MANUAL";
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly status: PaymentMatchStatus;
  readonly createdByOperationId: string;
  readonly resolvedByOperationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolvedAt: number | null;
}

export interface FinancialOperation {
  readonly financialOperationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly operationType: FinancialOperationType;
  readonly actorType: "SYSTEM" | "ADMIN";
  readonly actorId: string | null;
  readonly orderId: string | null;
  readonly ledgerEntryId: string | null;
  readonly reversesOperationId: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
}

export interface FinancialException {
  readonly exceptionId: string;
  readonly providerAccountKey: string;
  readonly exceptionType: FinancialExceptionType;
  readonly ledgerEntryId: string | null;
  readonly orderId: string | null;
  readonly candidateId: string | null;
  readonly contextKey: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly exceptionFingerprint: string;
  readonly status: "OPEN" | "RESOLVED";
  readonly resolutionOperationId: string | null;
  readonly resolution: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface CandidateFingerprintInput {
  readonly providerAccountKey: string;
  readonly ledgerEntryId: string;
  readonly ledgerSemanticFingerprint: string;
  readonly occurredAt: number;
  readonly occurredAtPrecisionMilliseconds: 1 | 10 | 100 | 1_000;
  readonly amountCents: number;
  readonly orderId: string;
  readonly collectionProfileId: string;
  readonly slotId: string;
  readonly slotGeneration: number;
  readonly slotOccupiedFrom: number;
  readonly slotReleasedAt: number | null;
}

export function candidateEvidence(input: CandidateFingerprintInput): Readonly<Record<string, unknown>> {
  const occurredAtIntervalEndExclusive = input.occurredAt + input.occurredAtPrecisionMilliseconds;
  return Object.freeze({
    schema: "perpay:match-candidate:v3",
    rule_version: RECONCILIATION_RULE_VERSION,
    provider_account_key: input.providerAccountKey,
    ledger_entry_id: input.ledgerEntryId,
    ledger_semantic_fingerprint: input.ledgerSemanticFingerprint,
    occurred_at: input.occurredAt,
    occurred_at_precision_milliseconds: input.occurredAtPrecisionMilliseconds,
    occurred_at_interval_end_exclusive: occurredAtIntervalEndExclusive,
    amount_cents: input.amountCents,
    order_id: input.orderId,
    collection_profile_id: input.collectionProfileId,
    slot_id: input.slotId,
    slot_generation: input.slotGeneration,
    slot_occupied_from: input.slotOccupiedFrom,
    slot_released_at: input.slotReleasedAt,
    evidence_type: "AMOUNT_INFERRED",
  });
}

export function candidateFingerprint(input: CandidateFingerprintInput): string {
  return sha256Json(candidateEvidence(input));
}

export interface FinancialOperationFingerprintInput {
  readonly operationType: FinancialOperationType;
  readonly actorType: "SYSTEM" | "ADMIN";
  readonly actorId: string | null;
  readonly orderId: string | null;
  readonly ledgerEntryId: string | null;
  readonly candidateId: string | null;
  readonly paymentMatchId: string | null;
  readonly reversesOperationId: string | null;
  readonly reason: string | null;
}

export interface ManualSettlementEvidenceInput {
  readonly financialOperationId: string;
  readonly actorId: string;
  readonly reason: string;
}

export function manualSettlementEvidence(
  input: ManualSettlementEvidenceInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "perpay:manual-settlement:v1",
    financial_operation_id: input.financialOperationId,
    actor_id: input.actorId,
    reason: input.reason,
  });
}

export interface RefundRecordEvidenceInput {
  readonly financialOperationId: string;
  readonly actorId: string;
  readonly reason: string;
}

export function refundRecordEvidence(
  input: RefundRecordEvidenceInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "perpay:refund-record:v1",
    financial_operation_id: input.financialOperationId,
    actor_id: input.actorId,
    reason: input.reason,
  });
}

export function financialOperationEvidence(
  input: FinancialOperationFingerprintInput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "perpay:financial-operation:v1",
    operation_type: input.operationType,
    actor_type: input.actorType,
    actor_id: input.actorId,
    order_id: input.orderId,
    ledger_entry_id: input.ledgerEntryId,
    candidate_id: input.candidateId,
    payment_match_id: input.paymentMatchId,
    reverses_operation_id: input.reversesOperationId,
    reason: input.reason,
  });
}

export function financialOperationFingerprint(input: FinancialOperationFingerprintInput): string {
  return sha256Json(financialOperationEvidence(input));
}

export interface FinancialExceptionFingerprintInput {
  readonly providerAccountKey: string;
  readonly exceptionType: FinancialExceptionType;
  readonly ledgerEntryId: string | null;
  readonly orderId: string | null;
  readonly candidateId: string | null;
  readonly contextKey: string;
}

export function financialExceptionFingerprint(input: FinancialExceptionFingerprintInput): string {
  return sha256Json({
    schema: "perpay:financial-exception:v1",
    rule_version: RECONCILIATION_RULE_VERSION,
    provider_account_key: input.providerAccountKey,
    exception_type: input.exceptionType,
    ledger_entry_id: input.ledgerEntryId,
    order_id: input.orderId,
    candidate_id: input.candidateId,
    context_key: input.contextKey,
  });
}

export function financialExceptionDetailsFingerprint(detailsJson: string): string {
  return fingerprintFinancialExceptionJson("details", detailsJson);
}

export function financialExceptionResolutionFingerprint(resolutionJson: string): string {
  return fingerprintFinancialExceptionJson("resolution", resolutionJson);
}

export function outboxPayloadFingerprint(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

function sha256Json(value: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function fingerprintFinancialExceptionJson(
  kind: "details" | "resolution",
  value: string,
): string {
  return createHash("sha256")
    .update(`perpay:financial-exception-${kind}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}
