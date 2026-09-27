import { randomBytes, randomUUID } from "node:crypto";

import type { ProviderIdentityActivation } from "../ledger/model.ts";
import { SettingsFieldError } from "./validation.ts";
import { verifyProviderApplicationKey, type ProviderKeyVerifier } from "./provider-key-verification.ts";

import {
  advancedSettingsInputSchema,
  regenerateProviderApplicationKeySchema,
  applicationKeyChangeActionSchema,
  activateProviderApplicationKeySchema,
  backupSettingsInputSchema,
  collectionSettingsInputSchema,
  displaySettingsInputSchema,
  generateProviderApplicationKey,
  parseProviderApplicationPrivateKey,
  parseProviderKeys,
  parseWebhookOrigin,
  providerEndpoint,
  providerSettingsInputSchema,
  webhookSettingsInputSchema,
  type AdvancedSettingsInput,
  type RegenerateProviderApplicationKeyInput,
  type ApplicationKeyChangeActionInput,
  type ActivateProviderApplicationKeyInput,
  type ProviderApplicationKeyChange,
  type ProviderSettings,
  type BackupSettingsInput,
  type DashboardChartType,
  type DisplaySettingsInput,
  type CollectionSettingsInput,
  type ApiCredentialSnapshot,
  type ProviderSettingsInput,
  type RuntimeSecretName,
  type RuntimeSettingsSnapshot,
  type WebhookSettingsInput,
} from "./model.ts";
import {
  RuntimeSettingsStore,
  SettingsError,
  type SettingsAuditContext,
} from "./store.ts";

export interface RuntimeSettingsView {
  readonly revision: number;
  readonly payment_revision: number;
  readonly updated_at: string;
  readonly completion: {
    readonly complete: boolean;
    readonly application_key: boolean;
    readonly collection: boolean;
    readonly provider: boolean;
    readonly api: boolean;
    readonly notifications: boolean;
    readonly next_step:
      | "GENERATE_APPLICATION_KEY"
      | "CONFIGURE_PROVIDER"
      | "CONFIGURE_COLLECTION"
      | "GENERATE_API_KEY"
      | null;
  };
  readonly collection: {
    readonly code_payload: string;
    readonly order_ttl_seconds: number;
    readonly amount_offset_maximum_cents: number;
    readonly amount_reuse_cooldown_seconds: number;
  } | null;
  readonly provider: {
    readonly environment: "PRODUCTION" | "SANDBOX";
    readonly app_id: string;
    readonly provider_account_key: string;
    readonly timeout_milliseconds: number;
    readonly scan_interval_seconds: number;
    readonly active_scan_interval_seconds: number;
    readonly safety_lag_seconds: number;
    readonly maximum_success_age_seconds: number;
  } | null;
  readonly application_public_key: string | null;
  readonly application_key_fingerprint: string | null;
  readonly pending_application_key: {
    readonly change_id: string;
    readonly public_key: string;
    readonly fingerprint: string;
    readonly app_id: string;
    readonly environment: "PRODUCTION" | "SANDBOX";
    readonly created_at: string;
  } | null;
  readonly provider_generations: readonly {
    readonly provider_account_key: string;
    readonly app_id: string;
    readonly environment: "PRODUCTION" | "SANDBOX";
    readonly activated_at: string;
    readonly active: boolean;
  }[];
  readonly notifications: {
    readonly enabled: boolean;
    readonly allowed_origin: string | null;
    readonly timeout_milliseconds: number;
    readonly maximum_attempts: number;
    readonly retry_base_seconds: number;
    readonly retry_maximum_seconds: number;
  };
  readonly advanced: {
    readonly checkout_key_rotation_days: number;
    readonly checkout_terminal_observation_seconds: number;
  };
  readonly backup: {
    readonly interval_seconds: number;
    readonly keep_count: number;
  };
  readonly display: {
    readonly checkout_show_product_name: boolean;
    readonly dashboard_chart_type: DashboardChartType;
  };
  readonly secrets: Readonly<Record<RuntimeSecretName, ReturnType<RuntimeSettingsStore["secretMetadata"]>>>;
}

export type ProviderSwitchGuard = (input: {
  readonly current: RuntimeSettingsSnapshot;
  readonly currentProviderAccountKey: string;
  readonly nextAppId: string;
  readonly nextEndpoint: string;
}) => void | Promise<void>;

export type SettingsApplied = (snapshot: RuntimeSettingsSnapshot) => void | Promise<void>;
export type PaymentMutationStarted = () => void | Promise<void>;
export type CollectionApplied = (
  collection: NonNullable<RuntimeSettingsSnapshot["collection"]>,
  providerAccountKey: string,
) => void | Promise<void>;
export type ProviderHistory = () => readonly ProviderIdentityActivation[];

export class RuntimeSettingsService {
  readonly #store: RuntimeSettingsStore;
  readonly #guardProviderSwitch: ProviderSwitchGuard;
  readonly #onApplied: SettingsApplied;
  readonly #onCollectionApplied: CollectionApplied;
  readonly #onPaymentMutationStarted: PaymentMutationStarted;
  readonly #providerHistory: ProviderHistory;
  readonly #verifyProviderApplicationKey: ProviderKeyVerifier;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly store: RuntimeSettingsStore;
    readonly guardProviderSwitch?: ProviderSwitchGuard | undefined;
    readonly onApplied?: SettingsApplied | undefined;
    readonly onCollectionApplied?: CollectionApplied | undefined;
    readonly onPaymentMutationStarted?: PaymentMutationStarted | undefined;
    readonly providerHistory?: ProviderHistory | undefined;
    readonly verifyProviderApplicationKey?: ProviderKeyVerifier | undefined;
  }) {
    this.#store = options.store;
    this.#guardProviderSwitch = options.guardProviderSwitch ?? (() => undefined);
    this.#onApplied = options.onApplied ?? (() => undefined);
    this.#onCollectionApplied = options.onCollectionApplied ?? (() => undefined);
    this.#onPaymentMutationStarted = options.onPaymentMutationStarted ?? (() => undefined);
    this.#providerHistory = options.providerHistory ?? (() => []);
    this.#verifyProviderApplicationKey = options.verifyProviderApplicationKey ?? verifyProviderApplicationKey;
  }

  initialize(): RuntimeSettingsSnapshot {
    this.#store.initialize();
    return this.#store.snapshot();
  }

  display() {
    return this.#store.display();
  }

  snapshot(): RuntimeSettingsSnapshot {
    return this.#store.snapshot();
  }

  apiCredential(): ApiCredentialSnapshot | null {
    return this.#store.apiCredential();
  }

  status() {
    return this.#store.status();
  }

  view(): RuntimeSettingsView {
    const snapshot = this.#store.snapshot();
    const status = this.#store.status();
    const applicationKey = this.#store.providerApplicationKey();
    const pending = this.#store.pendingApplicationKey();
    return {
      revision: snapshot.revision,
      payment_revision: snapshot.paymentRevision,
      updated_at: new Date(snapshot.updatedAt).toISOString(),
      completion: {
        complete: status.complete,
        application_key: applicationKey !== null,
        collection: status.collectionConfigured,
        provider: status.providerConfigured,
        api: status.apiConfigured,
        notifications: status.notificationConfigured,
        next_step: configurationNextStep({
          applicationKeyConfigured: applicationKey !== null,
          providerConfigured: status.providerConfigured,
          collectionConfigured: status.collectionConfigured,
          apiConfigured: status.apiConfigured,
        }),
      },
      collection: snapshot.collection
        ? {
            code_payload: snapshot.collection.codePayload,
            order_ttl_seconds: snapshot.collection.orderTtlSeconds,
            amount_offset_maximum_cents: snapshot.collection.amountOffsetMaximumCents,
            amount_reuse_cooldown_seconds: snapshot.collection.amountReuseCooldownSeconds,
          }
        : null,
      provider: snapshot.provider && snapshot.activeProviderAccountKey
        ? {
            environment: snapshot.provider.environment,
            app_id: snapshot.provider.appId,
            provider_account_key: snapshot.activeProviderAccountKey,
            timeout_milliseconds: snapshot.provider.timeoutMilliseconds,
            scan_interval_seconds: snapshot.provider.scanIntervalMilliseconds / 1_000,
            active_scan_interval_seconds: snapshot.provider.activeScanIntervalMilliseconds / 1_000,
            safety_lag_seconds: snapshot.provider.safetyLagMilliseconds / 1_000,
            maximum_success_age_seconds: snapshot.provider.maximumSuccessAgeMilliseconds / 1_000,
          }
        : null,
      application_public_key: applicationKey?.uploadPublicKey ?? null,
      application_key_fingerprint: applicationKey?.fingerprint ?? null,
      pending_application_key: pending?.key ? {
        change_id: pending.changeId,
        public_key: pending.key.uploadPublicKey,
        fingerprint: pending.newFingerprint,
        app_id: pending.appId!,
        environment: pending.environment!,
        created_at: new Date(pending.createdAt).toISOString(),
      } : null,
      provider_generations: Object.freeze(this.#providerHistory().map((generation) => ({
        provider_account_key: generation.providerAccountKey,
        app_id: generation.externalAccountId,
        environment: generation.endpoint === providerEndpoint("SANDBOX")
          ? "SANDBOX" as const
          : "PRODUCTION" as const,
        activated_at: new Date(generation.activatedAt).toISOString(),
        active: generation.providerAccountKey === snapshot.activeProviderAccountKey,
      }))),
      notifications: {
        enabled: snapshot.webhook.enabled,
        allowed_origin: snapshot.webhook.allowedOrigin,
        timeout_milliseconds: snapshot.webhook.timeoutMilliseconds,
        maximum_attempts: snapshot.webhook.maximumAttempts,
        retry_base_seconds: snapshot.webhook.retryBaseMilliseconds / 1_000,
        retry_maximum_seconds: snapshot.webhook.retryMaximumMilliseconds / 1_000,
      },
      advanced: {
        checkout_key_rotation_days: snapshot.advanced.checkoutKeyRotationDays,
        checkout_terminal_observation_seconds:
          snapshot.advanced.checkoutTerminalObservationSeconds,
      },
      backup: {
        interval_seconds: snapshot.backup?.intervalSeconds ?? 86_400,
        keep_count: snapshot.backup?.keepCount ?? 7,
      },
      display: {
        checkout_show_product_name: snapshot.display?.checkoutShowProductName ?? true,
        dashboard_chart_type: snapshot.display?.dashboardChartType ?? "AREA",
      },
      secrets: {
        api_secret: this.#store.secretMetadata("api_secret"),
        provider_private_key: this.#store.secretMetadata("provider_private_key"),
        provider_public_key: this.#store.secretMetadata("provider_public_key"),
        webhook_secret: this.#store.secretMetadata("webhook_secret"),
      },
    };
  }

  saveCollection(input: CollectionSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      let committed = false;
      let transitionStarted = false;
      try {
        const parsed = collectionSettingsInputSchema.parse(input);
        transitionStarted = true;
        await this.#onPaymentMutationStarted();
        const snapshot = this.#store.saveCollection(parsed, audit);
        committed = true;
        const collection = snapshot.collection;
        if (!collection) throw new Error("collection settings were not published");
        await this.#applyCommitted(snapshot, async () => {
          if (snapshot.activeProviderAccountKey !== null) {
            await this.#onCollectionApplied(collection, snapshot.activeProviderAccountKey);
          }
        });
        return this.view();
      } catch (error) {
        if (!committed && transitionStarted) await this.#restoreCurrentRuntime(error);
        throw error;
      }
    });
  }

  saveProvider(input: ProviderSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      let committed = false;
      let transitionStarted = false;
      try {
        const parsed = providerSettingsInputSchema.parse(input);
        const current = this.#store.snapshot();
        if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
        const endpoint = providerEndpoint(parsed.environment);
        const historicalActive = latestProviderGeneration(this.#providerHistory());
        const currentProviderAccountKey = current.activeProviderAccountKey ??
          historicalActive?.providerAccountKey ?? null;
        const currentAppId = current.provider?.appId ?? historicalActive?.externalAccountId ?? null;
        const currentEndpoint = current.provider?.endpoint ?? historicalActive?.endpoint ?? null;
        const identityChanged = currentAppId !== parsed.app_id || currentEndpoint !== endpoint;
        if (identityChanged && this.#store.pendingApplicationKey()) {
          throw new SettingsError("provider_application_key_change_pending", "activate or discard the pending application key before switching applications");
        }
        const stagedApplicationKey = current.provider === null && currentProviderAccountKey === null
          ? this.#store.providerApplicationKey()
          : null;
        if (stagedApplicationKey && parsed.private_key !== undefined) {
          const suppliedApplicationKey = parseProviderApplicationPrivateKey(parsed.private_key);
          if (suppliedApplicationKey.fingerprint !== stagedApplicationKey.fingerprint) {
            throw new SettingsFieldError(
              "private_key", "这把私钥与已生成的应用公钥不匹配，请使用对应的应用私钥。",
              "the supplied application private key does not match the generated application public key",
            );
          }
        }
        if (current.provider !== null && !identityChanged && parsed.private_key !== undefined) {
          const suppliedApplicationKey = parseProviderApplicationPrivateKey(parsed.private_key);
          if (
            suppliedApplicationKey.fingerprint !== current.provider.applicationKeyFingerprint
          ) {
            throw new SettingsError(
              "provider_application_key_rotation_not_supported",
              "the active provider application key cannot be replaced without a two-phase rotation",
            );
          }
        }
        const privateKeyPem = stagedApplicationKey?.privateKeyPem ?? parsed.private_key ??
          current.provider?.privateKeyPem ?? null;
        if (
          privateKeyPem === null &&
          current.provider === null &&
          currentProviderAccountKey === null &&
          parsed.private_key === undefined
        ) {
          throw new SettingsError(
            "provider_application_key_missing",
            "generate an application key before configuring the provider",
          );
        }
        const publicKeyPem = parsed.platform_public_key ?? (
          identityChanged ? null : current.provider?.publicKeyPem ?? null
        );
        if (!privateKeyPem || !publicKeyPem) {
          throw new SettingsFieldError(!privateKeyPem ? "private_key" : "platform_public_key", !privateKeyPem ? "请先生成或导入应用私钥。" : "切换应用后需要重新填写支付宝公钥。", "both provider keys are required for a new collection application");
        }
        const provider = parseProviderKeys({
          environment: parsed.environment,
          appId: parsed.app_id,
          privateKey: privateKeyPem,
          publicKey: publicKeyPem,
          timeoutMilliseconds: parsed.timeout_milliseconds,
          scanIntervalMilliseconds: parsed.scan_interval_seconds * 1_000,
          activeScanIntervalMilliseconds: (parsed.active_scan_interval_seconds ?? parsed.scan_interval_seconds) * 1_000,
          safetyLagMilliseconds: parsed.safety_lag_seconds * 1_000,
          maximumSuccessAgeMilliseconds: parsed.maximum_success_age_seconds * 1_000,
        });
        transitionStarted = true;
        await this.#onPaymentMutationStarted();
        if (identityChanged && currentProviderAccountKey !== null) {
          await this.#guardProviderSwitch({
            current,
            currentProviderAccountKey,
            nextAppId: parsed.app_id,
            nextEndpoint: endpoint,
          });
        }
        const accountKey = identityChanged
          ? `source:${randomUUID()}`
          : currentProviderAccountKey ?? `source:${randomUUID()}`;
        const snapshot = this.#store.saveProvider({
          expectedRevision: parsed.revision,
          accountKey,
          environment: parsed.environment,
          appId: parsed.app_id,
          privateKeyPem: provider.privateKeyPem,
          publicKeyPem: provider.publicKeyPem,
          privateKeyFingerprint: provider.applicationKeyFingerprint,
          publicKeyFingerprint: provider.platformKeyFingerprint,
          timeoutMilliseconds: provider.timeoutMilliseconds,
          scanIntervalMilliseconds: provider.scanIntervalMilliseconds,
          activeScanIntervalMilliseconds: provider.activeScanIntervalMilliseconds,
          safetyLagMilliseconds: provider.safetyLagMilliseconds,
          maximumSuccessAgeMilliseconds: provider.maximumSuccessAgeMilliseconds,
          providerIdentity: {
            endpoint: provider.endpoint,
            externalAccountId: provider.appId,
          },
          audit,
        });
        committed = true;
        await this.#applyCommitted(snapshot, async () => {
          if (snapshot.collection) {
            await this.#onCollectionApplied(snapshot.collection, accountKey);
          }
        });
        return this.view();
      } catch (error) {
        if (!committed && transitionStarted) await this.#restoreCurrentRuntime(error);
        throw error;
      }
    });
  }

  generateProviderApplicationKey(
    expectedRevision: number,
    audit: SettingsAuditContext,
  ): Promise<{
    readonly created: boolean;
    readonly settings: RuntimeSettingsView;
    readonly public_key: string;
    readonly fingerprint: string;
  }> {
    return this.#exclusive(async () => {
      const current = this.#store.snapshot();
      if (
        current.provider !== null ||
        current.activeProviderAccountKey !== null ||
        this.#providerHistory().length > 0
      ) {
        throw new SettingsError(
          "provider_application_key_rotation_not_supported",
          "an application key cannot be generated after a provider generation has been created",
        );
      }
      const existing = this.#store.providerApplicationKey();
      if (existing !== null) {
        if (expectedRevision > current.revision) {
          throw revisionConflict(expectedRevision, current.revision);
        }
        return {
          created: false,
          settings: this.view(),
          public_key: existing.uploadPublicKey,
          fingerprint: existing.fingerprint,
        };
      }
      if (current.revision !== expectedRevision) {
        throw revisionConflict(expectedRevision, current.revision);
      }
      const generated = await generateProviderApplicationKey();
      this.#store.saveGeneratedProviderApplicationKey({
        expectedRevision,
        privateKeyPem: generated.privateKeyPem,
        fingerprint: generated.fingerprint,
        audit,
      });
      return {
        created: true,
        settings: this.view(),
        public_key: generated.uploadPublicKey,
        fingerprint: generated.fingerprint,
      };
    });
  }

  regenerateProviderApplicationKey(
    input: RegenerateProviderApplicationKeyInput,
    audit: SettingsAuditContext,
  ) {
    return this.#exclusive(async () => {
      const parsed = regenerateProviderApplicationKeySchema.parse(input);
      const current = this.#store.snapshot();
      const currentKey = this.#store.providerApplicationKey();
      const replay = this.#store.applicationKeyChange(parsed.change_id);
      if (replay) {
        if (replay.requestedRevision !== parsed.revision || replay.baseFingerprint !== parsed.base_fingerprint ||
          replay.state === "DISCARDED" ||
          (replay.state === "ACTIVATED" && currentKey?.fingerprint !== replay.newFingerprint) ||
          (replay.state === "PENDING" && currentKey?.fingerprint !== replay.baseFingerprint)) {
          throw keyChangeConflict();
        }
        const key = replay.key ?? currentKey!;
        return { created: false, settings: this.view(), public_key: key.uploadPublicKey, fingerprint: key.fingerprint };
      }
      if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
      if (!currentKey || currentKey.fingerprint !== parsed.base_fingerprint) throw keyChangeConflict();
      if (this.#store.pendingApplicationKey()) {
        throw new SettingsError("provider_application_key_change_pending", "an application key is already awaiting activation");
      }
      if (!current.provider && (current.activeProviderAccountKey !== null || this.#providerHistory().length > 0)) {
        throw new SettingsError("settings_not_configured", "restore the existing provider configuration before regenerating its application key");
      }
      const key = await generateProviderApplicationKey();
      this.#store.createApplicationKeyChange({
        expectedRevision: parsed.revision, changeId: parsed.change_id,
        baseFingerprint: parsed.base_fingerprint, key, audit,
      });
      return { created: true, settings: this.view(), public_key: key.uploadPublicKey, fingerprint: key.fingerprint };
    });
  }

  activateProviderApplicationKey(
    input: ActivateProviderApplicationKeyInput,
    audit: SettingsAuditContext,
    signal?: AbortSignal,
  ): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = activateProviderApplicationKeySchema.parse(input);
      const current = this.#store.snapshot();
      const change = this.#store.applicationKeyChange(parsed.change_id);
      if (!change || !change.providerAccountKey) throw keyChangeConflict();
      if (change.state === "ACTIVATED") {
        if (parsed.revision + 1 !== change.finishedRevision ||
          current.activeProviderAccountKey !== change.providerAccountKey ||
          current.provider?.applicationKeyFingerprint !== change.newFingerprint) throw keyChangeConflict();
        if (parsed.platform_public_key && candidateProvider(current.provider, current.provider.privateKeyPem,
          parsed.platform_public_key).platformKeyFingerprint !== current.provider.platformKeyFingerprint) throw keyChangeConflict();
        // A lost response may follow a committed change whose runtime application failed.
        await this.#applyCommitted(current);
        return this.view();
      }
      if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
      assertPendingKeyMatches(current, change);
      const provider = candidateProvider(current.provider!, change.key!.privateKeyPem, parsed.platform_public_key);
      try {
        signal?.throwIfAborted();
        await this.#verifyProviderApplicationKey(provider, { signal, requestId: audit.requestId });
        signal?.throwIfAborted();
      } catch (error) {
        if (error instanceof SettingsError && error.code === "provider_application_key_verification_failed") throw error;
        throw new SettingsError("provider_application_key_verification_failed", "未能完成支付宝验证，当前密钥未更换，请重试。");
      }
      let committed = false;
      let transitionStarted = false;
      try {
        transitionStarted = true;
        await this.#onPaymentMutationStarted();
        if (signal?.aborted) throw new SettingsError("provider_application_key_verification_failed", "启用请求已取消，当前密钥未更换。");
        const snapshot = this.#store.finishApplicationKeyChange({
          expectedRevision: parsed.revision, changeId: parsed.change_id, provider, audit,
        });
        committed = true;
        await this.#applyCommitted(snapshot);
        return this.view();
      } catch (error) {
        if (!committed && transitionStarted) await this.#restoreCurrentRuntime(error);
        throw error;
      }
    });
  }

  discardProviderApplicationKey(
    input: ApplicationKeyChangeActionInput,
    audit: SettingsAuditContext,
  ): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = applicationKeyChangeActionSchema.parse(input);
      const current = this.#store.snapshot();
      const change = this.#store.applicationKeyChange(parsed.change_id);
      if (change?.state === "DISCARDED" && change.finishedRevision === parsed.revision + 1) return this.view();
      if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
      assertPendingKeyMatches(current, change);
      this.#store.finishApplicationKeyChange({
        expectedRevision: parsed.revision, changeId: parsed.change_id, audit,
      });
      return this.view();
    });
  }

  rotateApiSecret(expectedRevision: number, audit: SettingsAuditContext): Promise<{
    readonly settings: RuntimeSettingsView;
    readonly client_id: "default";
    readonly secret: string;
  }> {
    return this.#exclusive(async () => {
      const secret = randomBytes(32).toString("base64url");
      const snapshot = this.#store.saveApiSecret(secret, expectedRevision, audit);
      await this.#applyCommitted(snapshot);
      return { settings: this.view(), client_id: "default", secret };
    });
  }

  saveWebhook(input: WebhookSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = webhookSettingsInputSchema.parse(input);
      const current = this.#store.snapshot();
      if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
      const allowedOrigin = parsed.enabled ? parseWebhookOrigin(parsed.allowed_origin ?? "") : undefined;
      const secret = parsed.enabled && current.webhook.secret === null
        ? randomBytes(32).toString("base64url")
        : null;
      const snapshot = this.#store.saveWebhook({
        ...parsed,
        ...(allowedOrigin === undefined ? {} : { allowed_origin: allowedOrigin }),
        secret,
      }, audit);
      await this.#applyCommitted(snapshot);
      return this.view();
    });
  }

  saveAdvanced(input: AdvancedSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = advancedSettingsInputSchema.parse(input);
      this.#store.saveAdvanced(parsed, audit);
      return this.view();
    });
  }

  saveBackup(input: BackupSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = backupSettingsInputSchema.parse(input);
      this.#store.saveBackup(parsed, audit);
      return this.view();
    });
  }

  saveDisplay(input: DisplaySettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = displaySettingsInputSchema.parse(input);
      this.#store.saveDisplay(parsed, audit);
      return this.view();
    });
  }

  revealSecret(name: RuntimeSecretName, audit: SettingsAuditContext): string {
    return this.#store.reveal(name, audit);
  }

  async #applyCommitted(
    snapshot: RuntimeSettingsSnapshot,
    beforeApply?: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    const apply = async () => {
      await beforeApply?.();
      await this.#onApplied(snapshot);
    };
    try {
      await apply();
    } catch (firstError) {
      try {
        await apply();
      } catch (recoveryError) {
        throw new AggregateError(
          [firstError, recoveryError],
          "runtime settings were saved but could not be applied",
        );
      }
    }
  }

  async #restoreCurrentRuntime(originalError: unknown): Promise<void> {
    try {
      await this.#onApplied(this.#store.snapshot());
    } catch (recoveryError) {
      throw new AggregateError(
        [originalError, recoveryError],
        "settings mutation failed and the previous runtime could not be restored",
      );
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function keyChangeConflict(): SettingsError {
  return new SettingsError("provider_application_key_change_conflict", "the application key change no longer matches; reload the current configuration");
}

function assertPendingKeyMatches(current: RuntimeSettingsSnapshot, change: ProviderApplicationKeyChange | null): void {
  if (!change || change.state !== "PENDING" || !change.key || !current.provider ||
    current.activeProviderAccountKey !== change.providerAccountKey || current.provider.appId !== change.appId ||
    current.provider.environment !== change.environment || current.provider.applicationKeyFingerprint !== change.baseFingerprint) {
    throw keyChangeConflict();
  }
}

function candidateProvider(current: ProviderSettings, privateKey: string, publicKey?: string): ProviderSettings {
  return parseProviderKeys({
    environment: current.environment, appId: current.appId, privateKey,
    publicKey: publicKey ?? current.publicKeyPem,
    timeoutMilliseconds: current.timeoutMilliseconds,
    scanIntervalMilliseconds: current.scanIntervalMilliseconds,
    activeScanIntervalMilliseconds: current.activeScanIntervalMilliseconds,
    safetyLagMilliseconds: current.safetyLagMilliseconds,
    maximumSuccessAgeMilliseconds: current.maximumSuccessAgeMilliseconds,
  });
}

function revisionConflict(expected: number, current: number): SettingsError {
  return new SettingsError(
    "settings_revision_conflict",
    `settings changed concurrently: expected revision ${expected}, current revision ${current}`,
  );
}

function configurationNextStep(input: {
  readonly applicationKeyConfigured: boolean;
  readonly providerConfigured: boolean;
  readonly collectionConfigured: boolean;
  readonly apiConfigured: boolean;
}): RuntimeSettingsView["completion"]["next_step"] {
  if (!input.applicationKeyConfigured) return "GENERATE_APPLICATION_KEY";
  if (!input.providerConfigured) return "CONFIGURE_PROVIDER";
  if (!input.collectionConfigured) return "CONFIGURE_COLLECTION";
  if (!input.apiConfigured) return "GENERATE_API_KEY";
  return null;
}

function latestProviderGeneration(
  generations: readonly ProviderIdentityActivation[],
): ProviderIdentityActivation | null {
  let latest: ProviderIdentityActivation | null = null;
  for (const generation of generations) {
    if (latest === null || generation.sequence > latest.sequence) latest = generation;
  }
  return latest;
}
