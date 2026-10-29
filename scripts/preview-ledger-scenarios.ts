// SPDX-License-Identifier: MIT
// Synthetic source generations for the read-only ledger browser.
import assert from "node:assert/strict";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerStore } from "../src/ledger/store.ts";
import { SANDBOX_PROVIDER_ENDPOINT } from "../src/settings/model.ts";
import { previewLedgerNumber, previewTradeNumber } from "./preview-identities.ts";

const providerTime = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

function record(ledger: LedgerStore, providerAccountKey: string, details: AccountLogDetail[], now: number) {
  const times = details.map(detail => Date.parse(detail.occurredAt!));
  const run = ledger.startIngestRun({ providerAccountKey,
    start: providerTime(Math.min(...times) - 60_000), end: providerTime(Math.max(...times) + 60_000),
    pageSize: details.length, now });
  const observed = ledger.recordPage({ ingestRunId: run.ingestRunId,
    page: { pageNo: 1, pageSize: details.length, totalSize: details.length, hasMore: false, details },
    evidence: { httpStatus: 200, headers: { "x-perpay-synthetic": "true" },
      body: JSON.stringify({ synthetic: true, details }), traceId: "preview-ledger-source", signatureVerified: true }, now });
  assert.ok(observed.normalized.every(result => result.kind === "created"));
  ledger.completeIngestRun({ ingestRunId: run.ingestRunId, now });
  return details.map(detail => ledger.getLedgerEntry(providerAccountKey, detail.accountLogId!)!);
}

/** Retired sources cannot be reactivated; build this source before configuration. */
export function seedHistoricalLedgerSource(ledger: LedgerStore, capturedAt: number) {
  const occurredAt = capturedAt - 27 * 86_400_000;
  const details: AccountLogDetail[] = [
    { memo: "图书采购退款", amount: "49.00", payer: "许*然" },
    { memo: "办公用品采购尾款", amount: "731.29", payer: "林*宁" },
  ].map((item, index) => {
    const fields = { accountLogId: previewLedgerNumber(occurredAt, index + 1, 40),
      occurredAt: new Date(occurredAt).toISOString(), amount: item.amount, direction: "CREDIT",
      alipayOrderNo: previewTradeNumber(occurredAt, index + 1, 40), merchantOrderNo: null,
      transMemo: item.memo, otherAccount: item.payer };
    return { ...fields, raw: { ...fields, synthetic: true } };
  });
  ledger.bindProviderIdentity({ providerAccountKey: "preview-historical", providerKind: "alipay",
    endpoint: SANDBOX_PROVIDER_ENDPOINT, externalAccountId: "2026000000000002" }, occurredAt);
  const entries = record(ledger, "preview-historical", details, occurredAt);
  return { details, entries };
}

/** Observe the same event identities from the configured source, without new payments. */
export function seedCurrentLedgerSourceCopies(ledger: LedgerStore, providerAccountKey: string,
  historical: ReturnType<typeof seedHistoricalLedgerSource>, now: number) {
  assert.equal(ledger.providerIdentity(providerAccountKey)?.providerAccountKey, providerAccountKey);
  const details = historical.details.map((detail, index) => index === 0 ? detail : {
    ...detail, amount: "731.30", raw: { ...(detail.raw as Record<string, unknown>), amount: "731.30" },
  });
  const copies = record(ledger, providerAccountKey, details, now);
  assert.equal(copies[0]!.semanticFingerprint, historical.entries[0]!.semanticFingerprint);
  assert.notEqual(copies[1]!.semanticFingerprint, historical.entries[1]!.semanticFingerprint);
  assert.equal(ledger.providerIdentity(providerAccountKey)?.providerAccountKey, providerAccountKey);
  return { identical: historical.entries[0]!.ledgerEntryId, identicalCopy: copies[0]!.ledgerEntryId,
    inconsistent: historical.entries[1]!.ledgerEntryId, inconsistentCopy: copies[1]!.ledgerEntryId };
}
