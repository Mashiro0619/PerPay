import { serve, type HttpBindings } from "@hono/node-server";
import { startApplication } from "./application.ts";
import { loadConfig } from "./config.ts";
import { hardenProcessFileCreation } from "./infrastructure/storage/permissions.ts";
import { createApplicationHost } from "./maintenance/host.ts";
import { APP_VERSION } from "./version.ts";

hardenProcessFileCreation();
const config = loadConfig();
const application = await createApplicationHost(config, maintenance => startApplication(config, maintenance));
let shuttingDown = false;
const server = serve({ fetch: (request, environment) => application.fetch(request, environment as HttpBindings), hostname: config.host, port: config.port }, info => {
  console.log(JSON.stringify({ level: "info", event: "server_started", host: info.address, port: info.port, version: APP_VERSION }));
});

if ("requestTimeout" in server) server.requestTimeout = 30_000;
if ("headersTimeout" in server) server.headersTimeout = 10_000;
if ("keepAliveTimeout" in server) server.keepAliveTimeout = 5_000;
if ("keepAliveTimeoutBuffer" in server) server.keepAliveTimeoutBuffer = 1_000;
if ("maxRequestsPerSocket" in server) server.maxRequestsPerSocket = 1_000;
if ("maxHeadersCount" in server) server.maxHeadersCount = 100;
server.setTimeout(30_000);

server.once("error", error => {
  logError("server_failed", error);
  void shutdown();
});

async function shutdown(signal?: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  try {
    // Stop admitting new business traffic immediately while keeping paused maintenance
    // progress readable until any in-flight maintenance job completes cleanly.
    application.beginShutdown();
    await application.maintenance.settled();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      });
    } finally { await application.close(); }
  } catch (error) { logError("shutdown_failed", error); }
}

function logError(event: string, error: unknown): void {
  process.exitCode = 1;
  console.error(JSON.stringify({ level: "error", event, message: error instanceof Error ? error.message : "unknown_error" }));
}
process.once("SIGINT", signal => { void shutdown(signal); });
process.once("SIGTERM", signal => { void shutdown(signal); });
