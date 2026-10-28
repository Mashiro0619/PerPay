export type LedgerManualScanUnavailableReason =
  | "not_configured" | "transitioning" | "stopped" | "storage_unavailable"
  | "database_unavailable" | "demo_read_only";

/** Ephemeral administrator progress; never evidence that an order was paid. */
export interface LedgerManualScanRequest {
  readonly id: string;
  readonly state: "WAITING" | "RUNNING" | "COMPLETED" | "FAILED";
  readonly requested_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly next_attempt_at: string | null;
  readonly outcome: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED" | null;
  readonly error_code: string | null;
  readonly ingest_run_id: string | null;
}

export interface LedgerManualScanStatus {
  readonly available: boolean;
  readonly unavailable_reason: LedgerManualScanUnavailableReason | null;
  readonly request: LedgerManualScanRequest | null;
}
