// SPDX-License-Identifier: MIT
/** Public audit projections. This module has no server-only dependencies. */
export const AUDIT_SOURCES = ["core", "activity"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];
export const AUDIT_ACTOR_TYPES = ["SYSTEM", "ANONYMOUS", "ADMIN", "API_CLIENT"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const AUDIT_OUTCOMES = ["SUCCESS", "FAILURE"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export const AUDIT_CATEGORIES = ["identity", "configuration", "orders", "reconciliation", "notifications", "requests", "background", "maintenance", "audit", "other"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const AUDIT_CATEGORY_LABELS: Readonly<Record<AuditCategory, string>> = {
  identity: "登录与安全", configuration: "配置变更", orders: "订单", reconciliation: "对账与资金",
  notifications: "通知", requests: "接口访问", background: "后台任务", maintenance: "维护与备份",
  audit: "审计", other: "其他",
};
export const AUDIT_UNASSOCIATED_SITE = "unassociated";
export type AuditJsonValue = null | boolean | number | string | readonly AuditJsonValue[] | { readonly [key: string]: AuditJsonValue };
export interface AuditChange {
  readonly field: string;
  readonly kind: "value" | "redacted_change";
  readonly before?: AuditJsonValue;
  readonly after?: AuditJsonValue;
  readonly configured_before?: boolean;
  readonly configured_after?: boolean;
}
export interface AuditFilters {
  readonly source?: AuditSource;
  readonly category?: AuditCategory;
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly actor_type?: AuditActorType;
  /** A historical site ID, or "unassociated" for events without a recorded site. */
  readonly site_id?: string;
  readonly source_address?: string;
  readonly created_from?: string;
  readonly created_to?: string;
  readonly q?: string;
}
export interface AuditEventItem {
  readonly source: AuditSource;
  readonly event_id: string;
  readonly sequence: number;
  /** Immutable ordering timestamp; an open aggregate may receive an earlier occurrence later. */
  readonly occurred_at: string;
  /** Earliest recorded occurrence, including late arrivals in an open aggregate. */
  readonly first_occurred_at: string;
  readonly last_occurred_at: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor_type: AuditActorType;
  readonly actor_id: string | null;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly request_id: string | null;
  readonly activity_id: string | null;
  readonly site_id: string | null;
  readonly site_name: string | null;
  readonly source_address: string | null;
  readonly user_agent: string | null;
  readonly context_recorded: boolean;
  readonly source_type: "CORE" | "HTTP" | "BACKGROUND" | "MAINTENANCE" | "INTERNAL";
  readonly event_count: number;
  readonly is_aggregate: boolean;
  readonly duration_ms: number | null;
  readonly http_method: string | null;
  readonly route: string | null;
  readonly http_status: number | null;
}
export interface AuditRelatedEvent {
  readonly source: AuditSource;
  readonly event_id: string;
  readonly action: string;
  readonly occurred_at: string;
  readonly outcome: AuditOutcome;
}
export interface AuditEventDetail extends AuditEventItem {
  /** Explicitly allowed metadata only; never a raw request or response body. */
  readonly details: Readonly<Record<string, AuditJsonValue>>;
  readonly changes: readonly AuditChange[];
  readonly event_hash: string | null;
  readonly previous_hash: string | null;
  readonly context_fingerprint: string | null;
  readonly remote_address_hash: string | null;
  readonly related_events: readonly AuditRelatedEvent[];
  /** Null means no request association was recorded; false may include retention or capture gaps. */
  readonly related_activity_available: boolean | null;
}
export interface AuditSnapshot {
  readonly core_sequence: number;
  readonly activity_sequence: number;
  readonly captured_at: number;
}
export interface AuditEventPage {
  readonly data: readonly AuditEventItem[];
  readonly page: { readonly next_cursor: string | null; readonly snapshot_at: string };
}
export interface AuditCaptureState {
  readonly state: "healthy" | "degraded" | "unavailable";
  readonly buffered_events: number;
  readonly dropped_events: number;
  readonly last_dropped_at?: string | null;
  readonly write_failures: number;
  readonly last_flush_at: string | null;
  readonly last_error_code: string | null;
  readonly spool_last_import_at: string | null;
  readonly spool_failures: number;
  readonly spool_gap_count: number;
}
export interface AuditMetadata {
  readonly actions: readonly { readonly action: string; readonly category: AuditCategory }[];
  readonly sites: readonly { readonly site_id: string; readonly site_name: string | null; readonly deleted: boolean }[];
  readonly capture: AuditCaptureState;
  readonly retention: { readonly activity_days: 30; readonly core: "indefinite" };
}
export interface AuditExportInput extends AuditFilters {
  readonly created_from: string;
  readonly created_to: string;
}
