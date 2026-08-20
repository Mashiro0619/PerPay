import type { AppDatabase } from "../database/database.ts";
import {
  AlipayLedgerProvider,
  DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
  NodeV3Transport,
} from "../infrastructure/alipay/index.ts";
import {
  LedgerIngestScheduler,
  LedgerIngestService,
  type LedgerSchedulerHealth,
  type LedgerStore,
} from "../ledger/index.ts";
import {
  NodeWebhookTransport,
  WebhookDeliveryService,
  WebhookScheduler,
  type WebhookSchedulerHealth,
  type WebhookStore,
} from "../notifications/index.ts";
import type { OrderService } from "../orders/service.ts";
import {
  ReconciliationScheduler,
  type ReconciliationSchedulerHealth,
  type ReconciliationStore,
} from "../reconciliation/index.ts";
import type { RuntimeSettingsSnapshot } from "../settings/model.ts";
import { SettingsError } from "../settings/store.ts";

export interface RevisionedLedgerHealth extends LedgerSchedulerHealth {
  readonly enabled: boolean;
  readonly paymentRevision: number | null;
}

export interface RevisionedReconciliationHealth extends ReconciliationSchedulerHealth {
  readonly enabled: boolean;
  readonly paymentRevision: number | null;
}

export interface PaymentRuntimeStatus {
  readonly configured: boolean;
  readonly transitioning: boolean;
  readonly paymentRevision: number;
  readonly activeProviderAccountKey: string | null;
  readonly scanIntervalMilliseconds: number | null;
  readonly maximumSuccessAgeMilliseconds: number | null;
}

interface RuntimeControllerOptions {
  readonly database: AppDatabase;
  readonly orders: OrderService;
  readonly ledger: LedgerStore;
  readonly reconciliation: ReconciliationStore;
  readonly webhooks: WebhookStore;
  readonly clock?: (() => number) | undefined;
}

const disabledLedgerHealth: RevisionedLedgerHealth = Object.freeze({
  enabled: false,
  paymentRevision: null,
  state: "idle",
  inFlight: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
});

const disabledReconciliationHealth: RevisionedReconciliationHealth = Object.freeze({
  enabled: false,
  paymentRevision: null,
  state: "idle",
  inFlight: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
  pendingOrders: 0,
  continuationPending: false,
});

/** Owns every background worker that depends on mutable business settings. */
export class RuntimeController {
  readonly #database: AppDatabase;
  readonly #orders: OrderService;
  readonly #ledger: LedgerStore;
  readonly #reconciliation: ReconciliationStore;
  readonly #webhooks: WebhookStore;
  readonly #clock: () => number;
  #ledgerScheduler: LedgerIngestScheduler | null = null;
  #reconciliationScheduler: ReconciliationScheduler | null = null;
  #webhookScheduler: WebhookScheduler | null = null;
  #snapshot: RuntimeSettingsSnapshot | null = null;
  #ledgerRevision: number | null = null;
  #reconciliationRevision: number | null = null;
  #pausedLedgerHealth: RevisionedLedgerHealth | null = null;
  #pausedReconciliationHealth: RevisionedReconciliationHealth | null = null;
  #started = false;
  #stopped = false;
  #transitioning = false;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: RuntimeControllerOptions) {
    this.#database = options.database;
    this.#orders = options.orders;
    this.#ledger = options.ledger;
    this.#reconciliation = options.reconciliation;
    this.#webhooks = options.webhooks;
    this.#clock = options.clock ?? (() => Date.now());
  }

  start(snapshot: RuntimeSettingsSnapshot): Promise<void> {
    if (this.#started) return Promise.reject(new Error("runtime controller is already started"));
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    this.#started = true;
    return this.apply(snapshot);
  }

  apply(snapshot: RuntimeSettingsSnapshot): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    const operation = this.#mutation.catch(() => undefined).then(() => this.#applySnapshot(snapshot));
    this.#mutation = operation;
    return operation;
  }

  beginPaymentTransition(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    this.#transitioning = true;
    const operation = this.#mutation.catch(() => undefined).then(() => this.#pause());
    this.#mutation = operation;
    return operation;
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#mutation.catch(() => undefined);
      return;
    }
    this.#stopped = true;
    await this.#mutation.catch(() => undefined);
    await this.#stopSchedulers();
  }

  status(): PaymentRuntimeStatus {
    const snapshot = this.#snapshot;
    return Object.freeze({
      configured: snapshot !== null && isPaymentConfigured(snapshot),
      transitioning: this.#transitioning,
      paymentRevision: snapshot?.paymentRevision ?? 0,
      activeProviderAccountKey: snapshot?.activeProviderAccountKey ?? null,
      scanIntervalMilliseconds: snapshot?.provider?.scanIntervalMilliseconds ?? null,
      maximumSuccessAgeMilliseconds: snapshot?.provider?.maximumSuccessAgeMilliseconds ?? null,
    });
  }

  ledgerHealth(): RevisionedLedgerHealth {
    if (!this.#ledgerScheduler) return disabledLedgerHealth;
    return Object.freeze({
      enabled: true,
      paymentRevision: this.#ledgerRevision,
      ...this.#ledgerScheduler.health(),
    });
  }

  reconciliationHealth(): RevisionedReconciliationHealth {
    if (!this.#reconciliationScheduler) return disabledReconciliationHealth;
    return Object.freeze({
      enabled: true,
      paymentRevision: this.#reconciliationRevision,
      ...this.#reconciliationScheduler.health(),
    });
  }

  webhookHealth(): WebhookSchedulerHealth {
    if (this.#webhookScheduler) return this.#webhookScheduler.health();
    const counts = this.#webhooks.counts();
    return Object.freeze({
      enabled: false,
      state: "idle",
      inFlight: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      pendingDeliveries: counts.pending,
      deadLetters: counts.dead,
    });
  }

  async triggerOrder(orderId: string): Promise<void> {
    await this.#reconciliationScheduler?.triggerOrder(orderId);
  }

  async triggerReconciliation(reason: string): Promise<void> {
    await this.#reconciliationScheduler?.triggerSweep(reason);
  }

  async triggerWebhook(reason: string): Promise<void> {
    await this.#webhookScheduler?.trigger(reason);
  }

  assertProviderSwitchAllowed(
    current: RuntimeSettingsSnapshot,
    accountKey = current.activeProviderAccountKey,
  ): void {
    if (!accountKey) return;
    const counts = this.#database.read((connection) => {
      const row = connection.prepare(
        `SELECT
           (SELECT COUNT(*) FROM ledger_entries
             WHERE provider_account_key = ?) AS ledger_entries,
           (SELECT COUNT(*)
              FROM payment_orders AS orders
              JOIN collection_profile_provider_accounts AS link
                ON link.profile_id = orders.collection_profile_id
             WHERE link.provider_account_key = ?
               AND orders.checkout_status = 'OPEN'
               AND orders.payment_status = 'UNPAID') AS open_orders,
           (SELECT MAX(COALESCE(orders.closed_at, orders.expires_at))
              FROM payment_orders AS orders
              JOIN collection_profile_provider_accounts AS link
                ON link.profile_id = orders.collection_profile_id
             WHERE link.provider_account_key = ?
               AND orders.checkout_status != 'OPEN'
               AND orders.payment_status = 'UNPAID') AS latest_ended_order_at,
           (SELECT COUNT(*) FROM ingest_runs
             WHERE provider_account_key = ? AND status = 'RUNNING') AS running_scans`,
      ).get(accountKey, accountKey, accountKey, accountKey) as {
        readonly ledger_entries: bigint | number;
        readonly open_orders: bigint | number;
        readonly latest_ended_order_at: bigint | number | null;
        readonly running_scans: bigint | number;
      };
      return {
        ledgerEntries: Number(row.ledger_entries),
        openOrders: Number(row.open_orders),
        latestEndedOrderAt: row.latest_ended_order_at === null
          ? null
          : Number(row.latest_ended_order_at),
        runningScans: Number(row.running_scans),
      };
    });
    if (counts.openOrders > 0) {
      throw providerSwitchBlocked("当前采集账户仍有未支付订单");
    }
    const ledger = this.#pausedLedgerHealth ?? this.ledgerHealth();
    const reconciliation = this.#pausedReconciliationHealth ?? this.reconciliationHealth();
    if (counts.runningScans > 0 || ledger.inFlight || reconciliation.inFlight) {
      throw providerSwitchBlocked("当前采集或自动确认任务尚未结束");
    }
    if (counts.ledgerEntries === 0) return;
    const now = safeNow(this.#clock());
    const maximumAge = current.provider?.maximumSuccessAgeMilliseconds;
    if (
      maximumAge === undefined ||
      !isFresh(ledger.lastSuccessAt, now, maximumAge) ||
      !isFresh(reconciliation.lastSuccessAt, now, maximumAge) ||
      ledger.paymentRevision !== current.paymentRevision ||
      reconciliation.paymentRevision !== current.paymentRevision
    ) {
      throw providerSwitchBlocked("切换前需要当前采集账户完成近期采集和自动确认");
    }
    if (
      counts.latestEndedOrderAt !== null &&
      (
        ledger.lastSuccessAt === null ||
        reconciliation.lastSuccessAt === null ||
        ledger.lastSuccessAt < counts.latestEndedOrderAt ||
        reconciliation.lastSuccessAt < counts.latestEndedOrderAt
      )
    ) {
      throw providerSwitchBlocked("最近结束的未支付订单尚未经过采集和自动确认复核");
    }
  }

  async #applySnapshot(snapshot: RuntimeSettingsSnapshot): Promise<void> {
    const previous = this.#snapshot;
    const paymentChanged = previous === null ||
      previous.paymentRevision !== snapshot.paymentRevision ||
      previous.activeProviderAccountKey !== snapshot.activeProviderAccountKey ||
      isPaymentConfigured(previous) !== isPaymentConfigured(snapshot);
    const paymentNeedsReplacement = this.#transitioning || paymentChanged ||
      (isPaymentConfigured(snapshot) &&
        (this.#ledgerScheduler === null || this.#reconciliationScheduler === null)) ||
      (!isPaymentConfigured(snapshot) &&
        (this.#ledgerScheduler !== null || this.#reconciliationScheduler !== null));
    const webhookNeedsReplacement = previous === null ||
      !sameWebhookConfiguration(previous, snapshot) ||
      (isWebhookConfigured(snapshot) && this.#webhookScheduler === null) ||
      (!isWebhookConfigured(snapshot) && this.#webhookScheduler !== null);
    if (paymentNeedsReplacement) this.#transitioning = true;

    try {
      if (paymentNeedsReplacement) await this.#stopPaymentSchedulers();
      if (webhookNeedsReplacement) await this.#stopWebhookScheduler();
      if (paymentNeedsReplacement) await this.#installPaymentSchedulers(snapshot, true);
      if (webhookNeedsReplacement) await this.#installWebhookScheduler(snapshot);
      this.#snapshot = snapshot;
      if (paymentNeedsReplacement) {
        this.#pausedLedgerHealth = null;
        this.#pausedReconciliationHealth = null;
        this.#transitioning = false;
      }
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      if (paymentNeedsReplacement) {
        try {
          await this.#stopPaymentSchedulers();
          if (previous) await this.#installPaymentSchedulers(previous, false);
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (webhookNeedsReplacement) {
        try {
          await this.#stopWebhookScheduler();
          if (previous) await this.#installWebhookScheduler(previous);
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          "runtime replacement failed and the previous workers could not be restored",
        );
      }
      throw error;
    }
  }

  async #pause(): Promise<void> {
    const ledger = this.#ledgerScheduler;
    const reconciliation = this.#reconciliationScheduler;
    const ledgerRevision = this.#ledgerRevision;
    const reconciliationRevision = this.#reconciliationRevision;
    try {
      await this.#stopPaymentSchedulers();
      this.#pausedLedgerHealth = ledger === null
        ? disabledLedgerHealth
        : Object.freeze({
            enabled: true,
            paymentRevision: ledgerRevision,
            ...ledger.health(),
          });
      this.#pausedReconciliationHealth = reconciliation === null
        ? disabledReconciliationHealth
        : Object.freeze({
            enabled: true,
            paymentRevision: reconciliationRevision,
            ...reconciliation.health(),
          });
    } catch (error) {
      this.#pausedLedgerHealth = null;
      this.#pausedReconciliationHealth = null;
      throw error;
    }
  }

  async #stopSchedulers(): Promise<void> {
    const results = await Promise.allSettled([
      this.#stopPaymentSchedulers(),
      this.#stopWebhookScheduler(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "runtime workers could not be stopped");
  }

  async #stopPaymentSchedulers(): Promise<void> {
    const ledger = this.#ledgerScheduler;
    const reconciliation = this.#reconciliationScheduler;
    this.#ledgerScheduler = null;
    this.#reconciliationScheduler = null;
    this.#ledgerRevision = null;
    this.#reconciliationRevision = null;
    const results = await Promise.allSettled([
      ledger?.stop() ?? Promise.resolve(),
      reconciliation?.stop() ?? Promise.resolve(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "payment workers could not be stopped");
  }

  async #stopWebhookScheduler(): Promise<void> {
    const webhook = this.#webhookScheduler;
    this.#webhookScheduler = null;
    await webhook?.stop();
  }

  async #installPaymentSchedulers(
    snapshot: RuntimeSettingsSnapshot,
    initializeOrders: boolean,
  ): Promise<void> {
    if (initializeOrders) this.#orders.initialize();
    if (!this.#started || this.#stopped || !isPaymentConfigured(snapshot)) return;
    const ledger = this.#createLedgerScheduler(snapshot);
    const reconciliation = this.#createReconciliationScheduler(snapshot.paymentRevision);
    this.#ledgerScheduler = ledger;
    this.#reconciliationScheduler = reconciliation;
    this.#ledgerRevision = snapshot.paymentRevision;
    this.#reconciliationRevision = snapshot.paymentRevision;
    try {
      ledger.start();
      void reconciliation.start().catch((error: unknown) => {
        logRuntimeError("reconciliation_scheduler_startup_failed", error);
      });
    } catch (error) {
      await this.#stopPaymentSchedulers().catch(() => undefined);
      throw error;
    }
  }

  async #installWebhookScheduler(snapshot: RuntimeSettingsSnapshot): Promise<void> {
    if (!this.#started || this.#stopped || !isWebhookConfigured(snapshot)) return;
    const webhook = this.#createWebhookScheduler(snapshot);
    this.#webhookScheduler = webhook;
    try {
      void webhook.start().catch((error: unknown) => {
        logRuntimeError("webhook_scheduler_startup_failed", error);
      });
    } catch (error) {
      this.#webhookScheduler = null;
      await webhook.stop().catch(() => undefined);
      throw error;
    }
  }

  #createLedgerScheduler(snapshot: RuntimeSettingsSnapshot): LedgerIngestScheduler {
    const providerSettings = snapshot.provider;
    const providerAccountKey = snapshot.activeProviderAccountKey;
    if (!providerSettings || !providerAccountKey) {
      throw new Error("payment runtime was started without provider settings");
    }
    const activation = this.#ledger.activeProviderIdentity();
    if (!activation || activation.providerAccountKey !== providerAccountKey) {
      throw new Error("active provider generation does not match runtime settings");
    }
    const provider = new AlipayLedgerProvider({
      appId: providerSettings.appId,
      privateKey: providerSettings.privateKey,
      alipayPublicKey: providerSettings.publicKey,
      transport: new NodeV3Transport({ endpoint: providerSettings.endpoint }),
      timeoutMilliseconds: providerSettings.timeoutMilliseconds,
      pageSize: DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
    });
    const service = new LedgerIngestService({
      provider,
      store: this.#ledger,
      providerAccountKey,
      pageSize: DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
      overlapMilliseconds: 5 * 60 * 1_000,
      windowMilliseconds: 24 * 60 * 60 * 1_000,
      safetyLagMilliseconds: providerSettings.safetyLagMilliseconds,
      maxRequestsPerRun: 32,
      initialWindowStartMilliseconds: activation.activatedAt,
      clock: this.#clock,
    });
    return new LedgerIngestScheduler({
      service,
      intervalMilliseconds: providerSettings.scanIntervalMilliseconds,
      clock: this.#clock,
      onResult: (result, health) => {
        console.log(JSON.stringify({
          level: result.status === "FAILED" ? "warn" : "info",
          event: "ledger_scan_finished",
          payment_revision: snapshot.paymentRevision,
          provider_account_key: providerAccountKey,
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
        if (this.#reconciliationRevision === snapshot.paymentRevision) {
          void this.triggerReconciliation("ledger_scan").catch((error: unknown) => {
            logRuntimeError("reconciliation_sweep_trigger_failed", error);
          });
        }
      },
      onUnexpectedError: (error) => logRuntimeError("ledger_scheduler_failed", error),
    });
  }

  #createReconciliationScheduler(paymentRevision: number): ReconciliationScheduler {
    return new ReconciliationScheduler({
      store: this.#reconciliation,
      intervalMilliseconds: 60_000,
      batchSize: 64,
      maximumEntriesPerRun: 1_024,
      clock: this.#clock,
      onResult: (result, health) => {
        console.log(JSON.stringify({
          level: result.failures === 0 ? "info" : "warn",
          event: "reconciliation_finished",
          payment_revision: paymentRevision,
          reason: result.reason,
          processed_entries: result.processedEntries,
          processed_orders: result.processedOrders,
          auto_settled: result.autoSettled,
          failures: result.failures,
          continuation_pending: result.continuationPending,
          consecutive_failures: health.consecutiveFailures,
        }));
      },
      onAutoSettled: () => {
        void this.triggerWebhook("auto_settlement").catch((error: unknown) => {
          logRuntimeError("webhook_delivery_trigger_failed", error);
        });
      },
      onEntryError: (error, ledgerEntryId) => {
        logRuntimeError("reconciliation_entry_failed", error, { ledger_entry_id: ledgerEntryId });
      },
      onOrderError: (error, orderId) => {
        logRuntimeError("reconciliation_order_failed", error, { order_id: orderId });
      },
    });
  }

  #createWebhookScheduler(snapshot: RuntimeSettingsSnapshot): WebhookScheduler {
    if (!isWebhookConfigured(snapshot)) {
      throw new Error("webhook runtime was started without complete settings");
    }
    const config = snapshot.webhook;
    const key = this.#webhooks.syncSigningKey({
      secretFingerprint: config.signingKeyFingerprint,
      now: safeNow(this.#clock()),
    });
    if (key.secretFingerprint !== config.signingKeyFingerprint) {
      throw new Error("webhook signing key synchronization failed");
    }
    const service = new WebhookDeliveryService({
      store: this.#webhooks,
      config: {
        secret: config.secret,
        timeoutMilliseconds: config.timeoutMilliseconds,
        maximumAttempts: config.maximumAttempts,
        retryBaseMilliseconds: config.retryBaseMilliseconds,
        retryMaximumMilliseconds: config.retryMaximumMilliseconds,
      },
      transport: new NodeWebhookTransport(config.allowedOrigin),
      clock: this.#clock,
    });
    return new WebhookScheduler({
      service,
      store: this.#webhooks,
      intervalMilliseconds: 1_000,
      maximumDeliveriesPerRun: 32,
      clock: this.#clock,
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
      onUnexpectedError: (error) => logRuntimeError("webhook_scheduler_failed", error),
    });
  }
}

function isPaymentConfigured(snapshot: RuntimeSettingsSnapshot): boolean {
  return snapshot.collection !== null &&
    snapshot.provider !== null &&
    snapshot.activeProviderAccountKey !== null &&
    snapshot.apiSecret !== null;
}

function isWebhookConfigured(snapshot: RuntimeSettingsSnapshot): snapshot is RuntimeSettingsSnapshot & {
  readonly webhook: RuntimeSettingsSnapshot["webhook"] & {
    readonly enabled: true;
    readonly allowedOrigin: string;
    readonly secret: string;
    readonly signingKeyFingerprint: string;
  };
} {
  return snapshot.webhook.enabled &&
    snapshot.webhook.allowedOrigin !== null &&
    snapshot.webhook.secret !== null &&
    snapshot.webhook.signingKeyFingerprint !== null;
}

function sameWebhookConfiguration(
  left: RuntimeSettingsSnapshot,
  right: RuntimeSettingsSnapshot,
): boolean {
  return left.webhook.enabled === right.webhook.enabled &&
    left.webhook.allowedOrigin === right.webhook.allowedOrigin &&
    left.webhook.signingKeyFingerprint === right.webhook.signingKeyFingerprint &&
    left.webhook.timeoutMilliseconds === right.webhook.timeoutMilliseconds &&
    left.webhook.maximumAttempts === right.webhook.maximumAttempts &&
    left.webhook.retryBaseMilliseconds === right.webhook.retryBaseMilliseconds &&
    left.webhook.retryMaximumMilliseconds === right.webhook.retryMaximumMilliseconds;
}

function providerSwitchBlocked(message: string): SettingsError {
  return new SettingsError("provider_switch_blocked", message);
}

function isFresh(lastSuccessAt: number | null, now: number, maximumAge: number): boolean {
  if (lastSuccessAt === null) return false;
  const age = now - lastSuccessAt;
  return Number.isSafeInteger(age) && age >= 0 && age <= maximumAge;
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("runtime controller clock is invalid");
  }
  return value;
}

function logRuntimeError(
  event: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    ...details,
    error_type: error instanceof Error ? error.name : "unknown_error",
  }));
}
