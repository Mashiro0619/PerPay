// SPDX-License-Identifier: MIT
import type { Context, Env, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppDatabase } from "../database/database.ts";
import type { ActivityRecorder } from "../audit/activity.ts";
import { createAuditContext, runWithAuditContext } from "../audit/context.ts";

export function httpActivityMiddleware<E extends Env>(options: {
  database: Pick<AppDatabase, "read">;
  recorder?: ActivityRecorder | undefined;
  sourceAddress: (context: Context<E>) => string;
  requestId: (context: Context<E>) => string;
  isStaticAsset?: ((path: string) => boolean) | undefined;
  clock?: (() => number) | undefined;
}): MiddlewareHandler<E> {
  const clock = options.clock ?? Date.now;
  return async (context, next) => {
    let address: string | null = null;
    try { address = options.sourceAddress(context); } catch { /* The owning route reports malformed forwarded headers. */ }
    const scope = createAuditContext({ requestId: options.requestId(context), sourceAddress: address,
      userAgent: context.req.header("user-agent"), actorType: "ANONYMOUS" });
    const startedAt = clock(), started = performance.now();
    await runWithAuditContext(scope, async () => {
      try { await next(); } finally {
        if (options.recorder && !options.isStaticAsset?.(context.req.path)) {
          // Never let observer lookups reject an already committed operation.
          let coreIds: string[] = [];
          try {
            if (scope.coreEventIds.length) {
              const rows = options.database.read(db => db.prepare(`SELECT context.event_id, context.site_id, context.site_name, event.subject_type, event.subject_id
                FROM audit_event_context context JOIN audit_events event USING(event_id) WHERE context.activity_id = ?`).all(scope.activityId));
              coreIds = rows.map(row => String(row.event_id));
              const websites = new Map(rows.filter(row => typeof row.site_id === "string").map(row => [String(row.site_id), row.site_name]));
              if (websites.size === 1) {
                const [id, name] = [...websites][0]!;
                scope.siteId = id; scope.siteName = typeof name === "string" ? name : null;
              } else if (websites.size > 1) { scope.siteId = null; scope.siteName = null; }
              const subjects = new Map(rows.filter(row => typeof row.subject_id === "string").map(row => [String(row.subject_type) + ":" + String(row.subject_id), row]));
              if (subjects.size === 1) {
                const subject = [...subjects.values()][0]!;
                scope.subjectType = typeof subject.subject_type === "string" ? subject.subject_type : null;
                scope.subjectId = String(subject.subject_id);
              }
            } else if (context.res.status < 400 && scope.actorType !== "ANONYMOUS") {
              const orderId = context.req.param("orderId");
              const clientId = context.req.param("clientId");
              const resolved = options.database.read(db => orderId
                ? db.prepare(`SELECT orders.api_client_id AS site_id, json_extract(sites.configuration, '$.name') AS site_name
                    FROM payment_orders orders LEFT JOIN sites ON sites.client_id = orders.api_client_id WHERE orders.order_id = ?`).get(orderId)
                : clientId ? db.prepare("SELECT client_id AS site_id, json_extract(configuration, '$.name') AS site_name FROM sites WHERE client_id = ?").get(clientId) : undefined);
              if (resolved) {
                scope.siteId = String(resolved.site_id); scope.siteName = typeof resolved.site_name === "string" ? resolved.site_name : null;
                scope.subjectType = orderId ? "order" : "website"; scope.subjectId = orderId ?? clientId ?? null;
              }
            }
          } catch { /* No source facts are invented when the observer cannot read them. */ }
          let route = "/unmatched";
          try { const matched = routePath(context, -1); if (matched && matched !== "*") route = matched; } catch { /* Unmatched routes contain no safe identifiers. */ }
          const status = context.res.status;
          options.recorder.record({ action: "http.request", sourceType: "HTTP", occurredAt: startedAt,
            activityId: scope.activityId, requestId: scope.requestId, actorType: scope.actorType, actorId: scope.actorId,
            siteId: scope.siteId, siteName: scope.siteName, sourceAddress: scope.sourceAddress, userAgent: scope.userAgent,
            subjectType: scope.subjectType, subjectId: scope.subjectId,
            httpMethod: context.req.method, route, httpStatus: status, durationMs: Math.max(0, Math.round(performance.now() - started)),
            outcome: status >= 400 ? "FAILURE" : "SUCCESS",
            aggregate: scope.coreEventIds.length === 0 &&
              (["GET", "HEAD"].includes(context.req.method) || (scope.actorType === "ANONYMOUS" && status >= 400)),
            details: scope.errorCode ? { error_code: scope.errorCode } : {}, coreEventIds: coreIds });
        }
      }
    });
  };
}
