import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_FINANCIAL_REASON_CHARACTERS,
  candidateEvidence,
  candidateFingerprint,
  financialDecisionRequestSchema,
  financialExceptionDetailsFingerprint,
  financialExceptionFingerprint,
  financialExceptionResolutionFingerprint,
  financialOperationFingerprint,
  outboxPayloadFingerprint,
  type CandidateFingerprintInput,
} from "../src/reconciliation/model.ts";

const candidateInput: CandidateFingerprintInput = {
  providerAccountKey: "primary",
  ledgerEntryId: "11111111-1111-4111-8111-111111111111",
  ledgerSemanticFingerprint: "a".repeat(64),
  occurredAt: 1_700_000_000_000,
  occurredAtPrecisionMilliseconds: 1_000,
  amountCents: 1_234,
  orderId: "22222222-2222-4222-8222-222222222222",
  collectionProfileId: "33333333-3333-4333-8333-333333333333",
  slotId: "44444444-4444-4444-8444-444444444444",
  slotGeneration: 7,
  slotOccupiedFrom: 1_699_999_999_000,
  slotReleasedAt: null,
};

describe("reconciliation model", () => {
  it("keeps v3 candidate evidence and fingerprints stable", () => {
    const evidence = candidateEvidence(candidateInput);
    assert.equal(evidence.schema, "perpay:match-candidate:v3");
    assert.equal(evidence.rule_version, 3);
    assert.equal(evidence.evidence_type, "AMOUNT_INFERRED");
    assert.equal(evidence.occurred_at_interval_end_exclusive, 1_700_000_001_000);
    assert.match(candidateFingerprint(candidateInput), /^[0-9a-f]{64}$/);
    assert.equal(candidateFingerprint(candidateInput), candidateFingerprint({ ...candidateInput }));
  });

  it("binds automatic system operation fields and rejects changed evidence", () => {
    const base = {
      operationType: "AUTO_SETTLEMENT" as const,
      actorType: "SYSTEM" as const,
      actorId: null,
      orderId: candidateInput.orderId,
      ledgerEntryId: candidateInput.ledgerEntryId,
      candidateId: "55555555-5555-4555-8555-555555555555",
      paymentMatchId: "66666666-6666-4666-8666-666666666666",
      reversesOperationId: null,
      reason: null,
    };
    const expected = financialOperationFingerprint(base);
    assert.match(expected, /^[0-9a-f]{64}$/);
    for (const changed of [
      { ...base, orderId: "77777777-7777-4777-8777-777777777777" },
      { ...base, ledgerEntryId: "88888888-8888-4888-8888-888888888888" },
      { ...base, candidateId: null },
      { ...base, paymentMatchId: null },
    ]) {
      assert.notEqual(financialOperationFingerprint(changed), expected);
    }
  });

  it("keeps exception identity and byte fingerprints separate", () => {
    const exception = financialExceptionFingerprint({
      providerAccountKey: "primary",
      exceptionType: "UNMATCHED_CREDIT",
      ledgerEntryId: candidateInput.ledgerEntryId,
      orderId: null,
      candidateId: null,
      contextKey: "initial",
    });
    assert.match(exception, /^[0-9a-f]{64}$/);
    const details = '{"amount_cents":1001,"kind":"open"}';
    const resolution = '{"operation_id":"11111111-1111-4111-8111-111111111111","reason":"verified"}';
    assert.notEqual(financialExceptionDetailsFingerprint(details), financialExceptionResolutionFingerprint(resolution));
    assert.notEqual(financialExceptionDetailsFingerprint(details), financialExceptionDetailsFingerprint('{"kind":"open","amount_cents":1001}'));
  });

  it("validates administrator reasons without accepting legacy operation names", () => {
    const valid = {
      financial_operation_id: "99999999-9999-4999-8999-999999999999",
      reason: "manual exception claim",
    };
    assert.deepEqual(financialDecisionRequestSchema.parse(valid), valid);
    for (const reason of ["", " leading", "trailing ", "line\nbreak", "x".repeat(MAX_FINANCIAL_REASON_CHARACTERS + 1)]) {
      assert.equal(financialDecisionRequestSchema.safeParse({ ...valid, reason }).success, false);
    }
    assert.equal(financialDecisionRequestSchema.safeParse({ ...valid, operation_type: "CONFIRM_SETTLEMENT" }).success, false);
  });

  it("fingerprints exact outbox bytes", () => {
    const first = '{"event":"confirmed","amount":1234}';
    const reordered = '{"amount":1234,"event":"confirmed"}';
    assert.match(outboxPayloadFingerprint(first), /^[0-9a-f]{64}$/);
    assert.notEqual(outboxPayloadFingerprint(first), outboxPayloadFingerprint(reordered));
  });
});
