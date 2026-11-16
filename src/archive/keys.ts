import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function archiveIdentityDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isArchivedOperation(connection: DatabaseSync, kind: "FINANCIAL" | "LEDGER_CONFLICT", identity: { operationId?: string; operationKey?: string }): boolean {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'archived_operation_keys'").get()) return false;
  return !!connection.prepare(`SELECT 1 FROM archived_operation_keys WHERE operation_kind = ?
    AND (operation_id = ? OR operation_key_digest = ?) LIMIT 1`)
    .get(kind, identity.operationId ?? null, identity.operationKey === undefined ? null : archiveIdentityDigest(identity.operationKey));
}

export function findArchivedLedgerEntry(connection: DatabaseSync, providerAccountKey: string, externalEventId: string): {
  ledgerEntryId: string;
  archiveId: string;
  semanticFingerprint: string;
} | undefined {
  if (!connection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'archived_ledger_keys'").get()) return undefined;
  const row = connection.prepare(`SELECT ledger_entry_id, archive_id, semantic_fingerprint FROM archived_ledger_keys
    WHERE provider_account_key = ? AND external_event_digest = ?`).get(providerAccountKey, archiveIdentityDigest(externalEventId)) as {
      ledger_entry_id: string; archive_id: string; semantic_fingerprint: string;
    } | undefined;
  return row && { ledgerEntryId: row.ledger_entry_id, archiveId: row.archive_id, semanticFingerprint: row.semantic_fingerprint };
}
