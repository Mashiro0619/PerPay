import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { auditContextFingerprint } from "../audit/context.ts";

export interface AuditEventHashInput {
  readonly eventId: string;
  readonly occurredAt: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly requestId: string | null;
  readonly remoteAddressHash: string | null;
  readonly detailsJson: string;
  readonly previousHash: string | null;
}

export interface AuditChainIntegrity {
  readonly eventCount: number;
  readonly linkViolations: number;
  readonly hashViolations: number;
  readonly anchorViolations: number;
  readonly violations: number;
}

interface AuditEventRow {
  readonly sequence: bigint | number;
  readonly event_id: string;
  readonly occurred_at: bigint | number;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly request_id: string | null;
  readonly remote_address_hash: string | null;
  readonly details_json: string;
  readonly previous_hash: string | null;
  readonly event_hash: string;
}

export function calculateAuditEventHash(input: AuditEventHashInput): string {
  const payload = [
    "perpay-audit-v1",
    input.eventId,
    String(input.occurredAt),
    input.actorType,
    input.actorId ?? "",
    input.action,
    input.outcome,
    input.subjectType ?? "",
    input.subjectId ?? "",
    input.requestId ?? "",
    input.remoteAddressHash ?? "",
    input.detailsJson,
    input.previousHash ?? "",
  ].join("\0");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function inspectAuditChain(connection: DatabaseSync): AuditChainIntegrity {
  if (!tableExists(connection, "audit_events")) {
    const anchorViolations = tableExists(connection, "audit_chain_state") ? 1 : 0;
    return {
      eventCount: 0,
      linkViolations: 0,
      hashViolations: 0,
      anchorViolations,
      violations: anchorViolations,
    };
  }

  const rows = connection.prepare(
    `SELECT sequence, event_id, occurred_at, actor_type, actor_id, action, outcome,
            subject_type, subject_id, request_id, remote_address_hash,
            details_json, previous_hash, event_hash
       FROM audit_events
      ORDER BY sequence`,
  ).iterate() as unknown as Iterable<AuditEventRow>;

  let eventCount = 0;
  let linkViolations = 0;
  let hashViolations = 0;
  let previousHash: string | null = null;
  let lastSequence: number | null = null;
  for (const row of rows) {
    eventCount += 1;
    const sequence = Number(row.sequence);
    const occurredAt = Number(row.occurred_at);
    if (!Number.isSafeInteger(sequence) || sequence !== eventCount) linkViolations += 1;
    if (row.previous_hash !== previousHash) linkViolations += 1;
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      hashViolations += 1;
    } else if (row.event_hash !== calculateAuditEventHash({
      eventId: row.event_id,
      occurredAt,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      outcome: row.outcome,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      requestId: row.request_id,
      remoteAddressHash: row.remote_address_hash,
      detailsJson: row.details_json,
      previousHash: row.previous_hash,
    })) {
      hashViolations += 1;
    }
    previousHash = row.event_hash;
    lastSequence = Number.isSafeInteger(sequence) ? sequence : null;
  }

  const anchorViolations = inspectAuditAnchor(
    connection,
    eventCount,
    lastSequence,
    previousHash,
  );
  hashViolations += inspectAuditContexts(connection);
  return {
    eventCount,
    linkViolations,
    hashViolations,
    anchorViolations,
    violations: linkViolations + hashViolations + anchorViolations,
  };
}

function inspectAuditContexts(connection: DatabaseSync): number {
  if (!tableExists(connection, "audit_event_context")) {
    // Historical databases have no context fingerprints. A missing v39 table
    // must not silently turn newer authenticated contexts into historical ones.
    return Number(connection.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE json_type(details_json, '$.context_fingerprint') IS NOT NULL").get()?.count ?? 0);
  }
  let violations = 0;
  const rows = connection.prepare(`SELECT event.details_json, context.context_json, context.context_fingerprint,
    context.activity_id, context.source_address, context.user_agent, context.site_id, context.site_name
    FROM audit_events event LEFT JOIN audit_event_context context USING(event_id)
    WHERE context.event_id IS NOT NULL OR json_type(event.details_json, '$.context_fingerprint') IS NOT NULL`).iterate();
  for (const row of rows) {
    try {
      const expected = (JSON.parse(String(row.details_json)) as Record<string, unknown>).context_fingerprint;
      const json = row.context_json;
      if (typeof json !== "string" || expected !== row.context_fingerprint || expected !== auditContextFingerprint(json)) { violations++; continue; }
      const context = JSON.parse(json) as Record<string, unknown>;
      if (context.version !== 1 || !Array.isArray(context.changes) ||
        ["activity_id", "source_address", "user_agent", "site_id", "site_name"].some(key => row[key] !== context[key])) violations++;
    } catch { violations++; }
  }
  violations += Number(connection.prepare(`SELECT COUNT(*) AS count FROM audit_event_context context
    LEFT JOIN audit_events event USING(event_id) WHERE event.event_id IS NULL`).get()?.count ?? 0);
  return violations;
}

export function assertAuditChainIntegrity(connection: DatabaseSync): void {
  const integrity = inspectAuditChain(connection);
  if (integrity.linkViolations > 0) {
    throw new Error("audit chain link verification failed");
  }
  if (integrity.hashViolations > 0) {
    throw new Error("audit event hash verification failed");
  }
  if (integrity.anchorViolations > 0) {
    throw new Error("audit chain anchor verification failed");
  }
}

function inspectAuditAnchor(
  connection: DatabaseSync,
  eventCount: number,
  lastSequence: number | null,
  lastEventHash: string | null,
): number {
  if (!tableExists(connection, "audit_chain_state")) return 0;
  const rows = connection.prepare(
    `SELECT event_count, last_sequence, last_event_hash
       FROM audit_chain_state`,
  ).all() as Array<{
    event_count: bigint | number;
    last_sequence: bigint | number | null;
    last_event_hash: string | null;
  }>;
  if (rows.length !== 1) return 1;
  const row = rows[0]!;
  return Number(row.event_count) === eventCount &&
      (row.last_sequence === null ? null : Number(row.last_sequence)) === lastSequence &&
      row.last_event_hash === lastEventHash
    ? 0
    : 1;
}

function tableExists(connection: DatabaseSync, tableName: string): boolean {
  const row = connection.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(tableName) as { present: bigint | number } | undefined;
  return row !== undefined;
}
