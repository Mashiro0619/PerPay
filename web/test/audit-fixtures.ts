import type { AuditEventDetail, AuditEventItem, AuditEventPage, AuditMetadata } from "../../src/shared/audit";

export const auditEvent: AuditEventItem = {
  source: "core", event_id: "11111111-1111-4111-8111-111111111111", sequence: 20,
  occurred_at: "2026-11-01T02:03:04.000Z", first_occurred_at: "2026-11-01T02:03:04.000Z", last_occurred_at: "2026-11-01T02:03:04.000Z",
  category: "configuration", action: "settings.display_updated", outcome: "SUCCESS", actor_type: "ADMIN", actor_id: "admin",
  subject_type: "settings", subject_id: "display", request_id: "request-configuration", activity_id: "activity-configuration",
  site_id: null, site_name: null, source_address: "192.0.2.25",
  user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  context_recorded: true, source_type: "CORE", event_count: 1, is_aggregate: false, duration_ms: 25,
  http_method: "PUT", route: "/api/admin/v1/settings/display", http_status: 200,
};

export const aggregateEvent: AuditEventItem = {
  ...auditEvent, source: "activity", event_id: "22222222-2222-4222-8222-222222222222", sequence: 21,
  action: "http.read", category: "requests", actor_type: "API_CLIENT", actor_id: "site_a", source_type: "HTTP",
  request_id: null, activity_id: "aggregate-group-identifier", subject_type: null, subject_id: null, site_id: "site_a", site_name: "示例网站",
  user_agent: "curl/8.11.0", source_address: "2001:db8::25", event_count: 5, is_aggregate: true,
  duration_ms: 100, occurred_at: "2026-11-01T02:03:05.000Z", first_occurred_at: "2026-11-01T02:03:05.000Z", last_occurred_at: "2026-11-01T02:03:54.000Z",
  http_method: "GET", route: "/api/v1/orders/{orderId}",
};

export function auditDetail(event: AuditEventItem = auditEvent): AuditEventDetail {
  return { ...event, details: { changed_fields: ["system_name"] }, changes: [], event_hash: event.source === "core" ? "a".repeat(64) : null,
    previous_hash: null, context_fingerprint: "b".repeat(64), remote_address_hash: "c".repeat(64),
    related_events: [], related_activity_available: null };
}

export function auditPage(data: readonly AuditEventItem[] = [auditEvent], cursor: string | null = null): AuditEventPage {
  return { data, page: { next_cursor: cursor, snapshot_at: "2026-11-01T02:04:00.000Z" } };
}

export const auditMetadata: AuditMetadata = {
  actions: [{ action: "settings.display_updated", category: "configuration" }, { action: "http.read", category: "requests" }],
  sites: [{ site_id: "site_a", site_name: "示例网站", deleted: false }, { site_id: "site_b", site_name: "历史网站", deleted: true }],
  capture: { state: "healthy", buffered_events: 0, dropped_events: 0, write_failures: 0, last_flush_at: "2026-11-01T02:03:59.000Z", last_error_code: null, spool_last_import_at: null, spool_failures: 0, spool_gap_count: 0 },
  retention: { activity_days: 30, core: "indefinite" },
};
