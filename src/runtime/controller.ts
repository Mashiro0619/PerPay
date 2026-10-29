import { SiteWebhookProcessor } from "../notifications/site-processor.ts";
import type { AlipayAccountSnapshot } from "../alipay-accounts/model.ts";
import type { SiteStore } from "../sites/store.ts";
import { CheckoutVerifier } from "./checkout-verification.ts";
import { LedgerManualScanner } from "./ledger-manual-scan.ts";
import type { LedgerManualScanRequest, LedgerManualScanStatus, LedgerManualScanUnavailableReason } from "../shared/ledger-manual-scan.ts";
import { ledgerScanGate } from "../ledger/scan-gate.ts";
import type { AppDatabase } from "../database/database.ts";
import {
  AlipayLedgerProvider,
  DEFAULT_ACCOUNT_LOG_PAGE_SIZE,
  NodeV3Transport,
} from "../infrastructure/alipay/index.ts";
import {
  LedgerIngestScheduler,
  LedgerIngestService,
  LedgerScanCadencePolicy,
  normalLedgerOverlapMilliseconds,
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
import type { InstanceRuntimeSettingsSnapshot, RuntimeSettingsSnapshot } from "../settings/model.ts";
type PaymentRuntimeSnapshot = RuntimeSettingsSnapshot | InstanceRuntimeSettingsSnapshot;
import { SettingsError } from "../settings/store.ts";
import { collectionCodeError } from "../shared/collection-code.ts";

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
  readonly sites?: SiteStore | null;
  readonly clock?: (() => number) | undefined;
  readonly accounts?: (() => readonly AlipayAccountSnapshot[]) | undefined;
}

interface AccountWorker {
  readonly account: AlipayAccountSnapshot;
  readonly scheduler: LedgerIngestScheduler;
  readonly manualScanner: LedgerManualScanner;
}

export interface AccountRuntimeHealth {
  readonly state: string;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly collectionReady: boolean;
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
  readonly #sites: SiteStore | null;
  readonly #clock: () => number;
  readonly #checkoutVerifier: CheckoutVerifier;
  readonly #ledgerManualScanner: LedgerManualScanner;
  readonly #accounts: (() => readonly AlipayAccountSnapshot[]) | undefined;
  readonly #accountWorkers = new Map<string, AccountWorker>();
  readonly #accountTransitions = new Set<string>();
  readonly #pausedAccountHealth = new Map<string, RevisionedLedgerHealth>();
  #ledgerScheduler: LedgerIngestScheduler | null = null;
  #reconciliationScheduler: ReconciliationScheduler | null = null;
  #webhookScheduler: WebhookScheduler | null = null;
  #snapshot: PaymentRuntimeSnapshot | null = null;
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
    this.#sites = options.sites ?? null;
    this.#clock = options.clock ?? (() => Date.now());
    this.#checkoutVerifier = new CheckoutVerifier(this.#clock);
    this.#ledgerManualScanner = new LedgerManualScanner(this.#clock);
    this.#accounts = options.accounts;
  }

  start(snapshot: PaymentRuntimeSnapshot): Promise<void> {
    if (this.#started) return Promise.reject(new Error("runtime controller is already started"));
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    this.#started = true;
    return this.apply(snapshot);
  }

  apply(snapshot: PaymentRuntimeSnapshot): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    const operation = this.#mutation.catch(() => undefined).then(() => this.#applySnapshot(snapshot));
    this.#mutation = operation;
    return operation;
  }

  beginPaymentTransition(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("runtime controller is stopped"));
    this.#transitioning = true;
    this.#ledgerManualScanner.invalidate();
    const operation = this.#mutation.catch(() => undefined).then(() => this.#pause());
    this.#mutation = operation;
    return operation;
  }

  beginAccountTransition(accountId: string): Promise<void> {
    this.#accountTransitions.add(accountId);
    const operation = this.#mutation.catch(() => undefined).then(async () => {
      const worker = this.#accountWorkers.get(accountId);
      if (!worker) return;
      worker.manualScanner.invalidate();
      await worker.scheduler.stop();
      this.#pausedAccountHealth.set(accountId, { enabled: true, paymentRevision: worker.account.revision, ...worker.scheduler.health() });
      this.#accountWorkers.delete(accountId);
    });
    this.#mutation = operation;
    return operation;
  }

  applyAccounts(accountId: string): Promise<void> {
    const operation = this.#mutation.catch(() => undefined).then(async () => {
      this.#accountTransitions.delete(accountId);
      this.#pausedAccountHealth.delete(accountId);
      if (!this.#snapshot || this.#transitioning || this.#stopped) return;
      await this.#applyMultiAccountSnapshot(this.#snapshot);
    });
    this.#mutation = operation;
    return operation;
  }

  accountHealth(accountId: string): AccountRuntimeHealth {
    const account = this.#accounts?.().find(account => account.id === accountId);
    const worker = this.#accountWorkers.get(accountId);
    const health = worker?.scheduler.health();
    const lastSuccessAt = health?.lastSuccessAt ?? null;
    const ready = Boolean(account?.enabled && account.configured && health &&
      !this.#accountTransitions.has(accountId) && !this.#transitioning && !this.#stopped && health.state !== "stopped" &&
      health.lastErrorCode === null && isFresh(lastSuccessAt, this.#clock(), account.provider!.maximumSuccessAgeMilliseconds));
    return { state: this.#accountTransitions.has(accountId) ? "transitioning" : health?.state ?? "unconfigured",
      lastSuccessAt, lastErrorCode: health?.lastErrorCode ?? null, collectionReady: ready };
  }

  accountStatuses(): readonly { accountId: string; name: string; enabled: boolean; health: AccountRuntimeHealth }[] {
    return this.#accounts?.().map(account => ({ accountId: account.id, name: account.name, enabled: account.enabled, health: this.accountHealth(account.id) })) ?? [];
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#mutation.catch(() => undefined);
      return;
    }
    this.#stopped = true;
    this.#ledgerManualScanner.invalidate();
    await this.#mutation.catch(() => undefined);
    await this.#stopSchedulers();
  }

  status(): PaymentRuntimeStatus {
    const snapshot = this.#snapshot;
    const provider = this.#accounts?.().find(account => account.provider)?.provider ?? snapshot?.provider;
    return Object.freeze({
      configured: this.#accounts ? this.#accounts().some(account => account.configured && account.enabled) : snapshot !== null && isPaymentConfigured(snapshot),
      transitioning: this.#transitioning,
      paymentRevision: snapshot?.paymentRevision ?? 0,
      activeProviderAccountKey: snapshot?.activeProviderAccountKey ?? null,
      scanIntervalMilliseconds: provider?.scanIntervalMilliseconds ?? null,
      maximumSuccessAgeMilliseconds: provider?.maximumSuccessAgeMilliseconds ?? null,
    });
  }

  ledgerHealth(): RevisionedLedgerHealth {
    if (this.#accounts) {
      const workers = [...this.#accountWorkers.values()];
      if (!workers.length) return disabledLedgerHealth;
      const health = workers.map(worker => worker.scheduler.health());
      return { enabled: true, paymentRevision: this.#snapshot?.paymentRevision ?? 0,
        state: health.some(item => item.state === "degraded") ? "degraded" : health.some(item => item.inFlight) ? "running" : "idle",
        inFlight: health.some(item => item.inFlight),
        lastAttemptAt: maximumTimestamp(health.map(item => item.lastAttemptAt)),
        lastSuccessAt: maximumTimestamp(health.map(item => item.lastSuccessAt)),
        lastErrorCode: health.find(item => item.lastErrorCode)?.lastErrorCode ?? null,
        consecutiveFailures: Math.max(...health.map(item => item.consecutiveFailures)) };
    }
    if (!this.#ledgerScheduler) return disabledLedgerHealth;
    return Object.freeze({
      enabled: true,
      paymentRevision: this.#ledgerRevision,
      ...this.#ledgerScheduler.health(),
    });
  }

  ledgerNextRunAt(): number | null {
    if (this.#accounts) {
      const times = [...this.#accountWorkers.values()].flatMap(worker => {
        const next = worker.scheduler.nextScanAt();
        return worker.scheduler.health().inFlight || next === null ? [] : [next];
      });
      return times.length ? Math.min(...times) : null;
    }
    if (!this.#ledgerScheduler || this.#transitioning) return null;
    const health = this.#ledgerScheduler.health();
    return health.inFlight || health.state === "stopped" ? null : this.#ledgerScheduler.nextScanAt();
  }

  ledgerManualScan(accountId?: string): LedgerManualScanStatus {
    const worker = this.#accounts ? this.#accountWorker(accountId) : null;
    const scheduler = this.#accounts ? worker?.scheduler : this.#ledgerScheduler;
    let reason: LedgerManualScanUnavailableReason | null = null;
    if (this.#stopped || !this.#started) reason = "stopped";
    else if (this.#transitioning) reason = "transitioning";
    else if (!scheduler || !this.#snapshot || (!this.#accounts && !isPaymentConfigured(this.#snapshot))) reason = "not_configured";
    else if (scheduler.health().state === "stopped") reason = "stopped";
    else if (scheduler.health().lastErrorCode === "scan_schedule_unavailable") reason = "storage_unavailable";
    return { available: reason === null, unavailable_reason: reason, request: (worker?.manualScanner ?? this.#ledgerManualScanner).get() };
  }

  requestLedgerScan(accountId?: string): LedgerManualScanRequest {
    const worker = this.#accounts ? this.#accountWorker(accountId) : null;
    const scheduler = this.#accounts ? worker?.scheduler : this.#ledgerScheduler;
    if (!scheduler || !this.ledgerManualScan(accountId).available) throw new Error("ledger scan unavailable");
    return (worker?.manualScanner ?? this.#ledgerManualScanner).request(scheduler,
      () => !this.#stopped && !this.#transitioning && (worker ? this.#accountWorkers.get(worker.account.id) === worker : this.#ledgerScheduler === scheduler));
  }

  #accountWorker(accountId?: string): AccountWorker | null {
    if (accountId) return this.#accountWorkers.get(accountId) ?? null;
    return this.#accountWorkers.size === 1 ? this.#accountWorkers.values().next().value! : null;
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

  checkoutVerification(orderId: string) { return this.#checkoutVerifier.get(orderId); }

  requestCheckoutVerification(orderId: string) {
    const order = this.#orders.adminGet(orderId);
    const worker = this.#accounts ? this.#accountWorkers.get(order.alipayAccountId) : null;
    const scheduler = this.#accounts ? worker?.scheduler : this.#ledgerScheduler, reconciliation = this.#reconciliationScheduler;
    if (!scheduler || !reconciliation || this.#stopped || this.#transitioning) throw new Error("payment runtime unavailable");
    if (order.checkout.status !== "OPEN" || order.payment.status !== "UNPAID") return this.#checkoutVerifier.get(orderId);
    return this.#checkoutVerifier.request(orderId, scheduler, async () => { await reconciliation.verifyOrder(orderId); this.#orders.adminGet(orderId); },
      () => !this.#stopped && !this.#transitioning && (worker ? this.#accountWorkers.get(order.alipayAccountId) === worker : this.#ledgerScheduler === scheduler) && this.#reconciliationScheduler === reconciliation);
  }

  async triggerOrder(orderId: string): Promise<void> {
    if (this.#accounts) this.#accountWorkers.get(this.#orders.adminGet(orderId).alipayAccountId)?.scheduler.refreshSchedule();
    else this.#ledgerScheduler?.refreshSchedule();
    await this.#reconciliationScheduler?.triggerOrder(orderId);
  }

  async triggerReconciliation(reason: string): Promise<void> {
    await this.#reconciliationScheduler?.triggerSweep(reason);
  }

  async triggerWebhook(reason: string): Promise<void> {
    await this.#webhookScheduler?.trigger(reason);
  }

  assertProviderSwitchAllowed(
    current: PaymentRuntimeSnapshot,
    accountKey = current.activeProviderAccountKey,
    alipayAccountId?: string,
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
      throw providerSwitchBlocked("当前查账账户仍有未支付订单");
    }
    const worker = alipayAccountId ? this.#accountWorkers.get(alipayAccountId) : null;
    const ledger = alipayAccountId ? this.#pausedAccountHealth.get(alipayAccountId) ?? (worker
      ? { enabled: true, paymentRevision: worker.account.revision, ...worker.scheduler.health() }
      : disabledLedgerHealth) : this.#pausedLedgerHealth ?? this.ledgerHealth();
    const reconciliation = this.#pausedReconciliationHealth ?? this.reconciliationHealth();
    if (counts.runningScans > 0 || ledger.inFlight || (!alipayAccountId && reconciliation.inFlight)) {
      throw providerSwitchBlocked("当前查账或自动确认收款任务尚未结束");
    }
    // No recorded income does not prove that the last order has no late-visible payment.
    // Only an unused account can skip the final collection/confirmation checks.
    if (counts.ledgerEntries === 0 && counts.latestEndedOrderAt === null) return;
    const now = safeNow(this.#clock());
    const maximumAge = current.provider?.maximumSuccessAgeMilliseconds;
    if (
      maximumAge === undefined ||
      !isFresh(ledger.lastSuccessAt, now, maximumAge) ||
      !isFresh(reconciliation.lastSuccessAt, now, maximumAge) ||
      ledger.paymentRevision !== current.paymentRevision ||
      (!alipayAccountId && reconciliation.paymentRevision !== current.paymentRevision)
    ) {
      throw providerSwitchBlocked("切换前需要当前查账账户完成近期查账和自动确认收款");
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
      throw providerSwitchBlocked("最近结束的未支付订单尚未经过查账和自动确认收款复核");
    }
  }

  assertAccountProviderSwitchAllowed(account: AlipayAccountSnapshot): void {
    if (!this.#snapshot) throw providerSwitchBlocked("收款服务尚未启动，请稍后重试。");
    this.assertProviderSwitchAllowed({ ...this.#snapshot, provider: account.provider,
      activeProviderAccountKey: account.providerAccountKey, paymentRevision: account.revision }, account.providerAccountKey, account.id);
  }

  async #applySnapshot(snapshot: PaymentRuntimeSnapshot): Promise<void> {
    if (this.#accounts) return this.#applyMultiAccountSnapshot(snapshot);
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
    const webhookConfigured = this.#sites !== null || isWebhookConfigured(snapshot);
    const webhookNeedsReplacement = previous === null ||
      (this.#sites === null && !sameWebhookConfiguration(previous, snapshot)) ||
      (webhookConfigured && this.#webhookScheduler === null) ||
      (!webhookConfigured && this.#webhookScheduler !== null);
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

  async #applyMultiAccountSnapshot(snapshot: PaymentRuntimeSnapshot): Promise<void> {
    const accounts = this.#accounts!();
    const previous = this.#snapshot;
    this.#orders.initialize();
    for (const [id, worker] of this.#accountWorkers) {
      const account = accounts.find(account => account.id === id);
      if (account?.provider && account.providerAccountKey && account.revision === worker.account.revision &&
        previous?.paymentRevision === snapshot.paymentRevision) continue;
      worker.manualScanner.invalidate();
      await worker.scheduler.stop();
      this.#accountWorkers.delete(id);
    }
    if (!this.#reconciliationScheduler && this.#started && !this.#stopped) {
      const reconciliation = this.#createReconciliationScheduler(snapshot.paymentRevision);
      this.#reconciliationScheduler = reconciliation;
      this.#reconciliationRevision = snapshot.paymentRevision;
      void reconciliation.start().catch(error => logRuntimeError("reconciliation_scheduler_startup_failed", error));
    }
    this.#snapshot = snapshot;
    for (const account of accounts) {
      if (!account.provider || !account.providerAccountKey || this.#accountWorkers.has(account.id) ||
        this.#accountTransitions.has(account.id) || this.#stopped) continue;
      const accountSnapshot: PaymentRuntimeSnapshot = { ...snapshot,
        provider: account.provider, activeProviderAccountKey: account.providerAccountKey,
        paymentRevision: account.revision };
      const scheduler = this.#createLedgerScheduler(accountSnapshot);
      this.#accountWorkers.set(account.id, { account, scheduler, manualScanner: new LedgerManualScanner(this.#clock) });
      scheduler.start();
    }
    const webhookConfigured = this.#sites !== null || isWebhookConfigured(snapshot);
    if (!previous || (!this.#sites && !sameWebhookConfiguration(previous, snapshot))) await this.#stopWebhookScheduler();
    if (webhookConfigured && !this.#webhookScheduler) await this.#installWebhookScheduler(snapshot);
    this.#transitioning = false;
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
    for (const [id, worker] of this.#accountWorkers) {
      worker.manualScanner.invalidate();
      await worker.scheduler.stop();
      this.#pausedAccountHealth.set(id, { enabled: true, paymentRevision: worker.account.revision, ...worker.scheduler.health() });
      this.#accountWorkers.delete(id);
    }
    this.#ledgerManualScanner.invalidate();
    const ledger = this.#ledgerScheduler;
    const reconciliation = this.#reconciliationScheduler;
    const ledgerRevision = this.#ledgerRevision;
    const reconciliationRevision = this.#reconciliationRevision;
    this.#ledgerScheduler = null;
    this.#reconciliationScheduler = null;
    this.#ledgerRevision = null;
    this.#reconciliationRevision = null;
    const results = await Promise.allSettled([
      ledger?.stop() ?? Promise.resolve(),
      reconciliation?.stop() ?? Promise.resolve(),
    ]);
    // Keep failed workers reachable: a stopped ledger may still hold an
    // unpersisted cooldown that must be flushed before replacement is allowed.
    if (results[0]?.status === "rejected") {
      this.#ledgerScheduler = ledger;
      this.#ledgerRevision = ledgerRevision;
    }
    if (results[1]?.status === "rejected") {
      this.#reconciliationScheduler = reconciliation;
      this.#reconciliationRevision = reconciliationRevision;
    }
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
    snapshot: PaymentRuntimeSnapshot,
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

  async #installWebhookScheduler(snapshot: PaymentRuntimeSnapshot): Promise<void> {
    if (!this.#started || this.#stopped || (this.#sites === null && !isWebhookConfigured(snapshot))) return;
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

  #createLedgerScheduler(snapshot: PaymentRuntimeSnapshot): LedgerIngestScheduler {
    const providerSettings = snapshot.provider;
    const providerAccountKey = snapshot.activeProviderAccountKey;
    if (!providerSettings || !providerAccountKey) {
      throw new Error("payment runtime was started without provider settings");
    }
    const activation = this.#accounts ? this.#ledger.providerIdentity(providerAccountKey) : this.#ledger.activeProviderIdentity();
    if (!activation || activation.providerAccountKey !== providerAccountKey) {
      throw new Error("active provider generation does not match runtime settings");
    }
    const cadence = new LedgerScanCadencePolicy({
      database: this.#database,
      providerAccountKey,
      normalIntervalMilliseconds: providerSettings.scanIntervalMilliseconds,
      activeIntervalMilliseconds: providerSettings.activeScanIntervalMilliseconds,
      safetyLagMilliseconds: providerSettings.safetyLagMilliseconds,
      clock: this.#clock,
    });
    const getIntervalMilliseconds = () => cadence.current().intervalMilliseconds;
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
      overlapMilliseconds: normalLedgerOverlapMilliseconds(providerSettings.scanIntervalMilliseconds),
      windowMilliseconds: 24 * 60 * 60 * 1_000,
      safetyLagMilliseconds: providerSettings.safetyLagMilliseconds,
      scanIntervalMilliseconds: providerSettings.scanIntervalMilliseconds,
      getScanIntervalMilliseconds: getIntervalMilliseconds,
      maxRequestsPerRun: 32,
      initialWindowStartMilliseconds: "activatedAt" in activation ? activation.activatedAt as number : activation.boundAt,
      clock: this.#clock,
    });
    return new LedgerIngestScheduler({
      service,
      minimumIntervalMilliseconds: providerSettings.minimumScanIntervalMilliseconds ?? providerSettings.activeScanIntervalMilliseconds,
      gate: ledgerScanGate(this.#database, providerAccountKey),
      intervalMilliseconds: providerSettings.scanIntervalMilliseconds,
      getIntervalMilliseconds,
      clock: this.#clock,
      onResult: (result, health) => {
        const currentCadence = cadence.current();
        console.log(JSON.stringify({
          level: result.status === "FAILED" ? "warn" : "info",
          event: "ledger_scan_finished",
          scan_mode: currentCadence.mode,
          scan_interval_milliseconds: currentCadence.intervalMilliseconds,
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
        if (this.#accounts || this.#reconciliationRevision === snapshot.paymentRevision) {
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
        if (this.#accounts) for (const worker of this.#accountWorkers.values()) worker.scheduler.refreshSchedule();
        else if (this.#ledgerRevision === paymentRevision) this.#ledgerScheduler?.refreshSchedule();
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

  #createWebhookScheduler(snapshot: PaymentRuntimeSnapshot): WebhookScheduler {
    let service: WebhookDeliveryService | SiteWebhookProcessor;
    if (this.#sites) {
      service = new SiteWebhookProcessor({ sites: this.#sites, webhooks: this.#webhooks, clock: this.#clock });
    } else {
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
    service = new WebhookDeliveryService({
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
    }
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

function isPaymentConfigured(snapshot: PaymentRuntimeSnapshot): boolean {
  return snapshot.collection !== null && collectionCodeError(snapshot.collection.codePayload) === null &&
    snapshot.provider !== null &&
    snapshot.activeProviderAccountKey !== null;
}

function isWebhookConfigured(snapshot: PaymentRuntimeSnapshot): snapshot is RuntimeSettingsSnapshot & {
  readonly webhook: RuntimeSettingsSnapshot["webhook"] & {
    readonly enabled: true;
    readonly allowedOrigin: string;
    readonly secret: string;
    readonly signingKeyFingerprint: string;
  };
} {
  return "webhook" in snapshot && snapshot.webhook.enabled &&
    snapshot.webhook.allowedOrigin !== null &&
    snapshot.webhook.secret !== null &&
    snapshot.webhook.signingKeyFingerprint !== null;
}

function sameWebhookConfiguration(
  left: PaymentRuntimeSnapshot,
  right: PaymentRuntimeSnapshot,
): boolean {
  if (!("webhook" in left) || !("webhook" in right)) return !("webhook" in left) && !("webhook" in right);
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

function maximumTimestamp(values: readonly (number | null)[]): number | null {
  const timestamps = values.filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
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
