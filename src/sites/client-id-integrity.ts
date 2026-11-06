import type { DatabaseSync } from "node:sqlite";
import { changeSiteClientIdInputSchema, fingerprintSiteClientIdChange } from "./model.ts";

interface ChangeRow {
  operation_id: string;
  client_id: string;
  request_fingerprint: string;
  previous_api_client_id: string;
  next_api_client_id: string;
  revision: number | bigint;
  changed: number | bigint;
  created_at: number | bigint;
}

/** Older backups are checked on their original schema before migration. */
export function countSiteClientIdViolations(connection: DatabaseSync): number {
  const present = ["site_api_client_ids", "site_client_id_changes"].filter(name =>
    connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (present.length === 0) return 0;
  if (present.length !== 2) return 1;
  const count = (sql: string) => Number(connection.prepare(sql).get()!.total);
  let violations = count(`SELECT count(*) AS total FROM sites AS site
    LEFT JOIN site_api_client_ids AS current ON current.client_id=site.client_id AND current.is_current=1
    WHERE current.api_client_id IS NULL OR (site.deleted_at IS NULL) != (current.retired_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM site_api_client_ids AS original WHERE original.api_client_id=site.client_id AND original.client_id=site.client_id)`);
  violations += count(`SELECT count(*) AS total FROM api_client_idempotency_namespaces AS namespace
    LEFT JOIN site_api_client_ids AS reserved ON reserved.api_client_id=namespace.namespace_id
    WHERE reserved.api_client_id IS NULL OR reserved.client_id != namespace.client_id OR reserved.retired_at IS NULL`);
  violations += count(`SELECT count(*) AS total FROM site_api_client_ids AS identity
    WHERE identity.api_client_id != identity.client_id
      AND NOT EXISTS (SELECT 1 FROM api_client_idempotency_namespaces AS namespace WHERE namespace.namespace_id=identity.api_client_id AND namespace.client_id=identity.client_id)
      AND NOT EXISTS (SELECT 1 FROM site_client_id_changes AS operation WHERE operation.next_api_client_id=identity.api_client_id
        AND operation.client_id=identity.client_id AND operation.changed=1 AND operation.created_at=identity.created_at)`);
  violations += count(`SELECT count(*) AS total FROM site_api_client_ids AS identity
    WHERE identity.is_current=0
      AND NOT EXISTS (SELECT 1 FROM api_client_idempotency_namespaces AS namespace WHERE namespace.namespace_id=identity.api_client_id AND namespace.client_id=identity.client_id)
      AND NOT EXISTS (SELECT 1 FROM site_client_id_changes AS operation WHERE operation.previous_api_client_id=identity.api_client_id
        AND operation.client_id=identity.client_id AND operation.changed=1 AND operation.created_at=identity.retired_at)`);

  const audits = new Map<string, Array<{ subject_id: string; occurred_at: number | bigint; details: Record<string, unknown> }>>();
  for (const row of connection.prepare("SELECT subject_id, occurred_at, details_json FROM audit_events WHERE action='site.client_id_changed' AND outcome='SUCCESS' AND subject_type='website'").all()) {
    try {
      const details = JSON.parse(String(row.details_json)) as Record<string, unknown>;
      if (typeof details.operation_id !== "string") { violations++; continue; }
      const existing = audits.get(details.operation_id) ?? [];
      existing.push({ subject_id: String(row.subject_id), occurred_at: row.occurred_at as number | bigint, details });
      audits.set(details.operation_id, existing);
    } catch { violations++; }
  }
  const alias = connection.prepare("SELECT client_id, created_at, retired_at FROM site_api_client_ids WHERE api_client_id=?");
  const site = connection.prepare("SELECT revision FROM sites WHERE client_id=?");
  for (const operation of connection.prepare("SELECT * FROM site_client_id_changes").iterate() as Iterable<ChangeRow>) {
    const revision = Number(operation.revision), changed = Number(operation.changed), at = Number(operation.created_at);
    const parsed = changeSiteClientIdInputSchema.safeParse({ operation_id: operation.operation_id, revision, client_id: operation.next_api_client_id });
    if (!parsed.success || operation.request_fingerprint !== fingerprintSiteClientIdChange(operation.client_id, revision, operation.next_api_client_id)) violations++;
    const previous = alias.get(operation.previous_api_client_id), next = alias.get(operation.next_api_client_id);
    if (previous?.client_id !== operation.client_id || next?.client_id !== operation.client_id ||
      Number(previous?.created_at) > at || Number(next?.created_at) > at ||
      (previous?.retired_at != null && Number(previous.retired_at) < at) ||
      (next?.retired_at != null && Number(next.retired_at) < at) ||
      (changed === 1 && (Number(previous?.retired_at) !== at || Number(next?.created_at) !== at)) ||
      Number(site.get(operation.client_id)?.revision ?? -1) < revision + changed) violations++;
    const linked = audits.get(operation.operation_id) ?? [];
    audits.delete(operation.operation_id);
    const audit = linked[0];
    if (linked.length !== 1 || audit?.subject_id !== operation.client_id || Number(audit?.occurred_at) !== at ||
      audit?.details.request_fingerprint !== operation.request_fingerprint ||
      audit?.details.previous_api_client_id !== operation.previous_api_client_id || audit?.details.next_api_client_id !== operation.next_api_client_id ||
      audit?.details.revision !== revision + changed || audit?.details.changed !== Boolean(changed)) violations++;
  }
  return violations + audits.size;
}
