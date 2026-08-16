import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AppDatabase } from "../database/database.ts";
import type { AccountLogDetail } from "../infrastructure/alipay/types.ts";
import {
  LEDGER_CURSOR_DEFAULT_OVERLAP_MILLISECONDS,
  LEDGER_MAX_RAW_EVENT_BYTES,
  LEDGER_MAX_RAW_PAGE_BYTES,
  LedgerNormalizationError,
  conflictFingerprint,
  normalizeProviderIdentity,
  normalizeProviderAccountKey,
  parseAmountCents,
  parseDirection,
  parseOccurredAt,
  payloadFingerprint,
  requestFingerprint,
  responseFingerprint,
  semanticFingerprint,
  splitLedgerWindow,
  toBytes,
  validateOverlapMilliseconds,
  validatePageSize,
  validateWindow,
  type CompleteIngestRunInput,
  type IngestErrorInput,
  type IngestRun,
  type IngestSegment,
  type LedgerConflict,
  type LedgerConflictType,
  type LedgerCursor,
  type LedgerEntry,
  type LedgerListFilter,
  type PageNormalizationResult,
  type ProviderIdentityBinding,
  type ProviderIdentityInput,
  type RawPageEvidence,
  type RawErrorEvidence,
  type RawEventRecord,
  type RawPageRecord,
  type RecordLedgerPageInput,
  type RecordPageResult,
  type RecordSegmentPageInput,
  type RecordSegmentPageResult,
  type SegmentObservationKind,
  type StartIngestRunInput,
} from "./model.ts";

type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

interface IngestRunRow {
  readonly ingest_run_id: string;
  readonly provider_account_key: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly page_size: bigint | number;
  readonly status: IngestRun["status"];
  readonly started_at: bigint | number;
  readonly completed_at: bigint | number | null;
  readonly pages_received: bigint | number;
  readonly details_received: bigint | number;
  readonly failure_code: string | null;
}

interface CursorRow {
  readonly provider_account_key: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly next_page_no: bigint | number | null;
  readonly page_size: bigint | number;
  readonly expected_total_size: bigint | number | null;
  readonly overlap_milliseconds: bigint | number;
  readonly complete: bigint | number;
  readonly last_event_occurred_at: bigint | number | null;
  readonly last_completed_at: bigint | number | null;
  readonly updated_at: bigint | number;
  readonly version: bigint | number;
}

interface ProviderIdentityRow {
  readonly provider_account_key: string;
  readonly provider_kind: "alipay";
  readonly provider_endpoint: string;
  readonly external_account_id: string;
  readonly identity_fingerprint_version: bigint | number;
  readonly identity_fingerprint: string;
  readonly bound_at: bigint | number;
}

interface IngestSegmentRow {
  readonly ingest_segment_id: string;
  readonly ingest_run_id: string;
  readonly parent_segment_id: string | null;
  readonly window_start: string;
  readonly window_end: string;
  readonly depth: bigint | number;
  readonly state: IngestSegment["state"];
  readonly split_at: string | null;
  readonly accepted_raw_page_id: string | null;
  readonly created_at: bigint | number;
  readonly completed_at: bigint | number | null;
}

interface RawPageRow {
  readonly raw_page_id: string;
  readonly ingest_run_id: string;
  readonly provider_account_key: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly page_no: bigint | number;
  readonly page_size: bigint | number;
  readonly total_size: bigint | number;
  readonly has_more: bigint | number;
  readonly request_fingerprint: string;
  readonly response_fingerprint: string;
  readonly http_status: bigint | number;
  readonly signature_verified: bigint | number;
  readonly trace_id: string | null;
  readonly received_at: bigint | number;
}

interface LedgerEntryRow {
  readonly ledger_entry_id: string;
  readonly provider_account_key: string;
  readonly raw_event_id: string;
  readonly external_event_id: string;
  readonly semantic_fingerprint: string;
  readonly occurred_at: bigint | number;
  readonly amount_cents: bigint | number;
  readonly direction: LedgerEntry["direction"];
  readonly currency: "CNY";
  readonly alipay_order_no: string | null;
  readonly merchant_order_no: string | null;
  readonly trans_memo: string | null;
  readonly other_account: string | null;
  readonly state: LedgerEntry["state"];
  readonly created_at: bigint | number;
  readonly updated_at: bigint | number;
}

interface ConflictRow {
  readonly conflict_id: string;
  readonly provider_account_key: string;
  readonly conflict_type: LedgerConflict["conflictType"];
  readonly raw_page_id: string | null;
  readonly raw_event_id: string | null;
  readonly existing_ledger_entry_id: string | null;
  readonly external_event_id: string | null;
  readonly existing_semantic_fingerprint: string | null;
  readonly incoming_semantic_fingerprint: string | null;
  readonly details_json: string;
  readonly status: LedgerConflict["status"];
  readonly created_at: bigint | number;
  readonly resolved_at: bigint | number | null;
  readonly conflict_fingerprint: string;
}

interface PreparedRawEvent {
  readonly rawEventId: string;
  readonly rawPayload: Uint8Array;
  readonly payloadFingerprint: string;
  readonly externalEventId: string | null;
  readonly occurredAtText: string | null;
  readonly amountText: string | null;
  readonly directionText: string | null;
  readonly alipayOrderNo: string | null;
  readonly merchantOrderNo: string | null;
  readonly transMemo: string | null;
  readonly otherAccount: string | null;
  readonly shapeInvalid: boolean;
}

interface PreparedErrorEvidence {
  readonly httpStatus: number;
  readonly headersJson: string;
  readonly rawBody: Uint8Array;
  readonly responseFingerprint: string;
  readonly traceId: string | null;
  readonly signatureVerified: boolean | null;
}

interface PreparedSegmentPage {
  readonly now: number;
  readonly evidence: RawPageEvidence;
  readonly rawBody: Uint8Array;
  readonly headersJson: string;
  readonly responseHash: string;
}

interface RetainedSegmentPage {
  readonly observation: "inserted" | "duplicate" | "variant";
  readonly newlyObserved: boolean;
  readonly page: RawPageRecord;
}

/**
 * Synchronous persistence boundary for provider ingestion.
 *
 * Every mutating method is one `AppDatabase.write()` call, so raw evidence,
 * normalized facts, conflict isolation, and cursor movement commit together
 * under the application's single `BEGIN IMMEDIATE` writer.
 */
export class LedgerStore {
  readonly #database: DatabaseOwner;

  constructor(database: DatabaseOwner) {
    this.#database = database;
  }

  /**
   * Permanently binds the logical ledger namespace to one platform account.
   * Repeating the same identity is idempotent; changing endpoint or external
   * account identity requires a fresh database rather than silent reuse.
   */
  bindProviderIdentity(input: ProviderIdentityInput, nowInput?: number): ProviderIdentityBinding {
    const identity = normalizeProviderIdentity(input);
    const now = safeNow(nowInput);
    return this.#database.write((connection) => {
      const existing = readProviderIdentityBinding(connection, identity.providerAccountKey);
      if (existing === null) {
        const inserted = connection.prepare(
          `INSERT INTO provider_account_bindings(
             provider_account_key, provider_kind, provider_endpoint,
             external_account_id, identity_fingerprint_version,
             identity_fingerprint, bound_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          identity.providerAccountKey,
          identity.providerKind,
          identity.endpoint,
          identity.externalAccountId,
          identity.identityFingerprintVersion,
          identity.identityFingerprint,
          now,
        );
        assertChangedOnce(inserted.changes, "provider identity binding insert");
      }

      const binding = requireProviderIdentityBinding(connection, identity.providerAccountKey);
      assertProviderIdentityBindingIntegrity(binding);
      if (
        binding.providerKind !== identity.providerKind ||
        binding.endpoint !== identity.endpoint ||
        binding.externalAccountId !== identity.externalAccountId ||
        binding.identityFingerprintVersion !== identity.identityFingerprintVersion ||
        binding.identityFingerprint !== identity.identityFingerprint
      ) {
        throw new Error("provider identity does not match the existing account binding");
      }
      return binding;
    });
  }

  startIngestRun(input: StartIngestRunInput): IngestRun {
    validateWindow(input);
    validatePageSize(input.pageSize);
    const providerAccountKey = normalizeProviderAccountKey(input.providerAccountKey);
    const overlapMilliseconds =
      input.overlapMilliseconds ?? LEDGER_CURSOR_DEFAULT_OVERLAP_MILLISECONDS;
    validateOverlapMilliseconds(overlapMilliseconds);
    const requestedNow = safeNow(input.now);

    return this.#database.write((connection) => {
      const binding = readProviderIdentityBinding(connection, providerAccountKey);
      if (binding === null) {
        throw new Error("provider account must be bound before ledger ingestion");
      }
      assertProviderIdentityBindingIntegrity(binding);
      const running = readRunningRun(connection, providerAccountKey);
      const cursor = readCursor(connection, providerAccountKey);
      if (running) {
        if (
          running.windowStart !== input.start ||
          running.windowEnd !== input.end ||
          running.pageSize !== input.pageSize ||
          cursor === null ||
          cursor.windowStart !== input.start ||
          cursor.windowEnd !== input.end ||
          cursor.pageSize !== input.pageSize ||
          cursor.overlapMilliseconds !== overlapMilliseconds ||
          cursor.complete
        ) {
          throw new Error("provider account already has a different running ingest window");
        }
        requireRootSegment(connection, running.ingestRunId);
        return running;
      }
      const now = Math.max(
        requestedNow,
        cursor?.updatedAt ?? 0,
        cursor?.lastCompletedAt ?? 0,
      );
      if (cursor === null) {
        const inserted = connection
          .prepare(
            `INSERT INTO ledger_cursors(
               provider_account_key, window_start, window_end, next_page_no,
               page_size, expected_total_size, overlap_milliseconds, complete, last_event_occurred_at,
               last_completed_at, updated_at, version
             ) VALUES (?, ?, ?, 1, ?, NULL, ?, 0, NULL, NULL, ?, 1)`,
          )
          .run(providerAccountKey, input.start, input.end, input.pageSize, overlapMilliseconds, now);
        assertChangedOnce(inserted.changes, "ledger cursor insert");
      } else if (!cursor.complete) {
        if (
          cursor.windowStart !== input.start ||
          cursor.windowEnd !== input.end ||
          cursor.pageSize !== input.pageSize ||
          cursor.overlapMilliseconds !== overlapMilliseconds
        ) {
          throw new Error("an incomplete ledger window must be resumed with the same parameters");
        }
      } else {
        const updated = connection
          .prepare(
            `UPDATE ledger_cursors
                SET window_start = ?, window_end = ?, next_page_no = 1,
                    page_size = ?, expected_total_size = NULL,
                    overlap_milliseconds = ?, complete = 0,
                    updated_at = ?, version = version + 1
              WHERE provider_account_key = ?`,
          )
          .run(input.start, input.end, input.pageSize, overlapMilliseconds, now, providerAccountKey);
        assertChangedOnce(updated.changes, "ledger cursor restart");
      }

      const ingestRunId = randomUUID();
      const inserted = connection
        .prepare(
          `INSERT INTO ingest_runs(
             ingest_run_id, provider_account_key, window_start, window_end,
             page_size, status, started_at
           ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)`,
        )
        .run(ingestRunId, providerAccountKey, input.start, input.end, input.pageSize, now);
      assertChangedOnce(inserted.changes, "ingest run insert");
      const rootSegmentId = randomUUID();
      const rootInserted = connection
        .prepare(
          `INSERT INTO ingest_segments(
             ingest_segment_id, ingest_run_id, parent_segment_id,
             window_start, window_end, depth, state, created_at
           ) VALUES (?, ?, NULL, ?, ?, 0, 'PENDING', ?)`,
        )
        .run(rootSegmentId, ingestRunId, input.start, input.end, now);
      assertChangedOnce(rootInserted.changes, "ingest root segment insert");
      return requireRun(connection, ingestRunId);
    });
  }

  recordPage(input: RecordLedgerPageInput): RecordPageResult {
    if (input.page.hasMore) {
      throw new Error("oversized provider pages require the segment-aware persistence API");
    }
    const segment = this.getNextPendingSegment(input.ingestRunId);
    if (!segment) throw new Error("ingest run has no pending segment");
    const result = this.recordSegmentPage({ ...input, ingestSegmentId: segment.ingestSegmentId });
    if (result.kind !== "accepted") throw new Error("provider leaf was not accepted");
    return {
      kind: result.observation,
      page: result.page,
      normalized: result.normalized,
      cursor: result.cursor,
    };
  }

  recordSegmentPage(input: RecordSegmentPageInput): RecordSegmentPageResult {
    const requestedPage = prepareSegmentPage(input);
    return this.#database.write((connection) => {
      const run = requireRun(connection, input.ingestRunId);
      if (run.status !== "RUNNING") throw new Error("ingest run is already terminal");
      const segment = requireSegment(connection, input.ingestSegmentId);
      if (segment.ingestRunId !== run.ingestRunId || segment.state !== "PENDING") {
        throw new Error("ingest segment is not pending for this run");
      }
      if (run.pageSize !== input.page.pageSize) {
        throw new Error("provider page size does not match the ingest run");
      }
      const cursor = requireCursor(connection, run.providerAccountKey);
      if (
        cursor.complete ||
        cursor.windowStart !== run.windowStart ||
        cursor.windowEnd !== run.windowEnd ||
        cursor.pageSize !== run.pageSize
      ) {
        throw new Error("ingest run no longer owns the active ledger window");
      }
      validateDetailsWithinSegment(input.page.details, segment);
      const prepared: PreparedSegmentPage = {
        ...requestedPage,
        now: clampIngestWriteTime(connection, run, cursor, requestedPage.now),
      };

      const observationKind: SegmentObservationKind = input.page.hasMore
        ? "OVERSIZED_PROBE"
        : "ACCEPTED_LEAF";
      const retained = retainSegmentPage(
        connection,
        run,
        segment,
        input.page,
        prepared,
        observationKind,
      );
      if (!retained.newlyObserved) {
        throw new Error("pending ingest segment already observed this provider page");
      }

      if (input.page.hasMore) {
        updateRunProgress(connection, run.ingestRunId, 0);
        const split = splitLedgerWindow({ start: segment.windowStart, end: segment.windowEnd });
        if (split === null) {
          failDensityExceeded(connection, run, segment, retained.page, prepared.now);
          return {
            kind: "density_exceeded",
            observation: retained.observation,
            page: retained.page,
            segment: requireSegment(connection, segment.ingestSegmentId),
            children: [],
            normalized: [],
            cursor: requireCursor(connection, run.providerAccountKey),
            run: requireRun(connection, run.ingestRunId),
          };
        }

        const splitResult = connection
          .prepare(
            `UPDATE ingest_segments
                SET state = 'SPLIT', split_at = ?, completed_at = ?
              WHERE ingest_segment_id = ? AND state = 'PENDING'`,
          )
          .run(split.splitAt, prepared.now, segment.ingestSegmentId);
        assertChangedOnce(splitResult.changes, "ingest segment split");
        const left = insertChildSegment(
          connection,
          segment,
          split.left.start,
          split.left.end,
          prepared.now,
        );
        const right = insertChildSegment(
          connection,
          segment,
          split.right.start,
          split.right.end,
          prepared.now,
        );
        return {
          kind: "split",
          observation: retained.observation,
          page: retained.page,
          segment: requireSegment(connection, segment.ingestSegmentId),
          children: [left, right],
          normalized: [],
          cursor: requireCursor(connection, run.providerAccountKey),
          run: requireRun(connection, run.ingestRunId),
        };
      }

      const normalized: PageNormalizationResult[] = [];
      if (retained.observation === "duplicate") {
        const storedDetailCount = rawEventCountForPage(connection, retained.page.rawPageId);
        if (storedDetailCount !== input.page.details.length) {
          throw new Error("duplicate accepted leaf does not contain its stored raw events");
        }
      } else {
        for (const [ordinal, detail] of input.page.details.entries()) {
          const rawEvent = insertRawEvent(
            connection,
            run.providerAccountKey,
            retained.page.rawPageId,
            ordinal,
            detail,
            prepared.now,
          );
          normalized.push(normalizeAndInsert(connection, rawEvent, prepared.now));
        }
      }
      updateRunProgress(connection, run.ingestRunId, input.page.details.length);
      const completed = connection
        .prepare(
          `UPDATE ingest_segments
              SET state = 'COMPLETE', accepted_raw_page_id = ?, completed_at = ?
            WHERE ingest_segment_id = ? AND state = 'PENDING'`,
        )
        .run(retained.page.rawPageId, prepared.now, segment.ingestSegmentId);
      assertChangedOnce(completed.changes, "ingest segment completion");

      const rootCompleted = !hasPendingSegments(connection, run.ingestRunId);
      if (rootCompleted) completeSegmentRun(connection, run, cursor, prepared.now);
      return {
        kind: "accepted",
        observation: retained.observation,
        page: retained.page,
        segment: requireSegment(connection, segment.ingestSegmentId),
        children: [],
        normalized,
        cursor: requireCursor(connection, run.providerAccountKey),
        run: requireRun(connection, run.ingestRunId),
        rootCompleted,
      };
    });
  }

  getNextPendingSegment(ingestRunId: string): IngestSegment | null {
    return this.#database.read((connection) => readNextPendingSegment(connection, ingestRunId));
  }

  getRootSegment(ingestRunId: string): IngestSegment | null {
    return this.#database.read((connection) => readRootSegment(connection, ingestRunId));
  }

  listIngestSegments(ingestRunId: string): readonly IngestSegment[] {
    return this.#database.read((connection) => {
      const rows = connection
        .prepare(
          `SELECT ${INGEST_SEGMENT_COLUMNS}
             FROM ingest_segments
            WHERE ingest_run_id = ?
            ORDER BY depth, window_start, window_end, ingest_segment_id`,
        )
        .all(ingestRunId) as unknown as IngestSegmentRow[];
      return rows.map(mapSegment);
    });
  }

  completeIngestRun(input: CompleteIngestRunInput): IngestRun {
    const requestedNow = safeNow(input.now);
    return this.#database.write((connection) => {
      const run = requireRun(connection, input.ingestRunId);
      if (run.status !== "RUNNING") return run;
      const cursor = requireCursor(connection, run.providerAccountKey);
      const now = clampIngestWriteTime(connection, run, cursor, requestedNow);
      const status = input.status ?? (cursor.complete ? "COMPLETED" : "PARTIAL");
      if (status === "PARTIAL" && !cursor.complete) return run;
      if (status === "COMPLETED" && !cursor.complete) {
        throw new Error("an incomplete ledger cursor cannot complete its ingest run");
      }
      const updated = connection
        .prepare(
          `UPDATE ingest_runs
              SET status = ?, completed_at = ?
            WHERE ingest_run_id = ? AND status = 'RUNNING'`,
        )
        .run(status, now, run.ingestRunId);
      assertChangedOnce(updated.changes, "ingest run completion");
      return requireRun(connection, run.ingestRunId);
    });
  }

  recordIngestError(input: IngestErrorInput): IngestRun {
    const requestedNow = safeNow(input.now);
    const detailsJson = serializeDetails(input.details ?? {});
    const errorEvidence = prepareErrorEvidence(input.evidence);
    validateErrorLabel(input.errorKind, "ingest error kind", 64);
    validateErrorLabel(input.errorCode, "ingest error code", 128);
    if (input.pageNo !== undefined && (!Number.isSafeInteger(input.pageNo) || input.pageNo < 1)) {
      throw new RangeError("ingest error page number is invalid");
    }
    return this.#database.write((connection) => {
      const run = requireRun(connection, input.ingestRunId);
      if (run.status !== "RUNNING") throw new Error("ingest run is already terminal");
      const cursor = requireCursor(connection, run.providerAccountKey);
      const now = clampIngestWriteTime(connection, run, cursor, requestedNow);
      const inserted = connection
        .prepare(
          `INSERT INTO ingest_errors(
             ingest_error_id, ingest_run_id, provider_account_key, page_no,
             error_kind, error_code, retryable, http_status, headers_json,
             raw_body, response_fingerprint, trace_id, signature_verified,
             details_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          run.ingestRunId,
          run.providerAccountKey,
          input.pageNo ?? null,
          input.errorKind,
          input.errorCode,
          input.retryable ? 1 : 0,
          errorEvidence?.httpStatus ?? null,
          errorEvidence?.headersJson ?? null,
          errorEvidence?.rawBody ?? null,
          errorEvidence?.responseFingerprint ?? null,
          errorEvidence?.traceId ?? null,
          errorEvidence?.signatureVerified === null || errorEvidence === null
            ? null
            : errorEvidence.signatureVerified ? 1 : 0,
          detailsJson,
          now,
        );
      assertChangedOnce(inserted.changes, "ingest error insert");
      const failed = connection
        .prepare(
          `UPDATE ingest_runs
              SET status = 'FAILED', completed_at = ?, failure_code = ?
            WHERE ingest_run_id = ? AND status = 'RUNNING'`,
        )
        .run(now, input.errorCode, run.ingestRunId);
      assertChangedOnce(failed.changes, "ingest run failure");
      if (!cursor.complete) {
        const rewound = connection
          .prepare(
            `UPDATE ledger_cursors
                SET next_page_no = 1, expected_total_size = NULL,
                    updated_at = ?, version = version + 1
              WHERE provider_account_key = ? AND version = ?`,
          )
          .run(Math.max(now, cursor.updatedAt), cursor.providerAccountKey, cursor.version);
        assertChangedOnce(rewound.changes, "ledger cursor rewind after ingest failure");
      }
      return requireRun(connection, run.ingestRunId);
    });
  }

  getCursor(providerAccountKey = "primary"): LedgerCursor | null {
    const account = normalizeProviderAccountKey(providerAccountKey);
    return this.#database.read((connection) => readCursor(connection, account));
  }

  getRun(ingestRunId: string): IngestRun | null {
    return this.#database.read((connection) => readRun(connection, ingestRunId));
  }

  getRawPageBody(rawPageId: string): Uint8Array | null {
    return this.#database.read((connection) => {
      const row = connection
        .prepare("SELECT raw_body FROM provider_raw_pages WHERE raw_page_id = ?")
        .get(rawPageId) as { raw_body: Uint8Array } | undefined;
      return row ? new Uint8Array(row.raw_body) : null;
    });
  }

  getLedgerEntry(providerAccountKey: string, externalEventId: string): LedgerEntry | null {
    const account = normalizeProviderAccountKey(providerAccountKey);
    if (externalEventId.length < 1 || externalEventId.length > 256) return null;
    return this.#database.read((connection) =>
      readLedgerEntryByExternalId(connection, account, externalEventId),
    );
  }

  listLedgerEntries(filter: LedgerListFilter = {}): readonly LedgerEntry[] {
    const account = normalizeProviderAccountKey(filter.providerAccountKey);
    const limit = filter.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("ledger list limit is invalid");
    }
    if (filter.amountCents !== undefined && (!Number.isSafeInteger(filter.amountCents) || filter.amountCents < 1)) {
      throw new RangeError("ledger amount filter is invalid");
    }
    if (filter.occurredFrom !== undefined) safeTimestamp(filter.occurredFrom, "ledger occurred-from");
    if (filter.occurredUntil !== undefined) safeTimestamp(filter.occurredUntil, "ledger occurred-until");

    return this.#database.read((connection) => {
      const predicates = ["provider_account_key = ?"];
      const parameters: Array<string | number> = [account];
      if (filter.state !== undefined) {
        predicates.push("state = ?");
        parameters.push(filter.state);
      }
      if (filter.direction !== undefined) {
        predicates.push("direction = ?");
        parameters.push(filter.direction);
      }
      if (filter.amountCents !== undefined) {
        predicates.push("amount_cents = ?");
        parameters.push(filter.amountCents);
      }
      if (filter.occurredFrom !== undefined) {
        predicates.push("occurred_at >= ?");
        parameters.push(filter.occurredFrom);
      }
      if (filter.occurredUntil !== undefined) {
        predicates.push("occurred_at < ?");
        parameters.push(filter.occurredUntil);
      }
      parameters.push(limit);
      const rows = connection
        .prepare(
          `SELECT ${LEDGER_ENTRY_COLUMNS}
             FROM ledger_entries
            WHERE ${predicates.join(" AND ")}
            ORDER BY occurred_at DESC, ledger_entry_id
            LIMIT ?`,
        )
        .all(...parameters) as unknown as LedgerEntryRow[];
      return rows.map(mapLedgerEntry);
    });
  }

  listOpenConflicts(providerAccountKey = "primary", limit = 100): readonly LedgerConflict[] {
    const account = normalizeProviderAccountKey(providerAccountKey);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("ledger conflict list limit is invalid");
    }
    return this.#database.read((connection) => {
      const rows = connection
        .prepare(
          `SELECT ${CONFLICT_COLUMNS}
             FROM ledger_conflicts
            WHERE provider_account_key = ? AND status = 'OPEN'
            ORDER BY created_at, conflict_id
            LIMIT ?`,
        )
        .all(account, limit) as unknown as ConflictRow[];
      return rows.map(mapConflict);
    });
  }
}

const INGEST_RUN_COLUMNS = `
  ingest_run_id, provider_account_key, window_start, window_end, page_size,
  status, started_at, completed_at, pages_received, details_received, failure_code
`;

const INGEST_SEGMENT_COLUMNS = `
  ingest_segment_id, ingest_run_id, parent_segment_id, window_start, window_end,
  depth, state, split_at, accepted_raw_page_id, created_at, completed_at
`;

const RAW_PAGE_COLUMNS = `
  raw_page_id, ingest_run_id, provider_account_key, window_start, window_end,
  page_no, page_size, total_size, has_more, request_fingerprint,
  response_fingerprint, http_status, signature_verified, trace_id, received_at
`;

const LEDGER_ENTRY_COLUMNS = `
  ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
  semantic_fingerprint, occurred_at, amount_cents, direction, currency,
  alipay_order_no, merchant_order_no, trans_memo, other_account, state,
  created_at, updated_at
`;

const CONFLICT_COLUMNS = `
  conflict_id, provider_account_key, conflict_type, raw_page_id, raw_event_id,
  existing_ledger_entry_id, external_event_id, existing_semantic_fingerprint,
  incoming_semantic_fingerprint, details_json, status, created_at, resolved_at,
  conflict_fingerprint
`;

function readProviderIdentityBinding(
  connection: DatabaseSync,
  providerAccountKey: string,
): ProviderIdentityBinding | null {
  const row = connection.prepare(
    `SELECT provider_account_key, provider_kind, provider_endpoint,
            external_account_id, identity_fingerprint_version,
            identity_fingerprint, bound_at
       FROM provider_account_bindings
      WHERE provider_account_key = ?`,
  ).get(providerAccountKey) as ProviderIdentityRow | undefined;
  return row ? mapProviderIdentityBinding(row) : null;
}

function requireProviderIdentityBinding(
  connection: DatabaseSync,
  providerAccountKey: string,
): ProviderIdentityBinding {
  const binding = readProviderIdentityBinding(connection, providerAccountKey);
  if (binding === null) throw new Error("provider identity binding does not exist");
  return binding;
}

function mapProviderIdentityBinding(row: ProviderIdentityRow): ProviderIdentityBinding {
  if (row.provider_account_key !== "primary" || row.provider_kind !== "alipay") {
    throw new Error("provider identity binding has an invalid namespace");
  }
  const fingerprintVersion = toSafeInteger(
    row.identity_fingerprint_version,
    "provider identity fingerprint version",
  );
  if (fingerprintVersion !== 1) {
    throw new Error("provider identity fingerprint version is unsupported");
  }
  return {
    providerAccountKey: row.provider_account_key,
    providerKind: row.provider_kind,
    endpoint: row.provider_endpoint,
    externalAccountId: row.external_account_id,
    identityFingerprintVersion: fingerprintVersion,
    identityFingerprint: row.identity_fingerprint,
    boundAt: toSafeInteger(row.bound_at, "provider identity binding time"),
  };
}

function assertProviderIdentityBindingIntegrity(binding: ProviderIdentityBinding): void {
  const expected = normalizeProviderIdentity(binding);
  if (
    binding.identityFingerprintVersion !== expected.identityFingerprintVersion ||
    binding.identityFingerprint !== expected.identityFingerprint
  ) {
    throw new Error("provider identity binding fingerprint is invalid");
  }
}

function readRun(connection: DatabaseSync, ingestRunId: string): IngestRun | null {
  const row = connection
    .prepare(`SELECT ${INGEST_RUN_COLUMNS} FROM ingest_runs WHERE ingest_run_id = ?`)
    .get(ingestRunId) as IngestRunRow | undefined;
  return row ? mapRun(row) : null;
}

function requireRun(connection: DatabaseSync, ingestRunId: string): IngestRun {
  const run = readRun(connection, ingestRunId);
  if (!run) throw new Error("ingest run does not exist");
  return run;
}

function readSegment(connection: DatabaseSync, ingestSegmentId: string): IngestSegment | null {
  const row = connection
    .prepare(
      `SELECT ${INGEST_SEGMENT_COLUMNS}
         FROM ingest_segments
        WHERE ingest_segment_id = ?`,
    )
    .get(ingestSegmentId) as IngestSegmentRow | undefined;
  return row ? mapSegment(row) : null;
}

function requireSegment(connection: DatabaseSync, ingestSegmentId: string): IngestSegment {
  const segment = readSegment(connection, ingestSegmentId);
  if (!segment) throw new Error("ingest segment does not exist");
  return segment;
}

function readRootSegment(connection: DatabaseSync, ingestRunId: string): IngestSegment | null {
  const row = connection
    .prepare(
      `SELECT ${INGEST_SEGMENT_COLUMNS}
         FROM ingest_segments
        WHERE ingest_run_id = ? AND parent_segment_id IS NULL`,
    )
    .get(ingestRunId) as IngestSegmentRow | undefined;
  return row ? mapSegment(row) : null;
}

function requireRootSegment(connection: DatabaseSync, ingestRunId: string): IngestSegment {
  const segment = readRootSegment(connection, ingestRunId);
  if (!segment) throw new Error("ingest run has no root segment");
  return segment;
}

function readNextPendingSegment(connection: DatabaseSync, ingestRunId: string): IngestSegment | null {
  const row = connection
    .prepare(
      `SELECT ${INGEST_SEGMENT_COLUMNS}
         FROM ingest_segments
        WHERE ingest_run_id = ? AND state = 'PENDING'
        ORDER BY window_start, window_end, depth, ingest_segment_id
        LIMIT 1`,
    )
    .get(ingestRunId) as IngestSegmentRow | undefined;
  return row ? mapSegment(row) : null;
}

function mapSegment(row: IngestSegmentRow): IngestSegment {
  return {
    ingestSegmentId: row.ingest_segment_id,
    ingestRunId: row.ingest_run_id,
    parentSegmentId: row.parent_segment_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    depth: toSafeInteger(row.depth, "ingest segment depth"),
    state: row.state,
    splitAt: row.split_at,
    acceptedRawPageId: row.accepted_raw_page_id,
    createdAt: toSafeInteger(row.created_at, "ingest segment created-at"),
    completedAt: toNullableInteger(row.completed_at, "ingest segment completed-at"),
  };
}

function readRunningRun(connection: DatabaseSync, providerAccountKey: string): IngestRun | null {
  const row = connection
    .prepare(
      `SELECT ${INGEST_RUN_COLUMNS}
         FROM ingest_runs
        WHERE provider_account_key = ? AND status = 'RUNNING'`,
    )
    .get(providerAccountKey) as IngestRunRow | undefined;
  return row ? mapRun(row) : null;
}

function mapRun(row: IngestRunRow): IngestRun {
  return {
    ingestRunId: row.ingest_run_id,
    providerAccountKey: row.provider_account_key,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    pageSize: toSafeInteger(row.page_size, "ingest page size"),
    status: row.status,
    startedAt: toSafeInteger(row.started_at, "ingest started-at"),
    completedAt: toNullableInteger(row.completed_at, "ingest completed-at"),
    pagesReceived: toSafeInteger(row.pages_received, "ingest page count"),
    detailsReceived: toSafeInteger(row.details_received, "ingest detail count"),
    failureCode: row.failure_code,
  };
}

function readCursor(connection: DatabaseSync, providerAccountKey: string): LedgerCursor | null {
  const row = connection
    .prepare(
      `SELECT provider_account_key, window_start, window_end, next_page_no,
              page_size, expected_total_size, overlap_milliseconds, complete, last_event_occurred_at,
              last_completed_at, updated_at, version
         FROM ledger_cursors
        WHERE provider_account_key = ?`,
    )
    .get(providerAccountKey) as CursorRow | undefined;
  return row ? mapCursor(row) : null;
}

function requireCursor(connection: DatabaseSync, providerAccountKey: string): LedgerCursor {
  const cursor = readCursor(connection, providerAccountKey);
  if (!cursor) throw new Error("ledger cursor does not exist");
  return cursor;
}

function mapCursor(row: CursorRow): LedgerCursor {
  return {
    providerAccountKey: row.provider_account_key,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    nextPageNo: toNullableInteger(row.next_page_no, "ledger next page"),
    pageSize: toSafeInteger(row.page_size, "ledger page size"),
    expectedTotalSize: toNullableInteger(row.expected_total_size, "ledger expected total size"),
    overlapMilliseconds: toSafeInteger(row.overlap_milliseconds, "ledger overlap"),
    complete: Number(row.complete) === 1,
    lastEventOccurredAt: toNullableInteger(row.last_event_occurred_at, "ledger last event"),
    lastCompletedAt: toNullableInteger(row.last_completed_at, "ledger completion"),
    updatedAt: toSafeInteger(row.updated_at, "ledger cursor updated-at"),
    version: toSafeInteger(row.version, "ledger cursor version"),
  };
}

function readRawPageByFingerprints(
  connection: DatabaseSync,
  providerAccountKey: string,
  requestHash: string,
  responseHash: string,
): RawPageRecord | null {
  const row = connection
    .prepare(
      `SELECT ${RAW_PAGE_COLUMNS}
         FROM provider_raw_pages
        WHERE provider_account_key = ?
          AND request_fingerprint = ?
          AND response_fingerprint = ?`,
    )
    .get(providerAccountKey, requestHash, responseHash) as RawPageRow | undefined;
  return row ? mapRawPage(row) : null;
}

function readFirstRawPageForRequest(
  connection: DatabaseSync,
  providerAccountKey: string,
  requestHash: string,
): RawPageRecord | null {
  const row = connection
    .prepare(
      `SELECT ${RAW_PAGE_COLUMNS}
         FROM provider_raw_pages
        WHERE provider_account_key = ? AND request_fingerprint = ?
        ORDER BY received_at, raw_page_id
        LIMIT 1`,
    )
    .get(providerAccountKey, requestHash) as RawPageRow | undefined;
  return row ? mapRawPage(row) : null;
}

function requireRawPage(connection: DatabaseSync, rawPageId: string): RawPageRecord {
  const row = connection
    .prepare(`SELECT ${RAW_PAGE_COLUMNS} FROM provider_raw_pages WHERE raw_page_id = ?`)
    .get(rawPageId) as RawPageRow | undefined;
  if (!row) throw new Error("provider raw page cannot be read");
  return mapRawPage(row);
}

function mapRawPage(row: RawPageRow): RawPageRecord {
  return {
    rawPageId: row.raw_page_id,
    ingestRunId: row.ingest_run_id,
    providerAccountKey: row.provider_account_key,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    pageNo: toSafeInteger(row.page_no, "raw page number"),
    pageSize: toSafeInteger(row.page_size, "raw page size"),
    totalSize: toSafeInteger(row.total_size, "raw page total size"),
    hasMore: Number(row.has_more) === 1,
    requestFingerprint: row.request_fingerprint,
    responseFingerprint: row.response_fingerprint,
    httpStatus: toSafeInteger(row.http_status, "raw page HTTP status"),
    signatureVerified: Number(row.signature_verified) === 1,
    traceId: row.trace_id,
    receivedAt: toSafeInteger(row.received_at, "raw page received-at"),
  };
}

function insertRawEvent(
  connection: DatabaseSync,
  providerAccountKey: string,
  rawPageId: string,
  ordinal: number,
  detail: AccountLogDetail,
  now: number,
): RawEventRecord & PreparedRawEvent {
  const prepared = prepareRawEvent(detail);
  const inserted = connection
    .prepare(
      `INSERT INTO provider_raw_events(
         raw_event_id, raw_page_id, provider_account_key, ordinal,
         external_event_id, occurred_at_text, amount_text, direction_text,
         alipay_order_no, merchant_order_no, trans_memo, other_account, payload_fingerprint,
         raw_payload, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      prepared.rawEventId,
      rawPageId,
      providerAccountKey,
      ordinal,
      prepared.externalEventId,
      prepared.occurredAtText,
      prepared.amountText,
      prepared.directionText,
      prepared.alipayOrderNo,
      prepared.merchantOrderNo,
      prepared.transMemo,
      prepared.otherAccount,
      prepared.payloadFingerprint,
      prepared.rawPayload,
      now,
    );
  assertChangedOnce(inserted.changes, "provider raw event insert");
  return {
    ...prepared,
    rawPageId,
    providerAccountKey,
    ordinal,
    observedAt: now,
  };
}

function prepareRawEvent(detail: AccountLogDetail): PreparedRawEvent {
  let shapeInvalid = false;
  const externalEventId = boundedString(detail.accountLogId, 256);
  const occurredAtText = boundedString(detail.occurredAt, 128);
  const amountText = boundedString(detail.amount, 128);
  const directionText = boundedString(detail.direction, 64);
  const alipayOrderNo = boundedString(detail.alipayOrderNo, 128);
  const merchantOrderValue = detail.merchantOrderNo;
  const merchantOrderNo = boundedString(merchantOrderValue, 128);
  const transMemo = boundedString(detail.transMemo, 1024);
  const otherAccount = boundedString(detail.otherAccount, 256);
  if (
    invalidBoundedValue(detail.accountLogId, externalEventId) ||
    invalidBoundedValue(detail.occurredAt, occurredAtText) ||
    invalidBoundedValue(detail.amount, amountText) ||
    invalidBoundedValue(detail.direction, directionText) ||
    invalidBoundedValue(detail.alipayOrderNo, alipayOrderNo) ||
    invalidBoundedValue(merchantOrderValue, merchantOrderNo) ||
    invalidBoundedValue(detail.transMemo, transMemo) ||
    invalidBoundedValue(detail.otherAccount, otherAccount)
  ) {
    shapeInvalid = true;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(detail.raw);
    if (typeof serialized !== "string") throw new TypeError("provider detail is not JSON data");
  } catch {
    serialized = JSON.stringify({ _perpay_invalid_shape: true });
    shapeInvalid = true;
  }
  let rawPayload = toBytes(serialized);
  if (rawPayload.byteLength > LEDGER_MAX_RAW_EVENT_BYTES) {
    rawPayload = toBytes(
      JSON.stringify({
        _perpay_invalid_shape: true,
        original_payload_sha256: payloadFingerprint(rawPayload),
        original_payload_bytes: rawPayload.byteLength,
      }),
    );
    shapeInvalid = true;
  }

  return {
    rawEventId: randomUUID(),
    rawPayload,
    payloadFingerprint: payloadFingerprint(rawPayload),
    externalEventId,
    occurredAtText,
    amountText,
    directionText,
    alipayOrderNo,
    merchantOrderNo,
    transMemo,
    otherAccount,
    shapeInvalid,
  };
}

function normalizeAndInsert(
  connection: DatabaseSync,
  rawEvent: RawEventRecord & PreparedRawEvent,
  now: number,
): PageNormalizationResult {
  if (rawEvent.shapeInvalid) {
    const conflict = insertNormalizationConflict(
      connection,
      rawEvent,
      "INVALID_SHAPE",
      null,
      "provider event fields are outside the persistence contract",
      now,
    );
    return { kind: "isolated", conflict, rawEventId: rawEvent.rawEventId };
  }
  if (rawEvent.externalEventId === null) {
    const conflict = insertNormalizationConflict(
      connection,
      rawEvent,
      "MISSING_EXTERNAL_ID",
      null,
      "provider event has no account-scoped external ID",
      now,
    );
    return { kind: "isolated", conflict, rawEventId: rawEvent.rawEventId };
  }

  let occurredAt: number;
  let amountCents: number;
  let direction: LedgerEntry["direction"];
  try {
    occurredAt = parseOccurredAt(rawEvent.occurredAtText);
    amountCents = parseAmountCents(rawEvent.amountText);
    direction = parseDirection(rawEvent.directionText);
  } catch (error) {
    const type = error instanceof LedgerNormalizationError ? error.code : "INVALID_SHAPE";
    const message = error instanceof Error ? error.message : "provider event normalization failed";
    const conflict = insertNormalizationConflict(
      connection,
      rawEvent,
      type,
      rawEvent.externalEventId,
      message,
      now,
    );
    return { kind: "isolated", conflict, rawEventId: rawEvent.rawEventId };
  }

  const merchantOrderNo = rawEvent.merchantOrderNo;
  const semantics = semanticFingerprint({
    externalEventId: rawEvent.externalEventId,
    occurredAt,
    amountCents,
    direction,
    alipayOrderNo: rawEvent.alipayOrderNo,
    merchantOrderNo,
    transMemo: rawEvent.transMemo,
    otherAccount: rawEvent.otherAccount,
  });
  const existing = readLedgerEntryByExternalId(
    connection,
    rawEvent.providerAccountKey,
    rawEvent.externalEventId,
  );
  if (existing) {
    if (existing.semanticFingerprint === semantics) {
      return { kind: "duplicate", entry: existing, rawEventId: rawEvent.rawEventId };
    }
    if (existing.state !== "CONFLICT") {
      const isolated = connection
        .prepare(
          `UPDATE ledger_entries
              SET state = 'CONFLICT', updated_at = ?
            WHERE ledger_entry_id = ? AND state != 'CONFLICT'`,
        )
        .run(Math.max(now, existing.updatedAt), existing.ledgerEntryId);
      assertChangedOnce(isolated.changes, "ledger entry conflict isolation");
    }
    const conflict = insertConflict(connection, {
      providerAccountKey: rawEvent.providerAccountKey,
      conflictType: "DUPLICATE_EXTERNAL_ID",
      rawPageId: rawEvent.rawPageId,
      rawEventId: rawEvent.rawEventId,
      existingLedgerEntryId: existing.ledgerEntryId,
      externalEventId: rawEvent.externalEventId,
      existingSemanticFingerprint: existing.semanticFingerprint,
      incomingSemanticFingerprint: semantics,
      details: { reason: "same external ID has a different normalized semantic fingerprint" },
      fingerprintParts: [
        "DUPLICATE_EXTERNAL_ID",
        rawEvent.externalEventId,
        existing.semanticFingerprint,
        semantics,
      ],
      now,
    });
    return { kind: "conflict", conflict, rawEventId: rawEvent.rawEventId };
  }

  const ledgerEntryId = randomUUID();
  const inserted = connection
    .prepare(
      `INSERT INTO ledger_entries(
         ledger_entry_id, provider_account_key, raw_event_id, external_event_id,
         semantic_fingerprint, occurred_at, amount_cents, direction, currency,
         alipay_order_no, merchant_order_no, trans_memo, other_account, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, 'UNALLOCATED', ?, ?)`,
    )
    .run(
      ledgerEntryId,
      rawEvent.providerAccountKey,
      rawEvent.rawEventId,
      rawEvent.externalEventId,
      semantics,
      occurredAt,
      amountCents,
      direction,
      rawEvent.alipayOrderNo,
      merchantOrderNo,
      rawEvent.transMemo,
      rawEvent.otherAccount,
      now,
      now,
    );
  assertChangedOnce(inserted.changes, "ledger entry insert");
  const entry = requireLedgerEntry(connection, ledgerEntryId);
  return { kind: "created", entry, rawEventId: rawEvent.rawEventId };
}

function insertNormalizationConflict(
  connection: DatabaseSync,
  rawEvent: RawEventRecord,
  type: Exclude<LedgerConflictType, "RAW_PAGE_VARIANT" | "DUPLICATE_EXTERNAL_ID">,
  externalEventId: string | null,
  reason: string,
  now: number,
): LedgerConflict {
  return insertConflict(connection, {
    providerAccountKey: rawEvent.providerAccountKey,
    conflictType: type,
    rawPageId: rawEvent.rawPageId,
    rawEventId: rawEvent.rawEventId,
    existingLedgerEntryId: null,
    externalEventId,
    existingSemanticFingerprint: null,
    incomingSemanticFingerprint: null,
    details: { reason },
    fingerprintParts: [type, rawEvent.payloadFingerprint, rawEvent.rawPageId, rawEvent.ordinal],
    now,
  });
}

interface InsertConflictInput {
  readonly providerAccountKey: string;
  readonly conflictType: LedgerConflictType;
  readonly rawPageId: string | null;
  readonly rawEventId: string | null;
  readonly existingLedgerEntryId: string | null;
  readonly externalEventId: string | null;
  readonly existingSemanticFingerprint: string | null;
  readonly incomingSemanticFingerprint: string | null;
  readonly details: Record<string, unknown>;
  readonly fingerprintParts: readonly unknown[];
  readonly now: number;
}

function insertConflict(connection: DatabaseSync, input: InsertConflictInput): LedgerConflict {
  const fingerprint = conflictFingerprint(input.fingerprintParts);
  const existing = connection
    .prepare(
      `SELECT ${CONFLICT_COLUMNS}
         FROM ledger_conflicts
        WHERE provider_account_key = ? AND conflict_fingerprint = ?`,
    )
    .get(input.providerAccountKey, fingerprint) as ConflictRow | undefined;
  if (existing) return mapConflict(existing);

  const conflictId = randomUUID();
  const inserted = connection
    .prepare(
      `INSERT INTO ledger_conflicts(
         conflict_id, provider_account_key, conflict_type, raw_page_id,
         raw_event_id, existing_ledger_entry_id, external_event_id,
         existing_semantic_fingerprint, incoming_semantic_fingerprint,
         details_json, status, resolution_json, created_at, resolved_at,
         conflict_fingerprint
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, NULL, ?)`,
    )
    .run(
      conflictId,
      input.providerAccountKey,
      input.conflictType,
      input.rawPageId,
      input.rawEventId,
      input.existingLedgerEntryId,
      input.externalEventId,
      input.existingSemanticFingerprint,
      input.incomingSemanticFingerprint,
      serializeDetails(input.details),
      input.now,
      fingerprint,
    );
  assertChangedOnce(inserted.changes, "ledger conflict insert");
  return requireConflict(connection, conflictId);
}

function readLedgerEntryByExternalId(
  connection: DatabaseSync,
  providerAccountKey: string,
  externalEventId: string,
): LedgerEntry | null {
  const row = connection
    .prepare(
      `SELECT ${LEDGER_ENTRY_COLUMNS}
         FROM ledger_entries
        WHERE provider_account_key = ? AND external_event_id = ?`,
    )
    .get(providerAccountKey, externalEventId) as LedgerEntryRow | undefined;
  return row ? mapLedgerEntry(row) : null;
}

function requireLedgerEntry(connection: DatabaseSync, ledgerEntryId: string): LedgerEntry {
  const row = connection
    .prepare(`SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger_entries WHERE ledger_entry_id = ?`)
    .get(ledgerEntryId) as LedgerEntryRow | undefined;
  if (!row) throw new Error("normalized ledger entry cannot be read");
  return mapLedgerEntry(row);
}

function mapLedgerEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    ledgerEntryId: row.ledger_entry_id,
    providerAccountKey: row.provider_account_key,
    rawEventId: row.raw_event_id,
    externalEventId: row.external_event_id,
    semanticFingerprint: row.semantic_fingerprint,
    occurredAt: toSafeInteger(row.occurred_at, "ledger occurred-at"),
    amountCents: toSafeInteger(row.amount_cents, "ledger amount"),
    direction: row.direction,
    currency: row.currency,
    alipayOrderNo: row.alipay_order_no,
    merchantOrderNo: row.merchant_order_no,
    transMemo: row.trans_memo,
    otherAccount: row.other_account,
    state: row.state,
    createdAt: toSafeInteger(row.created_at, "ledger created-at"),
    updatedAt: toSafeInteger(row.updated_at, "ledger updated-at"),
  };
}

function requireConflict(connection: DatabaseSync, conflictId: string): LedgerConflict {
  const row = connection
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM ledger_conflicts WHERE conflict_id = ?`)
    .get(conflictId) as ConflictRow | undefined;
  if (!row) throw new Error("ledger conflict cannot be read");
  return mapConflict(row);
}

function mapConflict(row: ConflictRow): LedgerConflict {
  const parsed = JSON.parse(row.details_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ledger conflict details are invalid");
  }
  return {
    conflictId: row.conflict_id,
    providerAccountKey: row.provider_account_key,
    conflictType: row.conflict_type,
    rawPageId: row.raw_page_id,
    rawEventId: row.raw_event_id,
    existingLedgerEntryId: row.existing_ledger_entry_id,
    externalEventId: row.external_event_id,
    existingSemanticFingerprint: row.existing_semantic_fingerprint,
    incomingSemanticFingerprint: row.incoming_semantic_fingerprint,
    details: parsed as Record<string, unknown>,
    status: row.status,
    createdAt: toSafeInteger(row.created_at, "ledger conflict created-at"),
    resolvedAt: toNullableInteger(row.resolved_at, "ledger conflict resolved-at"),
    conflictFingerprint: row.conflict_fingerprint,
  };
}

function prepareSegmentPage(input: RecordSegmentPageInput): PreparedSegmentPage {
  const now = safeNow(input.now);
  const evidence = input.evidence ?? pageEvidence(input.page);
  const rawBody = toBytes(evidence.body);
  if (rawBody.byteLength > LEDGER_MAX_RAW_PAGE_BYTES) {
    throw new RangeError("provider raw page exceeds the persistence limit");
  }
  validatePageSize(input.page.pageSize);
  if (input.page.pageNo !== 1) {
    throw new RangeError("segment ingestion only accepts provider page one");
  }
  if (!Number.isSafeInteger(input.page.totalSize) || input.page.totalSize < 0) {
    throw new RangeError("provider total size is invalid");
  }
  if (input.page.details.length > input.page.pageSize) {
    throw new RangeError("provider page contains too many details");
  }
  if (input.page.hasMore) {
    if (
      input.page.totalSize <= input.page.pageSize ||
      input.page.details.length !== input.page.pageSize
    ) {
      throw new RangeError("oversized provider probe metadata is inconsistent");
    }
  } else if (input.page.totalSize !== input.page.details.length) {
    throw new RangeError("accepted provider leaf must contain its complete result set");
  }
  if (!Number.isSafeInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599) {
    throw new RangeError("provider HTTP status is invalid");
  }
  if (!evidence.signatureVerified) {
    throw new Error("unverified provider responses cannot enter ledger ingestion");
  }
  if (evidence.traceId !== null && (evidence.traceId.length < 1 || evidence.traceId.length > 256)) {
    throw new RangeError("provider trace ID is invalid");
  }
  return {
    now,
    evidence,
    rawBody,
    headersJson: serializeHeaders(evidence.headers),
    responseHash: responseFingerprint(rawBody),
  };
}

function validateDetailsWithinSegment(
  details: readonly AccountLogDetail[],
  segment: IngestSegment,
): void {
  const segmentStart = parseOccurredAt(segment.windowStart);
  const segmentEnd = parseOccurredAt(segment.windowEnd);
  for (const detail of details) {
    if (detail.occurredAt === null) continue;
    let occurredAt: number;
    try {
      occurredAt = parseOccurredAt(detail.occurredAt);
    } catch {
      // Malformed provider facts are retained and isolated during normalization.
      continue;
    }
    if (occurredAt < segmentStart || occurredAt > segmentEnd) {
      throw new RangeError("provider event is outside the ingest segment");
    }
  }
}

function clampIngestWriteTime(
  connection: DatabaseSync,
  run: IngestRun,
  cursor: LedgerCursor,
  requestedNow: number,
): number {
  const row = connection.prepare(
    `SELECT MAX(created_at) AS latest_created_at,
            MAX(completed_at) AS latest_completed_at
       FROM ingest_segments
      WHERE ingest_run_id = ?`,
  ).get(run.ingestRunId) as {
    latest_created_at: bigint | number | null;
    latest_completed_at: bigint | number | null;
  };
  return Math.max(
    requestedNow,
    run.startedAt,
    cursor.updatedAt,
    toNullableInteger(row.latest_created_at, "latest ingest segment creation") ?? 0,
    toNullableInteger(row.latest_completed_at, "latest ingest segment completion") ?? 0,
  );
}

function retainSegmentPage(
  connection: DatabaseSync,
  run: IngestRun,
  segment: IngestSegment,
  page: RecordSegmentPageInput["page"],
  prepared: PreparedSegmentPage,
  observationKind: SegmentObservationKind,
): RetainedSegmentPage {
  const requestHash = requestFingerprint(
    run.providerAccountKey,
    segment.windowStart,
    segment.windowEnd,
    1,
    page.pageSize,
  );
  const existingExact = readRawPageByFingerprints(
    connection,
    run.providerAccountKey,
    requestHash,
    prepared.responseHash,
  );
  if (existingExact) {
    if (
      existingExact.windowStart !== segment.windowStart ||
      existingExact.windowEnd !== segment.windowEnd ||
      existingExact.pageNo !== 1 ||
      existingExact.pageSize !== page.pageSize ||
      existingExact.totalSize !== page.totalSize ||
      existingExact.hasMore !== page.hasMore ||
      existingExact.httpStatus !== prepared.evidence.httpStatus ||
      existingExact.signatureVerified !== prepared.evidence.signatureVerified
    ) {
      throw new Error("duplicate provider segment metadata does not match stored evidence");
    }
    const storedDetails = rawEventCountForPage(connection, existingExact.rawPageId);
    if (
      (observationKind === "OVERSIZED_PROBE" && storedDetails !== 0) ||
      (observationKind === "ACCEPTED_LEAF" && storedDetails !== page.details.length)
    ) {
      throw new Error("duplicate provider segment raw event count is inconsistent");
    }
    return {
      observation: "duplicate",
      newlyObserved: insertPageObservation(
        connection,
        run.ingestRunId,
        segment.ingestSegmentId,
        existingExact.rawPageId,
        observationKind,
        prepared,
      ),
      page: existingExact,
    };
  }

  const previousVariant = readFirstRawPageForRequest(connection, run.providerAccountKey, requestHash);
  const rawPageId = randomUUID();
  const inserted = connection
    .prepare(
      `INSERT INTO provider_raw_pages(
         raw_page_id, ingest_run_id, provider_account_key, window_start,
         window_end, page_no, page_size, total_size, has_more,
         request_fingerprint, response_fingerprint, http_status,
         headers_json, raw_body, trace_id, signature_verified, received_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rawPageId,
      run.ingestRunId,
      run.providerAccountKey,
      segment.windowStart,
      segment.windowEnd,
      page.pageSize,
      page.totalSize,
      page.hasMore ? 1 : 0,
      requestHash,
      prepared.responseHash,
      prepared.evidence.httpStatus,
      prepared.headersJson,
      prepared.rawBody,
      prepared.evidence.traceId,
      1,
      prepared.now,
    );
  assertChangedOnce(inserted.changes, "provider raw segment page insert");
  if (!insertPageObservation(
    connection,
    run.ingestRunId,
    segment.ingestSegmentId,
    rawPageId,
    observationKind,
    prepared,
  )) {
    throw new Error("new provider segment page was already observed");
  }
  if (previousVariant) {
    insertConflict(connection, {
      providerAccountKey: run.providerAccountKey,
      conflictType: "RAW_PAGE_VARIANT",
      rawPageId,
      rawEventId: null,
      existingLedgerEntryId: null,
      externalEventId: null,
      existingSemanticFingerprint: previousVariant.responseFingerprint,
      incomingSemanticFingerprint: prepared.responseHash,
      details: {
        request_fingerprint: requestHash,
        ingest_segment_id: segment.ingestSegmentId,
        existing_raw_page_id: previousVariant.rawPageId,
        incoming_raw_page_id: rawPageId,
      },
      fingerprintParts: [
        "RAW_PAGE_VARIANT",
        requestHash,
        previousVariant.responseFingerprint,
        prepared.responseHash,
      ],
      now: prepared.now,
    });
  }
  return {
    observation: previousVariant ? "variant" : "inserted",
    newlyObserved: true,
    page: requireRawPage(connection, rawPageId),
  };
}

function insertPageObservation(
  connection: DatabaseSync,
  ingestRunId: string,
  ingestSegmentId: string,
  rawPageId: string,
  observationKind: SegmentObservationKind,
  prepared: PreparedSegmentPage,
): boolean {
  const inserted = connection
    .prepare(
      `INSERT INTO ingest_run_page_observations(
         ingest_run_id, ingest_segment_id, raw_page_id, observation_kind,
         http_status, headers_json, trace_id, signature_verified, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ingest_segment_id, raw_page_id) DO NOTHING`,
    )
    .run(
      ingestRunId,
      ingestSegmentId,
      rawPageId,
      observationKind,
      prepared.evidence.httpStatus,
      prepared.headersJson,
      prepared.evidence.traceId,
      prepared.evidence.signatureVerified ? 1 : 0,
      prepared.now,
    );
  const changes = Number(inserted.changes);
  if (changes !== 0 && changes !== 1) {
    throw new Error("ingest page observation changed an unexpected number of rows");
  }
  return changes === 1;
}

function insertChildSegment(
  connection: DatabaseSync,
  parent: IngestSegment,
  windowStart: string,
  windowEnd: string,
  now: number,
): IngestSegment {
  const ingestSegmentId = randomUUID();
  const inserted = connection
    .prepare(
      `INSERT INTO ingest_segments(
         ingest_segment_id, ingest_run_id, parent_segment_id,
         window_start, window_end, depth, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    )
    .run(
      ingestSegmentId,
      parent.ingestRunId,
      parent.ingestSegmentId,
      windowStart,
      windowEnd,
      parent.depth + 1,
      now,
    );
  assertChangedOnce(inserted.changes, "ingest child segment insert");
  return requireSegment(connection, ingestSegmentId);
}

function hasPendingSegments(connection: DatabaseSync, ingestRunId: string): boolean {
  const row = connection
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM ingest_segments
          WHERE ingest_run_id = ? AND state = 'PENDING'
       ) AS pending`,
    )
    .get(ingestRunId) as { pending: bigint | number };
  return Number(row.pending) === 1;
}

function failDensityExceeded(
  connection: DatabaseSync,
  run: IngestRun,
  segment: IngestSegment,
  page: RawPageRecord,
  now: number,
): void {
  const errorInserted = connection
    .prepare(
      `INSERT INTO ingest_errors(
         ingest_error_id, ingest_run_id, provider_account_key, page_no,
         error_kind, error_code, retryable, details_json, occurred_at
       ) VALUES (?, ?, ?, 1, 'pagination', 'pagination_density_exceeded', 0, ?, ?)`,
    )
    .run(
      randomUUID(),
      run.ingestRunId,
      run.providerAccountKey,
      serializeDetails({
        ingest_segment_id: segment.ingestSegmentId,
        raw_page_id: page.rawPageId,
        window_start: segment.windowStart,
        window_end: segment.windowEnd,
        total_size: page.totalSize,
        page_size: page.pageSize,
      }),
      now,
    );
  assertChangedOnce(errorInserted.changes, "pagination density error insert");
  const failed = connection
    .prepare(
      `UPDATE ingest_runs
          SET status = 'FAILED', completed_at = ?, failure_code = 'pagination_density_exceeded'
        WHERE ingest_run_id = ? AND status = 'RUNNING'`,
    )
    .run(now, run.ingestRunId);
  assertChangedOnce(failed.changes, "pagination density run failure");
}

function updateRunProgress(
  connection: DatabaseSync,
  ingestRunId: string,
  detailCount: number,
): void {
  const runUpdate = connection
    .prepare(
      `UPDATE ingest_runs
          SET pages_received = pages_received + 1,
              details_received = details_received + ?
        WHERE ingest_run_id = ? AND status = 'RUNNING'`,
    )
    .run(detailCount, ingestRunId);
  assertChangedOnce(runUpdate.changes, "ingest run progress update");
}

function latestOccurredAtForRun(connection: DatabaseSync, ingestRunId: string): number | null {
  const row = connection
    .prepare(
      `SELECT MAX(entry.occurred_at) AS occurred_at
         FROM ingest_run_page_observations AS observation
         JOIN provider_raw_events AS raw ON raw.raw_page_id = observation.raw_page_id
         JOIN ledger_entries AS entry ON entry.raw_event_id = raw.raw_event_id
        WHERE observation.ingest_run_id = ?
          AND observation.observation_kind = 'ACCEPTED_LEAF'`,
    )
    .get(ingestRunId) as { occurred_at: bigint | number | null };
  return toNullableInteger(row.occurred_at, "ledger run latest event");
}

function rawEventCountForPage(connection: DatabaseSync, rawPageId: string): number {
  const row = connection
    .prepare("SELECT COUNT(*) AS count FROM provider_raw_events WHERE raw_page_id = ?")
    .get(rawPageId) as { count: bigint | number };
  return toSafeInteger(row.count, "provider raw event count");
}

function completeSegmentRun(
  connection: DatabaseSync,
  run: IngestRun,
  cursor: LedgerCursor,
  now: number,
): void {
  if (cursor.complete || cursor.nextPageNo !== 1) {
    throw new Error("ledger cursor cannot complete this segment run");
  }
  const latestOccurredAt = latestOccurredAtForRun(connection, run.ingestRunId);
  const lastEvent =
    latestOccurredAt === null
      ? cursor.lastEventOccurredAt
      : Math.max(cursor.lastEventOccurredAt ?? 0, latestOccurredAt);
  const updated = connection
    .prepare(
      `UPDATE ledger_cursors
          SET next_page_no = NULL, expected_total_size = NULL, complete = 1,
              last_event_occurred_at = ?, last_completed_at = ?, updated_at = ?,
              version = version + 1
        WHERE provider_account_key = ? AND version = ? AND complete = 0`,
    )
    .run(
      lastEvent,
      now,
      now,
      cursor.providerAccountKey,
      cursor.version,
    );
  assertChangedOnce(updated.changes, "ledger cursor root completion");
  const completed = connection
    .prepare(
      `UPDATE ingest_runs
          SET status = 'COMPLETED', completed_at = ?
        WHERE ingest_run_id = ? AND status = 'RUNNING'`,
    )
    .run(now, run.ingestRunId);
  assertChangedOnce(completed.changes, "ingest segment run completion");
}

function pageEvidence(page: RecordLedgerPageInput["page"]): RawPageEvidence {
  if (!("rawResponse" in page)) {
    throw new Error("raw provider response evidence is required");
  }
  return {
    httpStatus: page.rawResponse.status,
    headers: page.rawResponse.headers,
    body: page.rawResponse.body,
    traceId: page.rawResponse.traceId,
    signatureVerified: page.rawResponse.signatureVerified,
  };
}

function prepareErrorEvidence(evidence: RawErrorEvidence | undefined): PreparedErrorEvidence | null {
  if (evidence === undefined) return null;
  if (!Number.isSafeInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599) {
    throw new RangeError("provider error HTTP status is invalid");
  }
  const rawBody = toBytes(evidence.body);
  if (rawBody.byteLength > LEDGER_MAX_RAW_PAGE_BYTES) {
    throw new RangeError("provider error response exceeds the persistence limit");
  }
  if (evidence.traceId !== null && (evidence.traceId.length < 1 || evidence.traceId.length > 256)) {
    throw new RangeError("provider error trace ID is invalid");
  }
  return {
    httpStatus: evidence.httpStatus,
    headersJson: serializeHeaders(evidence.headers),
    rawBody,
    responseFingerprint: responseFingerprint(rawBody),
    traceId: evidence.traceId,
    signatureVerified: evidence.signatureVerified,
  };
}

function serializeHeaders(headers: Readonly<Record<string, string | readonly string[]>>): string {
  const normalized: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers).sort(([left], [right]) =>
    left.toLowerCase().localeCompare(right.toLowerCase()),
  )) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) throw new RangeError("provider response header name is invalid");
    if (Object.hasOwn(normalized, key)) throw new RangeError("provider response headers are ambiguous");
    if (typeof value === "string") {
      if (value.includes("\0")) throw new RangeError("provider response header value is invalid");
      normalized[key] = value;
    } else {
      if (value.some((item) => typeof item !== "string" || item.includes("\0"))) {
        throw new RangeError("provider response header value is invalid");
      }
      normalized[key] = [...value];
    }
  }
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > 16_384) {
    throw new RangeError("provider response headers exceed the persistence limit");
  }
  return json;
}

function serializeDetails(details: Record<string, unknown>): string {
  const json = JSON.stringify(details);
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > 8192) {
    throw new RangeError("ledger details exceed the persistence limit");
  }
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RangeError("ledger details must be a JSON object");
  }
  return json;
}

function boundedString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maximum || trimmed.includes("\0")) return null;
  return trimmed;
}

function invalidBoundedValue(original: unknown, normalized: string | null): boolean {
  return original !== null && original !== undefined && normalized === null;
}

function validateErrorLabel(value: string, label: string, maximum: number): void {
  if (value.length < 1 || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

function safeNow(value: number | undefined): number {
  return safeTimestamp(value ?? Date.now(), "ledger clock");
}

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is invalid`);
  return value;
}

function toSafeInteger(value: bigint | number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the safe integer range`);
  return number;
}

function toNullableInteger(value: bigint | number | null, label: string): number | null {
  return value === null ? null : toSafeInteger(value, label);
}

function assertChangedOnce(changes: bigint | number, label: string): void {
  if (Number(changes) !== 1) throw new Error(`${label} did not change exactly one row`);
}
