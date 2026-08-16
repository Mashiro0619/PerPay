import { serve } from "@hono/node-server";

import { loadConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { createApp } from "./http/app.ts";
import { IdentityService } from "./identity/service.ts";
import {
  AlipayLedgerProvider,
  NodeV3Transport,
  DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
} from "./infrastructure/alipay/index.ts";
import {
  LedgerIngestScheduler,
  LedgerIngestService,
  LedgerStore,
  LEDGER_PROVIDER_ACCOUNT_KEY,
  LEDGER_PROVIDER_KIND,
  type LedgerSchedulerHealth,
} from "./ledger/index.ts";
import { OrderService } from "./orders/service.ts";
import {
  ReconciliationScheduler,
  ReconciliationStore,
  type ReconciliationSchedulerHealth,
} from "./reconciliation/index.ts";
import {
  NodeWebhookTransport,
  WebhookDeliveryService,
  WebhookScheduler,
  WebhookStore,
  type WebhookSchedulerHealth,
} from "./notifications/index.ts";
import { APP_VERSION } from "./version.ts";
import { hardenProcessFileCreation } from "./infrastructure/storage/permissions.ts";

// Apply before configuration loading and every runtime file-creation path.
hardenProcessFileCreation();
const startedAt = new Date();
const config = loadConfig();
const database = await AppDatabase.open(config.databasePath);
const identity = new IdentityService(database, config);
const orders = new OrderService(database, config);
const ledger = new LedgerStore(database);
const reconciliation = new ReconciliationStore(database);
const webhooks = new WebhookStore(database);
let ledgerScheduler: LedgerIngestScheduler | null = null;
let reconciliationScheduler: ReconciliationScheduler | null = null;
let webhookScheduler: WebhookScheduler | null = null;
try {
  reconciliationScheduler = createReconciliationScheduler();
  ledgerScheduler = createLedgerScheduler();
  webhookScheduler = createWebhookScheduler();
  await identity.initialize();
  orders.initialize();
} catch (error) {
  database.close();
  throw error;
}
const app = createApp({
  config,
  database,
  identity,
  orders,
  ledger,
  reconciliation,
  startedAt,
  ledgerHealth: () => ledgerHealth(ledgerScheduler),
  reconciliationHealth: () => reconciliationHealth(reconciliationScheduler),
  webhookStore: webhooks,
  webhookHealth: () => webhookHealth(webhookScheduler),
  onWebhookAvailable: () => triggerWebhookDelivery("http"),
  onOrderAvailable: (orderId) => {
    void triggerOrderReconciliation(orderId);
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
    void reconciliationScheduler?.start().catch((error: unknown) => {
      logReconciliationError("reconciliation_start_failed", error);
    });
    ledgerScheduler?.start();
    void webhookScheduler?.start().catch((error: unknown) => {
      logWebhookError("webhook_scheduler_start_failed", error);
    });
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
  void stopBackgroundTasks().finally(() => {
    closeDatabase();
    process.exitCode = 1;
  });
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  const backgroundTasksStopped = stopBackgroundTasks();
  let finalized = false;
  const finalize = (error?: Error) => {
    if (finalized) return;
    finalized = true;
    void backgroundTasksStopped.finally(() => {
      closeDatabase();
      if (error) {
        console.error(JSON.stringify({ level: "error", event: "shutdown_failed", message: error.message }));
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

function createLedgerScheduler(): LedgerIngestScheduler | null {
  if (!config.alipay.enabled) return null;
  const transport = new NodeV3Transport({ endpoint: config.alipay.endpoint });
  const provider = new AlipayLedgerProvider({
    appId: config.alipay.appId,
    privateKey: config.alipay.privateKey,
    alipayPublicKey: config.alipay.alipayPublicKey,
    transport,
    timeoutMilliseconds: config.alipay.timeoutMilliseconds,
    pageSize: DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
  });
  ledger.bindProviderIdentity({
    providerAccountKey: LEDGER_PROVIDER_ACCOUNT_KEY,
    providerKind: LEDGER_PROVIDER_KIND,
    endpoint: config.alipay.endpoint,
    externalAccountId: config.alipay.appId,
  });
  const service = new LedgerIngestService({
    provider,
    store: ledger,
    providerAccountKey: LEDGER_PROVIDER_ACCOUNT_KEY,
    pageSize: DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
    overlapMilliseconds: 5 * 60 * 1_000,
    windowMilliseconds: 24 * 60 * 60 * 1_000,
    safetyLagMilliseconds: 30 * 1_000,
    maxRequestsPerRun: 32,
  });
  return new LedgerIngestScheduler({
    service,
    intervalMilliseconds: config.alipay.scanIntervalMilliseconds,
    onResult: (result, health) => {
      console.log(JSON.stringify({
        level: result.status === "FAILED" ? "warn" : "info",
        event: "ledger_scan_finished",
        status: result.status,
        reason: result.reason,
        ingest_run_id: result.ingestRunId,
        pages: result.pages,
        details: result.details,
        created_entries: result.createdEntries,
        isolated_details: result.isolatedDetails,
        conflicts: result.conflicts,
        error_code: result.errorCode,
        consecutive_failures: health.consecutiveFailures,
      }));
      void triggerReconciliationSweep("ledger_scan");
    },
    onUnexpectedError: (error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "ledger_scheduler_failed",
        error_type: error instanceof Error ? error.name : "unknown_error",
      }));
    },
  });
}

function createReconciliationScheduler(): ReconciliationScheduler {
  return new ReconciliationScheduler({
    store: reconciliation,
    intervalMilliseconds: 60_000,
    batchSize: 64,
    maximumEntriesPerRun: 1_024,
    onResult: (result, health) => {
      console.log(JSON.stringify({
        level: result.failures === 0 ? "info" : "warn",
        event: "reconciliation_finished",
        reason: result.reason,
        processed_entries: result.processedEntries,
        processed_orders: result.processedOrders,
        failures: result.failures,
        continuation_pending: result.continuationPending,
        consecutive_failures: health.consecutiveFailures,
      }));
    },
    onEntryError: (error, ledgerEntryId) => {
      console.error(JSON.stringify({
        level: "error",
        event: "reconciliation_entry_failed",
        ledger_entry_id: ledgerEntryId,
        error_type: error instanceof Error ? error.name : "unknown_error",
      }));
    },
    onOrderError: (error, orderId) => {
      console.error(JSON.stringify({
        level: "error",
        event: "reconciliation_order_failed",
        order_id: orderId,
        error_type: error instanceof Error ? error.name : "unknown_error",
      }));
    },
  });
}

function createWebhookScheduler(): WebhookScheduler | null {
  if (!config.webhook.enabled) return null;
  const key = webhooks.syncSigningKey({
    secretFingerprint: config.webhook.signingKeyFingerprint,
    now: Date.now(),
  });
  if (key.secretFingerprint !== config.webhook.signingKeyFingerprint) {
    throw new Error("webhook signing key synchronization failed");
  }
  const transport = new NodeWebhookTransport(config.webhook.allowedOrigin);
  const service = new WebhookDeliveryService({
    store: webhooks,
    config: config.webhook,
    transport,
  });
  return new WebhookScheduler({
    service,
    store: webhooks,
    intervalMilliseconds: 1_000,
    maximumDeliveriesPerRun: 32,
    onResult: (result, health) => {
      if (result.reason === "scheduled" && result.processed === 0) return;
      console.log(JSON.stringify({
        level: health.state === "degraded" ? "warn" : "info",
        event: "webhook_delivery_finished",
        reason: result.reason,
        processed: result.processed,
        acknowledged: result.acknowledged,
        failed: result.failed,
        pending: result.pending,
        dead_letters: health.deadLetters,
      }));
    },
    onUnexpectedError: (error) => {
      logWebhookError("webhook_scheduler_failed", error);
    },
  });
}

function ledgerHealth(
  scheduler: LedgerIngestScheduler | null,
): LedgerSchedulerHealth & { readonly enabled: boolean } {
  if (scheduler) return { enabled: true, ...scheduler.health() };
  return {
    enabled: false,
    state: "idle",
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
  };
}

function reconciliationHealth(
  scheduler: ReconciliationScheduler | null,
): ReconciliationSchedulerHealth & { readonly enabled: boolean } {
  if (scheduler) return { enabled: true, ...scheduler.health() };
  return {
    enabled: false,
    state: "idle",
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    pendingOrders: 0,
    continuationPending: false,
  };
}

function webhookHealth(scheduler: WebhookScheduler | null): WebhookSchedulerHealth {
  if (scheduler) return scheduler.health();
  const counts = webhooks.counts();
  return {
    enabled: false,
    state: "idle",
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    pendingDeliveries: counts.pending,
    deadLetters: counts.dead,
  };
}

async function triggerOrderReconciliation(orderId: string): Promise<void> {
  try {
    await reconciliationScheduler?.triggerOrder(orderId);
  } catch (error) {
    logReconciliationError("reconciliation_order_trigger_failed", error);
  }
}

async function triggerReconciliationSweep(reason: string): Promise<void> {
  try {
    await reconciliationScheduler?.triggerSweep(reason);
  } catch (error) {
    logReconciliationError("reconciliation_sweep_trigger_failed", error);
  }
}

async function triggerWebhookDelivery(reason: string): Promise<void> {
  try {
    await webhookScheduler?.trigger(reason);
  } catch (error) {
    logWebhookError("webhook_delivery_trigger_failed", error);
  }
}

async function stopBackgroundTasks(): Promise<void> {
  const results = await Promise.allSettled([
    ledgerScheduler?.stop() ?? Promise.resolve(),
    reconciliationScheduler?.stop() ?? Promise.resolve(),
    webhookScheduler?.stop() ?? Promise.resolve(),
  ]);
  const taskNames = ["ledger", "reconciliation", "webhook"] as const;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    console.error(JSON.stringify({
      level: "error",
      event: "background_task_stop_failed",
      task: taskNames[index],
      error_type: result.reason instanceof Error ? result.reason.name : "unknown_error",
    }));
  }
}

function logReconciliationError(event: string, error: unknown): void {
  if (shuttingDown) return;
  console.error(JSON.stringify({
    level: "error",
    event,
    error_type: error instanceof Error ? error.name : "unknown_error",
  }));
}

function logWebhookError(event: string, error: unknown): void {
  if (shuttingDown) return;
  console.error(JSON.stringify({
    level: "error",
    event,
    error_type: error instanceof Error ? error.name : "unknown_error",
  }));
}

function closeDatabase(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  try {
    database.close();
  } catch (closeError) {
    console.error(JSON.stringify({
      level: "error",
      event: "database_close_failed",
      message: closeError instanceof Error ? closeError.message : "unknown_error",
    }));
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
