import { queryOptions } from "@tanstack/react-query";
import { api, result } from "./client";
import type { AuditEventDetail, AuditEventPage, AuditFilters, AuditMetadata, AuditSource } from "../../../src/shared/audit";

export const AUDIT_FILTER_KEYS = [
  "source", "category", "action", "outcome", "actor_type", "site_id",
  "source_address", "created_from", "created_to", "q",
] as const satisfies readonly (keyof AuditFilters)[];

/** URL values are validated by the API; only declared filter keys leave the page. */
export function readAuditFilters(search: URLSearchParams): AuditFilters {
  return Object.fromEntries(AUDIT_FILTER_KEYS.flatMap(key => {
    const value = search.get(key)?.trim();
    return value ? [[key, value]] : [];
  })) as AuditFilters;
}

export const auditMetadataKey = ["audit-metadata"] as const;
export function auditMetadataQuery() {
  return queryOptions({
    queryKey: auditMetadataKey,
    queryFn: ({ signal }): Promise<{ data: AuditMetadata }> => result(api.getAuditMetadata({ signal })),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function auditListKey(filters: AuditFilters) {
  return ["audit-events", JSON.stringify(filters)] as const;
}

export function auditEventsQuery(filters: AuditFilters, cursor?: string) {
  return queryOptions({
    queryKey: [...auditListKey(filters), cursor ?? null],
    queryFn: ({ signal }): Promise<AuditEventPage> => result(api.listAuditEvents({
      signal,
      query: { ...filters, limit: 20, ...(cursor ? { cursor } : {}) },
    })),
    // Keep the user's snapshot when returning from a detail or another window.
    // An explicit refresh invalidates this filter's pages and returns to page one.
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function auditEventQuery(source: AuditSource, eventId: string) {
  return queryOptions({
    queryKey: ["audit-event", source, eventId],
    queryFn: ({ signal }): Promise<{ data: AuditEventDetail }> => result(api.getAuditEvent({
      signal, path: { source, event_id: eventId },
    })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
