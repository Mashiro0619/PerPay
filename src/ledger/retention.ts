import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { parseAmountCents, parseDirection, parseOccurredAtWithPrecision, semanticFingerprint } from "./model.ts";
import { retainRequestCheckpoints } from "./request-checkpoints.ts";

export const INGEST_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const INGEST_RETENTION_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
export const INGEST_RETENTION_BATCH_SIZE = 200;
export const INGEST_RETENTION_EVENT_BUDGET = 2_000;
export const INGEST_RETENTION_BYTE_BUDGET = 8 * 1024 * 1024;

export interface IngestRetentionResult {
  readonly scannedRuns: number;
  readonly deletedRuns: number;
  readonly deletedPages: number;
  readonly deletedEvents: number;
  readonly deletedObservations: number;
  readonly hasMore: boolean;
}

interface RetentionState {
  last_completed_at: number | bigint | null;
  scan_after_started_at: number | bigint | null;
  scan_after_run_id: string | null;
}

const EMPTY_RESULT: IngestRetentionResult = {
  scannedRuns: 0, deletedRuns: 0, deletedPages: 0, deletedEvents: 0, deletedObservations: 0, hasMore: false,
};

/** Reclaims successful repeated polls while retaining original transaction and diagnostic evidence. */
export function pruneIngestHistory(
  database: Pick<AppDatabase, "read" | "write">,
  now = Date.now(),
): IngestRetentionResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("ingest retention time is invalid");
  const state = database.read(readState);
  if (state.last_completed_at !== null &&
      now - Number(state.last_completed_at) < INGEST_RETENTION_INTERVAL_MILLISECONDS) return EMPTY_RESULT;
  return database.write(connection => pruneBatch(connection, now));
}

function readState(connection: DatabaseSync): RetentionState {
  return connection.prepare(`SELECT last_completed_at, scan_after_started_at, scan_after_run_id
    FROM ledger_retention_state WHERE singleton_key = 1`).get() as unknown as RetentionState;
}

function pruneBatch(connection: DatabaseSync, now: number): IngestRetentionResult {
  const state = readState(connection);
  connection.exec(`CREATE TEMP TABLE IF NOT EXISTS ingest_retention_batch (
    ingest_run_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  DELETE FROM ingest_retention_batch;`);
  const seek = state.scan_after_started_at === null ? "" : "AND (run.started_at, run.ingest_run_id) > (?, ?)";
  const seekParameters = state.scan_after_started_at === null ? [] : [state.scan_after_started_at, state.scan_after_run_id];
  const candidates = connection.prepare(`SELECT run.ingest_run_id, run.started_at, run.details_received,
       (SELECT length(page.raw_body) FROM ingest_run_page_observations AS observation
          JOIN provider_raw_pages AS page ON page.raw_page_id = observation.raw_page_id
         WHERE observation.ingest_run_id = run.ingest_run_id LIMIT 1) AS raw_bytes
      FROM ingest_runs AS run
     WHERE run.status = 'COMPLETED' AND run.pages_received = 1
       AND run.completed_at < ?
       ${seek}
       AND NOT EXISTS (SELECT 1 FROM ingest_errors AS error WHERE error.ingest_run_id = run.ingest_run_id)
       AND run.ingest_run_id != COALESCE((
         SELECT latest.ingest_run_id FROM ingest_runs AS latest
          WHERE latest.provider_account_key = run.provider_account_key
            AND (latest.scan_kind = 'NORMAL') = (run.scan_kind = 'NORMAL')
          ORDER BY latest.started_at DESC, latest.ingest_run_id DESC LIMIT 1
       ), '')
       AND run.ingest_run_id != COALESCE((
         SELECT ingest_run_id FROM ingest_run_page_observations
          ORDER BY observation_sequence DESC LIMIT 1
       ), '')
     ORDER BY run.started_at, run.ingest_run_id LIMIT ?`).all(
       now - INGEST_RETENTION_MILLISECONDS,
       ...seekParameters,
       INGEST_RETENTION_BATCH_SIZE,
     ) as unknown as { ingest_run_id: string; started_at: bigint | number; details_received: bigint | number; raw_bytes: bigint | number }[];
  let eventCount = 0;
  let byteCount = 0;
  let scannedRuns = 0;
  const insertCandidate = connection.prepare("INSERT INTO ingest_retention_batch VALUES (?, ?)");
  for (const candidate of candidates) {
    const events = Number(candidate.details_received);
    const bytes = Number(candidate.raw_bytes);
    if (scannedRuns > 0 && (eventCount + events > INGEST_RETENTION_EVENT_BUDGET ||
        byteCount + bytes > INGEST_RETENTION_BYTE_BUDGET)) break;
    insertCandidate.run(candidate.ingest_run_id, candidate.started_at);
    scannedRuns++;
    eventCount += events;
    byteCount += bytes;
  }
  const last = candidates[scannedRuns - 1];
  const hasMore = candidates.length === INGEST_RETENTION_BATCH_SIZE || scannedRuns < candidates.length;

  // Conflicts retain their preceding observations even when the page is empty.
  connection.exec(`DELETE FROM ingest_retention_batch AS batch WHERE EXISTS (
    SELECT 1 FROM ingest_run_page_observations AS observation
      JOIN provider_raw_pages AS page ON page.raw_page_id = observation.raw_page_id
     WHERE observation.ingest_run_id = batch.ingest_run_id AND (
       observation.disposition != 'PROCESSED' OR observation.observation_kind != 'ACCEPTED_LEAF' OR page.has_more != 0
       OR EXISTS (SELECT 1 FROM provider_raw_events AS event
         JOIN ledger_conflicts AS conflict ON conflict.raw_event_id = event.raw_event_id
         WHERE event.raw_page_id = page.raw_page_id)
       OR EXISTS (
         SELECT 1 FROM ledger_conflicts AS conflict WHERE conflict.provider_account_key = page.provider_account_key AND (
           conflict.raw_page_id = page.raw_page_id
           OR json_extract(conflict.details_json, '$.existing_raw_page_id') = page.raw_page_id
           OR json_extract(conflict.details_json, '$.incoming_raw_page_id') = page.raw_page_id
           OR json_extract(conflict.details_json, '$.request_fingerprint') = page.request_fingerprint
           OR json_extract(conflict.details_json, '$.ingest_segment_id') = observation.ingest_segment_id
           OR json_extract(conflict.details_json, '$.previous_observation_sequence') = observation.observation_sequence
         )
       )
     )
  );`);
  retainOriginalOrUnresolvedEvents(connection);
  // Shared pages stay with their originating run until the final reference is
  // retired. Duplicate runs can leave independently, including across batches.
  connection.exec(`DELETE FROM ingest_retention_batch AS batch WHERE EXISTS (
    SELECT 1 FROM provider_raw_pages AS page
     WHERE page.ingest_run_id = batch.ingest_run_id AND (
       EXISTS (SELECT 1 FROM ingest_run_page_observations AS other
         WHERE other.raw_page_id = page.raw_page_id AND NOT EXISTS (
           SELECT 1 FROM ingest_retention_batch WHERE ingest_run_id = other.ingest_run_id
         ))
       OR EXISTS (SELECT 1 FROM ingest_segments AS segment
         WHERE segment.accepted_raw_page_id = page.raw_page_id AND NOT EXISTS (
           SELECT 1 FROM ingest_retention_batch WHERE ingest_run_id = segment.ingest_run_id
         ))
     )
  );`);

  connection.exec("UPDATE ledger_retention_state SET pruning = 1 WHERE singleton_key = 1");
  retainRequestCheckpoints(connection);
  const deletedObservations = Number(connection.prepare(`DELETE FROM ingest_run_page_observations
    WHERE ingest_run_id IN (SELECT ingest_run_id FROM ingest_retention_batch)`).run().changes);
  connection.exec(`DELETE FROM ingest_segments
    WHERE ingest_run_id IN (SELECT ingest_run_id FROM ingest_retention_batch);`);
  const deletedEvents = Number(connection.prepare(`DELETE FROM provider_raw_events
    WHERE raw_page_id IN (SELECT raw_page_id FROM provider_raw_pages
      WHERE ingest_run_id IN (SELECT ingest_run_id FROM ingest_retention_batch))`).run().changes);
  const deletedPages = Number(connection.prepare(`DELETE FROM provider_raw_pages
    WHERE ingest_run_id IN (SELECT ingest_run_id FROM ingest_retention_batch)`).run().changes);
  const deletedRuns = Number(connection.prepare(`DELETE FROM ingest_runs
    WHERE ingest_run_id IN (SELECT ingest_run_id FROM ingest_retention_batch)`).run().changes);
  connection.prepare(`UPDATE ledger_retention_state
    SET pruning = 0, last_completed_at = ?, scan_after_started_at = ?, scan_after_run_id = ?
    WHERE singleton_key = 1`).run(
      hasMore ? state.last_completed_at : now,
      hasMore ? last!.started_at : null,
      hasMore ? last!.ingest_run_id : null,
    );
  connection.exec("DELETE FROM ingest_retention_batch");
  return { scannedRuns, deletedRuns, deletedPages, deletedEvents, deletedObservations, hasMore };
}

interface EventCandidate {
  ingest_run_id: string;
  raw_event_id: string;
  external_event_id: string | null;
  occurred_at_text: string | null;
  amount_text: string | null;
  direction_text: string | null;
  alipay_order_no: string | null;
  merchant_order_no: string | null;
  trans_memo: string | null;
  other_account: string | null;
  canonical_event_id: string | null;
  canonical_fingerprint: string | null;
  has_conflict: bigint | number;
}

function retainOriginalOrUnresolvedEvents(connection: DatabaseSync): void {
  // Keep the bounded batch outermost instead of scanning historical raw events.
  const events = connection.prepare(`SELECT page.ingest_run_id, event.raw_event_id, event.external_event_id,
      event.occurred_at_text, event.amount_text, event.direction_text, event.alipay_order_no,
      event.merchant_order_no, event.trans_memo, event.other_account,
      entry.raw_event_id AS canonical_event_id, entry.semantic_fingerprint AS canonical_fingerprint,
      EXISTS (SELECT 1 FROM ledger_conflicts AS conflict WHERE conflict.raw_event_id = event.raw_event_id) AS has_conflict
    FROM ingest_retention_batch AS batch
      CROSS JOIN provider_raw_pages AS page
      CROSS JOIN provider_raw_events AS event
      LEFT JOIN ledger_entries AS entry ON entry.provider_account_key = event.provider_account_key
        AND entry.external_event_id = event.external_event_id
    WHERE page.ingest_run_id = batch.ingest_run_id AND event.raw_page_id = page.raw_page_id`).all() as unknown as EventCandidate[];
  const retainedRuns = new Set<string>();
  const retain = connection.prepare("DELETE FROM ingest_retention_batch WHERE ingest_run_id = ?");
  for (const event of events) {
    if (retainedRuns.has(event.ingest_run_id)) continue;
    if (event.canonical_event_id === event.raw_event_id || Number(event.has_conflict) !== 0 || !isKnownDuplicate(event)) {
      retain.run(event.ingest_run_id);
      retainedRuns.add(event.ingest_run_id);
    }
  }
}

function isKnownDuplicate(event: EventCandidate): boolean {
  if (event.external_event_id === null || event.canonical_fingerprint === null) return false;
  try {
    const occurredAt = parseOccurredAtWithPrecision(event.occurred_at_text);
    return semanticFingerprint({
      externalEventId: event.external_event_id,
      occurredAt: occurredAt.milliseconds,
      occurredAtPrecisionMilliseconds: occurredAt.precisionMilliseconds,
      amountCents: parseAmountCents(event.amount_text),
      direction: parseDirection(event.direction_text),
      alipayOrderNo: event.alipay_order_no,
      merchantOrderNo: event.merchant_order_no,
      transMemo: event.trans_memo,
      otherAccount: event.other_account,
    }) === event.canonical_fingerprint;
  } catch {
    return false;
  }
}
