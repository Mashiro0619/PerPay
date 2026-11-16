import type { HttpBindings } from "@hono/node-server";
import type { AppConfig } from "../config.ts";
import type { ActivityRecorder } from "../audit/activity.ts";
import { MaintenanceController } from "./controller.ts";
import { runMaintenanceWorker } from "./worker-client.ts";

export interface HostedApplication {
  app: { fetch(request: Request, environment?: Partial<HttpBindings>): Response | Promise<Response> };
  close(): Promise<void>;
  activity?: ActivityRecorder;
}

/** Replaces the whole application after offline maintenance without closing its HTTP listener. */
export async function createApplicationHost(config: AppConfig, start: (maintenance: MaintenanceController) => Promise<HostedApplication>) {
  let activeRequests = 0;
  let drained: (() => void) | null = null;
  let closing = false;
  const waitForRequests = () => activeRequests === 0 ? Promise.resolve() : new Promise<void>(resolve => { drained = resolve; });
  const release = () => {
    activeRequests--;
    if (activeRequests === 0) { drained?.(); drained = null; }
  };
  let current: HostedApplication;
  const maintenance = new MaintenanceController({
    pause: async () => { await waitForRequests(); await current.close(); },
    resume: async () => { current = await start(maintenance); },
    run: (request, progress) => runMaintenanceWorker(request,
      { dataDir: config.dataDir, backupDir: config.backupDir, masterKey: config.masterKey }, progress),
    completed: job => {
      if (maintenance.paused) return;
      current.activity?.record({ action: "maintenance.completed", sourceType: "INTERNAL", actorType: "SYSTEM",
        outcome: job.status === "SUCCEEDED" ? "SUCCESS" : "FAILURE", subjectType: "maintenance", subjectId: job.id,
        details: { kind: job.kind, status: job.status, ...job.result } });
    },
  });
  current = await start(maintenance);
  return {
    maintenance,
    async fetch(request: Request, environment?: Partial<HttpBindings>): Promise<Response> {
      if (closing) return Response.json({ error: { code: "service_stopping", message: "服务正在停止" } }, { status: 503 });
      if (maintenance.paused) return current.app.fetch(request, environment);
      activeRequests++;
      try {
        // Handlers finish their database work before returning. Archive downloads
        // stream an immutable file and do not keep a database connection in use.
        return await current.app.fetch(request, environment);
      } finally { release(); }
    },
    async close(): Promise<void> {
      closing = true;
      await maintenance.settled();
      await waitForRequests();
      await current.close();
    },
  };
}
