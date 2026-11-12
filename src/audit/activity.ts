import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { createAuditContext, currentAuditContext, normalizeAuditAddress, normalizeAuditUserAgent, runWithAuditContext } from "./context.ts";

export const ACTIVITY_RETENTION_DAYS = 30;
export const ACTIVITY_RETENTION_MILLISECONDS = ACTIVITY_RETENTION_DAYS * 86_400_000;
export const ACTIVITY_MAX_EVENT_BYTES = 16 * 1_024;
export const ACTIVITY_HTTP_MAX_RECORDS = 20_000;
export const ACTIVITY_HTTP_WRITES_PER_MINUTE = 600;
const MAX_DETAILS_BYTES = 8 * 1_024;
const MAX_BUFFER_BYTES = 4 * 1_024 * 1_024;
const MAX_HTTP_BUFFER_BYTES = 1 * 1_024 * 1_024;
const PRUNE_BATCH_SIZE = 1_000;
const HOUR = 3_600_000;
const BUDGETED_HTTP_SQL = "action = 'http.request' AND source_type = 'HTTP' AND core_event_ids_json = '[]' AND (http_method IN ('GET', 'HEAD') OR actor_type = 'ANONYMOUS')";
const ACTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIVATE_FIELD = /(?:password|passwd|secret|token|authorization|cookie|private.?key|signature|raw.?body|request.?body|response.?body|payload|credential)/i;

export type ActivitySourceType = "HTTP" | "BACKGROUND" | "MAINTENANCE" | "INTERNAL";
export type ActivityActorType = "SYSTEM" | "ANONYMOUS" | "ADMIN" | "API_CLIENT";
export type ActivityOutcome = "SUCCESS" | "FAILURE";
type DatabaseOwner = Pick<AppDatabase, "read" | "write">;

export interface ActivityEventInput {
  readonly action: string;
  readonly outcome?: ActivityOutcome | undefined;
  readonly occurredAt?: number | undefined;
  readonly sourceType?: ActivitySourceType | undefined;
  readonly activityId?: string | undefined;
  readonly requestId?: string | null | undefined;
  readonly actorType?: ActivityActorType | undefined;
  readonly actorId?: string | null | undefined;
  readonly subjectType?: string | null | undefined;
  readonly subjectId?: string | null | undefined;
  readonly siteId?: string | null | undefined;
  readonly siteName?: string | null | undefined;
  readonly sourceAddress?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly httpMethod?: string | null | undefined;
  readonly route?: string | null | undefined;
  readonly httpStatus?: number | null | undefined;
  readonly durationMs?: number | undefined;
  readonly count?: number | undefined;
  readonly aggregate?: boolean | "hour" | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly coreEventIds?: readonly string[] | undefined;
  readonly externalEventId?: string | null | undefined;
}

/** Plain, bounded values shared with the file spool and SQLite writer. */
export interface ActivityEvent {
  readonly eventId: string;
  readonly activityId: string;
  readonly requestId: string | null;
  readonly occurredAt: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  readonly sourceType: ActivitySourceType;
  readonly actorType: ActivityActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly outcome: ActivityOutcome;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly sourceAddress: string | null;
  readonly userAgent: string | null;
  readonly httpMethod: string | null;
  readonly route: string | null;
  readonly httpStatus: number | null;
  durationMs: number;
  eventCount: number;
  readonly isAggregate: boolean;
  readonly detailsJson: string;
  readonly coreEventIdsJson: string;
  readonly externalEventId: string | null;
  readonly aggregationKey: string | null;
}

export interface ActivityCaptureStatus {
  readonly state: "healthy" | "degraded";
  readonly bufferedEvents: number;
  readonly droppedEvents: number;
  readonly lastDroppedAt: number | null;
  readonly writeFailures: number;
  readonly lastFlushAt: number | null;
  readonly lastErrorCode: string | null;
  readonly spoolLastImportAt: number | null;
  readonly spoolFailures: number;
  readonly spoolGapCount: number;
  readonly retentionDays: typeof ACTIVITY_RETENTION_DAYS;
}

export interface ActivityTaskResult {
  readonly outcome?: ActivityOutcome;
  readonly aggregate?: boolean | "hour";
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ActivityRecorderOptions {
  readonly database: DatabaseOwner;
  readonly clock?: (() => number) | undefined;
  readonly flushIntervalMilliseconds?: number | undefined;
  readonly maxBufferedEvents?: number | undefined;
}

/** A failed observer can never reject an HTTP response or alter a worker result. */
export class ActivityRecorder {
  readonly #database: DatabaseOwner;
  readonly #clock: () => number;
  readonly #flushInterval: number;
  readonly #maximumEvents: number;
  #buffer: ActivityEvent[] = [];
  #aggregates = new Map<string, ActivityEvent>();
  #bufferBytes = 0;
  #httpBufferBytes = 0;
  #httpBufferedEvents = 0;
  #httpBudgetMinute = -1;
  #httpWrites = 0;
  #httpPrunePending = true;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #flushing = false;
  #droppedEvents = 0;
  #lastDroppedAt: number | null = null;
  #writeFailures = 0;
  #lastFlushAt: number | null = null;
  #lastErrorCode: string | null = null;
  #spoolLastImportAt: number | null = null;
  #spoolFailures = 0;
  #spoolGapCount = 0;
  #lastPrunedAt: number | null = null;
  #prunePending = false;
  #lastWarningAt = -Infinity;

  constructor(options: ActivityRecorderOptions) {
    this.#database = options.database;
    this.#clock = options.clock ?? Date.now;
    this.#flushInterval = Math.max(1, Math.min(5_000, options.flushIntervalMilliseconds ?? 5_000));
    this.#maximumEvents = Math.max(1, Math.min(8_192, options.maxBufferedEvents ?? 2_048));
    try {
      const row = this.#database.read(db => db.prepare("SELECT value_json FROM activity_capture_state WHERE key = 'recorder'").get()) as { value_json: string } | undefined;
      if (row) {
        const previous = JSON.parse(row.value_json) as Partial<ActivityCaptureStatus>;
        this.#droppedEvents = nonnegative(previous.droppedEvents ?? 0);
        this.#lastDroppedAt = previous.lastDroppedAt ?? null;
        this.#writeFailures = nonnegative(previous.writeFailures ?? 0);
        this.#spoolFailures = nonnegative(previous.spoolFailures ?? 0);
        this.#spoolGapCount = nonnegative(previous.spoolGapCount ?? 0);
        this.#lastFlushAt = previous.lastFlushAt ?? null;
        this.#spoolLastImportAt = previous.spoolLastImportAt ?? null;
        this.#lastErrorCode = previous.lastErrorCode ?? null;
      }
      // Source cursors and detected gaps are committed before the recorder's
      // periodic flush. Recover that durable evidence after an interrupted flush.
      const gaps = this.#database.read(db => db.prepare("SELECT COALESCE(SUM(gap_count), 0) AS count FROM activity_import_sources").get());
      this.#spoolGapCount = Math.max(this.#spoolGapCount, nonnegative(Number(gaps?.count ?? 0)));
    } catch { this.#lastErrorCode = "activity_state_unavailable"; }
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.flush(), this.#flushInterval);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.flush();
    this.#stopped = true;
  }

  record(input: ActivityEventInput): void {
    try {
      if (this.#stopped) { this.#drop("activity_recorder_stopped", input.count ?? 1); return; }
      const event = createActivityEvent(input, this.#now());
      const existing = event.aggregationKey === null ? undefined : this.#aggregates.get(event.aggregationKey);
      if (existing) {
        existing.firstOccurredAt = Math.min(existing.firstOccurredAt, event.firstOccurredAt);
        existing.lastOccurredAt = Math.max(existing.lastOccurredAt, event.lastOccurredAt);
        existing.eventCount = Math.min(Number.MAX_SAFE_INTEGER, existing.eventCount + event.eventCount);
        existing.durationMs = Math.min(Number.MAX_SAFE_INTEGER, existing.durationMs + event.durationMs);
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      const budgetedHttp = isBudgetedHttpEvent(event);
      if (budgetedHttp) {
        const minute = Math.floor(this.#now() / 60_000);
        if (minute !== this.#httpBudgetMinute) { this.#httpBudgetMinute = minute; this.#httpWrites = 0; }
        if (this.#httpWrites >= ACTIVITY_HTTP_WRITES_PER_MINUTE ||
          this.#httpBufferedEvents >= Math.max(1, Math.min(512, Math.floor(this.#maximumEvents / 2))) || this.#httpBufferBytes + bytes > MAX_HTTP_BUFFER_BYTES) {
          this.#drop("activity_http_budget_exceeded", event.eventCount);
          return;
        }
      }
      if (bytes > ACTIVITY_MAX_EVENT_BYTES || this.#buffer.length >= this.#maximumEvents || this.#bufferBytes + bytes > MAX_BUFFER_BYTES) {
        this.#drop("activity_buffer_full", event.eventCount);
        return;
      }
      this.#buffer.push(event);
      this.#bufferBytes += bytes;
      if (budgetedHttp) { this.#httpWrites += 1; this.#httpBufferedEvents += 1; this.#httpBufferBytes += bytes; }
      if (event.aggregationKey !== null) this.#aggregates.set(event.aggregationKey, event);
    } catch { this.#drop("activity_event_invalid", input.count ?? 1); }
  }

  flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const now = this.#now();
      let httpPrunePending = this.#httpPrunePending;
      this.#database.write(db => {
        for (const event of this.#buffer) persistActivityEvent(db, event);
        if (this.#httpBufferedEvents > 0 || httpPrunePending) {
          const pruned = db.prepare(`DELETE FROM activity_events WHERE sequence IN (
            SELECT sequence FROM activity_events WHERE ${BUDGETED_HTTP_SQL}
            ORDER BY occurred_at DESC, sequence DESC LIMIT ? OFFSET ?)`)
            .run(PRUNE_BATCH_SIZE, ACTIVITY_HTTP_MAX_RECORDS);
          httpPrunePending = Number(pruned.changes) === PRUNE_BATCH_SIZE;
        }
        persistCaptureState(db, { ...this.status(), bufferedEvents: 0, lastFlushAt: now,
          lastErrorCode: this.#lastErrorCode === "activity_write_failed" || this.#lastErrorCode === "activity_state_unavailable" ? null : this.#lastErrorCode }, now);
      });
      this.#buffer = [];
      this.#aggregates.clear();
      this.#bufferBytes = 0;
      this.#httpBufferBytes = 0;
      this.#httpBufferedEvents = 0;
      this.#httpPrunePending = httpPrunePending;
      this.#lastFlushAt = now;
      if (this.#lastErrorCode === "activity_write_failed" || this.#lastErrorCode === "activity_state_unavailable") this.#lastErrorCode = null;
      if (this.#prunePending || this.#lastPrunedAt === null || now - this.#lastPrunedAt >= HOUR) this.prune();
    } catch {
      this.#writeFailures += 1;
      this.#lastErrorCode = "activity_write_failed";
      this.#warn();
    } finally { this.#flushing = false; }
  }

  prune(): void {
    try {
      const now = this.#now(), cutoff = Math.max(0, now - ACTIVITY_RETENTION_MILLISECONDS);
      const deleted = this.#database.write(db => {
        const result = db.prepare("DELETE FROM activity_events WHERE sequence IN (SELECT sequence FROM activity_events WHERE occurred_at < ? ORDER BY occurred_at LIMIT 500)").run(cutoff);
        const receipts = db.prepare("DELETE FROM activity_external_receipts WHERE event_id IN (SELECT event_id FROM activity_external_receipts WHERE core_event_id IS NULL AND occurred_at < ? ORDER BY occurred_at LIMIT 500)").run(cutoff);
        return Math.max(Number(result.changes), Number(receipts.changes));
      });
      this.#lastPrunedAt = now;
      this.#prunePending = deleted === 500;
      if (this.#lastErrorCode === "activity_retention_failed") this.#lastErrorCode = null;
    } catch {
      this.#writeFailures += 1;
      this.#lastErrorCode = "activity_retention_failed";
      this.#warn();
    }
  }

  status(): ActivityCaptureStatus {
    return Object.freeze({ state: this.#lastErrorCode !== null || this.#droppedEvents > 0 || this.#spoolGapCount > 0 ? "degraded" : "healthy",
      bufferedEvents: this.#buffer.reduce((count, event) => count + event.eventCount, 0), droppedEvents: this.#droppedEvents, lastDroppedAt: this.#lastDroppedAt,
      writeFailures: this.#writeFailures, lastFlushAt: this.#lastFlushAt, lastErrorCode: this.#lastErrorCode,
      spoolLastImportAt: this.#spoolLastImportAt, spoolFailures: this.#spoolFailures, spoolGapCount: this.#spoolGapCount,
      retentionDays: ACTIVITY_RETENTION_DAYS });
  }

  noteSpoolImport(at: number): void { this.#spoolLastImportAt = at; if (this.#lastErrorCode === "activity_spool_unavailable") this.#lastErrorCode = null; }
  noteSpoolAvailable(): void {
    if (["activity_spool_unavailable", "activity_spool_invalid", "activity_spool_metadata_missing"].includes(this.#lastErrorCode ?? "")) this.#lastErrorCode = null;
  }
  noteSpoolFailure(code = "activity_spool_unavailable"): void { this.#spoolFailures += 1; this.#lastErrorCode = code; this.#warn(); }
  noteSpoolGap(count = 1): void { this.#spoolGapCount += Math.max(1, count); this.#lastErrorCode = "activity_spool_gap"; this.#warn(); }

  /** Call only once a coalescing scheduler has decided to execute real work. */
  runTask<T>(action: string, metadata: Pick<ActivityEventInput, "subjectType" | "subjectId" | "siteId" | "siteName" | "details">,
    operation: () => T | Promise<T>, classify?: ((result: T) => ActivityTaskResult) | undefined): Promise<T> {
    const scope = createAuditContext({ actorType: "SYSTEM", actorId: action, siteId: metadata.siteId, siteName: metadata.siteName });
    const started = this.#now();
    return runWithAuditContext(scope, async () => {
      try {
        const result = await operation();
        let summary: ActivityTaskResult = {};
        try { summary = classify?.(result) ?? {}; } catch { this.#drop("activity_task_summary_failed", 1); }
        this.record({ ...metadata, action, sourceType: "BACKGROUND", outcome: summary.outcome ?? "SUCCESS",
          durationMs: Math.max(0, this.#now() - started), aggregate: summary.aggregate,
          details: { ...metadata.details, ...summary.details }, coreEventIds: scope.coreEventIds });
        return result;
      } catch (error) {
        this.record({ ...metadata, action, sourceType: "BACKGROUND", outcome: "FAILURE", durationMs: Math.max(0, this.#now() - started),
          details: { ...metadata.details, error_code: safeErrorCode(error) }, coreEventIds: scope.coreEventIds });
        throw error;
      }
    });
  }

  #now(): number { try { return nonnegative(this.#clock()); } catch { return Date.now(); } }
  #drop(code: string, count: number): void {
    this.#droppedEvents += Number.isSafeInteger(count) && count > 0 ? count : 1;
    this.#lastDroppedAt = this.#now(); this.#lastErrorCode = code; this.#warn();
  }
  #warn(): void {
    const now = this.#now();
    if (now - this.#lastWarningAt < 60_000) return;
    this.#lastWarningAt = now;
    try { console.error(JSON.stringify({ level: "warn", event: "activity_capture_degraded", code: this.#lastErrorCode,
      dropped_events: this.#droppedEvents, write_failures: this.#writeFailures, spool_gaps: this.#spoolGapCount })); } catch { /* Logging must remain observational. */ }
  }
}

export function createActivityEvent(input: ActivityEventInput, now = Date.now()): ActivityEvent {
  if (!ACTION.test(input.action)) throw new TypeError("invalid activity action");
  const scope = currentAuditContext();
  const occurredAt = nonnegative(input.occurredAt ?? now);
  const actorType = input.actorType ?? scope?.actorType ?? "SYSTEM";
  const outcome = input.outcome ?? "SUCCESS";
  const sourceType = input.sourceType ?? (scope?.requestId ? "HTTP" : "INTERNAL");
  if (!["SYSTEM", "ANONYMOUS", "ADMIN", "API_CLIENT"].includes(actorType) || !["SUCCESS", "FAILURE"].includes(outcome) ||
    !["HTTP", "BACKGROUND", "MAINTENANCE", "INTERNAL"].includes(sourceType)) throw new TypeError("invalid activity category");
  const select = <T>(value: T | undefined, fallback: T): T => value === undefined ? fallback : value;
  const sourceAddress = normalizeAuditAddress(select(input.sourceAddress, scope?.sourceAddress ?? null));
  const userAgent = normalizeAuditUserAgent(select(input.userAgent, scope?.userAgent ?? null));
  const actorId = text(select(input.actorId, scope?.actorId ?? null), 256);
  const siteId = text(select(input.siteId, scope?.siteId ?? null), 256);
  const siteName = text(select(input.siteName, scope?.siteName ?? null), 512);
  const httpMethod = text(input.httpMethod, 16);
  const route = text(input.route, 512);
  const httpStatus = input.httpStatus ?? null;
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new TypeError("invalid activity HTTP status");
  const coreEventIds = (input.coreEventIds ?? scope?.coreEventIds ?? []).filter(id => typeof id === "string" && id.length <= 128).slice(0, 256);
  const aggregate = (input.aggregate === true || input.aggregate === "hour") &&
    (outcome === "SUCCESS" || (sourceType === "HTTP" && input.action === "http.request")) && coreEventIds.length === 0;
  const httpAggregate = aggregate && sourceType === "HTTP";
  // A request group represents the registered method/route, not its first order or website resource.
  const subjectType = httpAggregate ? null : text(input.subjectType, 128);
  const subjectId = httpAggregate ? null : text(input.subjectId, 256);
  const bucket = input.aggregate === "hour" ? "hour:" + Math.floor(occurredAt / HOUR) : Math.floor(occurredAt / 60_000);
  const details = sanitizeActivityDetails(input.details ?? {});
  const aggregationKey = aggregate ? createHash("sha256").update(JSON.stringify([bucket, sourceType,
    actorType, actorId, input.action, outcome, subjectType, subjectId, siteId, sourceAddress, userAgent, httpMethod, route, httpStatus,
    details.error_code ?? null])).digest("hex") : null;
  const detailsJson = JSON.stringify(details);
  if (Buffer.byteLength(detailsJson, "utf8") > MAX_DETAILS_BYTES) throw new TypeError("activity details too large");
  return { eventId: randomUUID(), activityId: aggregate ? randomUUID() : text(input.activityId ?? scope?.activityId, 128) ?? randomUUID(),
    requestId: aggregate ? null : text(select(input.requestId, scope?.requestId ?? null), 128), occurredAt, firstOccurredAt: occurredAt, lastOccurredAt: occurredAt,
    sourceType, actorType, actorId, action: input.action, outcome, subjectType, subjectId, siteId, siteName, sourceAddress, userAgent,
    httpMethod, route, httpStatus, durationMs: nonnegative(input.durationMs ?? 0), eventCount: Math.max(1, nonnegative(input.count ?? 1)),
    isAggregate: aggregate, detailsJson, coreEventIdsJson: JSON.stringify(coreEventIds), externalEventId: text(input.externalEventId, 128), aggregationKey };
}

function isBudgetedHttpEvent(event: ActivityEvent): boolean {
  return event.action === "http.request" && event.sourceType === "HTTP" && event.coreEventIdsJson === "[]" &&
    (event.httpMethod === "GET" || event.httpMethod === "HEAD" || event.actorType === "ANONYMOUS");
}

/** Called inside the caller's transaction so imported receipts cannot outrun data. */
export function persistActivityEvent(db: DatabaseSync, event: ActivityEvent): void {
  db.prepare(`INSERT INTO activity_events(event_id, activity_id, request_id, occurred_at, first_occurred_at, last_occurred_at,
    source_type, actor_type, actor_id, action, outcome, subject_type, subject_id, site_id, site_name, source_address,
    user_agent, http_method, route, http_status, duration_ms, event_count, is_aggregate, details_json, core_event_ids_json, external_event_id, aggregation_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(aggregation_key) DO UPDATE SET first_occurred_at = MIN(COALESCE(activity_events.first_occurred_at, activity_events.occurred_at), excluded.first_occurred_at),
      last_occurred_at = MAX(activity_events.last_occurred_at, excluded.last_occurred_at),
      duration_ms = MIN(9007199254740991, activity_events.duration_ms + excluded.duration_ms),
      event_count = MIN(9007199254740991, activity_events.event_count + excluded.event_count)`)
    .run(event.eventId, event.activityId, event.requestId, event.occurredAt, event.firstOccurredAt ?? event.occurredAt, event.lastOccurredAt, event.sourceType,
      event.actorType, event.actorId, event.action, event.outcome, event.subjectType, event.subjectId, event.siteId, event.siteName,
      event.sourceAddress, event.userAgent, event.httpMethod, event.route, event.httpStatus, event.durationMs, event.eventCount,
      event.isAggregate ? 1 : 0, event.detailsJson, event.coreEventIdsJson, event.externalEventId, event.aggregationKey);
}

export function sanitizeActivityDetails(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const clean = (entry: unknown, depth: number): unknown => {
    if (depth > 5) return "[omitted]";
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : null;
    if (typeof entry === "string") return entry.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_048);
    if (Array.isArray(entry)) return entry.slice(0, 100).map(item => clean(item, depth + 1));
    if (typeof entry !== "object") return null;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry).slice(0, 100)) {
      if (PRIVATE_FIELD.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      result[key.slice(0, 128)] = clean(child, depth + 1);
    }
    return result;
  };
  return clean(value, 0) as Readonly<Record<string, unknown>>;
}

export function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && ACTION.test(error.code)) return error.code;
  return "operation_failed";
}

function persistCaptureState(db: DatabaseSync, state: ActivityCaptureStatus, now: number): void {
  db.prepare("INSERT INTO activity_capture_state(key, value_json, updated_at) VALUES ('recorder', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
    .run(JSON.stringify(state), now);
}
function nonnegative(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid activity number"); return value; }
function text(value: string | null | undefined, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, "utf8") > maximum) throw new TypeError("invalid activity text");
  return value || null;
}
