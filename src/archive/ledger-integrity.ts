import type { DatabaseSync } from "node:sqlite";
import { conflictFingerprint, LedgerNormalizationError, parseAmountCents, parseDirection, parseOccurredAtWithPrecision, semanticFingerprint } from "../ledger/model.ts";
import { archiveIdentityDigest } from "./keys.ts";

interface RawArchiveEvidence {
  provider_account_key: string;
  external_event_id: string;
  raw_event_id: string;
  occurred_at_text: string | null;
  amount_text: string | null;
  direction_text: string | null;
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  trans_memo: string | null;
  other_account: string | null;
  invalid_shape: number | bigint;
}

interface ArchivedIdentity {
  ledger_entry_id: string;
  archive_id: string;
  semantic_fingerprint: string;
}

/** Revalidates observations of archived identities without reopening archive files or payloads. */
export function countArchivedLedgerEvidenceViolations(connection: DatabaseSync): number {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'archived_ledger_keys'").get() ||
    !connection.prepare("SELECT 1 FROM archived_ledger_keys LIMIT 1").get()) return 0;
  const identity = connection.prepare(`SELECT ledger_entry_id, archive_id, semantic_fingerprint FROM archived_ledger_keys
    WHERE provider_account_key = ? AND external_event_digest = ?`);
  const isolated = connection.prepare(`SELECT 1 FROM ledger_conflicts
    WHERE provider_account_key = ? AND raw_event_id = ? AND conflict_type = ?`);
  const changed = connection.prepare(`SELECT 1 FROM ledger_conflicts
    WHERE provider_account_key = ? AND conflict_fingerprint = ? AND external_event_id = ?
      AND conflict_type = 'DUPLICATE_EXTERNAL_ID' AND existing_ledger_entry_id IS NULL
      AND existing_semantic_fingerprint = ? AND incoming_semantic_fingerprint = ?
      AND json_extract(details_json, '$.archived_ledger_entry_id') = ?
      AND json_extract(details_json, '$.archive_id') = ?`);
  const rows = connection.prepare(`SELECT raw.provider_account_key, raw.external_event_id, raw.raw_event_id,
      raw.occurred_at_text, raw.amount_text, raw.direction_text, raw.alipay_order_no,
      raw.merchant_order_no, raw.trans_memo, raw.other_account,
      EXISTS (SELECT 1 FROM ledger_conflicts AS conflict WHERE conflict.provider_account_key = raw.provider_account_key
        AND conflict.raw_event_id = raw.raw_event_id AND conflict.conflict_type = 'INVALID_SHAPE') AS invalid_shape
    FROM provider_raw_events AS raw WHERE raw.external_event_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM archived_ledger_keys WHERE provider_account_key = raw.provider_account_key)
    ORDER BY raw.provider_account_key, raw.external_event_id`).iterate() as unknown as Iterable<RawArchiveEvidence>;
  let violations = 0;
  let previousProvider: string | undefined, previousExternalId: string | undefined;
  let archived: ArchivedIdentity | undefined;
  for (const raw of rows) {
    // The existing account/external-ID index keeps duplicate observations next
    // to one another, so both matches and misses need only one identity lookup.
    if (raw.provider_account_key !== previousProvider || raw.external_event_id !== previousExternalId) {
      archived = identity.get(raw.provider_account_key, archiveIdentityDigest(raw.external_event_id)) as ArchivedIdentity | undefined;
      previousProvider = raw.provider_account_key;
      previousExternalId = raw.external_event_id;
    }
    if (!archived || Number(raw.invalid_shape) !== 0) continue;
    let fingerprint: string;
    try {
      const occurrence = parseOccurredAtWithPrecision(raw.occurred_at_text);
      fingerprint = semanticFingerprint({ externalEventId: raw.external_event_id,
        occurredAt: occurrence.milliseconds, occurredAtPrecisionMilliseconds: occurrence.precisionMilliseconds,
        amountCents: parseAmountCents(raw.amount_text), direction: parseDirection(raw.direction_text),
        alipayOrderNo: raw.alipay_order_no, merchantOrderNo: raw.merchant_order_no,
        transMemo: raw.trans_memo, otherAccount: raw.other_account });
    } catch (error) {
      if (!(error instanceof LedgerNormalizationError) || !isolated.get(raw.provider_account_key, raw.raw_event_id, error.code)) violations++;
      continue;
    }
    if (fingerprint === archived.semantic_fingerprint) continue;
    // Repeated observations reuse the first conflict for the same semantic change.
    const conflict = conflictFingerprint(["DUPLICATE_EXTERNAL_ID", raw.external_event_id, archived.semantic_fingerprint, fingerprint]);
    if (!changed.get(raw.provider_account_key, conflict, raw.external_event_id, archived.semantic_fingerprint,
      fingerprint, archived.ledger_entry_id, archived.archive_id)) violations++;
  }
  return violations;
}
