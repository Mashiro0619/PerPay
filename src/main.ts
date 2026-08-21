import { serve } from "@hono/node-server";

import { createAsyncBackupHealthProvider } from "./backup/health.ts";
import { loadConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createApp } from "./http/app.ts";
import { IdentityService } from "./identity/service.ts";
import { hardenProcessFileCreation } from "./infrastructure/storage/permissions.ts";
import { LedgerStore } from "./ledger/index.ts";
import { WebhookStore } from "./notifications/index.ts";
import { OrderService } from "./orders/service.ts";
import { ReconciliationStore } from "./reconciliation/index.ts";
import { RuntimeController } from "./runtime/index.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "./settings/index.ts";
import { APP_VERSION } from "./version.ts";

hardenProcessFileCreation();
const startedAt = new Date();
const config = loadConfig();
const backupHealth = createAsyncBackupHealthProvider({
  backupDirectory: config.backupDir,
  dataDirectory: config.dataDir,
  intervalMilliseconds: config.backupIntervalMilliseconds,
});
const database = await AppDatabase.open(config.databasePath);
const identity = new IdentityService(database, config);
const ledger = new LedgerStore(database);
const reconciliation = new ReconciliationStore(database);
const webhooks = new WebhookStore(database);
const settingsStore = new RuntimeSettingsStore(database, config.masterKey);
let settings!: RuntimeSettingsService;
const orders = new OrderService(database, () => settings.snapshot());
const runtime = new RuntimeController({
  database,
  orders,
  ledger,
  reconciliation,
  webhooks,
});
settings = new RuntimeSettingsService({
  store: settingsStore,
  guardProviderSwitch: ({ current, currentProviderAccountKey }) =>
    runtime.assertProviderSwitchAllowed(current, currentProviderAccountKey),
  onPaymentMutationStarted: () => runtime.beginPaymentTransition(),
  providerHistory: () => ledger.providerIdentityHistory(),
  onCollectionApplied: (collection, providerAccountKey) => {
    orders.syncCollectionProfile(collection, providerAccountKey);
  },
  onApplied: (snapshot) => runtime.apply(snapshot),
});

try {
  await identity.initialize();
  const snapshot = settings.initialize();
  await runtime.start(snapshot);
} catch (error) {
  database.close();
  throw error;
}

const app = createApp({
  config,
  database,
  identity,
  settings,
  runtimeStatus: () => runtime.status(),
  orders,
  ledger,
  reconciliation,
  startedAt,
  backupHealth,
  ledgerHealth: () => runtime.ledgerHealth(),
  reconciliationHealth: () => runtime.reconciliationHealth(),
  webhookStore: webhooks,
  webhookHealth: () => runtime.webhookHealth(),
  onWebhookAvailable: () => runtime.triggerWebhook("http"),
  onOrderAvailable: (orderId) => {
    void runtime.triggerOrder(orderId).catch((error: unknown) => {
      logError("reconciliation_order_trigger_failed", error);
    });
  },
});

let shuttingDown = false;
let databaseClosed = false;
const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(JSON.stringify({
      level: "info",
      event: "server_started",
      host: info.address,
      port: info.port,
      version: APP_VERSION,
      instance_id: database.instanceId(),
    }));
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
  logError("server_failed", error);
  void runtime.stop().finally(() => {
    closeDatabase();
    process.exitCode = 1;
  });
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  const backgroundTasksStopped = runtime.stop();
  let finalized = false;
  const finalize = (error?: Error) => {
    if (finalized) return;
    finalized = true;
    void backgroundTasksStopped.finally(() => {
      closeDatabase();
      if (error) {
        logError("shutdown_failed", error);
        process.exitCode = 1;
      }
    });
  };
  try {
    server.close((error) => finalize(error ?? undefined));
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  } catch (error) {
    finalize(error instanceof Error ? error : new Error("HTTP server shutdown failed"));
  }
}

function closeDatabase(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  try {
    database.close();
  } catch (error) {
    logError("database_close_failed", error);
  }
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    message: error instanceof Error ? error.message : "unknown_error",
  }));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
