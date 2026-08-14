import { serve } from "@hono/node-server";

import { loadConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createApp } from "./http/app.ts";
import { APP_VERSION } from "./version.ts";

const startedAt = new Date();
const config = loadConfig();
const database = await AppDatabase.open(config.databasePath);
const app = createApp({ config, database, startedAt });

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

let shuttingDown = false;
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
