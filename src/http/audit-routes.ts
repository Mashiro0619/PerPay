// SPDX-License-Identifier: MIT
import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import type { AppDatabase } from "../database/database.ts";
import {
  AuditQueryError, exportAuditEvents, projectAuditCaptureState, queryAuditEvent,
  queryAuditEvents, queryAuditMetadata, readAuditPageQuery, type AuditExportSummary,
  type RawAuditCaptureState,
} from "../audit/query.ts";
import { ListQueryError } from "../shared/list-query.ts";
import { currentAuditContext } from "../audit/context.ts";

export interface AuditRouteDependencies<E extends Env> {
  readonly database: Pick<AppDatabase, "read">;
  readonly adminSession: MiddlewareHandler<E>;
  /** Same-origin/CSRF/current-session checks; exports also work in the isolated demo. */
  readonly exportGuard: MiddlewareHandler<E>;
  /** Use the application's bounded strict-JSON reader with auditExportSchema. */
  readonly readExportBody: (context: Context<E>) => Promise<unknown>;
  /** Must complete before any CSV response is returned; failure suppresses the download. */
  readonly onExportGenerated: (context: Context<E>, summary: AuditExportSummary) => void | Promise<void>;
  /** Read the live collector, since a failed database write cannot update persisted status. */
  readonly captureState?: (() => RawAuditCaptureState | null | undefined | Promise<RawAuditCaptureState | null | undefined>) | undefined;
  readonly clock?: (() => number) | undefined;
}

export function mountAuditRoutes<E extends Env>(app: Hono<E>, dependencies: AuditRouteDependencies<E>): void {
  const { database, adminSession } = dependencies;
  const now = dependencies.clock ?? Date.now;
  const guarded = (operation: (context: Context<E>) => Response | Promise<Response>) => async (context: Context<E>): Promise<Response> => {
    context.header("Cache-Control", "no-store");
    try { return await operation(context); } catch (error) {
      if (error instanceof AuditQueryError || error instanceof ListQueryError) {
        const code = error instanceof AuditQueryError ? error.code : "validation_failed";
        const scope = currentAuditContext();
        if (scope) scope.errorCode = code;
        return context.json({ error: { code,
          message: error.message, request_id: context.res.headers.get("x-request-id") ?? "" } }, error instanceof AuditQueryError ? error.status : 422);
      }
      throw error;
    }
  };
  const noQuery = (context: Context<E>): void => {
    if (new URL(context.req.url).searchParams.size !== 0) throw new ListQueryError("该审计接口不接受查询参数");
  };
  app.get("/api/admin/v1/audit-events", adminSession, guarded(context => {
    const query = readAuditPageQuery(new URL(context.req.url).searchParams);
    return context.json(queryAuditEvents(database, query, now()));
  }));
  app.get("/api/admin/v1/audit-events/meta", adminSession, guarded(async context => {
    noQuery(context);
    const capture = projectAuditCaptureState(await dependencies.captureState?.());
    return context.json({ data: queryAuditMetadata(database, capture, now()) });
  }));
  app.post("/api/admin/v1/audit-events/export", adminSession, dependencies.exportGuard, guarded(async context => {
    noQuery(context);
    const input = await dependencies.readExportBody(context);
    const generated = exportAuditEvents(database, input, now());
    await dependencies.onExportGenerated(context, generated.summary);
    return context.body(generated.csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="perpay-audit.csv"',
      "Cache-Control": "no-store",
    });
  }));
  app.get("/api/admin/v1/audit-events/:source/:event_id", adminSession, guarded(context => {
    noQuery(context);
    return context.json({ data: queryAuditEvent(database, context.req.param("source")!, context.req.param("event_id")!, now()) });
  }));
}
