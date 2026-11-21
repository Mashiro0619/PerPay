import { AlipayAccountService } from "./alipay-accounts/service.ts";
import { AlipayAccountStore } from "./alipay-accounts/store.ts";
import { recoverDeletedHistoryArchives } from "./archive/store.ts";
import { ActivityRecorder } from "./audit/activity.ts";
import { ActivitySpoolImporter } from "./audit/spool.ts";
import { createAsyncBackupHealthProvider } from "./backup/health.ts";
import type { AppConfig } from "./config.ts";
import { AppDatabase } from "./database/database.ts";
import { EpayStore } from "./epay/store.ts";
import { createApp } from "./http/app.ts";
import { IdentityService } from "./identity/service.ts";
import { LedgerStore } from "./ledger/index.ts";
import { LedgerRetentionScheduler } from "./ledger/retention-scheduler.ts";
import type { MaintenanceController } from "./maintenance/controller.ts";
import { WebhookStore } from "./notifications/index.ts";
import { OrderService } from "./orders/service.ts";
import { ReconciliationStore } from "./reconciliation/index.ts";
import { RuntimeController } from "./runtime/index.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "./settings/index.ts";
import { APP_VERSION } from "./version.ts";

export interface RunningApplication {
  readonly app: ReturnType<typeof createApp>;
  readonly database: AppDatabase;
  readonly identity: IdentityService;
  readonly activity: ActivityRecorder;
  /** The HTTP host drains its requests before closing the application. */
  close(): Promise<void>;
}

/** Creates a fresh set of services after startup, archiving, or database restore. */
export async function startApplication(
  config: AppConfig,
  maintenance?: MaintenanceController,
): Promise<RunningApplication> {
  const startedAt = new Date();
  const database = await AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
  let activity: ActivityRecorder | undefined;
  let activityImporter: ActivitySpoolImporter | undefined;
  let ledgerRetention: LedgerRetentionScheduler | undefined;
  let runtime: RuntimeController | undefined;
  let backupHealth: ReturnType<typeof createAsyncBackupHealthProvider> | undefined;

  async function stopBackground(): Promise<void> {
    ledgerRetention?.stop();
    const results = await Promise.allSettled([
      runtime?.stop(),
      activityImporter?.stop(),
      backupHealth?.stop(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "application background workers could not be stopped");
  }

  try {
    maintenance?.prepareDatabase(database);
    for (const failure of recoverDeletedHistoryArchives(database, config.dataDir).failed) {
      console.error(JSON.stringify({ level: "error", event: "history_archive_recovery_failed", ...failure }));
    }
    const recorder = new ActivityRecorder({ database });
    activity = recorder;
    const importer = new ActivitySpoolImporter({ database, recorder, backupDirectory: config.backupDir });
    activityImporter = importer;
    const health = createAsyncBackupHealthProvider({
      backupDirectory: config.backupDir,
      dataDirectory: config.dataDir,
      intervalMilliseconds: config.backupIntervalMilliseconds,
    });
    backupHealth = health;
    const identity = new IdentityService(database, config);
    const ledger = new LedgerStore(database);
    const retention = new LedgerRetentionScheduler({
      prune: () => ledger.pruneIngestHistory(),
      onPruned: result => console.log(JSON.stringify({ level: "info", event: "ingest_history_pruned", ...result })),
      onError: error => logError("ingest_history_prune_failed", error),
    });
    ledgerRetention = retention;
    const reconciliation = new ReconciliationStore(database);
    const webhooks = new WebhookStore(database);
    const settingsStore = new RuntimeSettingsStore(database, config.masterKey);
    const accountStore = new AlipayAccountStore(database, config.masterKey);
    const sites = settingsStore.siteStore();
    if (!sites) throw new Error("schema 34 website configuration is required");
    let settings!: RuntimeSettingsService;
    const orders: OrderService = new OrderService(database, () => settings.instanceSnapshot(), undefined, sites, undefined, {
      accounts: () => accountStore.snapshots(), available: id => controller.accountHealth(id).collectionReady,
    });
    const controller = new RuntimeController({
      epay: new EpayStore(database, config.masterKey),
      database,
      activity: recorder,
      orders,
      ledger,
      reconciliation,
      webhooks,
      sites,
      accounts: () => accountStore.snapshots(),
    });
    runtime = controller;
    const alipayAccounts = new AlipayAccountService({
      store: accountStore,
      onMutationStarted: id => controller.beginAccountTransition(id),
      onApplied: id => controller.applyAccounts(id),
      guardProviderSwitch: ({ current }) => controller.assertAccountProviderSwitchAllowed(current),
    });
    settings = new RuntimeSettingsService({
      store: settingsStore,
      alipayAccounts,
      guardProviderSwitch: ({ current, currentProviderAccountKey }) =>
        controller.assertProviderSwitchAllowed(current, currentProviderAccountKey),
      onPaymentMutationStarted: () => controller.beginPaymentTransition(),
      providerHistory: () => ledger.providerIdentityHistory(),
      onCollectionApplied: (collection, providerAccountKey) => {
        orders.syncCollectionProfile(collection, providerAccountKey);
      },
      onApplied: () => controller.apply(settingsStore.instanceSnapshot()),
    });

    await identity.initialize();
    settings.initialize();
    await controller.start(settingsStore.instanceSnapshot());
    recorder.prune();
    recorder.start();
    importer.start();
    retention.start();
    health.start(error => logError("backup_health_check_failed", error));

    const app = createApp({
      config,
      database,
      activity: recorder,
      identity,
      ...(maintenance ? { maintenance } : {}),
      onSetupToken: token => console.log(JSON.stringify({
        level: "info", event: "administrator_setup_required", setup_token: token,
      })),
      settings,
      alipayAccounts,
      accountHealth: id => controller.accountHealth(id),
      sites,
      runtimeStatus: () => controller.status(),
      orders,
      ledger,
      reconciliation,
      startedAt,
      backupHealth: health,
      ledgerHealth: () => controller.ledgerHealth(),
      ledgerNextRunAt: () => controller.ledgerNextRunAt(),
      ledgerManualScan: (accountId?: string) => controller.ledgerManualScan(accountId),
      requestLedgerScan: (accountId?: string) => controller.requestLedgerScan(accountId),
      reconciliationHealth: () => controller.reconciliationHealth(),
      webhookStore: webhooks,
      webhookHealth: () => controller.webhookHealth(),
      onWebhookAvailable: () => controller.triggerWebhook("http"),
      retryWebhookDelivery: input => controller.retryWebhookDelivery(input),
      checkoutVerification: orderId => controller.checkoutVerification(orderId),
      requestCheckoutVerification: orderId => controller.requestCheckoutVerification(orderId),
      onOrderAvailable: orderId => {
        void controller.triggerOrder(orderId).catch((error: unknown) => logError("reconciliation_order_trigger_failed", error));
      },
    });
    recorder.record({ action: "system.started", sourceType: "INTERNAL", actorType: "SYSTEM",
      subjectType: "instance", subjectId: database.instanceId(), details: { version: APP_VERSION } });

    let closing: Promise<void> | undefined;
    return {
      app, database, identity, activity: recorder,
      close() {
        closing ??= (async () => {
          recorder.record({ action: "system.stopping", sourceType: "INTERNAL", actorType: "SYSTEM" });
          await stopBackground();
          recorder.record({ action: "system.stopped", sourceType: "INTERNAL", actorType: "SYSTEM" });
          recorder.stop();
          database.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    activity?.record({ action: "system.start_failed", sourceType: "INTERNAL", actorType: "SYSTEM", outcome: "FAILURE" });
    try {
      await stopBackground();
    } catch (stopError) {
      throw new AggregateError([error, stopError], "application startup failed and background workers could not be stopped");
    }
    activity?.stop();
    database.close();
    throw error;
  }
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", event, message: error instanceof Error ? error.message : "unknown_error" }));
}
