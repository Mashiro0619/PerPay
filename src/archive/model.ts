export interface HistoryArchiveSummary {
  readonly archive_id: string;
  readonly created_at: number;
  readonly before: number;
  readonly schema_version: number;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly order_count: number;
  readonly ledger_count: number;
  readonly status: "AVAILABLE" | "DELETED";
  readonly deleted_at: number | null;
  readonly deletion_pending?: boolean;
}

export interface ArchiveOrderSummary {
  readonly order_id: string;
  readonly merchant_order_no: string;
  readonly site_id: string;
  readonly site_name: string;
  readonly product_name: string;
  readonly requested_amount_cents: number;
  readonly payable_amount_cents: number;
  readonly received_amount_cents: number | null;
  readonly payment_status: string;
  readonly refund_status: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface HistoryArchiveRecord {
  readonly table: string;
  readonly key: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class HistoryArchiveError extends Error {
  readonly code: "archive_not_found" | "archive_deleted" | "archive_changed" | "archive_empty" | "archive_order_not_found" | "archive_delete_pending";
  constructor(code: HistoryArchiveError["code"], message: string) {
    super(message);
    this.name = "HistoryArchiveError";
    this.code = code;
  }
}
