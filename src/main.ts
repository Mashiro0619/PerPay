import { serve } from "@hono/node-server";
import { EpayStore } from "./epay/store.ts";
import { AlipayAccountStore } from "./alipay-accounts/store.ts";
import { AlipayAccountService } from "./alipay-accounts/service.ts";

import { createAsyncBackupHealthProvider } from "./backup/health.ts";
import { loadConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createApp } from "./http/app.ts";
import { IdentityService } from "./identity/service.ts";
import { hardenProcessFileCreation } from "./infrastructure/storage/permissions.ts";
import { LedgerStore } from "./ledger/index.ts";
import { LedgerRetentionScheduler } from "./ledger/retention-scheduler.ts";
import { WebhookStore } from "./notifications/index.ts";
import { OrderService } from "./orders/service.ts";
import { ReconciliationStore } from "./reconciliation/index.ts";
import { RuntimeController } from "./runtime/index.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "./settings/index.ts";
import { APP_VERSION } from "./version.ts";
import { ActivityRecorder } from "./audit/activity.ts";
import { ActivitySpoolImporter } from "./audit/spool.ts";

hardenProcessFileCreation();
const startedAt = new Date();
const config = loadConfig();
const backupHealth = createAsyncBackupHealthProvider({
  backupDirectory: config.backupDir,
  dataDirectory: config.dataDir,
  intervalMilliseconds: config.backupIntervalMilliseconds,
});
const database = await AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
const activity = new ActivityRecorder({ database });
const activityImporter = new ActivitySpoolImporter({ database, recorder: activity, backupDirectory: config.backupDir });
const identity = new IdentityService(database, config);
const ledger = new LedgerStore(database);
const ledgerRetention = new LedgerRetentionScheduler({
  prune: () => ledger.pruneIngestHistory(),
  onPruned: result => console.log(JSON.stringify({ level: "info", event: "ingest_history_pruned", ...result })),
  onError: error => logError("ingest_history_prune_failed", error),
});
const reconciliation = new ReconciliationStore(database);
const webhooks = new WebhookStore(database);
const settingsStore = new RuntimeSettingsStore(database, config.masterKey);
const accountStore = new AlipayAccountStore(database, config.masterKey);
const sites = settingsStore.siteStore();
if (!sites) throw new Error("schema 34 website configuration is required");
let settings!: RuntimeSettingsService;
const orders: OrderService = new OrderService(database, () => settings.instanceSnapshot(), undefined, sites, undefined, {
  accounts: () => accountStore.snapshots(), available: id => runtime.accountHealth(id).collectionReady,
});
const runtime: RuntimeController = new RuntimeController({
  epay: new EpayStore(database, config.masterKey),
  database,
  activity,
  orders,
  ledger,
  reconciliation,
  webhooks,
  sites,
  accounts: () => accountStore.snapshots(),
});
const alipayAccounts = new AlipayAccountService({
  store: accountStore,
  onMutationStarted: id => runtime.beginAccountTransition(id),
  onApplied: id => runtime.applyAccounts(id),
  guardProviderSwitch: ({ current }) => runtime.assertAccountProviderSwitchAllowed(current),
});
settings = new RuntimeSettingsService({
  store: settingsStore,
  alipayAccounts,
  guardProviderSwitch: ({ current, currentProviderAccountKey }) =>
    runtime.assertProviderSwitchAllowed(current, currentProviderAccountKey),
  onPaymentMutationStarted: () => runtime.beginPaymentTransition(),
  providerHistory: () => ledger.providerIdentityHistory(),
  onCollectionApplied: (collection, providerAccountKey) => {
    orders.syncCollectionProfile(collection, providerAccountKey);
  },
  onApplied: (snapshot) => runtime.apply(settingsStore.siteStore() ? settingsStore.instanceSnapshot() : snapshot),
});

try {
  await identity.initialize();
  const snapshot = settings.initialize();
  await runtime.start(settingsStore.siteStore() ? settingsStore.instanceSnapshot() : snapshot);
  activity.prune();
  activity.start();
  activityImporter.start();
  ledgerRetention.start();
  backupHealth.start(error => logError("backup_health_check_failed", error));
} catch (error) {
  activity.record({ action: "system.start_failed", sourceType: "INTERNAL", actorType: "SYSTEM", outcome: "FAILURE" });
  activity.stop();
  database.close();
  throw error;
}

const app = createApp({
  config,
  database,
  activity,
  identity,
  onSetupToken: (token) => {
    console.log(JSON.stringify({
      level: "info",
      event: "administrator_setup_required",
      setup_token: token,
    }));
  },
  settings,
  alipayAccounts,
  accountHealth: id => runtime.accountHealth(id),
  sites,
  runtimeStatus: () => runtime.status(),
  orders,
  ledger,
  reconciliation,
  startedAt,
  backupHealth,
  ledgerHealth: () => runtime.ledgerHealth(),
  ledgerNextRunAt: () => runtime.ledgerNextRunAt(),
  ledgerManualScan: (accountId?: string) => runtime.ledgerManualScan(accountId),
  requestLedgerScan: (accountId?: string) => runtime.requestLedgerScan(accountId),
  reconciliationHealth: () => runtime.reconciliationHealth(),
  webhookStore: webhooks,
  webhookHealth: () => runtime.webhookHealth(),
  onWebhookAvailable: () => runtime.triggerWebhook("http"),
  checkoutVerification: (orderId) => runtime.checkoutVerification(orderId),
  requestCheckoutVerification: (orderId) => runtime.requestCheckoutVerification(orderId),
  onOrderAvailable: (orderId) => {
    void runtime.triggerOrder(orderId).catch((error: unknown) => {
      logError("reconciliation_order_trigger_failed", error);
    });
  },
});

let shuttingDown = false;
let databaseClosed = false;
let backgroundShutdownFailed = false;
const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    activity.record({ action: "system.started", sourceType: "INTERNAL", actorType: "SYSTEM", subjectType: "instance", subjectId: database.instanceId(), details: { version: APP_VERSION } });
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
  activity.record({ action: "system.failed", sourceType: "INTERNAL", actorType: "SYSTEM", outcome: "FAILURE" });
  void stopBackground().finally(() => {
    closeDatabase();
    process.exitCode = 1;
  });
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  activity.record({ action: "system.stopping", sourceType: "INTERNAL", actorType: "SYSTEM", details: { signal } });
  const backgroundTasksStopped = stopBackground();
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
    // Called only after the listener has drained and background work has stopped.
    // Keep capture alive until the final in-flight HTTP response has been recorded.
    activity.record({ action: "system.stopped", sourceType: "INTERNAL", actorType: "SYSTEM", outcome: backgroundShutdownFailed ? "FAILURE" : "SUCCESS" });
    activity.stop();
    database.close();
  } catch (error) {
    logError("database_close_failed", error);
  }
}

async function stopBackground(): Promise<void> {
  ledgerRetention.stop();
  const stopped = await Promise.allSettled([runtime.stop(), activityImporter.stop(), backupHealth.stop()]);
  const failure = stopped.find(result => result.status === "rejected");
  if (failure?.status === "rejected") { backgroundShutdownFailed = true; logError("background_shutdown_failed", failure.reason); process.exitCode = 1; }
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
