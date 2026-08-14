import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import { APP_VERSION } from "../version.ts";

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: AppDatabase;
  readonly startedAt: Date;
}

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    context.header("x-request-id", requestId);
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    context.header("cache-control", "no-store");
    await next();
  });

  app.get("/livez", (context) =>
    context.json({
      status: "alive",
      version: APP_VERSION,
      uptime_seconds: Math.floor((Date.now() - dependencies.startedAt.getTime()) / 1000),
    }),
  );

  app.get("/readyz", (context) => {
    const database = dependencies.database.health();
    const ready = database.ok;
    return context.json(
      {
        status: ready ? "ready" : "not_ready",
        checks: { database },
      },
      ready ? 200 : 503,
    );
  });

  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "route_not_found",
          message: "请求的资源不存在",
        },
      },
      404,
    ),
  );

  app.onError((error, context) => {
    console.error(JSON.stringify({ level: "error", event: "http_request_failed", message: error.message }));
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "服务器处理请求失败",
        },
      },
      500,
    );
  });

  return app;
}
