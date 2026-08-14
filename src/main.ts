import { serve } from "@hono/node-server";

import { loadConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createApp } from "./http/app.ts";
import { IdentityService } from "./identity/service.ts";
import { OrderService } from "./orders/service.ts";
import { APP_VERSION } from "./version.ts";

const startedAt = new Date();
const config = loadConfig();
const database = await AppDatabase.open(config.databasePath);
const identity = new IdentityService(database, config);
const orders = new OrderService(database, config);
try {
  await identity.initialize();
  orders.initialize();
} catch (error) {
  database.close();
  throw error;
}
const app = createApp({ config, database, identity, orders, startedAt });
let shuttingDown = false;

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "server_started",
        host: info.address,
        port: info.port,
        version: APP_VERSION,
        instance_id: database.instanceId(),
      }),
    );
  },
);

if ("requestTimeout" in server) server.requestTimeout = 30_000;
if ("headersTimeout" in server) server.headersTimeout = 10_000;
if ("keepAliveTimeout" in server) server.keepAliveTimeout = 5_000;
if ("keepAliveTimeoutBuffer" in server) server.keepAliveTimeoutBuffer = 1_000;
if ("maxRequestsPerSocket" in server) server.maxRequestsPerSocket = 1_000;
if ("maxHeadersCount" in server) server.maxHeadersCount = 100;
server.setTimeout(30_000);

server.once("error", (error) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(
    JSON.stringify({
      level: "error",
      event: "server_failed",
      message: error.message,
    }),
  );
  try {
    database.close();
  } catch (closeError) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "database_close_failed",
        message: closeError instanceof Error ? closeError.message : "unknown_error",
      }),
    );
  }
  process.exitCode = 1;
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  server.close((error) => {
    try {
      database.close();
    } finally {
      if (error) {
        console.error(JSON.stringify({ level: "error", event: "shutdown_failed", message: error.message }));
        process.exitCode = 1;
      }
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
