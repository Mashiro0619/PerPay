import { DockerClient } from "./docker-client.ts";
import { createUpdaterServer, ensureUpdaterToken, UpdaterOrchestrator } from "./updater-core.ts";

const host = process.env.PERPAY_UPDATER_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PERPAY_UPDATER_PORT ?? "6199");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PERPAY_UPDATER_PORT must be a valid TCP port");
}

const composeProject = process.env.PERPAY_COMPOSE_PROJECT?.trim() || "perpay";
const socketPath = process.env.PERPAY_DOCKER_SOCKET?.trim() || "/var/run/docker.sock";
const token = process.env.PERPAY_UPDATER_TOKEN?.trim()
  || ensureUpdaterToken(process.env.PERPAY_UPDATER_TOKEN_FILE?.trim() || "/run/perpay-updater-secrets/token");

const docker = new DockerClient({ socketPath });
const orchestrator = new UpdaterOrchestrator({ docker, composeProject });
const server = createUpdaterServer({
  orchestrator,
  token,
  pingDocker: () => docker.ping(),
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "updater_started",
    host,
    port,
    compose_project: composeProject,
  }));
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", event: "updater_stopping", signal }));
  await orchestrator.settled().catch(() => undefined);
  await new Promise<void>(resolve => { server.close(() => resolve()); });
}

process.once("SIGINT", signal => { void shutdown(signal); });
process.once("SIGTERM", signal => { void shutdown(signal); });
