// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

export interface MaintenanceAuditTarget {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly instanceId?: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Call only with an inspected artifact or a completed operation's result. */
export function artifactAuditTarget(kind: "backup" | "restore_quarantine", artifact: {
  readonly name: string;
  readonly sha256: string | null;
  readonly sizeBytes?: number | null;
  readonly schemaVersion?: number | null;
  readonly instanceId?: string | null;
}): MaintenanceAuditTarget {
  const prefix = kind === "backup" ? "backup" : "quarantine";
  return { subjectType: kind, subjectId: artifact.name, details: {
    [prefix + "_name"]: artifact.name,
    [prefix + "_sha256"]: artifact.sha256,
    ...(artifact.sizeBytes !== undefined ? { [prefix + "_size_bytes"]: artifact.sizeBytes } : {}),
    ...(artifact.schemaVersion !== undefined ? { schema_version: artifact.schemaVersion } : {}),
    ...(artifact.instanceId !== undefined ? { instance_id: artifact.instanceId } : {}),
  } };
}

/** Lock ownership values are credentials; an exact fingerprint identifies the cleared lock. */
export function lockAuditTarget(kind: "backup" | "database" | "publication", record: {
  readonly token: string;
  readonly createdAt: string;
}): MaintenanceAuditTarget {
  const unreadable = record.token === "unreadable-lock-cleared";
  const fingerprint = unreadable ? null : createHash("sha256").update(record.token).digest("hex");
  return { subjectType: "maintenance_lock", subjectId: kind + (fingerprint ? ":" + fingerprint : ":unreadable"),
    details: { lock_kind: kind, lock_fingerprint: fingerprint, lock_created_at: record.createdAt, lock_readable: !unreadable } };
}
