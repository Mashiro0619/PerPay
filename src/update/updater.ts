import { DockerClient } from "./docker-client.ts";
import {
  createUpdaterServer,
  ensureUpdaterToken,
  isValidUpdaterToken,
  resolveComposeProject,
  UpdaterOrchestrator,
} from "./updater-core.ts";

const host = process.env.PERPAY_UPDATER_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PERPAY_UPDATER_PORT ?? "6199");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PERPAY_UPDATER_PORT must be a valid TCP port");
}

const socketPath = process.env.PERPAY_DOCKER_SOCKET?.trim() || "/var/run/docker.sock";
const configuredToken = process.env.PERPAY_UPDATER_TOKEN?.trim();
if (configuredToken !== undefined && configuredToken !== "" && !isValidUpdaterToken(configuredToken)) {
  throw new Error("PERPAY_UPDATER_TOKEN must be 32-256 non-whitespace printable ASCII characters");
}
const token = configuredToken || ensureUpdaterToken(
  process.env.PERPAY_UPDATER_TOKEN_FILE?.trim() || "/run/perpay-updater-secrets/token",
);

function parseOptionalPositiveIntEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

const healthTimeoutSeconds = parseOptionalPositiveIntEnv("PERPAY_UPDATER_HEALTH_TIMEOUT_SECONDS", 30, 7200);
const stopTimeoutSeconds = parseOptionalPositiveIntEnv("PERPAY_UPDATER_STOP_TIMEOUT_SECONDS", 10, 86400);
const rollbackRestoreTimeoutSeconds = parseOptionalPositiveIntEnv("PERPAY_UPDATER_ROLLBACK_RESTORE_TIMEOUT_SECONDS", 60, 21600);

const docker = new DockerClient({ socketPath });
const composeProject = await resolveComposeProject(docker, process.env.PERPAY_COMPOSE_PROJECT);
const orchestrator = new UpdaterOrchestrator({
  docker,
  composeProject,
  ...(healthTimeoutSeconds !== undefined ? { healthTimeoutMilliseconds: healthTimeoutSeconds * 1_000 } : {}),
  ...(stopTimeoutSeconds !== undefined ? { stopTimeoutSeconds } : {}),
  ...(rollbackRestoreTimeoutSeconds !== undefined ? { rollbackRestoreTimeoutMilliseconds: rollbackRestoreTimeoutSeconds * 1_000 } : {}),
});
const server = createUpdaterServer({
  orchestrator,
  token,
  pingDocker: () => docker.ping(),
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

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
  const forceClose = setTimeout(() => { server.closeAllConnections(); }, 5_000);
  forceClose.unref();
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  clearTimeout(forceClose);
}

process.once("SIGINT", signal => { void shutdown(signal); });
process.once("SIGTERM", signal => { void shutdown(signal); });
