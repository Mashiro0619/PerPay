// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { ensurePrivateDirectory } from "../infrastructure/storage/permissions.ts";
import { createAuditContext, runWithAuditContext } from "./context.ts";
import { ACTIVITY_MAX_EVENT_BYTES, ACTIVITY_RETENTION_MILLISECONDS, ActivityRecorder, createActivityEvent,
  persistActivityEvent, safeErrorCode, sanitizeActivityDetails, type ActivityEvent, type ActivityEventInput } from "./activity.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_FILE = /^event-(\d{12})-([0-9a-f-]{36})\.json$/;
const RETENTION_FILE = /^retention-(\d{12})-([0-9a-f-]{36})\.json$/;
const MAX_FILE_BYTES = ACTIVITY_MAX_EVENT_BYTES + 4_096;
const HOUR = 3_600_000;
const PERMANENT_ACTIONS = new Set([
  "backup.restore", "backup.delete", "backup.lock.clear", "maintenance.lock.clear", "maintenance.publication_lock.clear",
  "maintenance.quarantine.delete", "maintenance.quarantine.prune", "maintenance.restore",
]);

interface SpoolSource {
  version: 1;
  sourceId: string;
  kind: "backup" | "maintenance";
  createdAt: number;
  lastAttemptAt: number;
  attemptedSequence: number;
  publishedSequence: number;
  failedEvents: number;
  lastErrorCode: string | null;
  prunedThroughSequence: number;
  prunedThroughAt: number | null;
  closedAt: number | null;
}

interface SpoolRetention {
  readonly version: 1;
  readonly sourceId: string;
  readonly prunedThroughSequence: number;
  readonly prunedThroughAt: number;
  readonly publishedAt: number;
}

export interface ActivitySpoolEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly sourceId: string;
  readonly sequence: number;
  readonly instanceId: string | null;
  readonly permanent: boolean;
  readonly activity: ActivityEvent;
}

export interface ActivitySpoolWriterOptions {
  readonly backupDirectory: string;
  readonly kind: "backup" | "maintenance";
  readonly clock?: (() => number) | undefined;
}

/** Each producer owns one directory; publishing an event never edits the data volume. */
export class ActivitySpoolWriter {
  readonly #root: string;
  readonly #directory: string;
  readonly #clock: () => number;
  readonly #source: SpoolSource;
  readonly #enabled: boolean;
  #lastPrunedAt = -Infinity;
  #lastWarningAt = -Infinity;

  constructor(options: ActivitySpoolWriterOptions) {
    this.#enabled = typeof options.backupDirectory === "string" && options.backupDirectory.trim().length > 0;
    this.#clock = options.clock ?? Date.now;
    this.#root = activitySpoolPath(options.backupDirectory);
    const now = this.#now(), sourceId = randomUUID();
    this.#directory = join(this.#root, sourceId);
    this.#source = { version: 1, sourceId, kind: options.kind, createdAt: now, lastAttemptAt: now,
      attemptedSequence: 0, publishedSequence: 0, failedEvents: 0, lastErrorCode: null,
      prunedThroughSequence: 0, prunedThroughAt: null, closedAt: null };
  }

  record(input: ActivityEventInput, options: { instanceId?: string | null; permanent?: boolean } = {}): boolean {
    const sequence = ++this.#source.attemptedSequence;
    this.#source.lastAttemptAt = this.#now();
    if (!this.#enabled) {
      this.#source.failedEvents += 1;
      this.#source.lastErrorCode = "activity_spool_directory_invalid";
      this.#warn();
      return false;
    }
    try {
      const scope = createAuditContext({ actorType: "SYSTEM", actorId: this.#source.kind });
      const activity = runWithAuditContext(scope, () => createActivityEvent({ ...input,
        sourceType: this.#source.kind === "backup" ? "BACKGROUND" : "MAINTENANCE", actorType: "SYSTEM",
        actorId: this.#source.kind, sourceAddress: null, userAgent: null, requestId: null, aggregate: false,
      }, this.#now()));
      const event: ActivitySpoolEvent = { version: 1, eventId: activity.eventId, sourceId: this.#source.sourceId, sequence,
        instanceId: options.instanceId ?? null, permanent: options.permanent === true && PERMANENT_ACTIONS.has(input.action), activity };
      ensureSpoolDirectory(this.#root, this.#directory);
      atomicJson(this.#directory, `event-${String(sequence).padStart(12, "0")}-${event.eventId}.json`, event);
      this.#source.publishedSequence = sequence;
      this.#source.lastErrorCode = null;
      this.#saveState();
      if (this.#now() - this.#lastPrunedAt >= HOUR) this.prune();
      return true;
    } catch {
      this.#source.failedEvents += 1;
      this.#source.lastErrorCode = "activity_spool_write_failed";
      this.#saveState();
      this.#warn();
      return false;
    }
  }

  async run<T>(action: string, details: Readonly<Record<string, unknown>>, operation: () => T | Promise<T>,
    options: { permanent?: boolean; summarize?: (result: T) => Readonly<Record<string, unknown>> } = {}): Promise<T> {
    const startedAt = this.#now();
    try {
      const result = await operation();
      let summary: Readonly<Record<string, unknown>> = {};
      try { summary = options.summarize?.(result) ?? {}; } catch { /* A summary failure cannot change a completed command. */ }
      const instanceId = typeof summary.instance_id === "string" && /^[0-9a-f]{32}$/.test(summary.instance_id) ? summary.instance_id : null;
      this.record({ action, outcome: "SUCCESS", durationMs: Math.max(0, this.#now() - startedAt), details: { ...details, ...summary } },
        { permanent: options.permanent ?? false, instanceId });
      return result;
    } catch (error) {
      this.record({ action, outcome: "FAILURE", durationMs: Math.max(0, this.#now() - startedAt),
        details: { ...details, error_code: safeErrorCode(error), ...(isRecord(error) && typeof error.stage === "string" ? { stage: error.stage } : {}) } },
      { permanent: options.permanent ?? false });
      throw error;
    }
  }

  close(): void {
    this.#source.closedAt = this.#now();
    if (this.#source.attemptedSequence > 0) this.#saveState();
  }

  /** Every source file expires after the handoff window; imported core facts remain permanent. */
  prune(): void {
    if (!this.#enabled) return;
    this.#lastPrunedAt = this.#now();
    const cutoff = this.#lastPrunedAt - ACTIVITY_RETENTION_MILLISECONDS;
    let budget = 500;
    try {
      for (const name of readdirSync(this.#root)) {
        if (budget <= 0) break;
        if (!UUID.test(name)) continue;
        const directory = join(this.#root, name);
        if (!ordinaryDirectorySync(directory)) continue;
        let source: SpoolSource;
        try { source = parseSource(readSmallJsonSync(join(directory, "source.json")), name); } catch { continue; }
        // A crashed producer has no closedAt. Its immutable old files can still
        // expire, without claiming that the producer has stopped permanently.
        if (name !== this.#source.sourceId && source.closedAt === null && source.lastAttemptAt >= cutoff) continue;
        if (name === this.#source.sourceId) source = this.#source;
        const files = readdirSync(directory);
        const expired: Array<{ file: string; event: ActivitySpoolEvent }> = [];
        for (const file of files) {
          if (expired.length >= budget) break;
          if (!EVENT_FILE.test(file)) continue;
          let event: ActivitySpoolEvent;
          try { event = parseEvent(readSmallJsonSync(join(directory, file)), name, file); } catch { continue; }
          if (event.activity.occurredAt >= cutoff) continue;
          expired.push({ file, event });
        }
        if (expired.length === 0) continue;
        const previousFile = highestRetentionFile(files);
        if (previousFile) source = mergeRetention(source, parseRetention(readSmallJsonSync(join(directory, previousFile)), name, previousFile));
        const watermark: SpoolRetention = { version: 1, sourceId: name,
          prunedThroughSequence: Math.max(source.prunedThroughSequence, ...expired.map(item => item.event.sequence)),
          prunedThroughAt: Math.max(source.prunedThroughAt ?? 0, ...expired.map(item => item.event.activity.occurredAt)),
          publishedAt: this.#lastPrunedAt };
        // Immutable markers are independent of source.json: a waking producer
        // or another cleaner cannot overwrite or move an established boundary back.
        atomicJson(directory, `retention-${String(watermark.prunedThroughSequence).padStart(12, "0")}-${randomUUID()}.json`, watermark);
        for (const item of expired) rmSync(join(directory, item.file), { force: true });
        budget -= expired.length;
      }
    } catch {
      this.#source.lastErrorCode = "activity_spool_retention_failed";
      this.#saveState();
      this.#warn();
    }
  }

  #now(): number { try { const now = this.#clock(); return integer(now) ? now : Date.now(); } catch { return Date.now(); } }
  #saveState(): void {
    if (!this.#enabled) return;
    try { ensureSpoolDirectory(this.#root, this.#directory); atomicJson(this.#directory, "source.json", this.#source); }
    catch { this.#source.lastErrorCode = "activity_spool_state_failed"; this.#warn(); }
  }
  #warn(): void {
    const now = this.#now();
    if (now - this.#lastWarningAt < 60_000) return;
    this.#lastWarningAt = now;
    try { console.error(JSON.stringify({ level: "warn", event: "activity_spool_degraded", source: this.#source.kind,
      code: this.#source.lastErrorCode, failed_events: this.#source.failedEvents })); } catch { /* Preserve the command result. */ }
  }
}

export interface ActivitySpoolImporterOptions {
  readonly database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  readonly recorder: ActivityRecorder;
  readonly backupDirectory: string;
  readonly clock?: (() => number) | undefined;
  readonly pollIntervalMilliseconds?: number | undefined;
  readonly maximumEventsPerPoll?: number | undefined;
}

interface ImportSourceRow { last_sequence: number; gap_count: number; details_json: string }

/** The app reads immutable spool files and commits each receipt with its history row. */
export class ActivitySpoolImporter {
  readonly #database: ActivitySpoolImporterOptions["database"];
  readonly #recorder: ActivityRecorder;
  readonly #root: string;
  readonly #clock: () => number;
  readonly #interval: number;
  readonly #maximumEvents: number;
  readonly #closedSources = new Set<string>();
  readonly #failedSources = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #current: Promise<void> | null = null;
  #position = 0;
  #stopped = false;

  constructor(options: ActivitySpoolImporterOptions) {
    this.#database = options.database;
    this.#recorder = options.recorder;
    this.#root = activitySpoolPath(options.backupDirectory);
    this.#clock = options.clock ?? Date.now;
    this.#interval = Math.max(1, Math.min(5_000, options.pollIntervalMilliseconds ?? 5_000));
    this.#maximumEvents = Math.max(1, Math.min(1_024, options.maximumEventsPerPoll ?? 256));
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    void this.poll();
    this.#timer = setInterval(() => { void this.poll(); }, this.#interval);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#current;
  }

  poll(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#current) return this.#current;
    this.#current = this.#collect().catch(() => { this.#recorder.noteSpoolFailure(); }).finally(() => { this.#current = null; });
    return this.#current;
  }

  async #collect(): Promise<void> {
    let sources: string[];
    try {
      const stat = await lstat(this.#root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("spool must be an ordinary directory");
      sources = (await readdir(this.#root)).filter(name => UUID.test(name) && !this.#closedSources.has(name)).sort();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (sources.length === 0) return;
    let budget = this.#maximumEvents;
    const start = this.#position % sources.length;
    for (let index = 0; index < Math.min(sources.length, 128) && budget > 0; index += 1) {
      const sourceId = sources[(start + index) % sources.length]!;
      budget -= await this.#collectSource(sourceId, budget);
      this.#position = (start + index + 1) % sources.length;
    }
    if (this.#failedSources.size === 0) this.#recorder.noteSpoolAvailable();
  }

  async #collectSource(sourceId: string, budget: number): Promise<number> {
    const directory = join(this.#root, sourceId);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { this.#failedSources.add(sourceId); this.#recorder.noteSpoolFailure("activity_spool_invalid"); return 1; }
    let source: SpoolSource;
    try { source = parseSource(await readSmallJson(join(directory, "source.json")), sourceId); this.#failedSources.delete(sourceId); }
    catch (error) {
      this.#failedSources.add(sourceId);
      this.#recorder.noteSpoolFailure(errorCode(error) === "ENOENT" ? "activity_spool_metadata_missing" : "activity_spool_invalid");
      // A crash can occur after the durable event rename but before source metadata publication.
      // Recover the intact events while keeping capture visibly degraded: an unpublished tail is unknown.
      if (errorCode(error) !== "ENOENT") return 1;
      const published = (await readdir(directory)).filter(file => EVENT_FILE.test(file)).sort();
      if (published.length === 0) return 1;
      let first: ActivitySpoolEvent;
      try { first = parseEvent(await readSmallJson(join(directory, published[0]!)), sourceId, published[0]!); }
      catch { return 1; }
      const lastSequence = Number(EVENT_FILE.exec(published.at(-1)!)![1]);
      source = { version: 1, sourceId, kind: first.activity.sourceType === "BACKGROUND" ? "backup" : "maintenance",
        createdAt: first.activity.occurredAt, lastAttemptAt: first.activity.occurredAt,
        attemptedSequence: lastSequence, publishedSequence: lastSequence, failedEvents: 0, lastErrorCode: "source_metadata_missing",
        prunedThroughSequence: 0, prunedThroughAt: null, closedAt: null };
    }
    const directoryFiles = await readdir(directory);
    const retentionFile = highestRetentionFile(directoryFiles);
    if (retentionFile) {
      try { source = mergeRetention(source, parseRetention(await readSmallJson(join(directory, retentionFile)), sourceId, retentionFile)); }
      catch { this.#failedSources.add(sourceId); this.#recorder.noteSpoolFailure("activity_spool_invalid"); return 1; }
    }
    const saved = this.#database.read(db => db.prepare("SELECT last_sequence, gap_count, details_json FROM activity_import_sources WHERE source_id = ?").get(sourceId)) as
      { last_sequence: number | bigint; gap_count: number | bigint; details_json: string } | undefined;
    let cursor: ImportSourceRow | undefined = saved ? { last_sequence: Number(saved.last_sequence), gap_count: Number(saved.gap_count), details_json: saved.details_json } : undefined;
    if (!cursor) {
      this.#database.write(db => db.prepare("INSERT OR IGNORE INTO activity_import_sources(source_id, last_sequence, first_observed_at) VALUES (?, 0, ?)").run(sourceId, this.#now()));
      cursor = { last_sequence: 0, gap_count: 0, details_json: "{}" };
    }
    const publishedFiles = directoryFiles.filter(file => EVENT_FILE.test(file)).sort();
    if (cursor.last_sequence < source.prunedThroughSequence) {
      const retained = new Set(publishedFiles.map(file => Number(EVENT_FILE.exec(file)![1]))
        .filter(sequence => sequence > cursor!.last_sequence && sequence <= source.prunedThroughSequence));
      const missing = Math.max(0, source.prunedThroughSequence - cursor.last_sequence - retained.size);
      this.#retentionGap(sourceId, cursor.last_sequence, missing, source);
      cursor.last_sequence = source.prunedThroughSequence;
    }
    // Permanent records below a retention watermark still need importing after a
    // long outage or a database restore. Advancing the cursor cannot discard them.
    const received = source.prunedThroughSequence > 0 ? this.#database.read(db => new Set(
      db.prepare("SELECT event_id FROM activity_external_receipts WHERE source_id = ? AND source_sequence <= ?")
        .all(sourceId, source.prunedThroughSequence).map(row => String(row.event_id)))) : new Set<string>();
    const files = publishedFiles.filter(file => {
      const match = EVENT_FILE.exec(file)!;
      const sequence = Number(match[1]);
      return sequence > cursor!.last_sequence || sequence <= source.prunedThroughSequence && !received.has(match[2]!);
    });
    let processed = 0;
    for (const file of files) {
      if (processed >= budget) break;
      const sequence = Number(EVENT_FILE.exec(file)![1]);
      if (sequence > cursor.last_sequence + 1) {
        const missing = sequence - Math.max(cursor.last_sequence + 1, source.prunedThroughSequence + 1);
        if (missing > 0) this.#gap(sourceId, cursor.last_sequence, missing, "source_sequence_missing", source);
      }
      let event: ActivitySpoolEvent;
      try { event = parseEvent(await readSmallJson(join(directory, file)), sourceId, file); }
      catch {
        this.#gap(sourceId, sequence, 1, "source_event_invalid", source);
        cursor.last_sequence = Math.max(cursor.last_sequence, sequence);
        processed += 1;
        continue;
      }
      if (event.instanceId !== null && event.instanceId !== this.#database.instanceId()) {
        this.#gap(sourceId, sequence, 1, "source_instance_mismatch", source);
        cursor.last_sequence = Math.max(cursor.last_sequence, sequence);
        processed += 1;
        continue;
      }
      this.#import(event, source);
      cursor.last_sequence = Math.max(cursor.last_sequence, sequence);
      processed += 1;
    }
    // A failed final write leaves no later file from which to infer its missing sequence.
    if (processed < budget && source.attemptedSequence > cursor.last_sequence &&
      (source.closedAt !== null || source.failedEvents > 0 && source.lastErrorCode !== null)) {
      const missing = source.attemptedSequence - Math.max(cursor.last_sequence, source.prunedThroughSequence);
      if (missing > 0) this.#gap(sourceId, source.attemptedSequence, missing, "source_tail_missing", source);
      else this.#database.write(db => updateSource(db, sourceId, source.attemptedSequence, this.#now(), source, null));
      cursor.last_sequence = source.attemptedSequence;
    }
    if (source.closedAt !== null && cursor.last_sequence >= source.publishedSequence && processed < budget) this.#closedSources.add(sourceId);
    return processed;
  }

  #import(event: ActivitySpoolEvent, source: SpoolSource): void {
    const now = this.#now();
    const scope = createAuditContext({ activityId: event.activity.activityId, actorType: "SYSTEM", actorId: source.kind,
      siteId: event.activity.siteId, siteName: event.activity.siteName });
    runWithAuditContext(scope, () => this.#database.write(db => {
      const seen = db.prepare("SELECT 1 FROM activity_external_receipts WHERE event_id = ? OR (source_id = ? AND source_sequence = ?)")
        .get(event.eventId, event.sourceId, event.sequence);
      if (!seen) {
        let coreEventId: string | null = null;
        if (event.permanent) {
          coreEventId = appendAuditEvent(db, { occurredAt: event.activity.occurredAt, actorType: "SYSTEM", actorId: source.kind,
            action: event.activity.action, outcome: event.activity.outcome, subjectType: event.activity.subjectType ?? "maintenance",
            subjectId: event.activity.subjectId ?? undefined, details: { ...JSON.parse(event.activity.detailsJson), external_event_id: event.eventId } }).eventId;
        }
        if (event.activity.occurredAt >= now - ACTIVITY_RETENTION_MILLISECONDS) {
          persistActivityEvent(db, { ...event.activity, externalEventId: event.eventId, coreEventIdsJson: JSON.stringify(scope.coreEventIds) });
        }
        db.prepare("INSERT INTO activity_external_receipts(event_id, source_id, source_sequence, occurred_at, imported_at, core_event_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(event.eventId, event.sourceId, event.sequence, event.activity.occurredAt, now, coreEventId);
      }
      updateSource(db, event.sourceId, event.sequence, now, source, null);
    }));
    this.#recorder.noteSpoolImport(now);
  }

  #gap(sourceId: string, lastSequence: number, count: number, code: string, source: SpoolSource): void {
    this.#database.write(db => {
      updateSource(db, sourceId, lastSequence, this.#now(), source, code);
      db.prepare("UPDATE activity_import_sources SET gap_count = gap_count + ? WHERE source_id = ?").run(count, sourceId);
    });
    this.#recorder.noteSpoolGap(count);
    this.#recorder.record({ action: "activity.capture_gap", outcome: "FAILURE", sourceType: "INTERNAL", actorType: "SYSTEM", actorId: "activity-importer",
      subjectType: "activity_source", subjectId: sourceId, sourceAddress: null, userAgent: null, requestId: null,
      details: { error_code: code, missing_events: count } });
  }

  #retentionGap(sourceId: string, fromSequence: number, count: number, source: SpoolSource): void {
    const now = this.#now();
    this.#database.write(db => {
      if (count > 0) {
        persistActivityEvent(db, createActivityEvent({ activityId: randomUUID(), action: "activity.capture_gap", outcome: "FAILURE",
          sourceType: "INTERNAL", actorType: "SYSTEM", actorId: "activity-importer", subjectType: "activity_source", subjectId: sourceId,
          sourceAddress: null, userAgent: null, siteId: null, siteName: null, requestId: null, coreEventIds: [],
          details: { error_code: "source_retention_gap", missing_events: count, after_sequence: fromSequence,
            through_sequence: source.prunedThroughSequence, pruned_through_at: source.prunedThroughAt },
        }, now));
        db.prepare("UPDATE activity_import_sources SET gap_count = gap_count + ? WHERE source_id = ?").run(count, sourceId);
      }
      updateSource(db, sourceId, source.prunedThroughSequence, now, source, count > 0 ? "source_retention_gap" : null);
    });
    if (count > 0) this.#recorder.noteSpoolGap(count);
  }

  #now(): number { try { const now = this.#clock(); return integer(now) ? now : Date.now(); } catch { return Date.now(); } }
}

export function activitySpoolPath(backupDirectory: string): string { return join(resolve(backupDirectory), "perpay-activity", "v1"); }

function updateSource(db: DatabaseSync, sourceId: string, sequence: number, now: number, source: SpoolSource, code: string | null): void {
  db.prepare(`UPDATE activity_import_sources SET last_sequence = MAX(last_sequence, ?), last_import_at = ?,
    last_error_code = CASE WHEN ? IS NULL THEN last_error_code ELSE ? END, details_json = ? WHERE source_id = ?`)
    .run(sequence, now, code, code, JSON.stringify({ failedEvents: source.failedEvents, attemptedSequence: source.attemptedSequence,
      publishedSequence: source.publishedSequence, prunedThroughSequence: source.prunedThroughSequence, prunedThroughAt: source.prunedThroughAt,
      closedAt: source.closedAt }), sourceId);
}

function parseSource(value: unknown, sourceId: string): SpoolSource {
  if (!isRecord(value) || value.version !== 1 || value.sourceId !== sourceId || !UUID.test(sourceId) ||
    !["backup", "maintenance"].includes(String(value.kind)) || !integer(value.createdAt) || !integer(value.lastAttemptAt) ||
    !integer(value.attemptedSequence) || !integer(value.publishedSequence) || value.publishedSequence > value.attemptedSequence ||
    !integer(value.failedEvents) || !integer(value.prunedThroughSequence) || value.prunedThroughSequence > value.publishedSequence ||
    !(value.prunedThroughAt === null || integer(value.prunedThroughAt)) || !(value.closedAt === null || integer(value.closedAt))) throw new TypeError("invalid activity source");
  return value as unknown as SpoolSource;
}

function highestRetentionFile(files: readonly string[]): string | undefined {
  return files.filter(file => RETENTION_FILE.test(file)).sort().at(-1);
}

function parseRetention(value: unknown, sourceId: string, filename: string): SpoolRetention {
  const match = RETENTION_FILE.exec(filename);
  if (!isRecord(value) || !match || !UUID.test(match[2]!) || value.version !== 1 || value.sourceId !== sourceId ||
    !integer(value.prunedThroughSequence) || value.prunedThroughSequence < 1 || value.prunedThroughSequence !== Number(match[1]) ||
    !integer(value.prunedThroughAt) || !integer(value.publishedAt)) throw new TypeError("invalid retention watermark");
  return value as unknown as SpoolRetention;
}

function mergeRetention(source: SpoolSource, watermark: SpoolRetention): SpoolSource {
  return { ...source, prunedThroughSequence: Math.max(source.prunedThroughSequence, watermark.prunedThroughSequence),
    prunedThroughAt: Math.max(source.prunedThroughAt ?? 0, watermark.prunedThroughAt),
    // A crash can leave a durable event ahead of the producer's last source.json.
    publishedSequence: Math.max(source.publishedSequence, watermark.prunedThroughSequence),
    attemptedSequence: Math.max(source.attemptedSequence, watermark.prunedThroughSequence) };
}

function parseEvent(value: unknown, sourceId: string, filename: string): ActivitySpoolEvent {
  const match = EVENT_FILE.exec(filename);
  if (!isRecord(value) || !match || value.version !== 1 || value.sourceId !== sourceId || value.sequence !== Number(match[1]) ||
    !integer(value.sequence) || value.sequence < 1 || typeof value.eventId !== "string" || !UUID.test(value.eventId) || value.eventId !== match[2] ||
    !(value.instanceId === null || typeof value.instanceId === "string" && /^[0-9a-f]{32}$/.test(value.instanceId)) ||
    typeof value.permanent !== "boolean" || !isRecord(value.activity)) throw new TypeError("invalid activity spool event");
  const input = value.activity as unknown as ActivityEvent;
  const scope = createAuditContext({ actorType: "SYSTEM", actorId: input.actorId });
  const normalized = runWithAuditContext(scope, () => createActivityEvent({ action: input.action, outcome: input.outcome,
    occurredAt: input.occurredAt, activityId: input.activityId, sourceType: input.sourceType, actorType: "SYSTEM", actorId: input.actorId,
    subjectType: input.subjectType, subjectId: input.subjectId, siteId: input.siteId, siteName: input.siteName,
    requestId: null, sourceAddress: null, userAgent: null, durationMs: input.durationMs,
    details: sanitizeActivityDetails(JSON.parse(input.detailsJson) as Record<string, unknown>), externalEventId: value.eventId as string,
  }, input.occurredAt));
  if (value.permanent && !PERMANENT_ACTIONS.has(normalized.action)) throw new TypeError("unsupported permanent maintenance event");
  return { version: 1, eventId: value.eventId, sourceId, sequence: value.sequence,
    instanceId: value.instanceId as string | null, permanent: value.permanent,
    activity: { ...normalized, eventId: value.eventId } };
}

function atomicJson(directory: string, name: string, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_FILE_BYTES) throw new RangeError("activity spool record is too large");
  const temporary = join(directory, `.activity-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, join(directory, name));
    if (process.platform !== "win32") {
      const directoryHandle = openSync(directory, "r");
      try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
    }
  } finally { rmSync(temporary, { force: true }); }
}

function ensureSpoolDirectory(root: string, directory: string): void {
  if (!ordinaryDirectorySync(resolve(root, "..", ".."))) throw new TypeError("backup volume must already exist");
  ensurePrivateDirectory(resolve(root, ".."));
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(directory);
}
function ordinaryDirectorySync(path: string): boolean { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
function readSmallJsonSync(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new TypeError("invalid activity spool file");
  return JSON.parse(readFileSync(path, "utf8"));
}
async function readSmallJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new TypeError("invalid activity spool file");
  return JSON.parse(await readFile(path, "utf8"));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function errorCode(error: unknown): string | null { return isRecord(error) && typeof error.code === "string" ? error.code : null; }
